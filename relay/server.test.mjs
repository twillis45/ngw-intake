// The relay against a fake Dropbox. Red-proofed both ways: the right request
// lands a file with the right name in the right folder; every wrong one is
// refused before Dropbox is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const calls = [];
// The notify sink: everything the relay posts to NOTIFY_URL. `notifyMode`
// makes it misbehave on demand, because the property that matters is that a
// broken notification cannot break an upload.
const notified = [];
let notifyMode = "ok";   // "ok" | "500" | "hang"
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  // `calls` records DROPBOX traffic. /notify is not Dropbox, and it arrives
  // after the upload's receipt has already been sent — so counting it here
  // lets one test's notification land inside a later test's window and be
  // read as a Dropbox call that never happened. It records into `notified`.
  if (req.url !== "/notify") {
    calls.push({ url: req.url, auth: req.headers.authorization, arg: req.headers["dropbox-api-arg"], len: body.length,
                 form: req.headers["content-type"] === "application/x-www-form-urlencoded" ? body.toString() : null });
  }
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
  if (req.url === "/notify") {
    notified.push({ body: body.toString(), sig: req.headers["x-relay-signature"], ct: req.headers["content-type"],
                    title: req.headers["title"], priority: req.headers["priority"], tags: req.headers["tags"] });
    if (notifyMode === "hang") return;                 // never answers
    if (notifyMode === "500") { res.writeHead(500); return res.end("no"); }
    return j({ ok: true });
  }
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
         CHUNK_BYTES: "1024", MAX_BYTES: "4096",
         NOTIFY_URL: FAKE + "/notify", NOTIFY_SECRET: "sign-me", NOTIFY_TIMEOUT_MS: "400" },
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

// Wait for the notification, which is sent AFTER the receipt, so `await post()`
// resolves before it lands.
const settle = async (n = 1, ms = 3000) => {
  const until = Date.now() + ms;
  while (notified.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return notified.length >= n;
};

test("a landed file is announced, signed, with nothing secret in it", async () => {
  notifyMode = "ok";
  notified.length = 0;
  const r = await post({ body: Buffer.from("a zip") });
  assert.equal(r.status, 200);

  assert.ok(await settle(1), "nothing was posted to NOTIFY_URL");
  const [n] = notified;
  assert.equal(n.ct, "application/json");
  const p = JSON.parse(n.body);
  assert.equal(p.event, "upload");
  assert.match(p.path, /^\/Cory outreach recordings\/\d{8}T\d{6}Z-cory-outreach-answers\.zip$/);
  assert.equal(p.size, 5);
  assert.ok(!Number.isNaN(Date.parse(p.at)), "the timestamp does not parse");

  // Signed with NOTIFY_SECRET, so the far end can tell this from anyone who
  // guessed the URL.
  const expect = "sha256=" + crypto.createHmac("sha256", "sign-me").update(n.body).digest("hex");
  assert.equal(n.sig, expect);

  // NOTHING SECRET. The relay exists so the page never holds a credential,
  // and a webhook is one more place one could leak to.
  for (const secret of ["open-sesame", "sign-me", "DROPBOX", "Bearer", "AT-1", "refresh"]) {
    assert.ok(!n.body.includes(secret), `the notification carried ${secret}`);
  }
});

test("a notification that 500s does not change what the page was told", async () => {
  notifyMode = "500";
  notified.length = 0;
  const r = await post({ body: Buffer.from("a zip") });
  assert.equal(r.status, 200, "a failing webhook changed the upload's answer");
  assert.equal((await r.json()).ok, true);
  assert.ok(await settle(1), "the notification was never attempted");
});

test("a notification that HANGS does not hold the upload, and times out", async () => {
  // The one that would actually hurt: an endpoint that accepts the connection
  // and never answers. The receipt is sent before notify is called, so the
  // page is already done; the timeout is what stops the handler leaking.
  notifyMode = "hang";
  notified.length = 0;
  const t0 = Date.now();
  const r = await post({ body: Buffer.from("a zip") });
  const waited = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(waited < 2000, `the page waited ${waited}ms on a hanging webhook`);
  assert.ok(await settle(1), "the notification was never attempted");
  notifyMode = "ok";
});

test("with no NOTIFY_URL the relay posts nothing at all", async () => {
  // Off by default. A live service must not start calling a new host just
  // because it was redeployed.
  const { notify } = await import("./server.mjs");
  const before = notified.length;
  const out = await notify({ event: "upload" });
  assert.deepEqual(out, { sent: false, reason: "no NOTIFY_URL" });
  assert.equal(notified.length, before, "something was posted with NOTIFY_URL unset");
});

test("NOTIFY_STYLE=ntfy sends a sentence a phone can show, naming nobody", async () => {
  // A second relay, because the style is read once at start — which is the
  // point: a running service does not change how it talks mid-flight.
  notifyMode = "ok";
  notified.length = 0;
  const PORT3 = PORT + 2;
  const ntfy = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, PORT: String(PORT3), DROPBOX_APP_KEY: "k", DROPBOX_APP_SECRET: "s",
           DROPBOX_REFRESH_TOKEN: "r", RELAY_PASSCODE: "open-sesame", ALLOWED_ORIGIN: "https://twillis45.github.io",
           DROPBOX_FOLDER: "/Cory outreach recordings/", DROPBOX_OAUTH_BASE: FAKE, DROPBOX_CONTENT_BASE: FAKE,
           NOTIFY_URL: FAKE + "/notify", NOTIFY_SECRET: "sign-me", NOTIFY_TIMEOUT_MS: "400",
           NOTIFY_STYLE: "ntfy" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const BASE = "http://127.0.0.1:" + PORT3;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const r = await fetch(BASE + "/upload?name=cory-outreach-answers.zip", {
      method: "POST",
      headers: { Origin: "https://twillis45.github.io", "X-Passcode": "open-sesame", "Content-Type": "application/zip" },
      body: Buffer.alloc(2 * 1048576, 7),
    });
    assert.equal(r.status, 200);
    assert.ok(await settle(1), "nothing was posted to NOTIFY_URL");

    const [n] = notified;
    assert.match(n.ct, /^text\/plain/);
    assert.equal(n.title, "New intake recording");
    assert.equal(n.tags, "inbox_tray");
    assert.equal(n.body, "A recording landed — 2.0 MB. Open Dropbox to hear it.");

    // The topic is the only secret on public ntfy.sh and it caches what it is
    // sent, so the message must not spell out whose recording this is. The
    // file name and the Dropbox path both do; the size does not.
    for (const leak of ["cory", "Cory", "outreach", "Dropbox recordings", "/Cory"]) {
      assert.ok(!n.body.includes(leak), "the ntfy message leaks " + leak);
    }
    assert.ok(!/[\r\n]/.test(n.title), "a header value carries a newline");

    // Signed anyway: public ntfy ignores it, a private receiver can check it.
    assert.equal(n.sig, "sha256=" + crypto.createHmac("sha256", "sign-me").update(n.body).digest("hex"));
  } finally {
    ntfy.kill();
  }
});

test("a size reads as a size, at every scale and at the edges", async () => {
  const { humanSize } = await import("./server.mjs");
  assert.equal(humanSize(0), "0 bytes");
  assert.equal(humanSize(1), "1 byte");
  assert.equal(humanSize(999), "999 bytes");
  assert.equal(humanSize(1023), "1023 bytes");
  assert.equal(humanSize(1024), "1 KB");
  assert.equal(humanSize(1048575), "1024 KB");
  assert.equal(humanSize(1048576), "1.0 MB");
  assert.equal(humanSize(4404019), "4.2 MB");
  // A missing or nonsense size says so rather than printing "NaN MB".
  assert.equal(humanSize(undefined), "unknown size");
  assert.equal(humanSize(NaN), "unknown size");
  assert.equal(humanSize(-1), "unknown size");
});

test.after(() => { relay.kill(); fake.close(); });
