// Serves the diary app and keeps a copy of the diary on this server, behind a password.
// No dependencies: plain Node 22.
import http from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PASSWORD = process.env.DIARY_PASSWORD || "";
const STATIC = join(process.cwd(), "dist");
const FILE = join(DATA_DIR, "diary.json");
const MAX_BODY = 20 * 1024 * 1024;
const KEEP_BACKUPS = 30;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
};

// ---- password check, with a lockout after repeated wrong tries ----
const failures = new Map(); // ip -> { count, until }
const digest = (s) => createHash("sha256").update(s).digest();
function locked(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now();
}
function checkPassword(req, ip) {
  const given = (req.headers.authorization || "").replace(/^Bearer /, "");
  const ok = PASSWORD && timingSafeEqual(digest(given), digest(PASSWORD));
  if (ok) { failures.delete(ip); return true; }
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  failures.set(ip, f);
  return false;
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

async function api(req, res, ip) {
  if (!PASSWORD) return send(res, 503, { error: "DIARY_PASSWORD is not set" });
  if (locked(ip)) return send(res, 429, { error: "too many wrong passwords" });
  if (!checkPassword(req, ip)) return send(res, 401, { error: "wrong password" });
  if (req.method === "GET") return send(res, 200, await load());
  if (req.method === "PUT") {
    let state;
    try { state = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "invalid diary" }); }
    if (!state || !Array.isArray(state.entries) || typeof state.reviews !== "object") return send(res, 400, { error: "invalid diary" });
    await save({ entries: state.entries, chapters: Array.isArray(state.chapters) ? state.chapters : [], chaptersAt: Number(state.chaptersAt) || 0, reviews: state.reviews || {}, savedAt: Date.now() });
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "method not allowed" });
}

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
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    return await staticFile(req, res);
  } catch {
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
}).listen(PORT, () => console.log(`Voice Diary on port ${PORT}${PASSWORD ? "" : " (saving to the server is off: DIARY_PASSWORD is not set)"}`));
