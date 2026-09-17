// End-to-end proof of the intake page's record path, against a fake mic.
// localhost counts as a secure context, so getUserMedia is allowed here without TLS.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';

const PAGE = new URL('../index.html', import.meta.url).pathname;
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
  viewport: { width: 390, height: 844 },      // iPhone-ish
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:8731/', { waitUntil: 'load' });

console.log('\n=== page at rest ===');
ok(!(await page.locator('#insecure').isVisible()), 'no insecure-context warning on localhost');
ok(!(await page.locator('#unsupported').isVisible()), 'no unsupported-browser warning');
ok((await page.locator('article.q').count()) === 13, '13 question cards rendered');
ok((await page.locator('#tally').textContent()).trim() === '0 of 13 recorded', 'tally starts at 0 of 13');
ok(await page.locator('#mic-q1').isEnabled(), 'record button enabled');
ok((await page.locator('article.q audio:visible').count()) === 0, 'no dead audio players on a fresh page');

console.log('\n=== record on q1 ===');
await page.locator('#mic-q1').click();
await page.waitForTimeout(400);
ok(await page.locator('#mic-q1').evaluate((b) => b.classList.contains('live')), 'button goes live while recording');
ok((await page.locator('#mic-q1').textContent()) === 'Stop', 'button reads Stop');
await page.waitForTimeout(1400);
const t = await page.locator('article.q').first().locator('.time').textContent();
ok(/^0:0[12]$/.test(t), `timer counted up (saw ${t})`);

await page.locator('#mic-q1').click();                       // stop
await page.waitForFunction(() => {
  const a = document.querySelector('article.q audio');
  return a && a.src && a.src.length > 0;
}, null, { timeout: 5000 }).catch(() => {});

console.log('\n=== after stop ===');
const card = page.locator('article.q').first();
ok(await card.locator('audio').evaluate((a) => !!a.src), 'audio source attached');
ok(await card.locator('audio').isVisible(), 'player revealed with the clip');
ok(await card.evaluate((c) => c.classList.contains('has-rec')), 'card marked as recorded');
ok(await card.locator('button.send').isVisible(), 'Send button shown');
ok(!(await page.locator('#mic-q1').isVisible()), 'Record button hidden once there is a clip');
ok((await page.locator('#tally').textContent()).trim() === '1 of 13 recorded', 'tally updated to 1 of 13');
const mime = await card.locator('audio').evaluate(async (a) => (await fetch(a.src)).blob().then((b) => b.type));
ok(/^audio\//.test(mime), `clip is audio (${mime})`);
const size = await card.locator('audio').evaluate(async (a) => (await fetch(a.src)).blob().then((b) => b.size));
ok(size > 0, `clip has bytes (${size})`);

console.log('\n=== survives a reload (IndexedDB) ===');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(700);
ok((await page.locator('#tally').textContent()).trim() === '1 of 13 recorded', 'clip restored after reload');
ok(await page.locator('article.q').first().locator('audio').evaluate((a) => !!a.src), 'restored clip has a source');

console.log('\n=== redo clears it ===');
await page.locator('article.q').first().locator('button', { hasText: 'Redo' }).click();
await page.waitForTimeout(400);
ok((await page.locator('#tally').textContent()).trim() === '0 of 13 recorded', 'tally back to 0 after Redo');
ok(await page.locator('#mic-q1').isVisible(), 'Record button returns');
ok(!(await page.locator('article.q').first().locator('audio').isVisible()), 'player hidden again after Redo');
ok(await page.locator('article.q').first().locator('audio').evaluate((a) => !a.src && (isNaN(a.duration) || a.duration === 0)), 'decoded buffer dropped, not just the src');

console.log('\n=== layout ===');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok(!overflow, 'no horizontal scroll at 390px');

await page.screenshot({ path: '/tmp/intake-light.png', fullPage: false });
await ctx.close();

const dark = await browser.newContext({ permissions: ['microphone'], colorScheme: 'dark', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const dp = await dark.newPage();
await dp.goto('http://localhost:8731/', { waitUntil: 'load' });
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `dark theme paints its own background (${bg})`);
await dp.screenshot({ path: '/tmp/intake-dark.png' });

console.log('\n=== console ===');
ok(errors.length === 0, errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors');

await browser.close();
server.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
