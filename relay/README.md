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
3. **Refresh token.** On your own machine:

   ```
   node relay/get-refresh-token.mjs APP_KEY APP_SECRET CODE
   ```

   It prints the refresh token once.
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

## What the relay refuses

Any origin but the page's, any request without the passcode, an empty
body, a body over `MAX_BYTES` (200 MB), and any path but `/upload` and
`/health`. Names are stripped to letters, digits, dot, dash and underscore
and stamped with the UTC time, so nothing a sender chooses can escape the
folder.
