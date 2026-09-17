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
const badges = await page.locator('.qnum').allTextContents();
ok(badges.join(',') === Array.from({ length: 13 }, (_, i) => 'Q' + (i + 1)).join(','),
   'badges Q1..Q13 in order');

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
ok((await page.locator('label[for="tx"]').count()) === 1, 'textarea has a real label');
// A JS escape in an HTML attribute renders literally — invisible to a parse
// check, obvious to anyone looking at the page.
const ph = await page.locator('#tx').getAttribute('placeholder');
ok(!/\\u[0-9a-f]{4}/i.test(ph), `placeholder has no raw escape (${ph})`);
ok(/\u2026$/.test(ph), 'placeholder ends with a real ellipsis');
const bodyText = await page.locator('body').innerText();
ok(!/\\u[0-9a-f]{4}/i.test(bodyText), 'no literal \\uXXXX anywhere on the rendered page');
ok((await page.locator('#tally').getAttribute('aria-live')) === 'polite', 'tally is announced');
ok((await page.locator('#verdict').getAttribute('aria-live')) === 'polite', 'summary is announced');
ok(await page.locator('button').first().evaluate((b) => getComputedStyle(b).touchAction === 'manipulation'),
   'buttons set touch-action: manipulation');
ok(await page.locator('#mic-q1').evaluate((b) => parseFloat(getComputedStyle(b).minHeight) >= 44),
   'tap targets at least 44px');
ok((await page.locator('[class*="rail"], .strip[style*="border-left"]').count()) === 0 &&
   await page.locator('.how').evaluate((e) => getComputedStyle(e).borderLeftWidth === '0px'),
   'the accent rail is gone from blocks that already carry a fill');
ok(await card(0).evaluate((e) => getComputedStyle(e).borderLeftWidth !== '0px'),
   'the rail survives where it means something (the top three)');

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

console.log('\n=== transcript summary ===');
await page.locator('#tx').fill('too short');
await page.locator('#checkbtn').click();
ok(/Paste a bit more/.test(await page.locator('#verdict').textContent()), 'refuses a scrap');

await page.locator('#tx').fill(
  'So the way it works is the controller has to be released by their facility. ' +
  'The facility manager is the one who signs off, because it comes down to ' +
  'staffing and coverage on the day. If they are short we are not going anywhere.');
await page.locator('#checkbtn').click();
const vtext = await page.locator('#verdict').textContent();
ok(!/sounds covered|not seen|came through/i.test(vtext), 'no verdicts or grades');
const shown = await page.locator('.vrow').count();
ok(shown >= 1 && shown < 13, `only topics with something to show (${shown} of 13)`);
const quoted = await page.locator('.vrow').first().locator('.quotes li').allTextContents();
const pasted = await page.locator('#tx').inputValue();
const norm = (x) => x.replace(/[\u201C\u201D"]/g, '').replace(/\s+/g, ' ').trim();
ok(quoted.length >= 1 && quoted.every((q) => norm(pasted).includes(norm(q).replace(/\u2026$/, ''))),
   'every quote is verbatim from the transcript — nothing invented');

// Clear must not discard a painful paste on one stray tap.
await page.locator('#clearbtn').click();
await page.waitForTimeout(200);
ok((await page.locator('#tx').inputValue()).length > 0, 'first Clear tap keeps the transcript');
ok((await page.locator('#clearbtn').textContent()) === 'Clear the box?', 'Clear arms first');
await page.locator('#clearbtn').click();
await page.waitForTimeout(200);
ok((await page.locator('#tx').inputValue()) === '', 'second tap clears');

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

console.log('\n=== console ===');
const real = errors.filter((e) => !/ERR_CERT_AUTHORITY_INVALID/.test(e));
ok(real.length === 0, real.length ? 'page errors: ' + real.join(' | ')
   : 'no page errors (font CDN cert is this sandbox proxy, ignored)');

await browser.close();
server.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
