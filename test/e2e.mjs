// Drives the real page in Chromium against a fake microphone.
// localhost is a secure context, so getUserMedia is allowed without TLS.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
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
ok((await page.locator('#tally').textContent()).trim() === '0 of 13 answered', 'tally at zero');
ok(!(await page.locator('#sendall').isVisible()), 'Send all hidden');
ok((await page.locator('article.q audio:visible').count()) === 0, 'no dead audio players');
const nums = await page.locator('.qnum').allTextContents();
ok(nums.join(',') === Array.from({ length: 13 }, (_, i) => String(i + 1)).join(','),
   'margin numbers run 1..13 in order');

console.log('\n=== copy ===');
const how = await page.locator('.how').textContent();
ok(/No names, no numbers, no labelling/.test(how), 'asks for no labelling');
ok(!/say the question number/i.test(how), 'never asks him to speak a number');
ok(/skip the list/.test(how), 'the one-long-recording option is offered');
ok(/stays in this browser on this phone/.test(how), 'says where recordings live');
ok(/Recording in Voice Memos instead/.test(await page.locator('.tallynote').textContent()),
   'tally explains it cannot see Voice Memos');
ok(/Text me/.test(await page.locator('.contact').textContent()), 'a way to reach him exists');

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
// The page is a document, not a stack of cards: nothing but the transcript
// quote block and the one warning may draw a box or a fill.
const boxes = await page.evaluate(() => {
  const sel = 'header, .how, article.q, .footer-bar, .check';
  return [...document.querySelectorAll(sel)].filter((e) => {
    const c = getComputedStyle(e);
    const bg = c.backgroundColor;
    const filled = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const boxed = ['Top', 'Right', 'Bottom', 'Left']
      .filter((s) => parseFloat(c['border' + s + 'Width']) > 0).length >= 2;
    return filled || boxed;
  }).length;
});
ok(boxes === 0, `no panels, cards or tinted blocks (${boxes} found)`);
const accent = await page.evaluate(() => {
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent)';
  document.body.appendChild(probe);
  const acc = getComputedStyle(probe).color;
  probe.remove();
  const uses = [...document.querySelectorAll('.wrap *')]
    .filter((e) => getComputedStyle(e).color === acc && e.offsetParent !== null);
  return { acc, count: uses.length, onBig: uses.filter((e) => e.closest('.q.big')).length };
});
ok(accent.count > 0, `the accent is actually applied somewhere (${accent.acc})`);
ok(accent.count === 3 && accent.onBig === 3,
   `accent used exactly on the first three questions and nowhere else (${accent.count} uses, ${accent.onBig} on .big)`);
ok(await card(0).evaluate((e) => getComputedStyle(e).borderTopWidth === '1px'),
   'entries are separated by a hairline, not boxed');

console.log('\n=== recording: the state machine ===');
await page.locator('#mic-q1').click();
await page.waitForTimeout(700);
ok((await page.locator('#mic-q1').textContent()) === 'Stop', 'button reads Stop while live');
ok(await page.locator('#mic-q4').isDisabled(), 'other questions disabled while one records');
ok(await card(0).locator('.keepon').isVisible(), 'screen-lock warning shows where it applies');
await page.waitForTimeout(900);
await page.locator('#mic-q1').click();
await page.waitForTimeout(900);
ok(!(await page.locator('#mic-q4').isDisabled()), 'others re-enabled after stop');
ok(await card(0).locator('.keepon').isHidden(), 'warning hidden again');
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
ok((await page.locator('#tally').textContent()).includes('3 of 13 answered'), 'restored after reload');
ok(!(await page.locator('#restorefail').isVisible()), 'no false restore-failure banner');

console.log('\n=== dictation degrades silently ===');
// Chromium here has no working speech service, so this proves the path nobody
// should ever notice: no transcript, no error, recording unaffected.
const dict = await page.evaluate(() => ({
  api: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  noteShown: !document.getElementById('dictation-note').hidden,
}));
ok(dict.noteShown === dict.api,
   `the dictation note appears only where dictation exists (api=${dict.api})`);
ok((await page.locator('.said').count()) === 0 || dict.api,
   'no transcript block without dictation');
ok((await card(0).locator('.clip').count()) > 0, 'recordings still file with dictation absent');

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
  const wrap = document.querySelector('.wrap').getBoundingClientRect();
  return {
    hangingNumber: q.querySelector('.qnum').getBoundingClientRect().right <= ask.left + 1,
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
ok(L.hangingNumber, 'the number hangs in the margin beside the question');
ok(!L.hScroll, 'no horizontal scroll at 1920px');
ok(L.whyCh >= 45 && L.whyCh <= 72, `line length stays readable on desktop (${L.whyCh}ch)`);
ok(L.column >= 560 && L.column <= 660, `measure stays readable on desktop (${L.column}px)`);
ok(L.bodyPx >= 16, `type scales up for desktop (${L.bodyPx}px)`);
await wp.screenshot({ path: '/tmp/intake-desktop.png' });
await wide.close();

console.log('\n=== console ===');
const real = errors.filter((e) => !/ERR_CERT_AUTHORITY_INVALID/.test(e));
ok(real.length === 0, real.length ? 'page errors: ' + real.join(' | ')
   : 'no page errors (font CDN cert is this sandbox proxy, ignored)');

await browser.close();
server.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
