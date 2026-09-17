// Cory's actual journey through the deployed page, captured step by step.
// iPhone 15 Pro metrics, a real tone on the microphone, and dictation stubbed
// at the API (there is no iOS Safari in this container — see demo/dictation.mjs).
import { chromium, devices } from 'playwright';
import http from 'node:http'; import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';

const OUT = '/tmp/claude-0/walk'; fs.mkdirSync(OUT, { recursive: true });
const srv = http.createServer((_, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(new URL('../index.html', import.meta.url)));
}).listen(8753);

const rate = 48000, n = rate * 20, d = Buffer.alloc(44 + n * 2);
d.write('RIFF',0); d.writeUInt32LE(36+n*2,4); d.write('WAVE',8); d.write('fmt ',12);
d.writeUInt32LE(16,16); d.writeUInt16LE(1,20); d.writeUInt16LE(1,22);
d.writeUInt32LE(rate,24); d.writeUInt32LE(rate*2,28); d.writeUInt16LE(2,32);
d.writeUInt16LE(16,34); d.write('data',36); d.writeUInt32LE(n*2,40);
for (let i=0;i<n;i++) d.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*11000)
  * (0.5 + 0.5*Math.sin(2*Math.PI*i/rate/1.7)), 44+i*2);   // varies so the meter moves
const WAV = path.join(os.tmpdir(), 'walk.wav'); fs.writeFileSync(WAV, d);

// Two different answers, so the synopsis has real material to choose from.
const SPEECH = {
  q1: ['So the way this actually works is the controller has to be released by their facility first. ',
       'The facility manager is the one who signs off on it, and it always comes down to staffing and coverage on the day. ',
       'So if they are short that week we are not travelling, no matter what I have already booked.'],
  q3: ['The worst one was a career fair in Ohio where the speaker got pulled two days out. ',
       'I ended up doing the whole thing myself off a borrowed laptop, because the school had already printed the flyers. ',
       'Now I never confirm a date until I have a second controller who can cover it.'],
  q4: ['Honestly I just ask around, and it ends up being the same four or five people every time. ',
       'That is not sustainable and I know it.'],
};
const mkStub = (phrases) => new Function('P', `
  let idx = 0;
  function F(){ this._t=[]; this._f=[]; }
  F.prototype.start = function () {
    this._f = [];
    const mine = P.slice(idx);
    mine.forEach((p, i) => this._t.push(setTimeout(() => {
      idx += 1; this._f.push(p);
      this.onresult && this.onresult({ resultIndex: 0,
        results: this._f.map(t => ({0:{transcript:t}, isFinal:true, length:1})) });
    }, 700 + i * 900)));
  };
  F.prototype.stop = function(){ this._t.forEach(clearTimeout); this._t=[]; this.onend && this.onend(); };
  window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
`);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--use-file-for-fake-audio-capture=' + WAV],
});
const ip = devices['iPhone 15 Pro'];
let step = 0;
const shot = async (p, name) => {
  step += 1;
  const f = `${String(step).padStart(2,'0')}-${name}`;
  await p.screenshot({ path: `${OUT}/${f}.png` });
  console.log('  ' + f);
};

const ctx = await browser.newContext({ ...ip, permissions: ['microphone'] });
await ctx.addInitScript(mkStub([]).toString().length ? () => {} : () => {});
const page = await ctx.newPage();
// install a stub whose phrase list we can swap per question
await page.addInitScript(() => { window.__phrases = []; });
await page.goto('http://localhost:8753/', { waitUntil: 'load' });
await page.evaluate(() => {
  function F(){ this._t=[]; this._f=[]; }
  F.prototype.start = function () {
    this._f = [];
    (window.__phrases || []).forEach((p, i) => this._t.push(setTimeout(() => {
      this._f.push(p);
      this.onresult && this.onresult({ resultIndex: 0,
        results: this._f.map(t => ({0:{transcript:t}, isFinal:true, length:1})) });
    }, 700 + i * 900)));
  };
  F.prototype.stop = function(){ this._t.forEach(clearTimeout); this._t=[]; this.onend && this.onend(); };
  window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
  // the page read SR at load; re-point it
  window.dispatchEvent(new Event('sr-ready'));
});
await page.reload({ waitUntil: 'load' });   // so the page picks the stub up at init
await page.addInitScript(() => {
  function F(){ this._t=[]; this._f=[]; }
  F.prototype.start = function () {
    this._f = [];
    (window.__phrases || []).forEach((p, i) => this._t.push(setTimeout(() => {
      this._f.push(p);
      this.onresult && this.onresult({ resultIndex: 0,
        results: this._f.map(t => ({0:{transcript:t}, isFinal:true, length:1})) });
    }, 700 + i * 900)));
  };
  F.prototype.stop = function(){ this._t.forEach(clearTimeout); this._t=[]; this.onend && this.onend(); };
  window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
});
await page.goto('http://localhost:8753/', { waitUntil: 'load' });
await page.waitForTimeout(600);

console.log('\nWALKTHROUGH');
await shot(page, 'first-open');

const answer = async (qid, phrases, ms) => {
  await page.evaluate((p) => { window.__phrases = p; }, phrases);
  await page.locator('#mic-' + qid).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await page.locator('#mic-' + qid).click();
  await page.waitForTimeout(ms);
};

// 1 — he taps Record on the first question
await answer('q1', SPEECH.q1, 2100);
await shot(page, 'recording-live');
await page.waitForTimeout(1600);
await shot(page, 'recording-more-text');
await page.locator('#mic-q1').click();
await page.waitForTimeout(1200);
await shot(page, 'first-answer-filed');

// 2 — he adds a second part to the same question
await answer('q1', ['One more thing I forgot, the travel approval itself takes about six weeks.'], 2200);
await page.locator('#mic-q1').click();
await page.waitForTimeout(1200);
await shot(page, 'two-parts-same-question');

// 3 — a second and third question
await answer('q3', SPEECH.q3, 3600);
await page.locator('#mic-q3').click();
await page.waitForTimeout(1200);
await answer('q4', SPEECH.q4, 2600);
await page.locator('#mic-q4').click();
await page.waitForTimeout(1400);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await shot(page, 'ledger-three-answered');

// 4 — the synopsis
await page.locator('#synopsis').scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -40));
await page.waitForTimeout(300);
await shot(page, 'synopsis');

// 5 — the two-stage delete
await page.locator('article.q').first().locator('button.danger').first().click();
await page.locator('article.q').first().scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -80));
await page.waitForTimeout(300);
await shot(page, 'delete-armed');
await page.waitForTimeout(4200);   // let it disarm rather than delete his answer

// 6 — send
await page.evaluate(() => {
  window.__shared = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => { window.__shared = d.files.map(f => f.name); return Promise.resolve(); }, configurable: true });
});
await page.locator('#sendall').scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -120));
await page.locator('#sendall').click();
await page.waitForTimeout(700);
await shot(page, 'handed-off');
console.log('  share sheet carried: ' + (await page.evaluate(() => window.__shared)).join(', '));

// 7 — the phone locks mid-recording
await answer('q5', ['They pull the speaker and I find out from the school, not from us.'], 1800);
const before = await page.locator('article.q').nth(4).locator('.clip').count();
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(1200);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.locator('article.q').nth(4).scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -80));
await page.waitForTimeout(300);
await shot(page, 'screen-locked-answer-kept');
console.log(`  clips on q5 before lock ${before}, after ${await page.locator('article.q').nth(4).locator('.clip').count()}`);
await ctx.close();

// 8 — dictation dead: audio still files, nothing is claimed
const dead = await browser.newContext({ ...ip, permissions: ['microphone'] });
await dead.addInitScript(() => {
  function D(){}
  D.prototype.start = function(){ setTimeout(() => this.onerror && this.onerror({error:'network'}), 120); };
  D.prototype.stop = function(){ this.onend && this.onend(); };
  window.SpeechRecognition = D; window.webkitSpeechRecognition = D;
});
const dpg = await dead.newPage();
await dpg.goto('http://localhost:8753/', { waitUntil: 'load' });
await dpg.locator('#mic-q1').click();
await dpg.waitForTimeout(2200);
await dpg.locator('#mic-q1').click();
await dpg.waitForTimeout(1200);
await dpg.locator('article.q').first().scrollIntoViewIfNeeded();
await dpg.evaluate(() => window.scrollBy(0, -80));
await shot(dpg, 'no-dictation-audio-only');
await dead.close();

// 9 — the same session on bigger glass
for (const [w, h, name] of [[768,1024,'ipad'], [1440,900,'desktop']]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2,
    permissions: ['microphone'] });
  await c.addInitScript(() => {
    function F(){ this._t=[]; this._f=[]; }
    F.prototype.start = function () {
      this._f = [];
      (window.__phrases || []).forEach((p, i) => this._t.push(setTimeout(() => {
        this._f.push(p);
        this.onresult && this.onresult({ resultIndex: 0,
          results: this._f.map(t => ({0:{transcript:t}, isFinal:true, length:1})) });
      }, 500 + i * 700)));
    };
    F.prototype.stop = function(){ this._t.forEach(clearTimeout); this._t=[]; this.onend && this.onend(); };
    window.SpeechRecognition = F; window.webkitSpeechRecognition = F;
  });
  const p2 = await c.newPage();
  await p2.goto('http://localhost:8753/', { waitUntil: 'load' });
  await p2.evaluate((ph) => { window.__phrases = ph; }, SPEECH.q1);
  await p2.locator('#mic-q1').click();
  await p2.waitForTimeout(2600);
  await p2.locator('#mic-q1').click();
  await p2.waitForTimeout(1200);
  await shot(p2, name);
  await c.close();
}

await browser.close(); srv.close();
console.log('\n' + OUT);
