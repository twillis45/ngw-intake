// Speak a seeded script INTO the page and check what comes back out.
//
// Two things are under test and they are independent:
//   RECORDING — does the MediaRecorder capture the speech faithfully? Checked
//     by decoding the recorded blob back to PCM in the page and comparing its
//     duration and loudness envelope against the source WAV.
//   TRANSCRIBING — does SpeechRecognition (the real one, not a stub) return
//     text for that speech? Reported as whatever actually happens, including
//     "the service never answered", which is a legitimate outcome here.
import { chromium, devices } from 'playwright';
import http from 'node:http'; import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SEED = process.argv[2] || 'cory-001';
const OUTDIR = '/tmp/claude-0/speech';
execFileSync('python3', ['-W', 'ignore',
  fileURLToPath(new URL('speech.py', import.meta.url)), '--seed', SEED, '--out', OUTDIR],
  { stdio: 'inherit' });
const manifest = JSON.parse(fs.readFileSync(`${OUTDIR}/manifest.json`, 'utf8'));

const PAGE = fileURLToPath(new URL('../index.html', import.meta.url));
const srv = http.createServer((_, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(PAGE));
}).listen(8757);

// Source loudness envelope, straight off the WAV, for comparison later.
const STEP = 0.05;                                   // seconds per envelope bucket
const envelopeOf = (wav) => {
  const b = fs.readFileSync(wav);
  let off = 12;
  while (off < b.length - 8) {                       // walk the RIFF chunks
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'data') { off += 8; var dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(dataLen / 2), per = Math.round(48000 * STEP);
  const buckets = Math.floor(n / per), out = [];
  for (let k = 0; k < buckets; k++) {
    let sum = 0;
    for (let i = 0; i < per; i++) {
      const v = b.readInt16LE(off + (k * per + i) * 2) / 32768;
      sum += v * v;
    }
    out.push(Math.sqrt(sum / per));
  }
  return { seconds: n / 48000, env: out };
};

// A correlation against the source was tried first and abandoned: Chromium
// loops --use-file-for-fake-audio-capture at a phase nothing here controls, so
// the score measured alignment, not fidelity. These statistics are computed
// from the loudness envelope and are rotation-invariant, so they answer the
// real question — is the recorded material the same material — without
// depending on where in the loop capture happened to begin.
const stats = (env) => {
  const s = [...env].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const rms = Math.sqrt(env.reduce((t, v) => t + v * v, 0) / env.length);
  const quiet = env.filter((v) => v < 0.02).length / env.length;
  // p90/p25, not p90/p10: the fixtures carry silence padding, so a p10 near
  // zero made the ratio meaningless (six-figure "dynamic range").
  return { rms, p25: q(0.25), p50: q(0.50), p90: q(0.90),
           dyn: q(0.90) / Math.max(q(0.25), 1e-4), quiet };
};
const pct = (a, b) => (b === 0 ? 0 : Math.abs(a - b) / b);

const QIDS = Object.keys(manifest.answers);
const results = [];

for (const qid of QIDS) {
  const a = manifest.answers[qid];
  const src = envelopeOf(a.wav);
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--use-file-for-fake-audio-capture=' + a.wav],
  });
  const ctx = await browser.newContext({ ...devices['iPhone 15 Pro'], permissions: ['microphone'] });
  const page = await ctx.newPage();
  const srEvents = [];
  await page.exposeFunction('__sr', (e) => srEvents.push(e));
  await page.addInitScript(() => {
    // Watch the REAL recogniser rather than replacing it, so whatever the
    // service does is what gets reported.
    const Real = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!Real) { window.__noSR = true; return; }
    function Wrapped() {
      const r = new Real();
      ['start', 'end', 'error', 'result', 'nomatch', 'audiostart', 'audioend',
       'speechstart', 'speechend', 'soundstart'].forEach((ev) => {
        r.addEventListener(ev, (e) => {
          let d = { type: ev };
          if (ev === 'error') d.error = e.error + (e.message ? ' — ' + e.message : '');
          if (ev === 'result') {
            d.n = e.results.length;
            d.text = [...e.results].map((x) => x[0].transcript).join('');
          }
          window.__sr(d);
        });
      });
      return r;
    }
    window.webkitSpeechRecognition = Wrapped; window.SpeechRecognition = Wrapped;
  });
  await page.goto('http://localhost:8757/', { waitUntil: 'load' });

  const record = Math.min(a.seconds + 1.0, 30) * 1000;
  process.stdout.write(`\n${qid}  speaking ${a.seconds}s of real audio into the recorder... `);
  await page.locator('#mic-' + qid).click();
  await page.waitForTimeout(record);
  await page.locator('#mic-' + qid).click();
  await page.waitForTimeout(1500);

  const got = await page.evaluate(async (buckets) => {
    const el = document.querySelector('article.q audio');
    const said = document.querySelector('.clip .said');
    if (!el) return { filed: false };
    const blob = await fetch(el.src).then((r) => r.blob());
    const buf = await blob.arrayBuffer();
    let dec = null, env = null, secs = null, peak = null;
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      dec = await ac.decodeAudioData(buf.slice(0));
      const ch = dec.getChannelData(0);
      secs = dec.duration;
      const per = Math.floor(ch.length / buckets); env = []; peak = 0;
      for (let k = 0; k < buckets; k++) {
        let s = 0;
        for (let i = 0; i < per; i++) { const v = ch[k * per + i]; s += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
        env.push(Math.sqrt(s / per));
      }
      await ac.close();
    } catch (e) { return { filed: true, bytes: blob.size, decodeError: String(e) }; }
    // hand the bytes back so the run leaves something audible behind
    const b64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result.split(',')[1]);
      fr.readAsDataURL(blob);
    });
    return { filed: true, bytes: blob.size, type: blob.type, secs, env, peak, b64,
             transcript: said ? said.textContent : null,
             noSR: !!window.__noSR };
  }, Math.max(8, Math.round(a.seconds / 0.05)));

  if (got.b64) {
    const ext = (got.type || '').indexOf('mp4') > -1 ? 'm4a' : 'webm';
    const out = `${OUTDIR}/recorded-${qid}.${ext}`;
    fs.writeFileSync(out, Buffer.from(got.b64, 'base64'));
    got.saved = out; delete got.b64;
  }
  results.push({ qid, a, src, got, srEvents: srEvents.slice() });
  console.log(got.filed ? 'filed.' : 'NOTHING FILED.');
  await browser.close();
}
srv.close();

// ── report ───────────────────────────────────────────────────────────────
console.log('\n\n================ RECORDING ================');
console.log('seed: ' + manifest.seed + '   (re-run with the same seed for the same words)\n');
let issues = [];
for (const r of results) {
  const { qid, src, got } = r;
  if (!got.filed) { issues.push(`${qid}: nothing was filed at all`); console.log(`${qid}  FAILED — no clip`); continue; }
  if (got.decodeError) { issues.push(`${qid}: recorded audio would not decode — ${got.decodeError}`); console.log(`${qid}  ${got.decodeError}`); continue; }
  const S = stats(src.env), G = stats(got.env);
  const drift = got.secs - src.seconds;
  console.log(
    `\n${qid}  spoke ${src.seconds.toFixed(2)}s  ->  recorded ${got.secs.toFixed(2)}s ` +
    `(${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s), ${got.bytes} bytes, ${got.type}\n` +
    `      source   rms ${S.rms.toFixed(3)}  median ${S.p50.toFixed(3)}  ` +
    `dynamic range ${S.dyn.toFixed(1)}x  silence ${(S.quiet * 100).toFixed(0)}%\n` +
    `      recorded rms ${G.rms.toFixed(3)}  median ${G.p50.toFixed(3)}  ` +
    `dynamic range ${G.dyn.toFixed(1)}x  silence ${(G.quiet * 100).toFixed(0)}%` +
    (got.saved ? `\n      saved: ${got.saved}` : ''));

  if (got.peak < 0.02) issues.push(`${qid}: recording is effectively silent (peak ${got.peak.toFixed(3)})`);
  if (drift < -0.5) issues.push(`${qid}: recording is ${(-drift).toFixed(2)}s SHORT of the speech — audio was lost`);
  // Speech alternates loud and quiet; a tone, a hum or a dead line does not.
  if (G.dyn < 5) issues.push(`${qid}: recorded audio lacks speech structure (dynamic range ${G.dyn.toFixed(1)}x)`);
  if (pct(G.rms, S.rms) > 0.5) issues.push(`${qid}: recorded loudness is ${(pct(G.rms, S.rms) * 100).toFixed(0)}% off the source`);
  if (pct(G.quiet, S.quiet) > 0.6 && Math.abs(G.quiet - S.quiet) > 0.12)
    issues.push(`${qid}: silence fraction ${(G.quiet * 100).toFixed(0)}% vs source ${(S.quiet * 100).toFixed(0)}%`);
}

console.log('\n================ TRANSCRIBING ================');
for (const r of results) {
  const kinds = r.srEvents.map((e) => e.type);
  const starts = kinds.filter((k) => k === 'start').length;
  const errs = [...new Set(r.srEvents.filter((e) => e.type === 'error').map((e) => e.error))];
  const best = r.srEvents.filter((e) => e.type === 'result').pop();
  const uniq = [...new Set(kinds)];
  console.log(`\n${r.qid}  ${kinds.length} recogniser events (${uniq.join(', ')}) — ${starts} start attempts`);
  if (starts > 20) issues.push(`${r.qid}: recogniser restarted ${starts} times in one recording`);
  if (errs.length) console.log(`      errors: ${errs.join(' | ')}`);
  console.log(`      spoken:     "${r.a.text.slice(0, 90)}${r.a.text.length > 90 ? '...' : ''}"`);
  console.log(`      recognized: ${best ? '"' + best.text.slice(0, 90) + '"' : '(nothing)'}`);
  console.log(`      on the clip: ${r.got.transcript ? '"' + r.got.transcript.slice(0, 70) + '..."' : '(no transcript block)'}`);
}

console.log('\n================ ISSUES ================');
if (!issues.length) console.log('Recording: none found.');
else issues.forEach((i) => console.log('  - ' + i));
const anyText = results.some((r) => r.srEvents.some((e) => e.type === 'result'));
console.log(anyText
  ? '\nTranscription: the recogniser returned text (see above).'
  : '\nTranscription: the recogniser returned NO text in this environment.\n' +
    '  That is expected here and is not a page defect — Chrome\'s Web Speech API\n' +
    '  posts audio to a Google endpoint, which this sandbox does not reach. It says\n' +
    '  nothing either way about Apple\'s on-device dictation on an iPhone.');
