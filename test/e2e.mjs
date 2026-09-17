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
ok((await page.locator('#tally').textContent()).trim() === '0 of 13 answered', 'tally starts at 0 of 13');
ok((await page.locator('article.q audio:visible').count()) === 0, 'no dead audio players on a fresh page');
ok(!(await page.locator('#sendall').isVisible()), 'Send all hidden with nothing recorded');
ok((await page.locator('#mic-q1').textContent()) === 'Record', 'button reads Record first time');

const badges = await page.locator('.qnum').allTextContents();
ok(badges.join(',') === Array.from({length: 13}, (_, i) => 'Q' + (i + 1)).join(','),
   `question badges run Q1..Q13 in order (${badges.slice(0, 3).join(',')}...)`);
const firstAsk = await page.locator('article.q').first().locator('.ask').textContent();
ok(/controller travels to speak/.test(firstAsk), 'Q1 badge sits on the release-authority question');
const how = await page.locator('.how').textContent();
ok(/Don't label anything|Don\u2019t label anything/.test(how), 'instructions ask for no labelling');
ok(!/say the question number|Say the question number/i.test(how), 'nothing asks him to speak a number');
ok(/skip the list entirely/.test(how), 'the one-long-recording option is offered');
ok(/Voice Memos/.test(await page.locator('.how').textContent()),
   'Voice Memos named as the main path');

async function record(id, ms) {
  await page.locator('#mic-' + id).click();
  await page.waitForTimeout(ms);
  await page.locator('#mic-' + id).click();
  await page.waitForTimeout(900);
}

console.log('\n=== first recording on q1 ===');
await record('q1', 1200);
const c1 = page.locator('article.q').first();
ok((await c1.locator('.clip').count()) === 1, 'one clip row');
ok((await c1.locator('.clip .part').first().textContent()) === 'Part 1', 'labelled Part 1');
ok(await c1.locator('.clip audio').first().evaluate((a) => !!a.src), 'clip has audio source');
ok((await page.locator('#mic-q1').textContent()) === 'Add another', 'button becomes Add another');
ok((await page.locator('#tally').textContent()).includes('1 of 13 answered'), 'tally counts the answer');
ok(await page.locator('#sendall').isVisible(), 'Send all appears');
ok((await page.locator('#sendall').textContent()) === 'Send it', 'singular label at one clip');

console.log('\n=== ADD a second recording, first survives ===');
await record('q1', 1200);
ok((await c1.locator('.clip').count()) === 2, 'two clip rows — the first was not replaced');
const parts = await c1.locator('.clip .part').allTextContents();
ok(parts.join(',') === 'Part 1,Part 2', `parts labelled in order (${parts.join(',')})`);
const srcs = await c1.locator('.clip audio').evaluateAll((els) => els.map((a) => a.src));
ok(srcs.length === 2 && srcs[0] !== srcs[1] && srcs.every(Boolean), 'both clips have distinct sources');
ok((await page.locator('#tally').textContent()).includes('2 recordings'), 'tally reports 2 recordings');
ok((await page.locator('#sendall').textContent()) === 'Send all 2', 'Send all counts both');

console.log('\n=== a second question, independent ===');
await record('q4', 1200);
ok((await page.locator('#tally').textContent()).includes('2 of 13 answered'), 'two questions answered');
ok((await page.locator('#sendall').textContent()) === 'Send all 3', 'Send all spans questions');
ok((await c1.locator('.clip').count()) === 2, "q1's clips untouched by q4");

console.log('\n=== all of it survives a reload ===');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1000);
ok((await page.locator('article.q').first().locator('.clip').count()) === 2, 'q1 restored with both clips');
ok((await page.locator('#tally').textContent()).includes('2 of 13 answered'), 'tally restored');
ok((await page.locator('#sendall').textContent()) === 'Send all 3', 'Send all restored');
const rparts = await page.locator('article.q').first().locator('.clip .part').allTextContents();
ok(rparts.join(',') === 'Part 1,Part 2', 'restored in recorded order');

console.log('\n=== deleting one leaves the other, renumbered ===');
await page.locator('article.q').first().locator('.clip').first()
  .locator('button', { hasText: 'Delete' }).click();
await page.waitForTimeout(500);
ok((await page.locator('article.q').first().locator('.clip').count()) === 1, 'one clip left');
ok((await page.locator('article.q').first().locator('.clip .part').first().textContent()) === 'Part 1',
   'survivor renumbered to Part 1');
ok((await page.locator('#tally').textContent()).includes('2 of 13 answered'), 'q1 still counts as answered');

console.log('\n=== deleting the last one resets that question ===');
await page.locator('article.q').first().locator('.clip').first()
  .locator('button', { hasText: 'Delete' }).click();
await page.waitForTimeout(500);
ok((await page.locator('article.q').first().locator('.clip').count()) === 0, 'no clips left on q1');
ok((await page.locator('#mic-q1').textContent()) === 'Record', 'button back to Record');
ok((await page.locator('#tally').textContent()).includes('1 of 13 answered'), 'tally drops to 1');

console.log('\n=== transcript coverage checker ===');
await page.locator('#tx').fill('too short');
await page.locator('#checkbtn').click();
ok(/Paste a bit more/.test(await page.locator('#verdict').textContent()),
   'refuses to guess from a scrap');

// The guarantee that matters: unrelated prose must claim NOTHING. A false
// "covered" makes him stop, and that answer is then lost for good.
await page.locator('#tx').fill(
  'I went to the store this morning and bought bread, milk and a newspaper. ' +
  'The weather was pleasant so I walked home through the park and sat on a ' +
  'bench watching the ducks for a while before heading back to the house.');
await page.locator('#checkbtn').click();
const noiseHeard = await page.locator('.vtag.heard').count();
ok(noiseHeard === 0, `unrelated prose claims nothing covered (saw ${noiseHeard})`);

// A real answer to Q1 should register, and should not drag others with it.
await page.locator('#tx').fill(
  'So the way it works is the controller has to be released by their facility. ' +
  'The facility manager is the one who signs off, because it comes down to ' +
  'staffing and coverage on the day. If they are short we are not going ' +
  'anywhere no matter what I have booked.');
await page.locator('#checkbtn').click();
const rows = await page.locator('.vrow').count();
ok(rows === 13, 'a verdict row per question');
const q1tag = await page.locator('.vrow').first().locator('.vtag').textContent();
ok(q1tag === 'sounds covered', `Q1 registers from a real answer (got "${q1tag}")`);
const heardNow = await page.locator('.vtag.heard').count();
ok(heardNow <= 3, `a single answer does not light up the whole list (${heardNow} covered)`);
ok(/not comprehension/.test(await page.locator('#verdict').textContent()),
   'states its own limitation in the result');

await page.locator('#clearbtn').click();
ok((await page.locator('#verdict').textContent()).trim() === '', 'Clear empties the verdict');
ok((await page.locator('#tx').inputValue()) === '', 'Clear empties the box');

console.log('\n=== layout ===');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok(!overflow, 'no horizontal scroll at 390px');
await page.screenshot({ path: '/tmp/intake-light.png' });
await ctx.close();

const dark = await browser.newContext({ permissions: ['microphone'], colorScheme: 'dark', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const dp = await dark.newPage();
await dp.goto('http://localhost:8731/', { waitUntil: 'load' });
const bg = await dp.evaluate(() => getComputedStyle(document.body).backgroundColor);
ok(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `dark theme paints its own background (${bg})`);
await dp.screenshot({ path: '/tmp/intake-dark.png' });

console.log('\n=== console ===');
const real = errors.filter((e) => !/ERR_CERT_AUTHORITY_INVALID/.test(e));
ok(real.length === 0, real.length ? 'page errors: ' + real.join(' | ') : 'no page errors (font CDN cert is this sandbox proxy, ignored)');

await browser.close();
server.close();
console.log(fail.length ? `\nFAILED (${fail.length})` : '\nALL PASS');
process.exit(fail.length ? 1 : 0);
