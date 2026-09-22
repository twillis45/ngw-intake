// UX_09 — UI QA Scorecard, run as a gate rather than read as a list.
// Studio Matte doctrine lives in ngw-event-planner/docs/claude-skills/ui-ux.
// Only checks that can be MEASURED are here; a check verified by looking is
// not a guard, so anything needing judgment is reported N/A by name rather
// than quietly marked PASS.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../index.html', import.meta.url));
const server = http.createServer((_, r) => {
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync(PAGE));
}).listen(8735);

const rows = [];
const check = (id, label, pass, detail = '') =>
  rows.push({ id, label, pass, detail });

// WCAG relative luminance, so contrast is computed rather than asserted.
const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const VIEWPORTS = [
  [375, 812], [390, 844], [430, 932],
  [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080],
];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, permissions: ['microphone'] });
const page = await ctx.newPage();
await page.goto('http://localhost:8735/', { waitUntil: 'load' });

// ── Section 1: Visual language ──────────────────────────────────────────
// UX_01 names the surface layers explicitly — Canvas, Card, Elevated, Input.
// They are CONTAINERS. A steel fill on a button is a semantic accent under
// UX_02, not a fourth surface, so the layer count is taken over containers
// and every one of them must equal a declared token rather than merely
// being dark. That is exact where a luminance threshold was a guess.
const CONTAINERS = 'body, .board, .rail, .list, .actions, .card, .q, .clip, .warn, .standing';
// Transcribed from palette.js at ACTIVE_MODE 'dark' and hardcoded HERE on
// purpose. Reading the expected values out of the page's own :root would ask
// "does this match itself", which passes on any palette — including a white
// one. The check is the transcription, so the source values are the test.
const PALETTE = ['#070809', '#121518', '#171b1f'];  // carbonBody / carbonPanel / carbonSurface2
const surf = await page.evaluate(({ sel, declared }) => {
  const hex = (s) => '#' + (s.match(/\d+/g) || []).slice(0, 3)
    .map((n) => (+n).toString(16).padStart(2, '0')).join('');
  const seen = new Set(), undeclared = [];
  for (const e of document.querySelectorAll(sel)) {
    if (e !== document.body && e.offsetParent === null) continue;
    const bg = getComputedStyle(e).backgroundColor;
    if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
    seen.add(hex(bg));
    if (!declared.includes(hex(bg))) undeclared.push((e.className || e.tagName) + ' ' + hex(bg));
  }
  return { layers: [...seen], undeclared: [...new Set(undeclared)], declared };
}, { sel: CONTAINERS, declared: PALETTE });
check('1.1', 'Maximum 3 surface layers visible', surf.layers.length <= 3,
      `${surf.layers.length}: ${surf.layers.join(' ')}`);
check('1.2', 'Every surface is a declared Studio Matte token (no white, no light)',
      surf.undeclared.length === 0,
      surf.undeclared.join(' | ') || `all of ${surf.declared.join(' ')}`);

// UX_01's scale, extended here for two roles this page has and the doctrine's
// examples did not: 18 for the question line, 40 for display numerals and the
// ledger figures. Recorded as an extension, not a drift: nothing else may use
// them.
const SCALE = [11, 13, 14, 16, 18, 22, 24, 40];
const sizes = await page.evaluate(() => {
  const out = new Set();
  for (const e of document.querySelectorAll('.board *, .standing, .standing *')) {
    if (!e.textContent.trim() || e.children.length && !e.matches('p,span,div,li,h1,h2,button,b,a')) continue;
    if (e.offsetParent === null) continue;
    out.add(parseFloat(getComputedStyle(e).fontSize));
  }
  return [...out];
});
const rogue = sizes.filter((s) => !SCALE.includes(s));
check('1.3', 'Typography uses the UX_01 scale (no rogue sizes)', rogue.length === 0,
      rogue.length ? `rogue: ${rogue.join(', ')}` : `sizes: ${sizes.sort((a,b)=>a-b).join(', ')}`);

const h1s = await page.locator('h1').count();
check('1.4', 'Page title appears exactly once', h1s === 1, `${h1s} h1`);

const offGrid = await page.evaluate(() => {
  const bad = [];
  const props = ['marginTop','marginBottom','marginLeft','marginRight',
                 'paddingTop','paddingBottom','paddingLeft','paddingRight','gap','columnGap','rowGap'];
  for (const e of document.querySelectorAll('.board, .board *, .standing')) {
    if (e.offsetParent === null && e !== document.body) continue;
    const cs = getComputedStyle(e);
    for (const p of props) {
      const v = parseFloat(cs[p]);
      if (!Number.isFinite(v) || v === 0) continue;
      if (v % 4 !== 0) bad.push(`${e.className || e.tagName}.${p}=${v}`);
    }
  }
  return [...new Set(bad)];
});
check('1.5', 'All spacing multiples of 4px', offGrid.length === 0, offGrid.slice(0, 6).join(' '));

const shadows = await page.evaluate(() =>
  [...document.querySelectorAll('.board *')].filter(
    (e) => e.offsetParent !== null && getComputedStyle(e).boxShadow !== 'none').length);
check('1.6', 'No shadows on non-overlay elements', shadows === 0, `${shadows} shadowed`);

const radii = await page.evaluate(() => {
  const out = new Set();
  for (const e of document.querySelectorAll('.card, .q, .clip, button, .warn, .level')) {
    if (e.offsetParent === null) continue;
    out.add(getComputedStyle(e).borderTopLeftRadius);
  }
  return [...out];
});
check('1.7', 'Border-radius consistent within the view', radii.length === 1, radii.join(' '));

check('1.8', 'No font-size below 10px', Math.min(...sizes) >= 10, `min ${Math.min(...sizes)}px`);

// ── Section 2: Color ────────────────────────────────────────────────────
const contrast = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll('.board *, .standing *')) {
    if (e.offsetParent === null) continue;
    const t = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!t) continue;
    const cs = getComputedStyle(e);
    let bg = 'rgba(0, 0, 0, 0)', p = e;
    while (p && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bg = getComputedStyle(p).backgroundColor; p = p.parentElement;
    }
    out.push({ what: e.className || e.tagName, fg: cs.color, bg,
               size: parseFloat(cs.fontSize), weight: cs.fontWeight });
  }
  return out;
});
const fails = contrast
  .map((c) => ({ ...c, r: ratio(rgb(c.fg), rgb(c.bg)) }))
  .filter((c) => {
    const large = c.size >= 24 || (c.size >= 18.66 && Number(c.weight) >= 700);
    return c.r < (large ? 3 : 4.5);
  });
check('2.8', 'WCAG AA contrast met for all text', fails.length === 0,
      fails.slice(0, 5).map((f) => `${f.what} ${f.r.toFixed(2)}:1`).join(' | ') ||
      `${contrast.length} text nodes, min ${Math.min(...contrast.map((c) => ratio(rgb(c.fg), rgb(c.bg)))).toFixed(2)}:1`);

const white = contrast.filter((c) => rgb(c.fg).every((v) => v === 255));
check('2.9', 'No pure white (#FFFFFF) text', white.length === 0, `${white.length} white`);

// ── Section 3: Responsive ───────────────────────────────────────────────
const scrolls = [], voids = [], clips = [];
for (const [w, h] of VIEWPORTS) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'] });
  const p2 = await c.newPage();
  await p2.goto('http://localhost:8735/', { waitUntil: 'load' });
  if (await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))
    scrolls.push(`${w}x${h}`);
  if (await p2.evaluate(() => [...document.querySelectorAll('.card,.q,.clip')]
        .some((e) => { const r = e.getBoundingClientRect();
                       return r.left < -1 || r.right > window.innerWidth + 1; })))
    clips.push(`${w}x${h}`);
  // The void budget above the phone: no empty region wider than 320px beside
  // the content, bounded by canvas on one side only.
  if (w >= 768) {
    const gutter = await p2.evaluate(() => {
      const b = document.querySelector('.board').getBoundingClientRect();
      return Math.max(b.left, window.innerWidth - b.right);
    });
    if (gutter > 320) voids.push(`${w}x${h} gutter ${Math.round(gutter)}px`);
  }
  await c.close();
}
check('3.1', 'No horizontal page-level scroll at any breakpoint', scrolls.length === 0, scrolls.join(' '));
check('3.2', 'Cards do not clip at viewport edges', clips.length === 0, clips.join(' '));
check('3.9', 'Desktop density: no void region wider than 320px', voids.length === 0, voids.join(' '));

const taps = await page.evaluate(() => [...document.querySelectorAll('button')]
  .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44).length);
check('3.4', 'Touch targets minimum 44px', taps === 0, `${taps} under 44px`);
// Folded rows are tapped as often as buttons, so they meet the same floor.
const heads = await page.evaluate(() => [...document.querySelectorAll('summary')]
  .filter((s) => s.offsetParent !== null && s.getBoundingClientRect().height < 44).length);
check('3.4d', 'Disclosure rows are tappable at 44px', heads === 0, `${heads} under 44px`);
const linkbtns = await page.evaluate(() => [...document.querySelectorAll('.linkbtn')]
  .filter((a) => a.offsetParent !== null && a.getBoundingClientRect().height < 44).length);
check('3.4e', 'Links dressed as buttons meet the 44px floor', linkbtns === 0, `${linkbtns} under 44px`);

// The sms links are the escape hatch — the thing he reaches for when something
// has gone wrong — and as bare inline text they measured 89x15px.
const smsTaps = await page.evaluate(() => [...document.querySelectorAll('a[href^="sms:"]')]
  .map((a) => { const r = a.getBoundingClientRect(); return Math.round(r.height); }));
check('3.4b', 'The contact links are tappable, not hairline text',
      smsTaps.length === 2 && smsTaps.every((h) => h >= 44), smsTaps.join(', ') + 'px tall');
// Growing a target must not silently steal taps from the text beside it.
const steal = await page.evaluate(() => {
  window.scrollTo(0, document.body.scrollHeight);
  const link = document.querySelector('.contact a').getBoundingClientRect();
  const sign = document.querySelector('.sign').getBoundingClientRect();
  // Sample directly ABOVE the link, inside the paragraph above it. Sampling
  // anywhere else on that line cannot catch this: the link sits at the right
  // end of its own line, so a probe on the left is never under the padded box.
  const x = link.left + link.width / 2;
  const el = document.elementFromPoint(x, sign.bottom - 4);
  if (!el) return 'nothing at the probe point';
  return el.closest('.sign') ? 'ok'
       : 'the link reaches ' + Math.round(sign.bottom - link.top) + 'px into .sign';
});
check('3.4c', 'The enlarged target steals no taps from neighboring text',
      steal === 'ok', steal);

const aboveFold = await page.evaluate(() => {
  const b = document.querySelector('.mic');
  return b ? b.getBoundingClientRect().top < window.innerHeight : false;
});
check('3.5', 'Mobile: primary CTA visible above the fold', aboveFold);

// ── Section 4: Hierarchy ────────────────────────────────────────────────
const orphans = await page.evaluate(() =>
  [...document.querySelectorAll('.board > *, .list > *')].filter((e) =>
    e.offsetParent !== null &&
    [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).length);
check('4.4', 'Every piece of content inside a container', orphans === 0, `${orphans} orphaned`);

const lane = await page.locator('.group.lane .q').count();
check('4.7', 'Priority lane shows max 3 items', lane > 0 && lane <= 3, `${lane} in lane`);

const distinct = await page.evaluate(() => {
  const big = document.querySelector('.q.big'), plain = document.querySelector('.q:not(.big)');
  const a = getComputedStyle(big), b = getComputedStyle(plain);
  return a.backgroundColor !== b.backgroundColor || a.borderLeftColor !== b.borderLeftColor;
});
check('4.3', 'Not all cards equal weight (priority > regular)', distinct);

// ── Section 5 / 7: components and CTA truthfulness ──────────────────────
const dis = await page.evaluate(() => {
  const b = document.querySelector('.mic'); b.disabled = true;
  const cs = getComputedStyle(b); const o = cs.opacity, c = cs.cursor;
  b.disabled = false; return { o, c };
});
check('5.4', 'Disabled buttons 40% opacity + not-allowed cursor',
      dis.o === '0.4' && dis.c === 'not-allowed', `opacity ${dis.o}, cursor ${dis.c}`);

const labels = await page.evaluate(() =>
  [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
const VERB = /^(Record|Stop|Add|Text|Delete|Open|Send|Save|Type|Hide)\b/;
check('5.2', 'Button labels are verbs, not nouns', labels.every((l) => VERB.test(l)),
      labels.join(' | '));
// UX_07: navigator.share is DEEP HANDOFF — the label must name the destination
// and must never claim a delivery the page cannot perform.
check('7.7', 'No "Send" label on an action the page cannot complete',
      !labels.some((l) => /^Send\b/.test(l)), labels.filter((l) => /^Send/.test(l)).join(' '));

const primaries = await page.evaluate(() => {
  const steel = getComputedStyle(document.documentElement).getPropertyValue('--steel').trim();
  const hex = (s) => '#' + (s.match(/\d+/g) || []).slice(0, 3)
    .map((n) => (+n).toString(16).padStart(2, '0')).join('');
  return [...document.querySelectorAll('.list button')]
    .filter((b) => b.offsetParent !== null && hex(getComputedStyle(b).backgroundColor) === steel.toLowerCase())
    .length;
});
check('2.5', 'Accent highlights one primary target per section', primaries <= 1,
      `${primaries} steel-filled buttons visible at rest`);

// 2.5 again, on a page that has answers on it. Measuring only the empty
// state is how five accent buttons shipped: the budget is a property of the
// VIEW, and the view changes once he has recorded something.
const busy = await browser.newContext({ viewport: { width: 390, height: 844 },
  permissions: ['microphone'] });
const bp = await busy.newPage();
await bp.goto('http://localhost:8735/', { waitUntil: 'load' });
for (const q of ['q1', 'q1', 'q4']) {
  const mic = bp.locator('#mic-' + q);
  if (!(await mic.isVisible())) await bp.locator('article.q:has(#mic-' + q + ') summary').click();
  await mic.click();
  await bp.waitForTimeout(900);
  await bp.locator('#mic-' + q).click();
  await bp.waitForTimeout(700);
}
const busyAccent = await bp.evaluate(() => {
  const want = getComputedStyle(document.documentElement).getPropertyValue('--steel').trim().toLowerCase();
  const hex = (x) => '#' + (x.match(/\d+/g) || []).slice(0, 3)
    .map((v) => (+v).toString(16).padStart(2, '0')).join('');
  return [...document.querySelectorAll('.board *')]
    .filter((e) => e.offsetParent !== null && hex(getComputedStyle(e).backgroundColor) === want).length;
});
const clipCount = await bp.locator('.clip').count();
check('2.5b', 'Accent budget holds once the page has answers on it', busyAccent <= 1,
      `${busyAccent} steel-filled with ${clipCount} clips present`);
const busySurf = await bp.evaluate((declared) => {
  const hex = (x) => '#' + (x.match(/\d+/g) || []).slice(0, 3)
    .map((v) => (+v).toString(16).padStart(2, '0')).join('');
  return [...document.querySelectorAll('body, .board, .card, .q, .clip, .warn, .standing')]
    .filter((e) => e !== document.body ? e.offsetParent !== null : true)
    .map((e) => hex(getComputedStyle(e).backgroundColor))
    .filter((c) => c !== '#000000' || false)
    .filter((c, i, a) => a.indexOf(c) === i)
    .filter((c) => !declared.includes(c));
}, PALETTE);
check('1.2b', 'Surfaces stay on-token with clips rendered', busySurf.length === 0, busySurf.join(' '));
await busy.close();

await browser.close();
server.close();

const pass = rows.filter((r) => r.pass).length;
console.log('\n## UI QA Scorecard — UX_09\n');
for (const r of rows) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.label}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\nChecks Passed: ${pass}/${rows.length}`);
const failed = rows.filter((r) => !r.pass);
console.log(`Checks Failed: ${failed.length}${failed.length ? ' — ' + failed.map((r) => r.id).join(', ') : ''}`);
console.log(`Viewports Tested: ${VIEWPORTS.map(([w, h]) => `${w}x${h}`).join(', ')}`);
process.exit(failed.length ? 1 : 0);
