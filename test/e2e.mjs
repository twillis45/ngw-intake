// Drives the real page in Chromium against a fake microphone.
// localhost is a secure context, so getUserMedia is allowed without TLS.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Chromium's fake microphone is silent by default, so a level meter would read
// zero whether or not it worked. Hand it a real tone instead, and keep a silent
// run at the end to prove the bar distinguishes the two.
function toneFile() {
  const rate = 48000, n = rate * 6, d = Buffer.alloc(44 + n * 2);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 2, 4); d.write('WAVE', 8);
  d.write('fmt ', 12); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20);
  d.writeUInt16LE(1, 22); d.writeUInt32LE(rate, 24); d.writeUInt32LE(rate * 2, 28);
  d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34);
  d.write('data', 36); d.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    d.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  }
  const f = path.join(os.tmpdir(), 'ngw-intake-tone.wav');
  fs.writeFileSync(f, d);
  return f;
}
const TONE = toneFile();

const PAGE = fileURLToPath(new URL('../index.html', import.meta.url));
const html = fs.readFileSync(PAGE);
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(8731);

// A stand-in for Todd's relay: it records what it was sent and answers as
// the real one does, and can be told to fail.
const relayHits = [];
const relayStub = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passcode');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  relayHits.push({ url: req.url, code: req.headers['x-passcode'] || '', origin, len: Buffer.concat(chunks).length });
  const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/health') return j(200, { ok: true });
  if (relayStub.fail) return j(502, { ok: false, error: 'dropbox' });
  if ((req.headers['x-passcode'] || '') !== 'open-sesame') return j(403, { ok: false, error: 'passcode' });
  j(200, { ok: true, name: '20260920T050000Z-cory-outreach-answers.zip', path: '/Cory outreach recordings/x.zip', size: 1 });
}).listen(8737);

const fail = [];
const ok = (cond, label) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) fail.push(label);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--use-file-for-fake-audio-capture=' + TONE],
});
const ctx = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto('http://localhost:8731/', { waitUntil: 'load' });

// Only the open question shows its controls. To press a closed question's
// Record, open its row first, the way he would.
const tap = async (pg, id, opts) => {
  const mic = pg.locator('#mic-' + id);
  if (!(await mic.isVisible())) {
    await pg.locator('article.q:has(#mic-' + id + ') summary').click();
    await pg.waitForTimeout(60);   // the toggle event that marks it open is queued, not sync
  }
  await mic.click(opts);
};
const isOpen = (c) => c.evaluate((e) => e.classList.contains('open'));
const open = async (c) => { if (!(await isOpen(c))) { await c.locator('summary').click(); await page.waitForTimeout(60); } };
const record = async (id, ms) => {
  await tap(page, id);
  await page.waitForTimeout(ms);
  await page.locator('#mic-' + id).click();
  await page.waitForTimeout(900);
};
const card = (n) => page.locator('article.q').nth(n);
// The count the page promises in its header and ledger. One place, so adding
// a question is a one-line change here and the rest of the run follows.
const N = 22;

console.log('\n=== at rest ===');
ok((await page.locator('article.q').count()) === N, `${N} question cards`);
ok((await page.locator('#fig-answered').textContent()) === `0/${N}` &&
   (await page.locator('#fig-clips').textContent()) === '0', 'ledger reads zero');
ok(/Nothing recorded or typed on this page yet/.test(await page.locator('#tally').textContent()),
   'and the line says what that means, naming both ways to answer');
ok(!(await page.locator('#sendall').isVisible()), 'Send all hidden');
ok((await page.locator('article.q audio:visible').count()) === 0, 'no dead audio players');
const nums = await page.locator('.qnum').allTextContents();
ok(nums.join(',') === Array.from({ length: N }, (_, i) => String(i + 1).padStart(2, '0')).join(','),
   `margin numbers run 01..${N} in order`);

console.log('\n=== attention: one open question, the rest an index ===');
ok((await page.locator('article.q.open').count()) === 1 && await isOpen(card(0)),
   'exactly one question is open at rest, and it is the first');
ok(/Start with 01/.test(await page.locator('#next').textContent()),
   'the whisper says where to start');
ok(!(await page.locator('#mic-q4').isVisible()) && !(await card(3).locator('.why').isVisible()),
   'a closed question shows its line and nothing else');
ok(await card(3).locator('summary').evaluate((s) => s.getBoundingClientRect().height >= 44),
   'the closed row is a full-height tap target');
await card(3).locator('summary').click();
await page.waitForTimeout(60);
ok((await isOpen(card(3))) && !(await isOpen(card(0))), 'opening another question closes the first');
ok(await page.locator('#mic-q4').isVisible(), 'and shows its controls');
ok(/you\u2019re on 04/.test(await page.locator('#next').textContent()),
   'the whisper follows him');
await card(0).locator('summary').click();
await page.waitForTimeout(60);
ok((await isOpen(card(0))) && !(await isOpen(card(3))), 'and back again');
// The fill leaves a closed button over 150ms; count accents once it has gone.
await page.waitForTimeout(250);
ok(await page.locator('#forward').evaluate((e) => !e.querySelector('details').open),
   'the forward-first card folds to one line');
ok(await page.locator('.how .lead').isVisible() && !(await page.locator('.how details').evaluate((d) => d.open)),
   'the how-to shows its lead and three lines, with the rest folded');
ok(await page.evaluate(() => {
     const how = document.querySelector('.how').getBoundingClientRect();
     const first = document.querySelector('article.q').getBoundingClientRect();
     return how.bottom <= first.top;
   }), 'the instructions come before the first question');

console.log('\n=== copy ===');
const how = await page.locator('.how').textContent();
ok(/No names, no numbers, no labeling/.test(how), 'asks for no labeling (US spelling)');
ok(!/say the question number/i.test(how), 'never asks him to speak a number');
ok(/skip the list/.test(how), 'the one-long-recording option is offered');
ok(/stays in this browser on this phone/.test(how), 'says where recordings live');
const tallynote = (await page.locator('.tallynote').allTextContents()).join(' ');
ok(/Recording in Voice Memos instead/.test(tallynote), 'tally explains it cannot see Voice Memos');
// A zero after switching browsers reads as lost work unless the page says otherwise.
ok(/on this page, in this browser/.test(tallynote), 'and that it only counts this browser');

// Everything else here is optional. This line is the job, so it has to survive
// scrolling — it is the only instruction he needs if he reads nothing else.
const standing = page.locator('#standing');
ok(await standing.isVisible(), 'the standing line is up without scrolling');
const stand = await standing.textContent();
ok(/Voice Memos/.test(stand) && /432-5650/.test(stand), 'it carries the whole instruction');
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(250);
ok(await standing.isVisible(), 'and is still up at the bottom of the page');
ok(await page.evaluate(() => {
     const bar = document.getElementById('standing').getBoundingClientRect();
     const last = document.querySelector('.contact').getBoundingClientRect();
     return last.bottom <= bar.top + 1;
   }), 'it does not sit on top of the last line of the page');
await page.evaluate(() => window.scrollTo(0, 0));
const contact = page.locator('#contact-me');
ok(/Text me/.test(await page.locator('.contact').textContent()), 'a way to reach him exists');
// A placeholder shipping to him would be worse than no contact line at all.
const href = await contact.getAttribute('href');
ok(/^sms:\+1\d{10}$/.test(href), `the number is a real tappable sms link (${href})`);
ok(!/ADD YOUR|PLACEHOLDER|\[/.test(await contact.textContent()),
   'no placeholder left in the contact line');
ok(href.replace(/\D/g, '').endsWith((await contact.textContent()).replace(/\D/g, '')),
   'the displayed number and the link agree');

console.log('\n=== guidelines ===');
ok((await page.locator('h1').count()) === 1, 'exactly one h1');
// A JS escape written into markup renders literally — invisible to a parse
// check, obvious to anyone looking at the page.
const bodyText = await page.locator('body').innerText();
ok(!/\\u[0-9a-f]{4}/i.test(bodyText), 'no literal \\uXXXX anywhere on the rendered page');
ok((await page.locator('#tally').getAttribute('aria-live')) === 'polite', 'tally is announced');
ok(await page.locator('button').first().evaluate((b) => getComputedStyle(b).touchAction === 'manipulation'),
   'buttons set touch-action: manipulation');
ok(await page.locator('#mic-q1').evaluate((b) => parseFloat(getComputedStyle(b).minHeight) >= 44),
   'tap targets at least 44px');
// UX_04 4.4: content lives in containers. The previous build asserted the
// reverse — "no panels, cards or tinted blocks" — which is exactly why it
// read flat. The assertion inverts rather than disappears.
ok((await page.locator('.q').count()) === N &&
   await card(0).evaluate((e) => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'),
   'every question sits on its own card surface');
// UX_02: the accent marks ONE primary target per view, and only interactives.
const steel = await page.evaluate(() => {
  const want = getComputedStyle(document.documentElement).getPropertyValue('--steel').trim().toLowerCase();
  const hex = (x) => '#' + (x.match(/\d+/g) || []).slice(0, 3)
    .map((n) => (+n).toString(16).padStart(2, '0')).join('');
  const hit = [...document.querySelectorAll('.board *')]
    .filter((e) => e.offsetParent !== null && hex(getComputedStyle(e).backgroundColor) === want);
  return { n: hit.length, allButtons: hit.every((e) => e.tagName === 'BUTTON') };
});
ok(steel.n === 1, `the accent marks exactly one target (${steel.n})`);
ok(steel.allButtons, 'and what it marks is interactive, never decoration');
// UX_04: the priority lane must not look like the rest of the list.
ok(await page.evaluate(() => {
     const a = getComputedStyle(document.querySelector('.q.big'));
     const b = getComputedStyle(document.querySelector('.q:not(.big)'));
     return a.backgroundColor !== b.backgroundColor || a.borderLeftColor !== b.borderLeftColor;
   }), 'the priority lane is visually distinct from the main list');

console.log('\n=== recording: the state machine ===');
await tap(page, 'q1');
await page.waitForTimeout(700);
ok((await page.locator('#mic-q1').textContent()) === 'Stop', 'button reads Stop while live');
ok(await page.locator('#mic-q4').isDisabled(), 'other questions disabled while one records');
ok(await card(0).locator('.keepon').isVisible(), 'screen-lock line shows where it applies');
ok(/stops and keeps what you said/.test(await card(0).locator('.keepon').textContent()),
   'it describes what the page does, not only what could go wrong');
// Live evidence about the recorder's own stream.
ok(await card(0).locator('.level').isVisible(), 'the level meter is up while recording');
ok(await card(0).locator('.level i').evaluate((e) => parseFloat(e.style.width) > 0),
   'the meter actually moves on the fake device');
await page.waitForTimeout(900);
await tap(page, 'q1');
await page.waitForTimeout(900);
ok(!(await page.locator('#mic-q4').isDisabled()), 'others re-enabled after stop');
ok(await card(0).locator('.keepon').isHidden(), 'line hidden again');
ok(await card(0).locator('.level').isHidden(), 'meter torn down with the recorder');
ok((await card(0).locator('.clip').count()) === 1, 'one clip filed');

// The race the old build lost an answer to: start a second question while the
// first is still live. The first must file, the second must be fully operable.
console.log('\n=== the race: switching questions mid-recording ===');
await tap(page, 'q2');
await page.waitForTimeout(800);
// The guard is the fix: q5 is disabled, so the tap that used to silently end
// q2's recording cannot land at all. Force it anyway to prove nothing happens.
ok(await page.locator('#mic-q5').isDisabled(), 'q5 locked out while q2 holds the mic');
await tap(page, 'q5', { force: true }).catch(() => {});
await page.waitForTimeout(900);
ok((await page.locator('#mic-q2').textContent()) === 'Stop', 'q2 still recording, not orphaned');
ok(await isOpen(card(1)), 'a recording question is never folded away by opening another');
await card(1).locator('summary').click();
await page.waitForTimeout(60);
ok((await isOpen(card(1))) && await page.locator('#mic-q2').isVisible(),
   'nor by a tap on its own row: Stop stays on screen while the mic is hot');
const t = await card(1).locator('.time').first().textContent();
ok(/^0:0[0-9]$/.test(t), `q2 timer still running (${t})`);
await tap(page, 'q2');
await page.waitForTimeout(900);
ok((await card(1).locator('.clip').count()) === 1, 'q2 filed its recording');
ok((await page.locator('#mic-q2').textContent()) === 'Add another', 'q2 button recovered');
ok((await card(4).locator('.clip').count()) === 0, 'q5 never started, so nothing is half-filed');

console.log('\n=== double-tap cannot orphan a recorder ===');
// A real double-tap fires both in one tick — Playwright's click auto-waits for
// the button to re-enable, which would make this a stop instead. Dispatch raw.
await page.evaluate(() => {
  const b = document.getElementById('mic-q3');
  b.click(); b.click();
});
await page.waitForTimeout(1600);
ok((await page.locator('#mic-q3').textContent()) === 'Stop',
   'one recording started, not two');
await tap(page, 'q3');
await page.waitForTimeout(1000);
const q3clips = await card(2).locator('.clip').count();
ok(q3clips === 1, `double-tap yields exactly one clip (got ${q3clips})`);
ok((await page.locator('#mic-q3').textContent()) === 'Add another', 'q3 button recovered');
ok(!(await page.locator('#mic-q1').isDisabled()), 'no recorder left holding the lock');

console.log('\n=== add, delete, persist ===');
await record('q1', 1100);
ok((await card(0).locator('.clip').count()) === 2, 'Add another appends, never replaces');

const del = card(0).locator('.clip').first().locator('button.danger');
await del.click();
await page.waitForTimeout(200);
ok((await del.textContent()) === 'Delete for good?', 'first tap arms rather than deletes');
ok((await card(0).locator('.clip').count()) === 2, 'nothing deleted on the first tap');
await del.click();
await page.waitForTimeout(400);
ok((await card(0).locator('.clip').count()) === 1, 'second tap deletes');
ok((await card(0).locator('.clip .part').first().textContent()) === 'Part 1', 'survivor renumbered');

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1100);
ok((await page.locator('#fig-answered').textContent()) === `3/${N}`, 'restored after reload');
ok((await page.locator('article.q.open').count()) === 1 && !(await isOpen(card(0))) &&
   await isOpen(card(3)),
   'after reload the open question is the first one without an answer');
ok(new RegExp(`3 of ${N} set`).test(await page.locator('#next').textContent()),
   'and the whisper counts what is set');

ok(!(await page.locator('#restorefail').isVisible()), 'no false restore-failure banner');

// The page warns that a screen lock can cut a recording off. Warning is not
// handling — this is the handling.
console.log('\n=== backgrounding files the answer instead of losing it ===');
await tap(page, 'q6');
await page.waitForTimeout(1300);
ok((await page.locator('#mic-q6').textContent()) === 'Stop', 'q6 is live');
// Stand in for the signal iOS sends on lock or app switch. The handler reads
// document.visibilityState, so that is what gets stubbed — not the handler.
const visibility = (state) => page.evaluate((v) => {
  Object.defineProperty(document, 'visibilityState', { get: () => v, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);
await visibility('hidden');
await page.waitForTimeout(1000);
ok((await page.locator('#mic-q6').textContent()) === 'Add another', 'the recorder stopped itself');
ok((await card(5).locator('.clip').count()) === 1, 'and what he had already said was filed');
ok(!(await page.locator('#mic-q1').isDisabled()), 'the mic lock was released');
await visibility('visible');

console.log('\n=== Send all offers only what has not gone ===');
ok((await page.locator('#sendall').textContent()) === 'Text all 4 to Todd',
   'four recordings, four to send');
await page.evaluate(() => {
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});
await open(card(0));
await card(0).locator('.clip').first().locator('button.send').click();
await page.waitForTimeout(500);
ok((await card(0).locator('.clip').first().locator('.flag').textContent()) === 'Handed off',
   'the badge says handed off, never sent');
ok(/check the message actually went/.test(await card(0).locator('.note').first().textContent()),
   'and the one thing the page cannot know is asked of him, per clip');
ok((await page.locator('#sendall').textContent()) === 'Text all 3 to Todd',
   'Send all stops offering a recording that already went');

console.log('\n=== a download is a request, not a receipt ===');
await page.evaluate(() => {
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
});
await open(card(1));
await card(1).locator('.clip').first().locator('button.send').click();
await page.waitForTimeout(600);
ok((await card(1).locator('.clip').first().locator('.flag').textContent()) === 'Not sent',
   'the fallback never claims the file was saved, let alone sent');
ok(/nothing has been sent yet/.test(await card(1).locator('.note').first().textContent()),
   'the note is conditional about the save and flat about the send');
ok((await page.locator('#sendall').textContent()) === 'Text all 3 to Todd',
   'a download did not quietly count as sent');

console.log('\n=== the zip holds everything and hands nothing off ===');
const [allzip] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadall').click()]);
await page.waitForTimeout(600);
ok(allzip.suggestedFilename() === 'cory-outreach-answers.zip', 'one file');
ok(/Saved one file with 4 items/.test(await page.locator('#sendall-err').textContent()),
   'it holds all four recordings, the one already handed off included');
ok((await page.locator('#sendall').textContent()) === 'Text all 3 to Todd',
   'and Send all still offers the three that have not gone');
ok((await card(0).locator('.clip').first().locator('.flag').textContent()) === 'Handed off',
   'a handed-off clip keeps its badge');
ok((await card(1).locator('.clip').first().locator('.flag').textContent()) === 'Saved to phone',
   'an unsent one says saved to phone');
ok(/still has to reach Todd/.test(await page.locator('#tally').textContent()),
   'and the tally says the file has not reached anyone');

console.log('\n=== a clip that cannot be restored is never silent ===');
await page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => {
    const tx = r.result.transaction('clips', 'readwrite');
    tx.objectStore('clips').put({ ms: 1000 }, 'q9::1');   // no blob
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  };
  r.onerror = () => rej(r.error);
}));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1300);
ok(await page.locator('#restorefail').isVisible(),
   'the banner is up for a stored clip that could not be read back');
ok((await card(8).locator('.clip').count()) === 0, 'and nothing was invented in its place');
ok((await card(0).locator('.clip').first().locator('.flag').textContent()) === 'Handed off',
   'the handed-off mark survived the reload');
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => {
    const tx = r.result.transaction('clips', 'readwrite');
    tx.objectStore('clips').delete('q9::1');
    tx.oncomplete = res; tx.onerror = res;
  };
  r.onerror = res;
}));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1300);
ok(!(await page.locator('#restorefail').isVisible()), 'banner gone once the store reads clean');

console.log('\n=== typing is offered on every question ===');
const boxes = await page.locator('.qbody > .typed textarea').all();
ok(boxes.length === N, `every question offers typing as well as recording (${boxes.length})`);
// The page must not tell him not to do the thing it offers.
const h1 = await page.locator('h1').textContent();
ok(!/don\u2019t type|don't type/i.test(h1), `the title does not contradict the typing box (${h1})`);
ok(/Type it instead/.test(await page.locator('.how').textContent()),
   'and the instructions mention typing as a real option');

console.log('\n=== a silent microphone is called out, not filed as an answer ===');
const deaf = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  // no --use-file-for-fake-audio-capture, so the fake device emits silence
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const dctx = await deaf.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const dp2 = await dctx.newPage();
await dp2.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(dp2, 'q1');
await dp2.waitForTimeout(5200);
const warned = await dp2.locator('article.q').first().locator('.err:visible, .note:visible').first();
const liveWarn = await warned.count() ? await warned.textContent() : '';
ok(/isn\u2019t picking anything up|picking anything up/.test(liveWarn),
   'it says so within a few seconds, not after twenty minutes');
await tap(dp2, 'q1');
await dp2.waitForTimeout(1200);
ok((await dp2.locator('article.q').first().locator('.clip').count()) === 1,
   'the recording is still kept — his call, not mine');
const noteCount = await dp2.locator('article.q').first().locator('.clip .note').count();
const clipNote = noteCount
  ? await dp2.locator('article.q').first().locator('.clip .note').first().textContent() : '';
ok(noteCount === 1 && /No sound on this one/.test(clipNote),
   `the clip itself is marked as empty (${noteCount} marks: "${clipNote.slice(0, 40)}")`);
ok((await dp2.locator('#fig-answered').textContent()) === `0/${N}`,
   'a silent recording does not count as an answer given');
await deaf.close();

// And with real sound present, none of that fires.
console.log('\n=== and a real recording is left alone ===');
const heard2 = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const hp2 = await heard2.newPage();
await hp2.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(hp2, 'q1');
await hp2.waitForTimeout(5200);
const noFalse = await hp2.locator('article.q').first().locator('.err:visible').count();
ok(noFalse === 0, 'no silence warning while the microphone is working');
await tap(hp2, 'q1');
await hp2.waitForTimeout(1200);
ok((await hp2.locator('article.q').first().locator('.clip .note').count()) === 0,
   'and the clip is not marked empty');
ok((await hp2.locator('#fig-answered').textContent()) === `1/${N}`,
   'a real recording counts as an answer');
await heard2.close();

console.log('\n=== a recording is sized for sending ===');
const bit = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const bp = await bit.newPage();
await bp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(bp, 'q1');
await bp.waitForTimeout(6000);
await tap(bp, 'q1');
await bp.waitForTimeout(1200);
const weight = await bp.evaluate(async () => {
  const a = document.querySelector('article.q audio');
  const blob = await fetch(a.src).then((r) => r.blob());
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  return { bytes: blob.size, secs: buf.duration };
});
const kbps = (weight.bytes * 8) / weight.secs / 1000;
ok(kbps < 60, `speech is recorded at a sendable rate (${Math.round(kbps)} kbps)`);
const perTwenty = (weight.bytes / weight.secs) * 1200 / 1024 / 1024;
ok(perTwenty < 8, `twenty minutes would weigh ${perTwenty.toFixed(1)} MB, not 18`);
ok(/\d+ (KB|MB|B)/.test(await bp.locator('#downloadall').textContent()),
   'and the button says what the bundle weighs before he sends it');
ok(await bp.locator('#sizewarn').isHidden(), 'no size warning while it is small');
await bit.close();

// The warning branch, without recording for four minutes: a stubbed recorder
// that hands back a blob too big for a text message.
const big = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
await big.addInitScript(() => {
  const Real = window.MediaRecorder;
  function Fat(stream, opts) {
    const r = new Real(stream, opts);
    const origStop = r.stop.bind(r);
    r.stop = function () {
      // one and a half megabytes, which no carrier MMS will take
      r.dispatchEvent(new BlobEvent('dataavailable',
        { data: new Blob([new Uint8Array(1500 * 1024)], { type: 'audio/mp4' }) }));
      origStop();
    };
    return r;
  }
  Fat.isTypeSupported = Real.isTypeSupported.bind(Real);
  window.MediaRecorder = Fat;
});
const gp = await big.newPage();
await gp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(gp, 'q1');
await gp.waitForTimeout(1200);
await tap(gp, 'q1');
await gp.waitForTimeout(1400);
const warn = gp.locator('#sizewarn');
ok(await warn.isVisible(), 'a bundle too big for a text message says so');
const wt = await warn.textContent();
ok(/MB/.test(wt) && /text message/.test(wt),
   'and names the weight and the limit rather than just failing later');
ok(/iMessage|Google Messages|email/.test(wt), 'and says what will carry it instead');
await big.close();

console.log('\n=== typing is a first-class answer ===');
const typ = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, acceptDownloads: true });
await typ.addInitScript(() => {
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
});
const tp = await typ.newPage();
await tp.goto('http://localhost:8731/', { waitUntil: 'load' });
const ANSWER = 'The facility manager signs off, and it comes down to staffing on the day.';
ok(await tp.locator('#text-q1').isHidden(), 'the typing box stays out of the way until asked for');
await tp.locator('article.q').first().locator('button.typebtn').click();
ok(await tp.locator('#text-q1').isVisible(), 'tapping Type it instead opens a box');
ok((await tp.locator('label[for="text-q1"]').count()) === 1, 'the box has a real label above it');
ok(await tp.locator('#text-q1').evaluate((e) => {
     const bg = getComputedStyle(e).backgroundColor;
     return bg !== 'rgb(255, 255, 255)' && bg !== 'rgba(0, 0, 0, 0)';
   }), 'and it is a dark recessed field, not a white box');
await tp.locator('#text-q1').fill(ANSWER);
await tp.waitForTimeout(900);
ok(/Saved on this device/.test(await tp.locator('article.q').first().locator('.state').textContent()),
   'it saves as he types, with no Save button to forget');
ok((await tp.locator('#fig-answered').textContent()) === `1/${N}`,
   'a typed answer counts as answered');
ok(/typed answer/.test(await tp.locator('#tally').textContent()),
   'and the tally says so in words');

await tp.reload({ waitUntil: 'load' });
await tp.waitForTimeout(1300);
ok((await tp.locator('#text-q1').inputValue()) === ANSWER, 'it survives closing the page');
ok(/Typed/.test(await tp.locator('article.q').first().locator('.qstate').textContent()),
   'the folded row says it holds a typed answer');
ok(await isOpen(tp.locator('article.q').nth(1)), 'and the spotlight has moved on to the next');
await tp.locator('article.q').first().locator('summary').click();
await tp.waitForTimeout(60);
ok(await tp.locator('#text-q1').isVisible(), 'opening it shows the box with his words');
ok(!(await tp.locator('#restorefail').isVisible()),
   'a typed answer is never mistaken for a broken recording');

ok(await tp.locator('#downloadall').isVisible(), 'a typed-only page still has a way to send');
const [tzip] = await Promise.all([tp.waitForEvent('download'), tp.locator('#downloadall').click()]);
const tzPath = path.join(os.tmpdir(), 'ngw-typed.zip');
await tzip.saveAs(tzPath);
const tb = fs.readFileSync(tzPath);
const te = tb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const tcount = tb.readUInt16LE(te + 10);
ok(tcount === 1, `the bundle carries the typed answer (${tcount} entry)`);
ok(tb.includes(Buffer.from(ANSWER, 'utf8')), 'and his actual words are inside it');
ok(tb.includes(Buffer.from('cory-q1-typed.txt', 'utf8')),
   'named so it is obvious which question it answers');

// Emptying the box must clear the answer, not leave a ghost counted forever.
await tp.locator('#text-q1').fill('');
await tp.waitForTimeout(900);
ok((await tp.locator('#fig-answered').textContent()) === `0/${N}`,
   'clearing the box un-answers the question');
await typ.close();

console.log('\n=== there is a route out of every browser ===');
const noshare = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, acceptDownloads: true });
await noshare.addInitScript(() => {
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
});
const np2 = await noshare.newPage();
await np2.goto('http://localhost:8731/', { waitUntil: 'load' });
for (const q of ['q1', 'q4']) {
  await tap(np2, q);
  await np2.waitForTimeout(1100);
  await tap(np2, q);
  await np2.waitForTimeout(800);
}
ok(!(await np2.locator('#sendall').isVisible()),
   'no share button is offered where the browser cannot share files');
const dlBtn = np2.locator('#downloadall');
ok(await dlBtn.isVisible(), 'the one-file route is offered instead');
ok(/Save all 2 as one file/.test(await dlBtn.textContent()),
   'and it counts what it will pack');
ok(await dlBtn.evaluate((e) => e.className === 'send'),
   'where it is the only route, it carries the accent as the primary action');
const [zip] = await Promise.all([np2.waitForEvent('download'), dlBtn.click()]);
const zipPath = path.join(os.tmpdir(), 'ngw-e2e-answers.zip');
await zip.saveAs(zipPath);
ok(zip.suggestedFilename() === 'cory-outreach-answers.zip',
   `the file is named for what it is (${zip.suggestedFilename()})`);

// Parse it here rather than trusting the writer that produced it.
const zb = fs.readFileSync(zipPath);
const eocd = zb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
ok(eocd > 0, 'the file ends with a real end-of-central-directory record');
const count = zb.readUInt16LE(eocd + 10);
const cdOff = zb.readUInt32LE(eocd + 16);
ok(count === 2, `it holds the two recordings (${count} entries)`);
const zipNames = [];
let o = cdOff;
for (let i = 0; i < count; i++) {
  ok(zb.readUInt32LE(o) === 0x02014b50, 'central directory entry ' + i + ' is well formed');
  const nlen = zb.readUInt16LE(o + 28);
  zipNames.push(zb.toString('utf8', o + 46, o + 46 + nlen));
  o += 46 + nlen + zb.readUInt16LE(o + 30) + zb.readUInt16LE(o + 32);
}
ok(zipNames.every((n) => !n.endsWith('.m4a')),
   `Chrome never ships Opus inside an .m4a (${zipNames.join(', ')})`);
ok(zipNames.filter((n) => n.endsWith('.m4a') || n.endsWith('.webm')).length === 2 &&
   zipNames.filter((n) => n.endsWith('.txt')).length === 0,
   `the audio travels and nothing else is invented beside it (${zipNames.join(', ')})`);
// Every stored entry's CRC must match its bytes, or the archive opens empty.
let crcOk = true;
o = cdOff;
const table = (() => { const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t; })();
const crc32 = (buf) => { let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0; };
for (let i = 0; i < count; i++) {
  const want = zb.readUInt32LE(o + 16), size = zb.readUInt32LE(o + 24);
  const lo = zb.readUInt32LE(o + 42);
  const dataAt = lo + 30 + zb.readUInt16LE(lo + 26) + zb.readUInt16LE(lo + 28);
  if (crc32(zb.subarray(dataAt, dataAt + size)) !== want) crcOk = false;
  o += 46 + zb.readUInt16LE(o + 28) + zb.readUInt16LE(o + 30) + zb.readUInt16LE(o + 32);
}
ok(crcOk, 'every entry\'s checksum matches its bytes — the archive really opens');
ok(/Saved one file/.test(await np2.locator('#sendall-err').textContent()),
   'and he is told where it went and that nothing left the device');
await noshare.close();

// Where sharing does work, the share sheet leads and the zip is the fallback.
const yesshare = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
await yesshare.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});
const yp = await yesshare.newPage();
await yp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(yp, 'q1');
await yp.waitForTimeout(1100);
await tap(yp, 'q1');
await yp.waitForTimeout(800);
ok(await yp.locator('#sendall').isVisible(), 'the share route leads where it exists');
ok(await yp.locator('#downloadall').evaluate((e) => e.className === 'second'),
   'and the one-file route steps back to secondary');
await yesshare.close();

console.log('\n=== typed answers are counted, sent and marked like clips ===');
const tsc = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
await tsc.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});
const ts = await tsc.newPage();
await ts.goto('http://localhost:8731/', { waitUntil: 'load' });
await ts.locator('article.q').first().locator('button.typebtn').click();
await ts.locator('#text-q1').fill('The facility manager signs off.');
await ts.waitForTimeout(900);
ok(await ts.locator('#sendall').isVisible() && (await ts.locator('#sendall').textContent()) === 'Text it to Todd',
   'one typed answer is one thing to send, and the button says so');
await ts.locator('#sendall').click();
await ts.waitForTimeout(500);
ok(await ts.locator('#sendall').isHidden(), 'once it went, nothing is offered again');
ok(/handed off/.test(await ts.locator('#tally').textContent()), 'and the tally says it went');
await ts.reload({ waitUntil: 'load' });
await ts.waitForTimeout(1300);
ok(await ts.locator('#sendall').isHidden(), 'the mark survives a reload');
await ts.locator('article.q').first().locator('summary').click();
await ts.waitForTimeout(60);
await ts.locator('#text-q1').fill('The facility manager signs off, and staffing decides.');
await ts.waitForTimeout(900);
ok(await ts.locator('#sendall').isVisible(), 'editing the answer makes it sendable again');

console.log('\n=== a typed sentence is saved when the page goes away ===');
await ts.locator('#text-q1').fill('The facility manager signs off, and staffing decides, always.');
await ts.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
const stored = await ts.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => {
    const g = r.result.transaction('clips').objectStore('clips').get('text::q1');
    g.onsuccess = () => res(g.result && g.result.text);
  };
}));
ok(stored === 'The facility manager signs off, and staffing decides, always.',
   'the 400ms timer is flushed on hide, not left for iOS to freeze');
await tsc.close();

console.log('\n=== a key from a question this build no longer has ===');
const orph = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
const op = await orph.newPage();
await op.goto('http://localhost:8731/', { waitUntil: 'load' });
await op.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => {
    const tx = r.result.transaction('clips', 'readwrite');
    tx.objectStore('clips').put({ blob: new Blob([new Uint8Array(64)]), type: 'audio/webm', ms: 900 }, 'q99::1');
    tx.oncomplete = res;
  };
}));
await op.reload({ waitUntil: 'load' });
await op.waitForTimeout(1300);
ok(await op.locator('#restorefail').isHidden(), 'it is not reported as a broken recording');
const gone = await op.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => { const g = r.result.transaction('clips').objectStore('clips').get('q99::1'); g.onsuccess = () => res(g.result === undefined); };
}));
ok(gone, 'and it is cleared rather than reported forever');
await orph.close();

console.log('\n=== the live button keeps its label ===');
const lbl = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
const lp = await lbl.newPage();
await lp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(lp, 'q1'); await lp.waitForTimeout(1100); await tap(lp, 'q1'); await lp.waitForTimeout(800);
await tap(lp, 'q1'); await lp.waitForTimeout(400);
ok((await lp.locator('#mic-q1').textContent()) === 'Stop', 'second take: the button reads Stop');
const del2 = lp.locator('article.q').first().locator('.clip').first().locator('button.danger');
await del2.click(); await del2.click(); await lp.waitForTimeout(300);
ok((await lp.locator('#mic-q1').textContent()) === 'Stop',
   'deleting the earlier take while recording does not relabel the live button');
await tap(lp, 'q1'); await lp.waitForTimeout(900);
ok((await lp.locator('article.q').first().locator('.clip').count()) === 1, 'and the new take files');
await lbl.close();

console.log('\n=== the drop-box route: one zip, one more tap ===');
const dbx = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, acceptDownloads: true });
const xp = await dbx.newPage();
await xp.goto('http://localhost:8731/', { waitUntil: 'load' });
ok(await xp.locator('#dropbox').isHidden(), 'no drop-box button before there is anything to send');
ok(await xp.locator('#dropbox-step').isHidden(), 'and no step card');
await tap(xp, 'q1');
await xp.waitForTimeout(1100);
await tap(xp, 'q1');
await xp.waitForTimeout(800);
ok(await xp.locator('#dropbox').isVisible(), 'the drop-box button appears with the first answer');
ok(/^Save/.test((await xp.locator('#dropbox').textContent()).trim()), 'and its label is a verb');
const [xzip] = await Promise.all([xp.waitForEvent('download'), xp.locator('#dropbox').click()]);
ok(xzip.suggestedFilename() === 'cory-outreach-answers.zip', 'it saves the same zip to the phone first');
await xp.waitForTimeout(400);
ok(await xp.locator('#dropbox-step').isVisible(), 'then shows the one-more-tap card');
const dlink = xp.locator('#dropbox-link');
ok((await dlink.getAttribute('href')) === 'https://www.dropbox.com/request/mthmpmq4pc6s85pg8pea',
   'the card links to the file request, not a Dropbox login');
ok((await dlink.getAttribute('target')) === '_blank' && /noopener/.test(await dlink.getAttribute('rel') || ''),
   'it opens beside the page, so the page and its recordings stay put');
ok(await dlink.evaluate((a) => a.getBoundingClientRect().height >= 44), 'the link taps like a button');
ok(/Saved to phone/.test(await xp.locator('article.q').first().locator('.clip .flag').first().textContent()),
   'the clip is marked saved to phone, never as sent');
ok(/still has to reach Todd/.test(await xp.locator('#tally').textContent()),
   'and the tally says the file has not reached anyone yet');
ok((await xp.locator('#dropbox-link-2').getAttribute('href')) === 'https://www.dropbox.com/request/mthmpmq4pc6s85pg8pea',
   'the Voice Memos route in the how-to points at the same drop box');
await dbx.close();

console.log('\n=== the relay route: one tap, a receipt, and a fallback that loses nothing ===');
const rly = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, acceptDownloads: true });
await rly.addInitScript(() => { window.NGW_RELAY_URL = 'http://localhost:8737'; });
const rp = await rly.newPage();
let rpDownloads = 0;
rp.on('download', () => { rpDownloads += 1; });
relayHits.length = 0;
await rp.goto('http://localhost:8731/?k=open-sesame', { waitUntil: 'load' });
await rp.waitForTimeout(400);
ok(relayHits.some((h) => h.url === '/health'), 'the page wakes the relay as soon as it loads with a passcode');
await tap(rp, 'q1'); await rp.waitForTimeout(1100); await tap(rp, 'q1'); await rp.waitForTimeout(800);
await rp.locator('article.q').nth(1).locator('summary').click();
await rp.waitForTimeout(60);
await rp.locator('article.q').nth(1).locator('button.typebtn').click();
await rp.locator('#text-q2').fill('Three short ones.');
await rp.waitForTimeout(900);
await rp.locator('#dropbox').click();
await rp.waitForTimeout(1500);
const up = relayHits.find((h) => h.url.startsWith('/upload'));
ok(!!up && up.code === 'open-sesame' && up.len > 0, 'the zip is posted to the relay with the passcode');
ok(/name=cory-outreach-answers\.zip/.test(up ? up.url : ''), 'named for what it is');
ok(rpDownloads === 0, 'nothing is downloaded when the relay takes it');
ok(await rp.locator('#dropbox-step').isHidden(), 'and no one-more-tap card is shown');
ok(/Landed in Todd\u2019s Dropbox as 20260920T050000Z-cory-outreach-answers\.zip/.test(await rp.locator('#sendall-err').textContent()),
   'the receipt names the file as it landed');
ok((await rp.locator('article.q').first().locator('.clip .flag').first().textContent()) === 'In Todd\u2019s Dropbox',
   'the clip carries the one badge that has a receipt behind it');
ok(/in Todd\u2019s Dropbox/.test(await rp.locator('#tally').textContent()), 'so does the tally');
ok(await rp.locator('#dropbox').isVisible() && await rp.locator('#downloadall').isVisible(),
   'the buttons stay, in case he adds more');
await rp.goto('http://localhost:8731/', { waitUntil: 'load' });
await rp.waitForTimeout(1300);
ok((await rp.locator('article.q').first().locator('.clip .flag').first().textContent()) === 'In Todd\u2019s Dropbox',
   'the receipt survives a reload without the passcode on the link');
ok(relayHits.filter((h) => h.url === '/health').length >= 2, 'and the remembered passcode still wakes the relay');
// The relay is down. Same tap, same zip, the other way.
relayStub.fail = true;
await rp.locator('article.q').nth(2).locator('summary').click();
await rp.waitForTimeout(60);
await tap(rp, 'q3'); await rp.waitForTimeout(1100); await tap(rp, 'q3'); await rp.waitForTimeout(800);
const [fzip] = await Promise.all([rp.waitForEvent('download'), rp.locator('#dropbox').click()]);
await rp.waitForTimeout(600);
ok(fzip.suggestedFilename() === 'cory-outreach-answers.zip', 'when the relay fails the zip is saved on the phone instead');
ok(await rp.locator('#dropbox-step').isVisible(), 'and the one-more-tap card takes over');
ok(/relay dropbox, so the file is saved on this phone instead/.test(await rp.locator('#sendall-err').textContent()),
   'with the reason, in words');
ok((await rp.locator('article.q').nth(2).locator('.clip .flag').first().textContent()) === 'Saved to phone',
   'and the new clip says saved to phone, not sent');
ok((await rp.locator('article.q').first().locator('.clip .flag').first().textContent()) === 'In Todd\u2019s Dropbox',
   'while the one that landed keeps its receipt');
relayStub.fail = false;
await rly.close();

console.log('\n=== mistakes, do-overs and deletions ===');
const mdc = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 }, acceptDownloads: true });
const mp2 = await mdc.newPage();
await mp2.goto('http://localhost:8731/', { waitUntil: 'load' });
const c0 = mp2.locator('article.q').first();
const keys = () => mp2.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => { const g = r.result.transaction('clips').objectStore('clips').getAllKeys(); g.onsuccess = () => res(g.result.map(String).sort()); };
}));
// A mis-tap: Record and Stop inside a fraction of a second.
await mp2.evaluate(() => { const b = document.getElementById('mic-q1'); b.click(); setTimeout(() => b.click(), 200); });
await mp2.waitForTimeout(900);
ok((await c0.locator('.clip').count()) === 0, 'a tap-and-release files nothing');
ok(/tap, not a take/.test(await c0.locator('.note, .err').first().textContent()), 'and says so in words');
ok((await mp2.locator('#fig-answered').textContent()) === `0/${N}`, 'the question is not counted as answered');
ok((await mp2.locator('#mic-q1').textContent()) === 'Record' && !(await mp2.locator('#mic-q4').isDisabled()),
   'the button and the mic lock are back to rest');
// A real take, then the delete arm left to lapse.
await tap(mp2, 'q1'); await mp2.waitForTimeout(1100); await tap(mp2, 'q1'); await mp2.waitForTimeout(800);
const d1 = c0.locator('.clip').first().locator('button.danger');
await d1.click(); await mp2.waitForTimeout(200);
ok((await d1.textContent()) === 'Delete for good?', 'one tap arms');
await mp2.waitForTimeout(4300);
ok((await d1.textContent()) === 'Delete' && (await c0.locator('.clip').count()) === 1,
   'left alone, the arm lapses and nothing is deleted');
// Armed, then distracted by another question: still nothing deleted.
await d1.click(); await mp2.waitForTimeout(100);
await mp2.locator('article.q').nth(1).locator('summary').click(); await mp2.waitForTimeout(100);
await c0.locator('summary').click(); await mp2.waitForTimeout(100);
ok((await c0.locator('.clip').count()) === 1, 'opening another question while armed deletes nothing');
await mp2.waitForTimeout(4300);
// Armed, then the page is closed: nothing deleted.
await d1.click(); await mp2.waitForTimeout(100);
await mp2.reload({ waitUntil: 'load' }); await mp2.waitForTimeout(1300);
ok((await c0.locator('.clip').count()) === 1, 'an arm does not survive a reload as a deletion');
// Delete the only take: the question goes back to unanswered, everywhere.
await c0.locator('summary').click(); await mp2.waitForTimeout(60);
const d2 = c0.locator('.clip').first().locator('button.danger');
await d2.click(); await d2.click(); await mp2.waitForTimeout(400);
ok((await c0.locator('.clip').count()) === 0, 'the only take is gone');
ok((await mp2.locator('#fig-answered').textContent()) === `0/${N}` &&
   (await mp2.locator('#mic-q1').textContent()) === 'Record' &&
   await c0.locator('.qstate').isHidden() &&
   !(await c0.evaluate((e) => e.classList.contains('has-rec'))),
   'the ledger, the button, the folded-row state and the card all say unanswered');
ok(/Start with 01/.test(await mp2.locator('#next').textContent()), 'the whisper points back at it');
ok(await mp2.locator('#dropbox').isHidden() && await mp2.locator('#downloadall').isHidden() &&
   await mp2.locator('#sendall-err').isHidden(),
   'nothing is offered for sending, and no stale note about sending remains');
ok((await keys()).length === 0, 'and the store is empty, not just the screen');
// Do-over: record again after deleting. One take, one key, and a reload agrees.
await tap(mp2, 'q1'); await mp2.waitForTimeout(1100); await tap(mp2, 'q1'); await mp2.waitForTimeout(800);
ok((await c0.locator('.clip').count()) === 1 && (await c0.locator('.clip .part').first().textContent()) === 'Part 1',
   'the do-over is Part 1, not Part 2');
const k1 = await keys();
ok(k1.length === 1, `one key in the store (${k1.join(',')})`);
await mp2.reload({ waitUntil: 'load' }); await mp2.waitForTimeout(1300);
ok((await c0.locator('.clip').count()) === 1, 'the do-over survives a reload with no ghost of the deleted take');
// Three takes, delete the middle one: the survivors renumber and reload in order.
await c0.locator('summary').click(); await mp2.waitForTimeout(60);
await tap(mp2, 'q1'); await mp2.waitForTimeout(1100); await tap(mp2, 'q1'); await mp2.waitForTimeout(800);
await tap(mp2, 'q1'); await mp2.waitForTimeout(1100); await tap(mp2, 'q1'); await mp2.waitForTimeout(800);
ok((await c0.locator('.clip').count()) === 3, 'three takes');
const dm = c0.locator('.clip').nth(1).locator('button.danger');
await dm.click(); await dm.click(); await mp2.waitForTimeout(400);
ok((await c0.locator('.clip .part').allTextContents()).join(',') === 'Part 1,Part 2', 'the middle one goes and the rest renumber');
await mp2.reload({ waitUntil: 'load' }); await mp2.waitForTimeout(1300);
ok((await c0.locator('.clip').count()) === 2 && (await c0.locator('.clip .part').allTextContents()).join(',') === 'Part 1,Part 2',
   'two come back, numbered 1 and 2');
ok(await c0.locator('.clip audio').evaluateAll((as) => as.every((a) => a.src.startsWith('blob:'))), 'each with its audio');
await c0.locator('summary').click(); await mp2.waitForTimeout(60);
await tap(mp2, 'q1'); await mp2.waitForTimeout(1100); await tap(mp2, 'q1'); await mp2.waitForTimeout(800);
ok((await c0.locator('.clip .part').allTextContents()).join(',') === 'Part 1,Part 2,Part 3',
   'a new take after a reload numbers on from the survivors');
ok((await keys()).length === 3, 'three keys, none colliding');
// Deleting a take that already went does not resurrect anything.
await mp2.evaluate(() => {
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});
await c0.locator('.clip').first().locator('button.send').click(); await mp2.waitForTimeout(400);
ok((await c0.locator('.clip').first().locator('.flag').textContent()) === 'Handed off', 'first take handed off');
ok((await mp2.locator('#sendall').textContent()) === 'Text all 2 to Todd', 'two left to send');
const ds = c0.locator('.clip').first().locator('button.danger');
await ds.click(); await ds.click(); await mp2.waitForTimeout(400);
ok((await mp2.locator('#sendall').textContent()) === 'Text all 2 to Todd', 'deleting the sent one leaves two to send');
ok((await c0.locator('.clip .part').allTextContents()).join(',') === 'Part 1,Part 2', 'and the rest renumber');
// A typed do-over: clear the text and the answer is gone, everywhere.
await mp2.locator('article.q').nth(1).locator('summary').click(); await mp2.waitForTimeout(60);
await mp2.locator('article.q').nth(1).locator('button.typebtn').click();
await mp2.locator('#text-q2').fill('First thought.'); await mp2.waitForTimeout(900);
ok((await mp2.locator('#fig-answered').textContent()) === `2/${N}`, 'a typed answer counts');
await mp2.locator('#text-q2').fill(''); await mp2.waitForTimeout(900);
ok((await mp2.locator('#fig-answered').textContent()) === `1/${N}` &&
   await mp2.locator('article.q').nth(1).locator('.qstate').isHidden(),
   'clearing it uncounts it and clears the folded-row state');
ok(!(await keys()).some((k) => k === 'text::q2'), 'and removes it from the store');
await mp2.reload({ waitUntil: 'load' }); await mp2.waitForTimeout(1300);
ok((await mp2.locator('#text-q2').inputValue()) === '' && (await mp2.locator('#fig-answered').textContent()) === `1/${N}`,
   'a reload agrees');
await mdc.close();

console.log('\n=== the shared file carries a bare media type ===');
const mime = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const mp = await mime.newPage();
await mp.addInitScript(() => {
  window.__offered = [];
  Object.defineProperty(navigator, 'canShare', {
    value: (d) => { window.__offered.push(d.files.map((f) => f.type)); return true; },
    configurable: true });
  Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
});
await mp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(mp, 'q1');
await mp.waitForTimeout(1100);
await tap(mp, 'q1');
await mp.waitForTimeout(900);
const recorded = await mp.evaluate(() => document.querySelector('article.q audio') ? true : false);
ok(recorded, 'a clip exists to share');
await mp.locator('article.q').first().locator('button.send').click();
await mp.waitForTimeout(500);
const offered = await mp.evaluate(() => window.__offered);
const types = offered.flat();
ok(types.length > 0, `a file was offered to the share sheet (${types.join(', ')})`);
ok(types.every((t) => t.indexOf(';') === -1),
   `no offered file carries media-type parameters (${types.join(', ')})`);
ok(types.some((t) => /^audio\//.test(t)), 'the audio file is offered as an audio type');
const names = await mp.evaluate(() => window.__names || []);
await mime.close();

console.log('\n=== layout ===');
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)),
   'no horizontal scroll at 390px');
await page.screenshot({ path: '/tmp/intake-light.png' });
await ctx.close();

const dark = await browser.newContext({ permissions: ['microphone'], colorScheme: 'dark',
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const dp = await dark.newPage();
await dp.goto('http://localhost:8731/', { waitUntil: 'load' });
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `dark theme paints its own ground (${bg})`);
await dp.screenshot({ path: '/tmp/intake-dark.png' });

console.log('\n=== desktop layout ===');
const wide = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const wp = await wide.newPage();
await wp.goto('http://localhost:8731/', { waitUntil: 'load' });
await wp.waitForTimeout(400);
const L = await wp.evaluate(() => {
  const q = document.querySelector('article.q');
  const ask = q.querySelector('.ask').getBoundingClientRect();
  const btn = q.querySelector('.row').getBoundingClientRect();
  const why = q.querySelector('.why');
  const wrap = document.querySelector('.board').getBoundingClientRect();
  return {
    numberBesideAsk: q.querySelector('.qnum').getBoundingClientRect().right <= ask.left + 1,
    hScroll: document.documentElement.scrollWidth > innerWidth + 1,
    whyCh: (() => {
      const probe = document.createElement('span');
      probe.textContent = 'x'.repeat(100);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' +
        getComputedStyle(why).font;
      document.body.appendChild(probe);
      const per = probe.getBoundingClientRect().width / 100;
      probe.remove();
      return Math.round(why.getBoundingClientRect().width / per);
    })(),
    column: Math.round(wrap.width),
    gap: Math.round(ask.left - q.getBoundingClientRect().left),
    bodyPx: parseFloat(getComputedStyle(document.body).fontSize),
  };
});
ok(L.numberBesideAsk, 'the number sits in its own column beside the question');
ok(!L.hScroll, 'no horizontal scroll at 1920px');
ok(L.whyCh >= 45 && L.whyCh <= 72, `line length stays readable on desktop (${L.whyCh}ch)`);
// Density, not stretch: more lanes and a bounded void, with the type scale
// held fixed because UX_01 sets it by role, never by viewport.
const D = await wp.evaluate(() => {
  const b = document.querySelector('.board').getBoundingClientRect();
  const lane = document.querySelector('.group:not(.lane)');
  const cols = getComputedStyle(lane).gridTemplateColumns.split(' ').length;
  return { gutter: Math.max(b.left, innerWidth - b.right), cols,
           body: parseFloat(getComputedStyle(document.querySelector('.why')).fontSize) };
});
ok(D.gutter <= 320, `no unbounded void beside the content (${Math.round(D.gutter)}px gutter)`);
ok(D.cols >= 2, `the list gains lanes rather than padding (${D.cols} columns)`);
ok(D.body === 14, `the type scale is fixed by role, not by viewport (${D.body}px)`);
await wp.screenshot({ path: '/tmp/intake-desktop.png' });
await wide.close();

// The meter is only worth having if a flat bar means something. Same page,
// same code path, silence on the wire.
console.log('\n=== the meter reads silence as silence ===');
const quiet = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const qc = await quiet.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const qp = await qc.newPage();
await qp.goto('http://localhost:8731/', { waitUntil: 'load' });
await tap(qp, 'q1');
await qp.waitForTimeout(1800);
ok(await qp.locator('.level').first().isVisible(), 'the meter is still up on a silent mic');
ok(await qp.locator('.level i').first().evaluate((e) => parseFloat(e.style.width) === 0),
   'and reads flat, so a moving bar is real evidence');
await tap(qp, 'q1');
await qp.waitForTimeout(900);
ok((await qp.locator('article.q').first().locator('.clip').count()) === 1,
   'a silent recording still files — the meter reports, it does not gate');
await quiet.close();

console.log('\n=== console ===');
const real = errors.filter((e) => !/ERR_CERT_AUTHORITY_INVALID/.test(e));
ok(real.length === 0, real.length ? 'page errors: ' + real.join(' | ')
   : 'no page errors (font CDN cert is this sandbox proxy, ignored)');

await browser.close();
server.close();
relayStub.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
