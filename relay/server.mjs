// The relay: the one place a Dropbox credential lives. The recordings page
// posts a zip here; this writes it into Todd's Dropbox and answers with a
// receipt. No dependencies, so nothing here can drift under a lockfile.
//
// It accepts exactly one thing: a POST from the page's origin carrying the
// passcode, with a body under MAX_BYTES. Anything else gets a short no.

import http from "node:http";
import crypto from "node:crypto";

const env = process.env;
const PORT = Number(env.PORT) || 10000;
const ORIGIN = env.ALLOWED_ORIGIN || "https://twillis45.github.io";
const FOLDER = (env.DROPBOX_FOLDER || "/Cory outreach recordings").replace(/\/+$/, "");
const PASSCODE = env.RELAY_PASSCODE || "";
const MAX_BYTES = Number(env.MAX_BYTES) || 200 * 1024 * 1024;
// Dropbox's single-call upload takes up to 150 MB; anything over one chunk
// goes through an upload session so a long batch never trips that edge.
const CHUNK_BYTES = Number(env.CHUNK_BYTES) || 8 * 1024 * 1024;
const OAUTH_BASE = env.DROPBOX_OAUTH_BASE || "https://api.dropboxapi.com";
const CONTENT_BASE = env.DROPBOX_CONTENT_BASE || "https://content.dropboxapi.com";

const missing = ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REFRESH_TOKEN", "RELAY_PASSCODE"]
  .filter((k) => !env[k]);

// ---- Dropbox ------------------------------------------------------------
let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && cached.exp > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.DROPBOX_REFRESH_TOKEN,
    client_id: env.DROPBOX_APP_KEY,
    client_secret: env.DROPBOX_APP_SECRET,
  });
  const r = await fetch(OAUTH_BASE + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error("dropbox-auth " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 14400) * 1000 };
  return cached.token;
}

async function content(path, arg, bytes, token) {
  const r = await fetch(CONTENT_BASE + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify(arg),
    },
    body: bytes,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("dropbox " + path + " " + r.status + " " + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

async function putInDropbox(name, bytes) {
  const token = await accessToken();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = FOLDER + "/" + stamp + "-" + name;
  const commit = { path, mode: "add", autorename: true, mute: false };
  if (bytes.length <= CHUNK_BYTES) {
    return content("/2/files/upload", commit, bytes, token);
  }
  const first = bytes.subarray(0, CHUNK_BYTES);
  const start = await content("/2/files/upload_session/start", { close: false }, first, token);
  let offset = first.length;
  while (bytes.length - offset > CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + CHUNK_BYTES);
    await content("/2/files/upload_session/append_v2",
      { cursor: { session_id: start.session_id, offset }, close: false }, part, token);
    offset += part.length;
  }
  const last = bytes.subarray(offset);
  return content("/2/files/upload_session/finish",
    { cursor: { session_id: start.session_id, offset }, commit }, last, token);
}

// ---- HTTP ---------------------------------------------------------------
function cors(res, origin) {
  if (origin === ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Passcode");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;                      // keep draining so the 413 can be read
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error("too-large"), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  cors(res, origin);
  const url = new URL(req.url, "http://relay");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, missing.length ? 503 : 200, { ok: !missing.length, missing });
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/upload") { send(res, 404, { ok: false, error: "no" }); return; }
  if (missing.length) { send(res, 503, { ok: false, error: "relay-unconfigured", missing }); return; }
  if (origin !== ORIGIN) { send(res, 403, { ok: false, error: "origin" }); return; }
  const code = req.headers["x-passcode"] || url.searchParams.get("k") || "";
  if (!same(code, PASSCODE)) { send(res, 403, { ok: false, error: "passcode" }); return; }

  const name = (url.searchParams.get("name") || "upload.zip").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  let bytes;
  try { bytes = await readBody(req, MAX_BYTES); }
  catch (e) { send(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? "too-large" : "body" }); return; }
  if (!bytes.length) { send(res, 400, { ok: false, error: "empty" }); return; }

  try {
    const r = await putInDropbox(name, bytes);
    send(res, 200, { ok: true, name: r.name, path: r.path_display, size: r.size ?? bytes.length });
  } catch (e) {
    console.error(String(e && e.message || e));
    send(res, 502, { ok: false, error: /dropbox-auth/.test(String(e)) ? "dropbox-auth" : "dropbox" });
  }
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(PORT, () => {
    console.log("relay on " + PORT + (missing.length ? " (unconfigured: " + missing.join(", ") + ")" : ""));
  });
}
