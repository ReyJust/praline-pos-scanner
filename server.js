// Praline scanner: serves the POS page and forwards box photos to
// Azure AI Content Understanding. No dependencies, Node 18+.
//
// Secrets come from environment variables (or a local .env file) and never
// reach the browser: the page only ever talks to POST /analyze on this server.
//
//   AZURE_CU_ENDPOINT   https://<resource>.services.ai.azure.com
//   AZURE_CU_KEY        Content Understanding key
//   APP_PASSWORD        password for scanning (required in production). The page itself is public;
//                       visitors get one free test scan, after that scans need the password.
//   FREE_SCANS_PER_DAY  optional, cap on free test scans across all visitors per day (default 20, 0 = none)
//   AZURE_CU_ANALYZER_ID  optional, defaults to pralineBox
//   PORT                set by the host

import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { timingSafeEqual, createHash, createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

// Local development: load .env if present. On the host, use its env-var settings instead.
if (existsSync(join(ROOT, ".env"))) {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ENDPOINT = (process.env.AZURE_CU_ENDPOINT || "").replace(/\/+$/, "");
const KEY = process.env.AZURE_CU_KEY || "";
const PASSWORD = process.env.APP_PASSWORD || "";
const ANALYZER_ID = process.env.AZURE_CU_ANALYZER_ID || process.env.ANALYZER_ID || "pralineBox";
const GRID_ANALYZER_ID = process.env.AZURE_CU_GRID_ANALYZER_ID || "pralineGrid";
const API = "2025-11-01";
const PORT = Number(process.env.PORT) || 8000;
const MAX_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT = 60; // Azure calls per IP per hour (each scan = recognition + grid locator)
const FREE_PER_DAY = Number(process.env.FREE_SCANS_PER_DAY ?? 20);

if (!ENDPOINT || !KEY) {
  console.error("Missing AZURE_CU_ENDPOINT or AZURE_CU_KEY.");
  process.exit(1);
}
if (!PASSWORD) console.warn("APP_PASSWORD is not set: anyone who can reach this server can run unlimited scans.");

const PAGE = readFileSync(join(ROOT, "index.html"));
// Demo photos (demo/*.jpg) for trying the app without a camera. Read once; only these names are served.
const DEMO_DIR = join(ROOT, "demo");
const DEMOS = new Map(existsSync(DEMO_DIR)
  ? readdirSync(DEMO_DIR).filter(f => /^[\w-]+\.jpe?g$/i.test(f)).map(f => [`/demo/${f}`, readFileSync(join(DEMO_DIR, f))])
  : []);
const NAMES = JSON.parse(readFileSync(join(ROOT, "azure", "praline-ids.json"), "utf8"));
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/bmp", "image/tiff"]);

// ---------- helpers ----------
const sha = s => createHash("sha256").update(String(s)).digest();
const passwordOk = given => timingSafeEqual(sha(given || ""), sha(PASSWORD));

// Login session: an HttpOnly cookie "exp.signature". The signing key is derived from the
// password and Azure key, so changing APP_PASSWORD logs every device out.
const SESSION_DAYS = 30;
const SIGNING_KEY = sha(`session:${PASSWORD}:${KEY}`);
const sign = exp => createHmac("sha256", SIGNING_KEY).update(String(exp)).digest("base64url");
function sessionOk(req) {
  if (!PASSWORD) return true;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)session=(\d+)\.([\w-]+)/);
  if (!m || Number(m[1]) < Date.now()) return false;
  const want = Buffer.from(sign(m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
const cookie = (req, name, value, maxAge) => {
  const https = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
};
function sessionCookie(req) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  return cookie(req, "session", `${exp}.${sign(exp)}`, SESSION_DAYS * 86400);
}

// The rightmost X-Forwarded-For entry is the one added by the host's proxy; entries to its
// left come from the client and can be forged.
const clientIp = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",").pop().trim().replace(/^::ffff:/, "");
function limiter(max, windowMs) {
  const hits = new Map(); // ip -> [timestamps]
  return ip => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > max;
  };
}
const scanLimited = limiter(RATE_LIMIT, 3600_000);
const loginLimited = limiter(10, 15 * 60_000); // slows down password guessing

// ---------- free test scan ----------
// Without the password, a visitor gets one scan if ALL of these hold:
//   - this browser has no "trial used" cookie (signed, so it can't be forged)
//   - this IP had no free scan in the last 24 h (stops clearing cookies / private windows)
//   - fewer than FREE_SCANS_PER_DAY free scans were given out today, across everyone
// Granting a trial issues a ticket cookie good for one scan (one recognition + one grid call)
// within 3 minutes. Counters live in memory and reset on restart; the Azure budget is the backstop.
const TRIAL_KEY = sha(`trial:${KEY}`);
const trialSig = v => createHmac("sha256", TRIAL_KEY).update(v).digest("base64url");
const TRIAL_DAYS = 365;
function trialUsed(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)trial=(\d+)\.([\w-]+)/);
  if (!m) return false;
  const want = Buffer.from(trialSig(m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}
const trialIps = new Map(); // ip -> time of last free scan
let freeDay = "", freeToday = 0;
const tickets = new Map(); // id -> { exp, analyze, grid } (calls already spent)
function grantTrial(req) {
  const now = Date.now(), ip = clientIp(req), day = new Date().toISOString().slice(0, 10);
  if (day !== freeDay) { freeDay = day; freeToday = 0; }
  for (const [k, t] of trialIps) if (now - t > 86400_000) trialIps.delete(k);
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
  if (trialUsed(req) || trialIps.has(ip) || freeToday >= FREE_PER_DAY) return null;
  freeToday++;
  trialIps.set(ip, now);
  const id = randomBytes(18).toString("base64url");
  tickets.set(id, { exp: now + 180_000, analyze: false, grid: false });
  return [cookie(req, "ticket", id, 180), cookie(req, "trial", `${now}.${trialSig(String(now))}`, TRIAL_DAYS * 86400)];
}
// Spends this request's call on the ticket; false if there is no valid ticket or it's already spent.
function useTicket(req, kind) {
  const id = (req.headers.cookie || "").match(/(?:^|;\s*)ticket=([\w-]+)/)?.[1];
  const t = id && tickets.get(id);
  if (!t || t.exp < Date.now() || t[kind]) return false;
  t[kind] = true;
  if (t.analyze && t.grid) tickets.delete(id);
  return true;
}

function send(res, code, body, type = "application/json", extra = {}) {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...extra,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BYTES) { reject(new Error("too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Azure Content Understanding ----------
async function analyze(image, contentType, analyzerId = ANALYZER_ID) {
  const url = `${ENDPOINT}/contentunderstanding/analyzers/${analyzerId}:analyzeBinary?api-version=${API}`;
  const start = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": KEY, "Content-Type": contentType },
    body: image,
  });
  if (!start.ok) throw new Error(`Azure rejected the photo (${start.status}): ${(await start.text()).slice(0, 300)}`);
  const op = start.headers.get("operation-location");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const r = await fetch(op, { headers: { "Ocp-Apim-Subscription-Key": KEY } });
    const body = await r.json();
    if (body.status === "Succeeded") return body.result.contents[0].fields;
    if (body.status === "Failed" || body.status === "Canceled")
      throw new Error(`Analysis ${body.status.toLowerCase()}: ${JSON.stringify(body.error || {}).slice(0, 300)}`);
  }
  throw new Error("Analysis timed out");
}

function summarise(fields) {
  const val = f => f?.valueString ?? f?.valueNumber;
  const slots = (fields.pieces?.valueArray || []).map(item => {
    const o = item.valueObject || {};
    const id = val(o.praline);
    const look = [val(o.shell), val(o.shape), val(o.topping)]
      .filter(v => v && !/^(none|other|empty)$/i.test(v)).join(", ").toLowerCase();
    return { row: Number(val(o.row)) || 0, col: Number(val(o.column)) || 0, id, name: NAMES[id] || null, look };
  });
  const counts = {};
  for (const s of slots) if (s.name) counts[s.name] = (counts[s.name] || 0) + 1;
  return {
    rows: Number(val(fields.boxRows)) || 0,
    cols: Number(val(fields.boxColumns)) || 0,
    slots: slots.map(({ row, col, id, name }) => ({ row, col, id, name })),
    counts,
    unknown: slots.filter(s => s.id === "Unknown").map(({ row, col, look }) => ({ row, col, look })),
    empty: slots.filter(s => s.id === "Empty").length,
  };
}

// Where the slot grid sits in the photo, in % (read off the ruler the page adds; image fields have no bounding boxes).
function summariseGrid(fields) {
  const val = f => f?.valueString ?? f?.valueNumber;
  const pct = f => Math.min(100, Math.max(0, Number(val(f))));
  const g = [fields.gridLeft, fields.gridTop, fields.gridRight, fields.gridBottom].map(pct);
  const grid = g.every(Number.isFinite) && g[2] > g[0] && g[3] > g[1] ? { left: g[0], top: g[1], right: g[2], bottom: g[3] } : null;
  return { rows: Number(val(fields.boxRows)) || 0, cols: Number(val(fields.boxColumns)) || 0, grid };
}

// ---------- server ----------
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const html = "text/html; charset=utf-8";

    if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(res, 200, PAGE, html);

    if (req.method === "GET" && DEMOS.has(path)) return send(res, 200, DEMOS.get(path), "image/jpeg");

    // Called by the page before each scan: go ahead (logged in, or a free scan was granted) or ask for the password.
    if (req.method === "POST" && path === "/access") {
      if (sessionOk(req)) return send(res, 200, { access: "session" });
      const set = grantTrial(req);
      if (set) return send(res, 200, { access: "trial" }, "application/json", { "Set-Cookie": set });
      return send(res, 401, { needPassword: true });
    }

    if (req.method === "POST" && path === "/login") {
      if (!PASSWORD) return send(res, 200, { ok: true });
      if (loginLimited(clientIp(req))) return send(res, 429, { error: "Too many attempts. Wait 15 minutes." });
      let form;
      try { form = new URLSearchParams((await readBody(req)).toString("utf8")); } catch { return send(res, 413, { error: "Request too large." }); }
      if (!passwordOk(form.get("password"))) return send(res, 401, { error: "Wrong password." });
      return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": sessionCookie(req) });
    }

    if (req.method === "GET" && path === "/logout")
      return send(res, 303, "", html, { Location: "/", "Set-Cookie": cookie(req, "session", "", 0) });

    if (req.method === "POST" && (path === "/analyze" || path === "/grid")) {
      if (!sessionOk(req) && !useTicket(req, path.slice(1)))
        return send(res, 401, { needPassword: true, error: "Enter the password to scan." });
      if (scanLimited(clientIp(req))) return send(res, 429, { error: "Too many scans this hour. Try again later." });
      const type = (req.headers["content-type"] || "").split(";")[0].toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return send(res, 415, { error: `Unsupported image type: ${type || "none"}` });
      let image;
      try { image = await readBody(req); } catch { return send(res, 413, { error: "Photo is larger than 10 MB." }); }
      if (!image.length) return send(res, 400, { error: "No photo received." });
      if (path === "/grid") return send(res, 200, summariseGrid(await analyze(image, type, GRID_ANALYZER_ID)));
      return send(res, 200, summarise(await analyze(image, type)));
    }

    // Everything else (.env, scripts, results) is never served.
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 502, { error: err.message.slice(0, 400) });
  }
}).listen(PORT, () => console.log(`Praline scanner listening on port ${PORT}`));
