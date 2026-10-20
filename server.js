// Praline scanner: serves the POS page and forwards box photos to
// Azure AI Content Understanding. No dependencies, Node 18+.
//
// Secrets come from environment variables (or a local .env file) and never
// reach the browser: the page only ever talks to POST /analyze on this server.
//
//   AZURE_CU_ENDPOINT   https://<resource>.services.ai.azure.com
//   AZURE_CU_KEY        Content Understanding key
//   APP_PASSWORD        password staff type once on their phone (required in production)
//   AZURE_CU_ANALYZER_ID  optional, defaults to pralineBox
//   PORT                set by the host

import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { timingSafeEqual, createHash, createHmac } from "node:crypto";
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
const API = "2025-11-01";
const PORT = Number(process.env.PORT) || 8000;
const MAX_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT = 30; // scans per IP per hour

if (!ENDPOINT || !KEY) {
  console.error("Missing AZURE_CU_ENDPOINT or AZURE_CU_KEY.");
  process.exit(1);
}
if (!PASSWORD) console.warn("APP_PASSWORD is not set: anyone who can reach this server can run scans.");

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
function sessionCookie(req) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const https = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `session=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${https ? "; Secure" : ""}`;
}

const clientIp = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
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

const loginPage = error => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Praline Scanner</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f4f4; font: 16px/1.4 -apple-system, system-ui, sans-serif; color: #222; }
  form { width: min(320px, calc(100vw - 32px)); background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 24px; }
  h1 { margin: 0 0 16px; font-size: 20px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; border: 1px solid #bbb; border-radius: 6px; }
  button { margin-top: 12px; width: 100%; padding: 10px; font: inherit; font-weight: 600; color: #fff; background: #2e8b3e; border: 0; border-radius: 6px; cursor: pointer; }
  .err { margin: 0 0 12px; color: #b00; }
</style></head><body>
<form method="post" action="/login">
  <h1>Praline Scanner</h1>
  ${error ? `<p class="err">${error}</p>` : ""}
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Enter</button>
</form>
</body></html>`;

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
async function analyze(image, contentType) {
  const url = `${ENDPOINT}/contentunderstanding/analyzers/${ANALYZER_ID}:analyzeBinary?api-version=${API}`;
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
    counts,
    unknown: slots.filter(s => s.id === "Unknown").map(({ row, col, look }) => ({ row, col, look })),
    empty: slots.filter(s => s.id === "Empty").length,
  };
}

// ---------- server ----------
createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const html = "text/html; charset=utf-8";

    if (req.method === "GET" && (path === "/" || path === "/index.html"))
      return sessionOk(req) ? send(res, 200, PAGE, html) : send(res, 200, loginPage(), html);

    if (req.method === "GET" && DEMOS.has(path)) {
      if (!sessionOk(req)) return send(res, 401, { error: "Not logged in." });
      return send(res, 200, DEMOS.get(path), "image/jpeg");
    }

    if (req.method === "POST" && path === "/login") {
      if (!PASSWORD) return send(res, 303, "", html, { Location: "/" });
      if (loginLimited(clientIp(req))) return send(res, 429, loginPage("Too many attempts. Wait 15 minutes."), html);
      let form;
      try { form = new URLSearchParams((await readBody(req)).toString("utf8")); } catch { return send(res, 413, loginPage("Request too large."), html); }
      if (!passwordOk(form.get("password"))) return send(res, 401, loginPage("Wrong password."), html);
      return send(res, 303, "", html, { Location: "/", "Set-Cookie": sessionCookie(req) });
    }

    if (req.method === "GET" && path === "/logout")
      return send(res, 303, "", html, { Location: "/", "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });

    if (req.method === "POST" && path === "/analyze") {
      if (!sessionOk(req)) return send(res, 401, { error: "Not logged in. Reload the page and enter the password." });
      if (scanLimited(clientIp(req))) return send(res, 429, { error: "Too many scans this hour. Try again later." });
      const type = (req.headers["content-type"] || "").split(";")[0].toLowerCase();
      if (!ALLOWED_TYPES.has(type)) return send(res, 415, { error: `Unsupported image type: ${type || "none"}` });
      let image;
      try { image = await readBody(req); } catch { return send(res, 413, { error: "Photo is larger than 10 MB." }); }
      if (!image.length) return send(res, 400, { error: "No photo received." });
      const fields = await analyze(image, type);
      return send(res, 200, summarise(fields));
    }

    // Everything else (.env, scripts, results) is never served.
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 502, { error: err.message.slice(0, 400) });
  }
}).listen(PORT, () => console.log(`Praline scanner listening on port ${PORT}`));
