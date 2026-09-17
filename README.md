# ngw-intake

A one-page voice recorder for practitioner interviews. Someone opens the link,
taps record, answers a question out loud, and taps send. No account, no app, no
form.

Live at the repo's GitHub Pages URL.

## Why this repo is public

Free GitHub Pages requires it, and nothing here is sensitive: a page of
questions and a recorder. **Recordings never leave the viewer's device** — they
are held in their own browser's IndexedDB and handed to the operating system's
share sheet only when they tap send. Nothing is uploaded, and this repo has no
backend to upload to.

The planner that consumes the answers lives in a separate, private repo. Once an
interview is done, that playbook describes a real organization's internal
process and has no business on a public URL. Keeping the recorder here and the
answers there is the whole point of the split.

## It must be served over https

`getUserMedia` is refused outside a secure context. Pages serves https, so the
published URL works. Opening `index.html` from disk will render the page and the
record buttons will not work — that is the browser, not a bug.

## What it does and does not assume

Nothing about the viewer's device is taken on faith:

| Checked | Why |
|---|---|
| `isSecureContext`, `MediaRecorder` | States the reason instead of showing dead buttons |
| `MediaRecorder.isTypeSupported` | Safari records `audio/mp4`, Chrome and Firefox `audio/webm` |
| `navigator.canShare({files})` | Share sheet where there is one, file download where there isn't |
| `NotAllowedError` by name | A declined mic gets a route that doesn't need the mic |

Where recording cannot work at all, the page says so and points at the phone's
own voice memo app. **The questions are the deliverable; the recorder is a
convenience.** Nobody is blocked by a device that won't cooperate.

Clips persist in IndexedDB and are restored on a revisit, so a locked phone or a
stray reload does not eat a fifteen-minute answer. Every storage path swallows
its own failure — blocked or private-mode storage degrades to memory-only rather
than breaking recording.

One honest limit, stated on the page itself: iOS can cut a recording short if
the phone locks or the viewer switches apps. For long answers, the native voice
memo app is the safer bet.

## Editing the questions

The questions are a `QUESTIONS` array at the top of the inline script in
`index.html` — `group` starts a new section, `big` marks the ones that matter
most, `ask` and `why` are the copy. The page renders itself from that array, so
adding a question means adding an object, and the counter follows automatically.

## Deploying

Push to `main`. The workflow parses the inline script, confirms the capability
guards are still present, and publishes `index.html` alone. A page that does
nothing when it opens is worse than a page that ships a day later — the viewer
tries once and goes back to email.
