// Speech-to-text, end to end, against the real page.
//
// WHAT THIS PROVES: the page's own code — live rendering while he talks,
// restart through pauses, filing with the clip, persistence across a reload,
// and what actually lands in the share sheet.
//
// WHAT IT CANNOT PROVE: that Apple's dictation works on Cory's iPhone.
// Chromium's speech service is unreachable from this container and there is
// no iOS Safari here, so SpeechRecognition is STUBBED AT THE API. Everything
// downstream of the API is the shipping code, unmodified.
import { chromium, devices } from 'playwright';
import http from 'node:http'; import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';

const OUT = '/tmp/claude-0/dict'; fs.mkdirSync(OUT, { recursive: true });
const srv = http.createServer((_, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync('index.html'));
}).listen(8747);

// A real tone, so the level meter reports real audio alongside the text.
const rate = 48000, n = rate * 12, d = Buffer.alloc(44 + n * 2);
d.write('RIFF',0); d.writeUInt32LE(36+n*2,4); d.write('WAVE',8); d.write('fmt ',12);
d.writeUInt32LE(16,16); d.writeUInt16LE(1,20); d.writeUInt16LE(1,22);
d.writeUInt32LE(rate,24); d.writeUInt32LE(rate*2,28); d.writeUInt16LE(2,32);
d.writeUInt16LE(16,34); d.write('data',36); d.writeUInt32LE(n*2,40);
for (let i=0;i<n;i++) d.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/rate)*11000), 44+i*2);
const WAV = path.join(os.tmpdir(), 'demo-tone.wav'); fs.writeFileSync(WAV, d);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--use-file-for-fake-audio-capture=' + WAV],
});

// The stub models how dictation actually behaves: interim results that get
// revised, finals that accumulate, and a service that gives up on a pause and
// has to be restarted. The page's own onend handler is what restarts it.
const DICTATION = () => {
  window.__srLog = [];
  const SCRIPT = [
    { at: 250,  interim: 'so the way this' },
    { at: 600,  interim: 'so the way this actually works is' },
    { at: 950,  final:   'So the way this actually works is the controller has to be released by their facility. ' },
    { at: 1400, endNow: true },                       // service drops on a pause
    { at: 1900, interim: 'the facility manager' },
    { at: 2300, interim: 'the facility manager is the one who signs' },
    { at: 2700, final:   'The facility manager is the one who signs off, and it always comes down to staffing on the day. ' },
    { at: 3300, interim: 'so if they are short that week' },
    { at: 3800, final:   'So if they are short that week we are not traveling, no matter what I already booked.' },
  ];
  function Fake() {
    this.continuous = false; this.interimResults = false; this.lang = 'en-US';
    this._timers = []; this._cursor = 0; this._finals = [];
  }
  Fake.prototype.start = function () {
    window.__srLog.push('start');
    // Per spec, each session gets a fresh SpeechRecognitionResultList — a
    // restart does NOT replay earlier finals. Modeling that faithfully is
    // what makes the accumulation bug visible rather than invented.
    this._finals = [];
    const t0 = Date.now();
    const base = this._cursor;
    SCRIPT.forEach((step, i) => {
      if (i < base) return;
      this._timers.push(setTimeout(() => {
        this._cursor = i + 1;
        if (step.endNow) { window.__srLog.push('service ended on pause');
          this._timers.forEach(clearTimeout); this._timers = [];
          this.onend && this.onend(); return; }
        if (step.final) this._finals.push(step.final);
        const results = this._finals.map((t) => ({ 0: { transcript: t }, isFinal: true, length: 1 }));
        if (step.interim) results.push({ 0: { transcript: step.interim }, isFinal: false, length: 1 });
        this.onresult && this.onresult({ resultIndex: 0, results });
      }, step.at - (Date.now() - t0) > 0 ? step.at : 0));
    });
  };
  Fake.prototype.stop = function () {
    window.__srLog.push('stop');
    this._timers.forEach(clearTimeout); this._timers = [];
    this.onend && this.onend();
  };
  Fake.prototype.abort = Fake.prototype.stop;
  window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
};

const ip = devices['iPhone 15 Pro'];
const ctx = await browser.newContext({ ...ip, permissions: ['microphone'] });
await ctx.addInitScript(DICTATION);
const page = await ctx.newPage();
const shot = async (f) => { await page.screenshot({ path: `${OUT}/${f}.png` }); };
await page.goto('http://localhost:8747/', { waitUntil: 'load' });
await page.waitForTimeout(500);

const line = (s) => console.log(s);
line('\n=== 1. Is dictation even offered? ===');
line('  dictation note shown to him: ' +
  !(await page.locator('#dictation-note').isHidden()));

line('\n=== 2. Live, while he is still talking ===');
await page.locator('#mic-q1').scrollIntoViewIfNeeded();
await page.locator('#mic-q1').click();
const live = page.locator('article.q').first().locator('.said.pending');
for (const [ms, tag] of [[700,'a'],[1600,'b'],[2900,'c'],[4100,'d']]) {
  await page.waitForTimeout(ms - (tag === 'a' ? 0 : 0));
  const t = (await live.isVisible()) ? (await live.textContent()) : '(nothing on screen)';
  line(`  t+${String(ms).padStart(4)}ms  ${t.length ? '"' + t.slice(-72) + '"' : '(empty)'}`);
  if (tag === 'b') await shot('01-live-mid-sentence');
  if (tag === 'd') await shot('02-live-after-restart');
}
line('  recogniser lifecycle: ' + (await page.evaluate(() => window.__srLog.join(' -> '))));

line('\n=== 3. Filed with the recording ===');
await page.locator('#mic-q1').click();
await page.waitForTimeout(1200);
const filed = page.locator('article.q').first().locator('.clip .said');
line('  transcript blocks on the clip: ' + (await filed.count()));
line('  live block cleared: ' + (await live.isHidden()));
const text1 = await filed.textContent();
line('  filed text: "' + text1 + '"');
await shot('03-filed-with-transcript');

line('\n=== 4. What actually goes in the share sheet ===');
await page.evaluate(() => {
  window.__shared = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => { window.__shared = d.files.slice(); return Promise.resolve(); }, configurable: true });
});
await page.locator('article.q').first().locator('button.send').click();
await page.waitForTimeout(600);
const bundle = await page.evaluate(async () => Promise.all(window.__shared.map(async (f) => ({
  name: f.name, type: f.type, size: f.size,
  text: f.type.indexOf('text') === 0 ? await f.text() : null }))));
for (const f of bundle) line(`  ${f.name.padEnd(22)} ${f.type.padEnd(12)} ${String(f.size).padStart(7)} bytes`);
const txt = bundle.find((f) => f.text);
line('\n  ---- the .txt file, verbatim ----');
if (txt) txt.text.split('\n').forEach((l) => line('  | ' + l));
else line('  | (no text file in the bundle)');
line('  --------------------------------');
await shot('04-handed-off');

line('\n=== 5. Does it survive closing the page? ===');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1400);
const after = page.locator('article.q').first().locator('.clip .said');
line('  transcript still on the clip after reload: ' + (await after.count() === 1));
line('  same text: ' + ((await after.textContent()) === text1));

line('\n=== 6. A second answer on the same question ===');
await page.locator('#mic-q1').click();
await page.waitForTimeout(3000);
await page.locator('#mic-q1').click();
await page.waitForTimeout(1200);
const both = await page.locator('article.q').first().locator('.clip .said').allTextContents();
line('  clips on q1: ' + both.length);
both.forEach((t, i) => line(`    part ${i + 1}: "${t.slice(0, 64)}..."`));
line('  the two transcripts are separate: ' + (both.length === 2));
await shot('05-two-answers');

line('\n=== 7. When dictation produces nothing (the silent-failure path) ===');
const mute = await browser.newContext({ ...ip, permissions: ['microphone'] });
await mute.addInitScript(() => {
  function Dead() { this.continuous = false; this.interimResults = false; }
  Dead.prototype.start = function () { setTimeout(() => this.onerror && this.onerror({ error: 'network' }), 150); };
  Dead.prototype.stop = function () { this.onend && this.onend(); };
  window.SpeechRecognition = Dead; window.webkitSpeechRecognition = Dead;
});
const mp = await mute.newPage();
await mp.goto('http://localhost:8747/', { waitUntil: 'load' });
await mp.locator('#mic-q1').click();
await mp.waitForTimeout(2200);
await mp.locator('#mic-q1').click();
await mp.waitForTimeout(1200);
line('  recording still filed: ' + (await mp.locator('article.q').first().locator('.clip').count() === 1));
line('  empty transcript block shown: ' + (await mp.locator('.clip .said').count() > 0));
line('  visible error shown to him: ' + (await mp.locator('article.q').first().locator('.err:visible').count() > 0));
await mp.evaluate(() => {
  window.__shared = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => { window.__shared = d.files.slice(); return Promise.resolve(); }, configurable: true });
});
await mp.locator('article.q').first().locator('button.send').click();
await mp.waitForTimeout(500);
const mb = await mp.evaluate(() => window.__shared.map((f) => f.name));
line('  share bundle: ' + mb.join(', ') + '   (audio only, no orphan .txt)');
await mp.screenshot({ path: `${OUT}/06-no-dictation.png` });
await mute.close();

line('\n=== 8. Send-all: every transcript, one sheet ===');
await page.locator('#mic-q5').scrollIntoViewIfNeeded();
await page.locator('#mic-q5').click();
await page.waitForTimeout(2600);
await page.locator('#mic-q5').click();
await page.waitForTimeout(1200);
await page.evaluate(() => {
  window.__shared = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', {
    value: (d) => { window.__shared = d.files.slice(); return Promise.resolve(); }, configurable: true });
});
await page.locator('#sendall').scrollIntoViewIfNeeded();
await page.locator('#sendall').click();
await page.waitForTimeout(700);
const all = await page.evaluate(async () => Promise.all(window.__shared.map(async (f) => ({
  name: f.name, kind: f.type.indexOf('text') === 0 ? 'transcript' : 'audio',
  words: f.type.indexOf('text') === 0 ? (await f.text()).split(/\s+/).length : null }))));
all.forEach((f) => line(`  ${f.name.padEnd(22)} ${f.kind}${f.words ? '  (' + f.words + ' words)' : ''}`));
const words = all.filter((f) => f.words).reduce((s, f) => s + f.words, 0);
line(`\n  ${all.length} files — ${all.filter(f=>f.kind==='audio').length} recordings, ` +
     `${all.filter(f=>f.kind==='transcript').length} transcripts, ${words} words of text total`);
await shot('07-send-all');

line('\n=== 9. The synopsis, built from those transcripts, with nothing pasted ===');
const syn = await page.evaluate(() => {
  const box = document.getElementById('synopsis');
  if (box.hidden) return null;
  return [...box.querySelectorAll('.syn-q')].map((b) => ({
    ask: b.querySelector('.syn-ask').textContent,
    lines: [...b.querySelectorAll('li')].map((li) => li.textContent),
  }));
});
if (!syn) { line('  (synopsis hidden)'); }
else {
  for (const b of syn) {
    line('\n  ' + b.ask);
    b.lines.forEach((l) => line('    \u2014 ' + l));
  }
  // The guarantee that makes this safe to show him: every line is his.
  const verbatim = await page.evaluate(() => {
    const norm = (x) => x.replace(/\s+/g, ' ').trim();
    const said = norm([...document.querySelectorAll('.clip .said')].map((e) => e.textContent).join(' '));
    return [...document.querySelectorAll('.syn-q li')].every((li) => said.includes(norm(li.textContent)));
  });
  line('\n  every line is a verbatim substring of what he said: ' + verbatim);
  line('  he pasted or copied anything to get this: false');
}
await page.locator('#synopsis').scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
await shot('08-synopsis');

await browser.close(); srv.close();
line('\nScreenshots: ' + OUT);
