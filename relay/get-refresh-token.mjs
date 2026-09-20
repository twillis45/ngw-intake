// One-time: turn a Dropbox authorization code into the long-lived refresh
// token the relay needs. Run it on your own machine, never on the server.
//
//   node get-refresh-token.mjs APP_KEY APP_SECRET CODE
//
// It prints the refresh token once. Put it in Render as DROPBOX_REFRESH_TOKEN
// and do not keep it anywhere else.
const [key, secret, code] = process.argv.slice(2);
if (!key || !secret || !code) {
  console.error("usage: node get-refresh-token.mjs APP_KEY APP_SECRET CODE");
  process.exit(2);
}
const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: key, client_secret: secret }).toString(),
});
const j = await r.json();
if (!r.ok || !j.refresh_token) { console.error(JSON.stringify(j, null, 2)); process.exit(1); }
console.log(j.refresh_token);
