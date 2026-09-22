# The relay

The recordings page cannot write to Dropbox by itself, and must not carry
a key that could. This service holds the key. The page posts a zip to
`/upload`; the relay writes it into one Dropbox folder and answers with a
receipt. Nothing else is accepted.

No dependencies. `node server.mjs` runs it; `node --test` proves it against
a fake Dropbox.

## Set up once (about ten minutes)

1. **Dropbox app.** At https://www.dropbox.com/developers/apps create an app:
   Scoped access, **Full Dropbox**, any name. On the Permissions tab tick
   `files.content.write` only, then Submit. Note the App key and App secret
   from the Settings tab.
2. **Authorize it, offline.** Open, with your app key in place of `APP_KEY`:

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline
   ```

   Approve. Copy the code it shows.
3. **Refresh token.** Once the relay is deployed with the app key, secret
   and passcode (step 4 can come first; the refresh token can be filled in
   after), open in a browser, within a few minutes of getting the code:

   ```
   https://ngw-intake-relay.onrender.com/exchange?k=PASSCODE&code=CODE
   ```

   It answers with `refresh_token`, once. Or, on your own machine:

   ```
   node relay/get-refresh-token.mjs APP_KEY APP_SECRET CODE
   ```
4. **Render.** New → Blueprint, pick this repo; Render reads `render.yaml`.
   It asks for the four secrets: the app key, the app secret, the refresh
   token, and a passcode you invent (any long phrase; it goes in the link
   you send, nowhere else). Deploy. Note the service URL, for example
   `https://ngw-intake-relay.onrender.com`.
5. **The page.** If the URL differs from the one in `index.html`
   (`RELAY_URL`), change it there. Send Cory the page link with the passcode
   on it: `https://twillis45.github.io/ngw-intake/?k=THE-PASSCODE`. The page
   remembers it; later visits need no query.

## What the free plan means

Render spins a free service down after fifteen minutes idle; the first
request then takes up to a minute. The page pings `/health` as soon as it
loads with a passcode, so the relay is usually awake by the time he taps
send, and the page says "the first one can take a minute" while it waits.

## Getting told when one lands

The relay is the thing doing the upload, so it knows the moment a file
lands. Set `NOTIFY_URL` and it POSTs a notification; leave it unset and it
posts nothing, because a live service must not start calling a new host
just because it was redeployed.

| Variable | |
|---|---|
| `NOTIFY_URL` | Where to post. Unset means off. |
| `NOTIFY_STYLE` | `json` (default) or `ntfy`. |
| `NOTIFY_SECRET` | Optional. Signs the body as `X-Relay-Signature: sha256=…`. |
| `NOTIFY_TIMEOUT_MS` | Optional, defaults to 5000. |

The notification can never affect the upload. The receipt goes out first,
the notify call sits outside the upload's error path, and every failure
ends as a log line. A notification that 500s, hangs, or points at a host
that no longer resolves changes nothing the page was told.

Nothing secret is ever sent: no passcode, no token, no app secret. The
relay exists so the page never holds a credential, and a webhook is one
more place one could leak to.

### To a phone, with ntfy

Install [ntfy](https://ntfy.sh) on the phone, subscribe to one long random
topic, and set `NOTIFY_URL` to `https://ntfy.sh/THAT-TOPIC` with
`NOTIFY_STYLE=ntfy`. The phone buzzes with:

> **New intake recording**
> A recording landed — 2.0 MB. Open Dropbox to hear it.

**The topic name is the only secret.** Anyone who learns it can read
everything sent to that topic, and the public server caches messages for
hours. So treat the topic like the passcode: long, random, never in a
commit, never in a screenshot.

That is also why the ntfy message names no file and no folder. A file name
and a Dropbox path both spell out whose recording it is; a size does not,
and the next move is the same either way — open Dropbox. Run your own ntfy
server, or put a private receiver in front, and `NOTIFY_STYLE=json` gives
back the full record.

## What the relay refuses

Any origin but the page's, any request without the passcode, an empty
body, a body over `MAX_BYTES` (200 MB), and any path but `/upload` and
`/health`. Names are stripped to letters, digits, dot, dash and underscore
and stamped with the UTC time, so nothing a sender chooses can escape the
folder.
