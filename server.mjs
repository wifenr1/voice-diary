// Serves the diary app, keeps each person's diary on this server behind their password,
// and offers each diary to Claude as its own MCP connector. No dependencies: plain Node 22.
import http from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { timingSafeEqual, createHash, randomBytes, scryptSync } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PASSWORD = process.env.DIARY_PASSWORD || "";
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const TIME_ZONE = process.env.DIARY_TIME_ZONE || "Europe/Berlin";
const INVITE_CODE = process.env.INVITE_CODE || "";
// The owner (Anna) signs in with DIARY_PASSWORD and keeps the original diary file and connector.
const OWNER = (process.env.OWNER_USERNAME || "anna").toLowerCase();
const OWNER_NAME = process.env.OWNER_NAME || "Anna";
const STATIC = join(process.cwd(), "dist");
const USERS_FILE = join(DATA_DIR, "users.json");
const MAX_BODY = 20 * 1024 * 1024;
const KEEP_BACKUPS = 30;

// Anna's starting chapters, the same as the app's, used until she changes them there.
const DEFAULT_CHAPTERS = [
  { k: "learn", name: "Work learnings", c: "--b-learn", hint: "lessons and insights from work" },
  { k: "exp", name: "Work experiences", c: "--b-exp", hint: "things that happened at work" },
  { k: "tom", name: "Private life with Tom", c: "--b-tom", hint: "my life with my partner Tom" },
  { k: "hobby", name: "Hobbies", c: "--b-hobby", hint: "sport, making things, free time" },
  { k: "future", name: "Future", c: "--b-future", hint: "goals, plans and wishes" },
  { k: "berlin", name: "Berlin", c: "--b-berlin", hint: "the city, places and life there" },
];

// Starting chapters for everyone else, until they pick their own when they sign up.
const GENERIC_CHAPTERS = [
  { k: "learn", name: "Work learnings", c: "--b-learn", hint: "lessons and insights from work" },
  { k: "exp", name: "Work experiences", c: "--b-exp", hint: "things that happened at work" },
  { k: "people", name: "People I love", c: "--b-tom", hint: "partner, family and friends" },
  { k: "hobby", name: "Hobbies", c: "--b-hobby", hint: "sport, making things, free time" },
  { k: "future", name: "Future", c: "--b-future", hint: "goals, plans and wishes" },
];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
};

// ---- secrets, with a lockout after repeated wrong tries ----
const failures = new Map(); // ip -> { count, until }
const digest = (s) => createHash("sha256").update(s).digest();
const same = (a, b) => Boolean(a) && Boolean(b) && timingSafeEqual(digest(a), digest(b));
const locked = (ip) => (failures.get(ip)?.until || 0) > Date.now();
function noteResult(ip, ok) {
  if (ok) { failures.delete(ip); return ok; }
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (++f.count >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  failures.set(ip, f);
  return ok;
}

// ---- storage: one JSON file, written atomically, plus one backup per day ----
// Anna's diary stays in diary.json; everyone else's is people/<username>.json.
const diaryFile = (user) => (user === OWNER ? join(DATA_DIR, "diary.json") : join(DATA_DIR, "people", `${user}.json`));
const backupPrefix = (user) => (user === OWNER ? "diary-" : `${user}--`);
async function writeAtomic(file, data) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file + ".tmp", data);
  await rename(file + ".tmp", file);
}
async function load(user) {
  try { return JSON.parse(await readFile(diaryFile(user), "utf8")); }
  catch { return { entries: [], chapters: [], chaptersAt: 0, reviews: {} }; }
}
async function save(user, state) {
  await writeAtomic(diaryFile(user), JSON.stringify(state));
  await mkdir(join(DATA_DIR, "backups"), { recursive: true });
  const day = new Date().toISOString().slice(0, 10), prefix = backupPrefix(user);
  await writeFile(join(DATA_DIR, "backups", `${prefix}${day}.json`), JSON.stringify(state));
  const old = (await readdir(join(DATA_DIR, "backups"))).filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}\.json$/.test(f.slice(prefix.length))).sort().slice(0, -KEEP_BACKUPS);
  await Promise.all(old.map((f) => unlink(join(DATA_DIR, "backups", f))));
}
// The phone and Claude both write, so changes are merged, never replaced:
// the newest version of each entry wins and nothing is dropped.
function merge(stored, incoming) {
  const byId = new Map((stored.entries || []).map((e) => [e.id, e]));
  for (const e of incoming.entries || []) {
    if (!e || !e.id) continue;
    const mine = byId.get(e.id);
    if (!mine || (e.updatedAt || e.createdAt || 0) >= (mine.updatedAt || mine.createdAt || 0)) byId.set(e.id, e);
  }
  const reviews = { ...(stored.reviews || {}) };
  for (const [w, rv] of Object.entries(incoming.reviews || {})) {
    if (!reviews[w] || (rv?.at || 0) >= (reviews[w]?.at || 0)) reviews[w] = rv;
  }
  const newerChapters = Array.isArray(incoming.chapters) && incoming.chapters.length && (Number(incoming.chaptersAt) || 0) > (stored.chaptersAt || 0);
  return {
    entries: [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    chapters: newerChapters ? incoming.chapters : stored.chapters || [],
    chaptersAt: newerChapters ? Number(incoming.chaptersAt) : stored.chaptersAt || 0,
    reviews,
    savedAt: Date.now(),
  };
}
// one change at a time, so the phone and Claude never overwrite each other
let queue = Promise.resolve();
function serially(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
const withDiary = (user, fn) => serially(async () => fn(await load(user)));

// ---- people: accounts, sign-in sessions and personal connector secrets ----
async function loadUsers() {
  try { return JSON.parse(await readFile(USERS_FILE, "utf8")); } catch { return { users: {}, sessions: {} }; }
}
const saveUsers = (u) => writeAtomic(USERS_FILE, JSON.stringify(u));
const hashPassword = (pw, salt) => scryptSync(pw, salt, 32).toString("hex");
const secret = () => randomBytes(24).toString("base64url");
const tokenKey = (t) => createHash("sha256").update(t).digest("hex");
const validUsername = (u) => /^[a-z0-9][a-z0-9_-]{1,29}$/.test(u);
async function newSession(user) {
  const token = secret();
  await serially(async () => { const u = await loadUsers(); u.sessions[tokenKey(token)] = { user, at: Date.now() }; await saveUsers(u); });
  return token;
}
// Who is calling: a session token from signing in, or (for Anna's phone set up earlier) DIARY_PASSWORD itself.
async function whoIs(token) {
  if (!token) return null;
  if (PASSWORD && same(token, PASSWORD)) return OWNER;
  const s = (await loadUsers()).sessions[tokenKey(token)];
  return s ? s.user : null;
}
async function profile(user) {
  if (user === OWNER) return { username: OWNER, name: OWNER_NAME, owner: true, connector: MCP_TOKEN ? `/mcp/${MCP_TOKEN}` : "" };
  const rec = (await loadUsers()).users[user];
  return { username: user, name: rec?.name || user, owner: false, connector: rec ? `/mcp/${rec.mcp}` : "" };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

// ---- signing up and signing in ----
async function readJson(req) { try { return JSON.parse(await readBody(req)) || {}; } catch { return {}; } }
async function account(req, res, ip, path) {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (locked(ip)) return send(res, 429, { error: "too many wrong tries" });
  const b = await readJson(req);
  const username = String(b.username || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (path === "/api/login") {
    let ok = false;
    if (username === OWNER) ok = Boolean(PASSWORD) && same(password, PASSWORD);
    else {
      const rec = (await loadUsers()).users[username];
      ok = Boolean(rec) && same(hashPassword(password, rec.salt), rec.hash);
    }
    if (!noteResult(ip, ok)) return send(res, 401, { error: "wrong username or password" });
    return send(res, 200, { token: await newSession(username), me: await profile(username) });
  }
  if (path === "/api/signup") {
    if (!INVITE_CODE) return send(res, 403, { error: "signups_off" });
    if (!noteResult(ip, same(String(b.invite || "").trim(), INVITE_CODE))) return send(res, 401, { error: "wrong_invite" });
    if (!validUsername(username) || username === OWNER) return send(res, 400, { error: "bad_username" });
    if (password.length < 8) return send(res, 400, { error: "short_password" });
    const name = String(b.name || "").trim().slice(0, 40) || username;
    const created = await serially(async () => {
      const u = await loadUsers();
      if (u.users[username]) return false;
      const salt = secret();
      u.users[username] = { name, salt, hash: hashPassword(password, salt), mcp: secret(), createdAt: Date.now() };
      await saveUsers(u);
      return true;
    });
    if (!created) return send(res, 409, { error: "taken" });
    return send(res, 200, { token: await newSession(username), me: await profile(username) });
  }
  return send(res, 404, { error: "not found" });
}

// ---- the app's sync API ----
async function api(req, res, ip) {
  if (locked(ip)) return send(res, 429, { error: "too many wrong passwords" });
  const given = (req.headers.authorization || "").replace(/^Bearer /, "");
  const user = await whoIs(given);
  if (!noteResult(ip, Boolean(user))) return send(res, 401, { error: "wrong password" });
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/api/me") return send(res, 200, await profile(user));
  if (path === "/api/logout") {
    await serially(async () => { const u = await loadUsers(); delete u.sessions[tokenKey(given)]; await saveUsers(u); });
    return send(res, 200, { ok: true });
  }
  if (path !== "/api/diary") return send(res, 404, { error: "not found" });
  if (req.method === "GET") return send(res, 200, await load(user));
  if (req.method === "PUT") {
    let incoming;
    try { incoming = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid diary" }); }
    if (!incoming || !Array.isArray(incoming.entries)) return send(res, 400, { error: "invalid diary" });
    const merged = await withDiary(user, async (stored) => { const m = merge(stored, incoming); await save(user, m); return m; });
    return send(res, 200, merged);
  }
  return send(res, 405, { error: "method not allowed" });
}

// ---- the MCP connector for Claude ----
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE }).format(new Date());
const nowTime = () => new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const chaptersOf = (d, user) => (d.chapters && d.chapters.length ? d.chapters : user === OWNER ? DEFAULT_CHAPTERS : GENERIC_CHAPTERS);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || "");
function weekStartOf(date) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const toolsFor = (who) => [
  {
    name: "get_chapters",
    description: `List the chapters of ${who}'s diary, with the key to use for each and a hint of what belongs in it. Call this before add_diary_entry so each point goes into the right chapter.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_diary_entry",
    description:
      `Save what ${who} told you as one diary entry. Split their words into separate points: one per story, paragraph or bullet. ` +
      "Keep their own words and first person, only fixing obvious transcription slips and punctuation. Put each point in exactly one chapter, using a key from get_chapters. " +
      "Turn every reminder request (\"remind me to…\", \"don't let me forget…\") into a reminder with a short title, a date (YYYY-MM-DD) and a time (HH:MM, 24h), resolving relative dates from today; " +
      "if no time is given use 09:00, if no day is given use tomorrow. Leave reminder sentences out of the points. Afterwards, tell them briefly which chapters you used.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Everything they said for this entry, as they said it." },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, chapter: { type: "string", description: "Chapter key from get_chapters" } },
            required: ["text", "chapter"],
            additionalProperties: false,
          },
        },
        reminders: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24h" } },
            required: ["title", "date"],
            additionalProperties: false,
          },
        },
        date: { type: "string", description: "The day this entry is about, YYYY-MM-DD. Leave out for today." },
      },
      required: ["transcript", "points"],
      additionalProperties: false,
    },
  },
  {
    name: "list_entries",
    description: `Read ${who}'s diary entries between two dates (inclusive), for example to write their weekly review or answer questions about their diary.`,
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD, defaults to today" } },
      required: ["from"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "tidy_entry",
    description:
      `Rewrite an entry ${who} spoke into the app itself (sorted_by "app" in list_entries). The app's speech recognition often garbles words and its sorting is simple, ` +
      "so rebuild the points from the transcript: fix what was misheard (they may mix languages), keep their own words and first person, one point per story, " +
      "each in exactly one chapter key from get_chapters. Give the full list of reminders in it, as in add_diary_entry; leave reminders out to keep the ones it has. The entry keeps its date and time.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The entry's id from list_entries" },
        points: {
          type: "array",
          items: {
            type: "object",
            properties: { text: { type: "string" }, chapter: { type: "string", description: "Chapter key from get_chapters" } },
            required: ["text", "chapter"],
            additionalProperties: false,
          },
        },
        reminders: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24h" } },
            required: ["title", "date"],
            additionalProperties: false,
          },
        },
      },
      required: ["id", "points"],
      additionalProperties: false,
    },
  },
  {
    name: "save_weekly_review",
    description:
      `Save ${who}'s weekly review so it shows in their diary app. First read the week with list_entries (Monday to Sunday). For each chapter with points, write a 1 to 3 sentence summary in second person ("you"), ` +
      "then 1 to 3 small, concrete challenges for next week, grounded in what they wrote. Each challenge has a type: \"future\" (think about the future here), \"again\" (do this again) or \"train\" (practise this skill).",
    inputSchema: {
      type: "object",
      properties: {
        week_start: { type: "string", description: "The Monday of the week, YYYY-MM-DD" },
        chapters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chapter: { type: "string", description: "Chapter key" },
              summary: { type: "string" },
              challenges: {
                type: "array",
                items: {
                  type: "object",
                  properties: { type: { type: "string", enum: ["future", "again", "train"] }, text: { type: "string" } },
                  required: ["type", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["chapter", "summary", "challenges"],
            additionalProperties: false,
          },
        },
      },
      required: ["week_start", "chapters"],
      additionalProperties: false,
    },
  },
];

const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

async function callTool(user, name, a = {}) {
  if (name === "get_chapters") {
    const d = await load(user);
    return text({ today: today(), chapters: chaptersOf(d, user).map((c) => ({ key: c.k, name: c.name, hint: c.hint || "" })) });
  }
  if (name === "add_diary_entry") {
    if (typeof a.transcript !== "string" || !Array.isArray(a.points) || !a.points.length) return fail("Give the transcript and at least one point.");
    if (a.date && !isDate(a.date)) return fail("date must be YYYY-MM-DD.");
    return withDiary(user, async (d) => {
      const keys = new Set(chaptersOf(d, user).map((c) => c.k));
      const unknown = a.points.filter((p) => !keys.has(p.chapter)).map((p) => p.chapter);
      if (unknown.length) return fail(`Unknown chapter key(s): ${[...new Set(unknown)].join(", ")}. Call get_chapters for the valid keys.`);
      const reminders = (a.reminders || []).filter((r) => r && r.title && isDate(r.date)).map((r) => ({ title: String(r.title).trim(), date: r.date, time: isTime(r.time) ? r.time : "" }));
      const now = Date.now();
      const entry = {
        id: "m" + now.toString(36), source: "claude",
        date: a.date || today(), time: nowTime(), createdAt: now, updatedAt: now,
        text: a.transcript, items: a.points.map((p) => ({ t: String(p.text).trim(), b: p.chapter })).filter((p) => p.t), reminders,
      };
      const m = merge(d, { entries: [entry] });
      await save(user, m);
      const names = Object.fromEntries(chaptersOf(m, user).map((c) => [c.k, c.name]));
      const used = [...new Set(entry.items.map((i) => names[i.b]))];
      return text(`Saved to the diary for ${entry.date}: ${entry.items.length} point(s) in ${used.join(", ")}` +
        (reminders.length ? `, and ${reminders.length} reminder(s) they can add to their calendar from the app.` : "."));
    });
  }
  if (name === "list_entries") {
    if (!isDate(a.from) || (a.to && !isDate(a.to))) return fail("from and to must be YYYY-MM-DD.");
    const d = await load(user);
    const to = a.to || today();
    const names = Object.fromEntries(chaptersOf(d, user).map((c) => [c.k, c.name]));
    const entries = (d.entries || []).filter((e) => !e.deleted && e.date >= a.from && e.date <= to).map((e) => ({
      id: e.id, date: e.date, time: e.time, sorted_by: e.source === "claude" ? "claude" : "app",
      transcript: e.source === "claude" ? undefined : e.text,
      points: (e.items || []).map((i) => ({ chapter: i.b, chapter_name: names[i.b] || i.b, text: i.t })),
      reminders: e.reminders || [],
    }));
    return text({ from: a.from, to, count: entries.length, entries });
  }
  if (name === "tidy_entry") {
    if (typeof a.id !== "string" || !Array.isArray(a.points) || !a.points.length) return fail("Give the entry id and at least one point.");
    return withDiary(user, async (d) => {
      const old = (d.entries || []).find((e) => e.id === a.id && !e.deleted);
      if (!old) return fail(`No entry with id ${a.id}. Use list_entries to find it.`);
      const keys = new Set(chaptersOf(d, user).map((c) => c.k));
      const unknown = a.points.filter((p) => !keys.has(p.chapter)).map((p) => p.chapter);
      if (unknown.length) return fail(`Unknown chapter key(s): ${[...new Set(unknown)].join(", ")}. Call get_chapters for the valid keys.`);
      const reminders = (a.reminders || []).filter((r) => r && r.title && isDate(r.date)).map((r) => ({ title: String(r.title).trim(), date: r.date, time: isTime(r.time) ? r.time : "" }));
      const entry = {
        ...old, source: "claude", tidied: true, updatedAt: Date.now(),
        items: a.points.map((p) => ({ t: String(p.text).trim(), b: p.chapter })).filter((p) => p.t),
        reminders: Array.isArray(a.reminders) ? reminders : old.reminders || [],
      };
      await save(user, merge(d, { entries: [entry] }));
      return text(`Tidied the entry from ${entry.date} ${entry.time}: ${entry.items.length} point(s).`);
    });
  }
  if (name === "save_weekly_review") {
    if (!isDate(a.week_start) || !Array.isArray(a.chapters)) return fail("Give week_start (YYYY-MM-DD) and chapters.");
    const week = weekStartOf(a.week_start);
    const review = {
      at: Date.now(), source: "claude",
      buckets: a.chapters.map((c) => ({ bucket: c.chapter, summary: c.summary, challenges: (c.challenges || []).map((x) => ({ type: x.type, text: x.text })) })),
    };
    await withDiary(user, async (d) => { await save(user, merge(d, { reviews: { [week]: review } })); });
    return text(`Saved the weekly review for the week starting ${week}. It shows on the Week page of their diary app.`);
  }
  return fail(`Unknown tool: ${name}`);
}

async function rpc(user, who, msg) {
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "Invalid request");
  if (id === undefined) return null; // a notification: nothing to answer
  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "voice-diary", version: "1.0.0" },
      instructions: `This is ${who}'s personal diary. When they tell you about their day or say "diary: …", call get_chapters, then add_diary_entry. When they ask for their weekly review, read the week with list_entries and save it with save_weekly_review. ` +
        "When they say \"tidy my diary\", read the last two weeks with list_entries and rewrite every entry with sorted_by \"app\" using tidy_entry, then tell them what you changed. " +
        "Do the same quietly before writing a weekly review.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: toolsFor(who) });
  if (method === "tools/call") {
    try { return reply(await callTool(user, params?.name, params?.arguments)); }
    catch { return reply(fail("The diary server had a problem saving or reading. Try again.")); }
  }
  return error(-32601, `Method not found: ${method}`);
}

// Each connector address carries a long secret: https://<domain>/mcp/<secret>.
// Anna's secret is MCP_TOKEN; everyone else gets their own when they sign up.
async function connectorOwner(token) {
  if (!token) return null;
  if (MCP_TOKEN && same(token, MCP_TOKEN)) return { user: OWNER, who: OWNER_NAME };
  const users = (await loadUsers()).users;
  for (const [user, rec] of Object.entries(users)) if (same(token, rec.mcp)) return { user, who: rec.name || user };
  return null;
}
async function mcp(req, res, ip) {
  if (locked(ip)) return send(res, 429, { error: "too many wrong tries" });
  const token = new URL(req.url, "http://x").pathname.split("/")[2] || "";
  const owner = await connectorOwner(token);
  if (!noteResult(ip, Boolean(owner))) return send(res, 404, { error: "not found" });
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const out = Array.isArray(body) ? (await Promise.all(body.map((m) => rpc(owner.user, owner.who, m)))).filter(Boolean) : await rpc(owner.user, owner.who, body);
  if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  return send(res, 200, out);
}

// ---- the app's files ----
async function staticFile(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(STATIC, path));
  if (!file.startsWith(STATIC)) return send(res, 403, "Forbidden", "text/plain");
  const target = existsSync(file) ? file : join(STATIC, "index.html");
  const type = TYPES[extname(target)] || "application/octet-stream";
  const fresh = target.endsWith("index.html") || target.endsWith("sw.js");
  res.writeHead(200, { "content-type": type, "cache-control": fresh ? "no-cache" : "public, max-age=86400", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(await readFile(target));
}

http.createServer(async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/login" || path === "/api/signup") return await account(req, res, ip, path);
    if (path.startsWith("/api/")) return await api(req, res, ip);
    if (req.url.startsWith("/mcp/")) return await mcp(req, res, ip);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    return await staticFile(req, res);
  } catch {
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
}).listen(PORT, () => {
  console.log(`Voice Diary on port ${PORT}`);
  if (!PASSWORD) console.log("Saving from the app is off: set DIARY_PASSWORD.");
  if (!MCP_TOKEN) console.log("Anna's Claude connector is off: set MCP_TOKEN.");
  if (!INVITE_CODE) console.log("New people can't sign up: set INVITE_CODE to allow it.");
});
