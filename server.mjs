// Serves the diary app, keeps the diary on this server behind a password,
// and offers it to Claude as an MCP connector. No dependencies: plain Node 22.
import http from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PASSWORD = process.env.DIARY_PASSWORD || "";
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const TIME_ZONE = process.env.DIARY_TIME_ZONE || "Europe/Berlin";
const STATIC = join(process.cwd(), "dist");
const FILE = join(DATA_DIR, "diary.json");
const MAX_BODY = 20 * 1024 * 1024;
const KEEP_BACKUPS = 30;

// Same starting chapters as the app, used until Anna changes them there.
const DEFAULT_CHAPTERS = [
  { k: "learn", name: "Work learnings", c: "--b-learn", hint: "lessons and insights from work" },
  { k: "exp", name: "Work experiences", c: "--b-exp", hint: "things that happened at work" },
  { k: "tom", name: "Private life with Tom", c: "--b-tom", hint: "my life with my partner Tom" },
  { k: "hobby", name: "Hobbies", c: "--b-hobby", hint: "sport, making things, free time" },
  { k: "future", name: "Future", c: "--b-future", hint: "goals, plans and wishes" },
  { k: "berlin", name: "Berlin", c: "--b-berlin", hint: "the city, places and life there" },
];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
};

// ---- secrets, with a lockout after repeated wrong tries ----
const failures = new Map(); // ip -> { count, until }
const digest = (s) => createHash("sha256").update(s).digest();
const same = (a, b) => Boolean(b) && timingSafeEqual(digest(a), digest(b));
const locked = (ip) => (failures.get(ip)?.until || 0) > Date.now();
function noteResult(ip, ok) {
  if (ok) { failures.delete(ip); return ok; }
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (++f.count >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  failures.set(ip, f);
  return ok;
}

// ---- storage: one JSON file, written atomically, plus one backup per day ----
async function load() {
  try { return JSON.parse(await readFile(FILE, "utf8")); }
  catch { return { entries: [], chapters: [], chaptersAt: 0, reviews: {} }; }
}
async function save(state) {
  await mkdir(join(DATA_DIR, "backups"), { recursive: true });
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, FILE);
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(join(DATA_DIR, "backups", `diary-${day}.json`), JSON.stringify(state));
  const old = (await readdir(join(DATA_DIR, "backups"))).filter((f) => f.startsWith("diary-")).sort().slice(0, -KEEP_BACKUPS);
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
function withDiary(fn) {
  const run = queue.then(async () => fn(await load()));
  queue = run.catch(() => {});
  return run;
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

// ---- the app's sync API ----
async function api(req, res, ip) {
  if (!PASSWORD) return send(res, 503, { error: "DIARY_PASSWORD is not set" });
  if (locked(ip)) return send(res, 429, { error: "too many wrong passwords" });
  const given = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!noteResult(ip, same(given, PASSWORD))) return send(res, 401, { error: "wrong password" });
  if (req.method === "GET") return send(res, 200, await load());
  if (req.method === "PUT") {
    let incoming;
    try { incoming = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid diary" }); }
    if (!incoming || !Array.isArray(incoming.entries)) return send(res, 400, { error: "invalid diary" });
    const merged = await withDiary(async (stored) => { const m = merge(stored, incoming); await save(m); return m; });
    return send(res, 200, merged);
  }
  return send(res, 405, { error: "method not allowed" });
}

// ---- the MCP connector for Claude ----
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE }).format(new Date());
const nowTime = () => new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const chaptersOf = (d) => (d.chapters && d.chapters.length ? d.chapters : DEFAULT_CHAPTERS);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isTime = (s) => /^\d{2}:\d{2}$/.test(s || "");
function weekStartOf(date) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const TOOLS = [
  {
    name: "get_chapters",
    description: "List the chapters of Anna's diary, with the key to use for each and a hint of what belongs in it. Call this before add_diary_entry so each point goes into the right chapter.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_diary_entry",
    description:
      "Save what Anna told you as one diary entry. Split her words into separate points: one per story, paragraph or bullet. " +
      "Keep her own words and first person, only fixing obvious transcription slips and punctuation. Put each point in exactly one chapter, using a key from get_chapters. " +
      "Turn every reminder request (\"remind me to…\", \"don't let me forget…\") into a reminder with a short title, a date (YYYY-MM-DD) and a time (HH:MM, 24h), resolving relative dates from today; " +
      "if no time is given use 09:00, if no day is given use tomorrow. Leave reminder sentences out of the points. Afterwards, tell her briefly which chapters you used.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Everything she said for this entry, as she said it." },
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
    description: "Read Anna's diary entries between two dates (inclusive), for example to write her weekly review or answer questions about her diary.",
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
      "Rewrite an entry Anna spoke into the app itself (sorted_by \"app\" in list_entries). The app's speech recognition often garbles words and its sorting is simple, " +
      "so rebuild the points from the transcript: fix what was misheard (she speaks English, sometimes mixed with German), keep her own words and first person, one point per story, " +
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
      "Save Anna's weekly review so it shows in her diary app. First read the week with list_entries (Monday to Sunday). For each chapter with points, write a 1 to 3 sentence summary in second person (\"you\"), " +
      "then 1 to 3 small, concrete challenges for next week, grounded in what she wrote. Each challenge has a type: \"future\" (think about the future here), \"again\" (do this again) or \"train\" (practise this skill).",
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

async function callTool(name, a = {}) {
  if (name === "get_chapters") {
    const d = await load();
    return text({ today: today(), chapters: chaptersOf(d).map((c) => ({ key: c.k, name: c.name, hint: c.hint || "" })) });
  }
  if (name === "add_diary_entry") {
    if (typeof a.transcript !== "string" || !Array.isArray(a.points) || !a.points.length) return fail("Give the transcript and at least one point.");
    if (a.date && !isDate(a.date)) return fail("date must be YYYY-MM-DD.");
    return withDiary(async (d) => {
      const keys = new Set(chaptersOf(d).map((c) => c.k));
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
      await save(m);
      const names = Object.fromEntries(chaptersOf(m).map((c) => [c.k, c.name]));
      const used = [...new Set(entry.items.map((i) => names[i.b]))];
      return text(`Saved to the diary for ${entry.date}: ${entry.items.length} point(s) in ${used.join(", ")}` +
        (reminders.length ? `, and ${reminders.length} reminder(s) she can add to her calendar from the app.` : "."));
    });
  }
  if (name === "list_entries") {
    if (!isDate(a.from) || (a.to && !isDate(a.to))) return fail("from and to must be YYYY-MM-DD.");
    const d = await load();
    const to = a.to || today();
    const names = Object.fromEntries(chaptersOf(d).map((c) => [c.k, c.name]));
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
    return withDiary(async (d) => {
      const old = (d.entries || []).find((e) => e.id === a.id && !e.deleted);
      if (!old) return fail(`No entry with id ${a.id}. Use list_entries to find it.`);
      const keys = new Set(chaptersOf(d).map((c) => c.k));
      const unknown = a.points.filter((p) => !keys.has(p.chapter)).map((p) => p.chapter);
      if (unknown.length) return fail(`Unknown chapter key(s): ${[...new Set(unknown)].join(", ")}. Call get_chapters for the valid keys.`);
      const reminders = (a.reminders || []).filter((r) => r && r.title && isDate(r.date)).map((r) => ({ title: String(r.title).trim(), date: r.date, time: isTime(r.time) ? r.time : "" }));
      const entry = {
        ...old, source: "claude", tidied: true, updatedAt: Date.now(),
        items: a.points.map((p) => ({ t: String(p.text).trim(), b: p.chapter })).filter((p) => p.t),
        reminders: Array.isArray(a.reminders) ? reminders : old.reminders || [],
      };
      await save(merge(d, { entries: [entry] }));
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
    await withDiary(async (d) => { await save(merge(d, { reviews: { [week]: review } })); });
    return text(`Saved the weekly review for the week starting ${week}. It shows on the Week page of her diary app.`);
  }
  return fail(`Unknown tool: ${name}`);
}

async function rpc(msg) {
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
      instructions: "This is Anna's personal diary. When she tells you about her day or says \"diary: …\", call get_chapters, then add_diary_entry. When she asks for her weekly review, read the week with list_entries and save it with save_weekly_review. " +
        "When she says \"tidy my diary\", read the last two weeks with list_entries and rewrite every entry with sorted_by \"app\" using tidy_entry, then tell her what you changed. " +
        "Do the same quietly before writing a weekly review.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS });
  if (method === "tools/call") {
    try { return reply(await callTool(params?.name, params?.arguments)); }
    catch { return reply(fail("The diary server had a problem saving or reading. Try again.")); }
  }
  return error(-32601, `Method not found: ${method}`);
}

// The connector's address carries a long secret: https://<domain>/mcp/<MCP_TOKEN>
async function mcp(req, res, ip) {
  if (!MCP_TOKEN) return send(res, 503, { error: "MCP_TOKEN is not set" });
  if (locked(ip)) return send(res, 429, { error: "too many wrong tries" });
  const token = new URL(req.url, "http://x").pathname.split("/")[2] || "";
  if (!noteResult(ip, same(token, MCP_TOKEN))) return send(res, 404, { error: "not found" });
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const out = Array.isArray(body) ? (await Promise.all(body.map(rpc))).filter(Boolean) : await rpc(body);
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
    if (req.url.startsWith("/api/diary")) return await api(req, res, ip);
    if (req.url.startsWith("/mcp/")) return await mcp(req, res, ip);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    return await staticFile(req, res);
  } catch {
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
}).listen(PORT, () => {
  console.log(`Voice Diary on port ${PORT}`);
  if (!PASSWORD) console.log("Saving from the app is off: set DIARY_PASSWORD.");
  if (!MCP_TOKEN) console.log("The Claude connector is off: set MCP_TOKEN.");
});
