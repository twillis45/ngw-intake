// The relay against a fake Dropbox. Red-proofed both ways: the right request
// lands a file with the right name in the right folder; every wrong one is
// refused before Dropbox is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const calls = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  calls.push({ url: req.url, auth: req.headers.authorization, arg: req.headers["dropbox-api-arg"], len: body.length,
               form: req.headers["content-type"] === "application/x-www-form-urlencoded" ? body.toString() : null });
  const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/oauth2/token") {
    if (/grant_type=authorization_code/.test(body.toString())) {
      if (/code=GOOD/.test(body.toString())) return j({ access_token: "AT-x", refresh_token: "RT-" + "x".repeat(60), expires_in: 14400 });
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant", error_description: "code has expired" }));
    }
    if (/refresh_token=BAD/.test(body.toString())) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token is not valid" }));
    }
    return j({ access_token: "AT-1", expires_in: 14400 });
  }
  if (req.url === "/2/files/upload") {
    const a = JSON.parse(req.headers["dropbox-api-arg"]);
    return j({ name: a.path.split("/").pop(), path_display: a.path, size: body.length });
  }
  if (req.url === "/2/files/upload_session/start") return j({ session_id: "S1" });
  if (req.url === "/2/files/upload_session/append_v2") return j({});
  if (req.url === "/2/files/upload_session/finish") {
    const a = JSON.parse(req.headers["dropbox-api-arg"]);
    return j({ name: a.commit.path.split("/").pop(), path_display: a.commit.path, size: 0 });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => fake.listen(0, r));
const FAKE = "http://127.0.0.1:" + fake.address().port;

const PORT = 18000 + Math.floor(Math.random() * 1000);
const relay = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
  env: { ...process.env, PORT: String(PORT), DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s",
         DROPBOX_REFRESH_TOKEN: "r", RELAY_PASSCODE: "open-sesame", ALLOWED_ORIGIN: "https://twillis45.github.io",
         DROPBOX_FOLDER: "/Cory outreach recordings/", DROPBOX_OAUTH_BASE: FAKE, DROPBOX_CONTENT_BASE: FAKE,
         CHUNK_BYTES: "1024", MAX_BYTES: "4096" },
  stdio: ["ignore", "pipe", "pipe"],
});
const RELAY = "http://127.0.0.1:" + PORT;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(RELAY + "/health")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const post = (opts = {}) => fetch(RELAY + "/upload?name=" + (opts.name ?? "cory-outreach-answers.zip"), {
  method: "POST",
  headers: { Origin: opts.origin ?? "https://twillis45.github.io", "X-Passcode": opts.code ?? "open-sesame",
             "Content-Type": "application/zip" },
  body: opts.body ?? Buffer.alloc(300, 1),
});

test("health answers and preflight carries the page's origin only", async () => {
  const h = await fetch(RELAY + "/health");
  assert.equal(h.status, 200);
  const pre = await fetch(RELAY + "/upload", { method: "OPTIONS", headers: { Origin: "https://twillis45.github.io" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://twillis45.github.io");
  const other = await fetch(RELAY + "/upload", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("a small zip lands in one call, in the folder, with the name stamped", async () => {
  calls.length = 0;
  const r = await post();
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true);
  assert.match(j.path, /^\/Cory outreach recordings\/\d{8}T\d{6}Z-cory-outreach-answers\.zip$/);
  assert.ok(calls.some((c) => c.url === "/oauth2/token" && /grant_type=refresh_token/.test(c.form)), "refreshed a token");
  const up = calls.find((c) => c.url === "/2/files/upload");
  assert.ok(up, "used the single-call upload");
  assert.equal(up.len, 300);
  assert.equal(up.auth, "Bearer AT-1");
  assert.equal(JSON.parse(up.arg).autorename, true);
});

test("a big zip goes through an upload session, every byte accounted for", async () => {
  calls.length = 0;
  const r = await post({ body: Buffer.alloc(2600, 2) });
  assert.equal(r.status, 200);
  const seq = calls.filter((c) => c.url.startsWith("/2/files/upload_session")).map((c) => c.url.split("/").pop() + ":" + c.len);
  assert.deepEqual(seq, ["start:1024", "append_v2:1024", "finish:552"]);
  assert.ok(!calls.some((c) => c.url === "/2/files/upload"), "not the single call");
  assert.ok(calls.filter((c) => c.url === "/oauth2/token").length === 0, "the token was cached from the first test");
});

test("the wrong passcode, the wrong origin, an empty body and a huge body are all refused untouched", async () => {
  calls.length = 0;
  assert.equal((await post({ code: "nope" })).status, 403);
  assert.equal((await post({ code: "" })).status, 403);
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ body: Buffer.alloc(0) })).status, 400);
  assert.equal((await post({ body: Buffer.alloc(5000, 3) })).status, 413);
  assert.equal(calls.length, 0, "Dropbox was never called");
});

test("the file name is sanitized, never a path", async () => {
  calls.length = 0;
  const r = await post({ name: encodeURIComponent("../../etc/passwd zip") });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.path, /\/Cory outreach recordings\/\d{8}T\d{6}Z-......etc-passwd-zip$/);
});

test("the health check can try the token and report Dropbox's reason, and secrets are trimmed", async () => {
  const h = await (await fetch(RELAY + "/health?check=1")).json();
  assert.equal(h.dropboxAuth, "ok");
  assert.equal(h.appKeyEndsWith, "k");
  // A second relay with a bad token and a padded key: the key still works, the token's rejection is named.
  const PORT2 = PORT + 1;
  const bad = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT2), DROPBOX_APP_KEY: "  k\n", DROPBOX_APP_SECRET: "s",
           DROPBOX_REFRESH_TOKEN: "BAD", RELAY_PASSCODE: "x", DROPBOX_OAUTH_BASE: FAKE, DROPBOX_CONTENT_BASE: FAKE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch("http://127.0.0.1:" + PORT2 + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const r = await fetch("http://127.0.0.1:" + PORT2 + "/health?check=1");
  const j = await r.json();
  bad.kill();
  assert.equal(r.status, 503);
  assert.match(j.dropboxAuth, /^dropbox-auth 400 refresh token is not valid/);
  assert.equal(j.appKeyEndsWith, "k", "whitespace around a secret is trimmed");
});

test("the exchange turns a code into a refresh token, behind the passcode", async () => {
  const noKey = await fetch(RELAY + "/exchange?code=GOOD");
  assert.equal(noKey.status, 403);
  const bad = await (await fetch(RELAY + "/exchange?k=open-sesame&code=STALE")).json();
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "code has expired");
  const good = await (await fetch(RELAY + "/exchange?k=open-sesame&code=GOOD")).json();
  assert.equal(good.ok, true);
  assert.match(good.refresh_token, /^RT-x{60}$/);
});

test.after(() => { relay.kill(); fake.close(); });
