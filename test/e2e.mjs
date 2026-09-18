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

const record = async (id, ms) => {
  await page.locator('#mic-' + id).click();
  await page.waitForTimeout(ms);
  await page.locator('#mic-' + id).click();
  await page.waitForTimeout(900);
};
const card = (n) => page.locator('article.q').nth(n);

console.log('\n=== at rest ===');
ok((await page.locator('article.q').count()) === 13, '13 question cards');
ok((await page.locator('#fig-answered').textContent()) === '0/13' &&
   (await page.locator('#fig-clips').textContent()) === '0', 'ledger reads zero');
ok(/Nothing recorded or typed on this page yet/.test(await page.locator('#tally').textContent()),
   'and the line says what that means, naming both ways to answer');
ok(!(await page.locator('#sendall').isVisible()), 'Send all hidden');
ok((await page.locator('article.q audio:visible').count()) === 0, 'no dead audio players');
const nums = await page.locator('.qnum').allTextContents();
ok(nums.join(',') === Array.from({ length: 13 }, (_, i) => String(i + 1)).join(','),
   'margin numbers run 1..13 in order');

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
ok((await page.locator('.q').count()) === 13 &&
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
await page.locator('#mic-q1').click();
await page.waitForTimeout(700);
ok((await page.locator('#mic-q1').textContent()) === 'Stop', 'button reads Stop while live');
ok(await page.locator('#mic-q4').isDisabled(), 'other questions disabled while one records');
ok(await card(0).locator('.keepon').isVisible(), 'screen-lock line shows where it applies');
ok(/stops and keeps what you said/.test(await card(0).locator('.keepon').textContent()),
   'it describes what the page does, not only what could go wrong');
// Live evidence about the recorder's own stream, not about dictation.
ok(await card(0).locator('.level').isVisible(), 'the level meter is up while recording');
ok(await card(0).locator('.level i').evaluate((e) => parseFloat(e.style.width) > 0),
   'the meter actually moves on the fake device');
await page.waitForTimeout(900);
await page.locator('#mic-q1').click();
await page.waitForTimeout(900);
ok(!(await page.locator('#mic-q4').isDisabled()), 'others re-enabled after stop');
ok(await card(0).locator('.keepon').isHidden(), 'line hidden again');
ok(await card(0).locator('.level').isHidden(), 'meter torn down with the recorder');
ok(await card(0).locator('.said.pending').isHidden(), 'live transcript cleared on stop');
ok((await card(0).locator('.clip').count()) === 1, 'one clip filed');

// The race the old build lost an answer to: start a second question while the
// first is still live. The first must file, the second must be fully operable.
console.log('\n=== the race: switching questions mid-recording ===');
await page.locator('#mic-q2').click();
await page.waitForTimeout(800);
// The guard is the fix: q5 is disabled, so the tap that used to silently end
// q2's recording cannot land at all. Force it anyway to prove nothing happens.
ok(await page.locator('#mic-q5').isDisabled(), 'q5 locked out while q2 holds the mic');
await page.locator('#mic-q5').click({ force: true }).catch(() => {});
await page.waitForTimeout(900);
ok((await page.locator('#mic-q2').textContent()) === 'Stop', 'q2 still recording, not orphaned');
const t = await card(1).locator('.time').first().textContent();
ok(/^0:0[0-9]$/.test(t), `q2 timer still running (${t})`);
await page.locator('#mic-q2').click();
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
await page.locator('#mic-q3').click();
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
ok((await page.locator('#fig-answered').textContent()) === '3/13', 'restored after reload');
ok(!(await page.locator('#restorefail').isVisible()), 'no false restore-failure banner');

// The page warns that a screen lock can cut a recording off. Warning is not
// handling — this is the handling.
console.log('\n=== backgrounding files the answer instead of losing it ===');
await page.locator('#mic-q6').click();
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
await card(1).locator('.clip').first().locator('button.send').click();
await page.waitForTimeout(600);
ok((await card(1).locator('.clip').first().locator('.flag').textContent()) === 'Not sent',
   'the fallback never claims the file was saved, let alone sent');
ok(/nothing has been sent yet/.test(await card(1).locator('.note').first().textContent()),
   'the note is conditional about the save and flat about the send');
ok((await page.locator('#sendall').textContent()) === 'Text all 3 to Todd',
   'a download did not quietly count as sent');

console.log('\n=== a clip that cannot be restored is never silent ===');
await page.evaluate(() => new Promise((res, rej) => {
  const r = indexedDB.open('ngw-voice-brief', 1);
  r.onsuccess = () => {
    const tx = r.result.transaction('clips', 'readwrite');
    tx.objectStore('clips').put({ ms: 1000, said: '' }, 'q9::1');   // no blob
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

console.log('\n=== dictation degrades silently ===');
// Chromium here has no working speech service, so this proves the path nobody
// should ever notice: no transcript, no error, recording unaffected.
const dict = await page.evaluate(() => ({
  api: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  noteShown: !document.getElementById('dictation-note').hidden,
}));
ok(dict.noteShown === dict.api,
   `the dictation note appears only where dictation exists (api=${dict.api})`);
// The API exists in this browser but its service never answers, so this is the
// silent-failure path: no text, and therefore no empty transcript block either.
ok((await page.locator('.said:visible').count()) === 0,
   'a transcript block never shows with nothing in it');
ok((await card(0).locator('.clip').count()) > 0, 'recordings still file with dictation absent');

// With a service that does answer, the words have to reach the screen while he
// talks, and ride along with the audio afterwards. Stub the API, not our code.
console.log('\n=== the transcript is shown as he speaks ===');
const heard = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await heard.addInitScript(() => {
  const SAID = 'the facility manager signs off on it';
  function Fake() { this.continuous = false; this.interimResults = false; this.lang = 'en-US'; }
  Fake.prototype.start = function () {
    this._t = setTimeout(() => {
      if (!this.onresult) return;
      this.onresult({ resultIndex: 0, results: [{ 0: { transcript: SAID }, isFinal: true, length: 1 }] });
    }, 300);
  };
  Fake.prototype.stop = function () {
    clearTimeout(this._t);
    if (this.onend) this.onend();
  };
  window.SpeechRecognition = Fake;
  window.webkitSpeechRecognition = Fake;
});
const hp = await heard.newPage();
await hp.goto('http://localhost:8731/', { waitUntil: 'load' });
ok(!(await hp.locator('#dictation-note').isHidden()),
   'he is told his phone is writing it out, and where that text goes');
await hp.locator('#mic-q1').click();
await hp.waitForTimeout(1400);
const liveEl = hp.locator('article.q').first().locator('.said.pending');
ok(await liveEl.isVisible(), 'the words appear while the recording is still running');
ok(/facility manager signs off/.test(await liveEl.textContent()),
   'and they are the words that were said');
await hp.locator('#mic-q1').click();
await hp.waitForTimeout(900);
ok(await liveEl.isHidden(), 'the live block clears once the clip is filed');
const filed = hp.locator('article.q').first().locator('.clip .said');
ok((await filed.count()) === 1 && /facility manager signs off/.test(await filed.textContent()),
   'the text is filed with its recording, with nothing copied or pasted');
await heard.close();

// Dictation hands back a CUMULATIVE result list per session, and resultIndex
// only marks the first entry that changed. Appending the slice from
// resultIndex re-added every final the event still carried, so one sentence
// filed three, six, twelve times. A restart through a pause then has to keep
// the earlier session's text without replaying it. Both halves are asserted.
console.log('\n=== the transcript is not duplicated across pauses ===');
const dup = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
await dup.addInitScript(() => {
  const S = [{ at: 200, final: 'Alpha one. ' }, { at: 600, end: true },
             { at: 1000, final: 'Bravo two. ' }, { at: 1400, final: 'Charlie three.' }];
  function F() { this._t = []; this._f = []; this._cur = 0; }
  F.prototype.start = function () {
    this._f = [];                                  // a session starts empty, per spec
    const base = this._cur;
    S.forEach((step, i) => {
      if (i < base) return;
      this._t.push(setTimeout(() => {
        this._cur = i + 1;
        if (step.end) { this._t.forEach(clearTimeout); this._t = []; this.onend && this.onend(); return; }
        this._f.push(step.final);
        this.onresult && this.onresult({ resultIndex: 0,
          results: this._f.map((t) => ({ 0: { transcript: t }, isFinal: true, length: 1 })) });
      }, step.at));
    });
  };
  F.prototype.stop = function () { this._t.forEach(clearTimeout); this.onend && this.onend(); };
  window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
});
const dupPage = await dup.newPage();
await dupPage.goto('http://localhost:8731/', { waitUntil: 'load' });
await dupPage.locator('#mic-q1').click();
await dupPage.waitForTimeout(2000);
await dupPage.locator('#mic-q1').click();
await dupPage.waitForTimeout(1000);
const filedText = (await dupPage.locator('.clip .said').first().textContent()).trim();
ok(filedText === 'Alpha one. Bravo two. Charlie three.',
   `each sentence lands exactly once ("${filedText}")`);
ok((filedText.match(/Alpha/g) || []).length === 1, 'the pre-pause sentence is not repeated');
ok(/Bravo two\. Charlie three\./.test(filedText), 'and the post-restart text is kept in order');

// The synopsis exists so he can see he was heard, without copying anything.
// It is extractive: every line must be a substring of what he actually said.
console.log('\n=== the synopsis is his own words, never a paraphrase ===');
ok(await dupPage.locator('#synopsis').isVisible(), 'a synopsis appears once a transcript exists');
const synLines = await dupPage.locator('.syn-q li').allTextContents();
ok(synLines.length > 0, `it has lines (${synLines.length})`);
ok(await dupPage.evaluate(() => {
     const norm = (x) => x.replace(/\s+/g, ' ').trim();
     const said = norm([...document.querySelectorAll('.clip .said')].map((e) => e.textContent).join(' '));
     return [...document.querySelectorAll('.syn-q li')].every((li) => said.includes(norm(li.textContent)));
   }), 'every line is verbatim from the transcript — nothing generated');
ok((await dupPage.locator('#tx').count()) === 0, 'the transcript paste box is still gone');
const boxes = await dupPage.locator('textarea').all();
const asks = await Promise.all(boxes.map((b) => b.getAttribute('placeholder')));
ok(asks.every((a) => a && !/paste|transcript/i.test(a)),
   'no box asks him to paste a transcript — typing is for answering, not transcribing');
ok(boxes.length === 13, `every question offers typing as well as recording (${boxes.length})`);
// The page must not tell him not to do the thing it offers.
const h1 = await dupPage.locator('h1').textContent();
ok(!/don\u2019t type|don't type/i.test(h1), `the title does not contradict the typing box (${h1})`);
ok(/Type it instead/.test(await dupPage.locator('.how').textContent()),
   'and the instructions mention typing as a real option');
ok(/your own sentences/.test(await dupPage.locator('.syn-note').textContent()),
   'the page says plainly where the lines came from');
await dup.close();

// Found by speaking real audio into the page: when the recogniser cannot get
// the microphone it errors immediately, onend fires, and restarting from onend
// unconditionally spins start -> error -> end as fast as the browser allows.
// Measured at 6,555 cycles in one 14-second recording — battery and CPU burned
// at the moment he is talking, for a feature that is optional anyway.
// MediaRecorder reports the type it negotiated with its parameters attached —
// "audio/mp4;codecs=opus" was observed in this very suite. Web Share matches a
// file against an allowlist of BARE types, so a codecs parameter makes
// canShare() answer false and every share silently becomes a download. This is
// the shape of the failure reported from an iPad, a MacBook and a Samsung.
// navigator.share is defined to be platform-dependent, so it cannot be the
// only way out. Reported failing across an iPad, a MacBook and a Samsung. A
// download has never varied between browsers, so everything can also leave as
// one zip — and the archive has to be real, not bytes that merely look like one.
// Not everyone wants to hear themselves talk. Typing has to be a real way to
// answer — saved, counted, restored and delivered exactly like a recording.
// Twenty minutes of answers has to be sendable. The browser default measured
// 129 kbps — 0.92 MB a minute, 18 MB for twenty — which no text message will
// carry and email barely will. One voice does not need that.
// Found on a real MacBook: Safari had permission and an open audio stream that
// carried NO SOUND. Two independent systems agreed — an AnalyserNode saw a flat
// signal and Safari's own recogniser fired audiostart but never soundstart. The
// page filed that as a perfectly good answer: a card that looks done, a clip
// with a duration, and nothing inside it. That is the worst failure here,
// because he only finds out after twenty minutes of talking.
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
await dp2.locator('#mic-q1').click();
await dp2.waitForTimeout(5200);
const warned = await dp2.locator('article.q').first().locator('.err:visible, .note:visible').first();
const liveWarn = await warned.count() ? await warned.textContent() : '';
ok(/isn\u2019t picking anything up|picking anything up/.test(liveWarn),
   'it says so within a few seconds, not after twenty minutes');
await dp2.locator('#mic-q1').click();
await dp2.waitForTimeout(1200);
ok((await dp2.locator('article.q').first().locator('.clip').count()) === 1,
   'the recording is still kept — his call, not mine');
const noteCount = await dp2.locator('article.q').first().locator('.clip .note').count();
const clipNote = noteCount
  ? await dp2.locator('article.q').first().locator('.clip .note').first().textContent() : '';
ok(noteCount === 1 && /No sound on this one/.test(clipNote),
   `the clip itself is marked as empty (${noteCount} marks: "${clipNote.slice(0, 40)}")`);
ok((await dp2.locator('#fig-answered').textContent()) === '0/13',
   'a silent recording does not count as an answer given');
await deaf.close();

// And with real sound present, none of that fires.
console.log('\n=== and a real recording is left alone ===');
const heard2 = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const hp2 = await heard2.newPage();
await hp2.goto('http://localhost:8731/', { waitUntil: 'load' });
await hp2.locator('#mic-q1').click();
await hp2.waitForTimeout(5200);
const noFalse = await hp2.locator('article.q').first().locator('.err:visible').count();
ok(noFalse === 0, 'no silence warning while the microphone is working');
await hp2.locator('#mic-q1').click();
await hp2.waitForTimeout(1200);
ok((await hp2.locator('article.q').first().locator('.clip .note').count()) === 0,
   'and the clip is not marked empty');
ok((await hp2.locator('#fig-answered').textContent()) === '1/13',
   'a real recording counts as an answer');
await heard2.close();

console.log('\n=== a recording is sized for sending ===');
const bit = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const bp = await bit.newPage();
await bp.goto('http://localhost:8731/', { waitUntil: 'load' });
await bp.locator('#mic-q1').click();
await bp.waitForTimeout(6000);
await bp.locator('#mic-q1').click();
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
await gp.locator('#mic-q1').click();
await gp.waitForTimeout(1200);
await gp.locator('#mic-q1').click();
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
ok((await tp.locator('#fig-answered').textContent()) === '1/13',
   'a typed answer counts as answered');
ok(/typed answer/.test(await tp.locator('#tally').textContent()),
   'and the tally says so in words');

await tp.reload({ waitUntil: 'load' });
await tp.waitForTimeout(1300);
ok((await tp.locator('#text-q1').inputValue()) === ANSWER, 'it survives closing the page');
ok(await tp.locator('#text-q1').isVisible(), 'and the box is open again so he can see it');
ok(!(await tp.locator('#restorefail').isVisible()),
   'a typed answer is never mistaken for a broken recording');

const syn = await tp.locator('.syn-q li').allTextContents();
ok(syn.length > 0 && syn.some((l) => ANSWER.indexOf(l.trim()) > -1 || l.trim() === ANSWER),
   'the synopsis reads typed answers too, still verbatim');

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
ok((await tp.locator('#fig-answered').textContent()) === '0/13',
   'clearing the box un-answers the question');
await typ.close();

console.log('\n=== there is a route out of every browser ===');
const noshare = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 }, acceptDownloads: true });
await noshare.addInitScript(() => {
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  // Dictation has to work for the archive to carry transcripts as well as
  // audio, and Chromium's own recogniser cannot reach its service here.
  function F() { this._t = null; }
  F.prototype.start = function () {
    this._t = setTimeout(() => {
      this.onresult && this.onresult({ resultIndex: 0, results: [
        { 0: { transcript: 'The facility manager signs off on it.' }, isFinal: true, length: 1 }] });
    }, 300);
  };
  F.prototype.stop = function () { clearTimeout(this._t); this.onend && this.onend(); };
  window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
});
const np2 = await noshare.newPage();
await np2.goto('http://localhost:8731/', { waitUntil: 'load' });
for (const q of ['q1', 'q4']) {
  await np2.locator('#mic-' + q).click();
  await np2.waitForTimeout(1100);
  await np2.locator('#mic-' + q).click();
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
ok(count === 4, `it holds two recordings and their two transcripts (${count} entries)`);
const zipNames = [];
let o = cdOff;
for (let i = 0; i < count; i++) {
  ok(zb.readUInt32LE(o) === 0x02014b50, 'central directory entry ' + i + ' is well formed');
  const nlen = zb.readUInt16LE(o + 28);
  zipNames.push(zb.toString('utf8', o + 46, o + 46 + nlen));
  o += 46 + nlen + zb.readUInt16LE(o + 30) + zb.readUInt16LE(o + 32);
}
ok(zipNames.filter((n) => n.endsWith('.m4a') || n.endsWith('.webm')).length === 2 &&
   zipNames.filter((n) => n.endsWith('.txt')).length === 2,
   `audio and transcripts both travel (${zipNames.join(', ')})`);
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
await yp.locator('#mic-q1').click();
await yp.waitForTimeout(1100);
await yp.locator('#mic-q1').click();
await yp.waitForTimeout(800);
ok(await yp.locator('#sendall').isVisible(), 'the share route leads where it exists');
ok(await yp.locator('#downloadall').evaluate((e) => e.className === 'second'),
   'and the one-file route steps back to secondary');
await yesshare.close();

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
await mp.locator('#mic-q1').click();
await mp.waitForTimeout(1100);
await mp.locator('#mic-q1').click();
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

console.log('\n=== a failing recogniser does not spin ===');
const spin = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
await spin.addInitScript(() => {
  window.__starts = 0;
  function Broken() {}
  Broken.prototype.start = function () {
    window.__starts += 1;
    setTimeout(() => {
      this.onerror && this.onerror({ error: 'audio-capture' });
      this.onend && this.onend();
    }, 5);
  };
  Broken.prototype.stop = function () { this.onend && this.onend(); };
  window.SpeechRecognition = Broken; window.webkitSpeechRecognition = Broken;
});
const sp = await spin.newPage();
await sp.goto('http://localhost:8731/', { waitUntil: 'load' });
await sp.locator('#mic-q1').click();
await sp.waitForTimeout(4000);
const starts = await sp.evaluate(() => window.__starts);
ok(starts <= 5, `a recogniser that always fails is retried a few times, not thousands (${starts})`);
await sp.locator('#mic-q1').click();
await sp.waitForTimeout(900);
ok((await sp.locator('article.q').first().locator('.clip').count()) === 1,
   'and the recording it was riding alongside still files');

await spin.close();

// A declined microphone is a decision, not a glitch — never re-ask in a loop.
// The page reads the constructor once at init, so this needs its own context
// rather than a swap after load.
const denied = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
await denied.addInitScript(() => {
  window.__starts = 0;
  function Denied() {}
  Denied.prototype.start = function () {
    window.__starts += 1;
    setTimeout(() => {
      this.onerror && this.onerror({ error: 'not-allowed' });
      this.onend && this.onend();
    }, 5);
  };
  Denied.prototype.stop = function () { this.onend && this.onend(); };
  window.SpeechRecognition = Denied; window.webkitSpeechRecognition = Denied;
});
const dn = await denied.newPage();
await dn.goto('http://localhost:8731/', { waitUntil: 'load' });
await dn.locator('#mic-q1').click();
await dn.waitForTimeout(2500);
ok((await dn.evaluate(() => window.__starts)) === 1,
   `a declined microphone is asked for exactly once (${await dn.evaluate(() => window.__starts)})`);
await dn.locator('#mic-q1').click();
await dn.waitForTimeout(900);
ok((await dn.locator('article.q').first().locator('.clip').count()) === 1,
   'and the recording is unaffected by the refusal');
await denied.close();

// No transcripts, no synopsis — an empty panel would be worse than none.
const nosyn = await browser.newContext({ permissions: ['microphone'],
  viewport: { width: 390, height: 844 } });
const np = await nosyn.newPage();
await np.goto('http://localhost:8731/', { waitUntil: 'load' });
await np.waitForTimeout(400);
ok(await np.locator('#synopsis').isHidden(), 'no synopsis panel before there is anything in it');
await nosyn.close();

ok((await page.locator('#tx').count()) === 0, 'the paste box is gone');
ok((await page.locator('#checkbtn').count()) === 0, 'the summary button is gone');
const pageText = await page.locator('body').innerText();
ok(!/[Pp]aste a transcript/.test(pageText), 'nothing asks him to paste anything');

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
ok(D.body === 13, `the type scale is fixed by role, not by viewport (${D.body}px)`);
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
await qp.locator('#mic-q1').click();
await qp.waitForTimeout(1800);
ok(await qp.locator('.level').first().isVisible(), 'the meter is still up on a silent mic');
ok(await qp.locator('.level i').first().evaluate((e) => parseFloat(e.style.width) === 0),
   'and reads flat, so a moving bar is real evidence');
await qp.locator('#mic-q1').click();
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
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
