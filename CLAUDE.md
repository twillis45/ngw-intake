# ngw-intake

One page, `index.html`, served by GitHub Pages at
https://twillis45.github.io/ngw-intake/. It asks a practitioner the questions
that fill a planner in `ngw-program-planner`, and it takes the answers by
voice. A `relay/` service on Render holds the Dropbox credential so the page
never does.

Global preferences in `~/.claude/CLAUDE.md` apply here in full. This file adds
only what is specific to this repo.

## Language

**American English, everywhere.** Spelling, and dates as `September 22, 2026`,
never `22 September 2026`. This holds for page copy, comments, commit
messages, test names and demo fixtures alike — the fixtures are speech a
person is imagined saying, and they are written the way the reader spells.

The one exception is text quoted from a source. A quotation is reproduced
exactly as the source wrote it, British spelling included, because a quote
that has been tidied is no longer a quote. Quotations belong in the planner
repo's evidence store, not here; this repo holds none today.

## Before any push

The page is the only thing the practitioner ever sees. A broken one costs the
relationship, not a build.

```
node test/scorecard.mjs   # 28 design checks across 8 viewports
node test/e2e.mjs         # behaviour of the recorder, the ledger and the routes
```

Both must pass. The Pages workflow re-checks that the page parses and keeps
its capability guards, but it runs after the push, which is too late to be the
only check.

## Rules specific to this repo

**The page must work with nothing installed and no account.** Every route has
a fallback that needs neither: if the relay is asleep the Dropbox file request
takes over, if recording fails there is a typing box, if the share sheet is
missing there is a copy button.

**Never advise clearing website data.** Recordings live in the viewer's own
browser until they are uploaded. Clearing Safari's website data destroys
answers that have not been sent, which is the one irreversible thing a user
can do here.

**Credentials live in Render, never in the repo or the page.** The page
carries a passcode only when the link it was opened with carries one, and it
keeps that in `localStorage`. Anything that has passed through a chat
transcript is burned and must be rotated before the link goes out.

**The build stamp is load-bearing.** Pages caches for about ten minutes, so
`<p class="build">` is how a stale copy is told from a fresh one. Change it
whenever the questions change.
