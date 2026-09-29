// Stage-4 measurement pass for the ngw-program-planner surface.
//
// WHY IT LIVES HERE. The planner is zero-dependency by doctrine, and this pass
// needs a real browser: the Path to Production requires computed geometry
// asserted with getBoundingClientRect and getComputedStyle on any surface that
// renders in more than one layout regime. The planner's renders in four. Owner
// decision, September 29, 2026 — run it from this repo, which already drives
// 28 design checks across 8 viewports, rather than give the planner its first
// dependency.
//
// Only checks that can be MEASURED are here. A criterion verified by looking
// is not a guard, so anything needing judgment is reported by name rather than
// quietly marked PASS.
//
//   cd ../ngw-program-planner && npm run surface
//   cd ../ngw-intake && node test/planner-surface.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.env.PLANNER_SURFACE
  ?? fileURLToPath(new URL('../../ngw-program-planner/surface', import.meta.url));

if (!fs.existsSync(DIR)) {
  console.error(`\nNo surface at ${DIR}\n`);
  console.error('Render it first:  cd ../ngw-program-planner && npm run surface\n');
  process.exit(2);
}

const SCREENS = ['budget', 'plan', 'roster'];
const THEMES = ['light', 'dark'];
// The regimes the spec names. Law 4 makes parity a requirement, so every
// assertion below runs in both themes at both widths.
const WIDTHS = [390, 1440];

const server = http.createServer((q, r) => {
  const f = path.join(DIR, decodeURIComponent(q.url.split('?')[0]));
  if (f.startsWith(DIR) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    r.end(fs.readFileSync(f));
  } else { r.writeHead(404); r.end('no'); }
}).listen(8741);

const rows = [];
const check = (id, label, pass, detail = '') => rows.push({ id, label, pass, detail });

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
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const tag = `${theme}/${width}`;

    for (const screen of SCREENS) {
      await page.goto(`http://localhost:8741/${theme}/${screen}.html`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(120);
      const m = await page.evaluate(() => {
        const cs = (el) => getComputedStyle(el);
        const interactive = [...document.querySelectorAll('a, button, input, select, textarea')];
        return {
          // The gate must be on the page and actually painted, not merely in
          // the markup with zero height.
          gate: (() => {
            const g = document.querySelector('.gate');
            if (!g) return null;
            const r = g.getBoundingClientRect();
            return { text: g.textContent.trim().slice(0, 60), h: r.height, w: r.width };
          })(),
          // Touch targets, measured. The spec found real buttons at 38, 34 and
          // 32px in the prototype.
          smallTargets: interactive
            .map((el) => ({ t: el.tagName, txt: el.textContent.trim().slice(0, 24), h: el.getBoundingClientRect().height }))
            .filter((x) => x.h > 0 && x.h < 44),
          // The caption floor. `.cert` rendered at 10px in the prototype
          // against a stated 11px floor.
          certSizes: [...document.querySelectorAll('.cert')]
            .map((el) => parseFloat(cs(el).fontSize)),
          overflow: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
          // Nothing may sit outside the viewport horizontally.
          clipped: [...document.querySelectorAll('main *')]
            .map((el) => ({ c: el.className || el.tagName, r: el.getBoundingClientRect() }))
            .filter((x) => x.r.width > 0 && (x.r.left < -1 || x.r.right > document.documentElement.clientWidth + 1))
            .map((x) => String(x.c).slice(0, 24)),
          ink: cs(document.body).color,
          bg: cs(document.body).backgroundColor,
          // The EFFECTIVE background, composited. A status pill in the dark
          // theme is a 14% wash over its card, so reading its own
          // backgroundColor as opaque compares the text against a colour that
          // is never painted — it reported "Action needed" at 1.00:1, which is
          // text on itself, about a pill that is legible. Walk up for an
          // opaque backdrop and blend the stack over it.
          pills: [...document.querySelectorAll('.pill')].slice(0, 12).map((el) => {
            const parse = (c) => {
              const n = (c.match(/[\d.]+/g) || []).map(Number);
              return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 1 };
            };
            const over = (fg, bg) => ({
              r: fg.a * fg.r + (1 - fg.a) * bg.r,
              g: fg.a * fg.g + (1 - fg.a) * bg.g,
              b: fg.a * fg.b + (1 - fg.a) * bg.b,
              a: 1,
            });
            const stack = [];
            for (let n = el; n; n = n.parentElement) {
              const c = parse(cs(n).backgroundColor);
              if (c.a === 0) continue;
              stack.push(c);
              if (c.a === 1) break;
            }
            let eff = stack.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
            while (stack.length) eff = over(stack.pop(), eff);
            return {
              cls: el.className, fg: cs(el).color,
              bg: `rgb(${Math.round(eff.r)}, ${Math.round(eff.g)}, ${Math.round(eff.b)})`,
              txt: el.textContent.trim().slice(0, 18),
            };
          }),
        };
      });

      check(`G/${tag}/${screen}`, 'the ship gate is painted on the page',
        Boolean(m.gate && m.gate.h > 20 && /Ship gate/.test(m.gate.text)),
        m.gate ? `${Math.round(m.gate.h)}px — ${m.gate.text}` : 'no .gate element');

      check(`T/${tag}/${screen}`, 'every interactive target is at least 44px tall',
        m.smallTargets.length === 0,
        m.smallTargets.map((x) => `${x.t} "${x.txt}" ${Math.round(x.h)}px`).join('; '));

      const minCert = m.certSizes.length ? Math.min(...m.certSizes) : null;
      check(`C/${tag}/${screen}`, 'caption text is at least 11px',
        minCert === null || minCert >= 11,
        minCert === null ? 'no .cert on this screen' : `smallest ${minCert}px`);

      check(`O/${tag}/${screen}`, 'the page does not scroll sideways',
        m.overflow.scroll <= m.overflow.client + 1,
        `${m.overflow.scroll} vs ${m.overflow.client}`);

      check(`X/${tag}/${screen}`, 'nothing is clipped at the viewport edge',
        m.clipped.length === 0, m.clipped.slice(0, 4).join(', '));

      const body = ratio(rgb(m.ink), rgb(m.bg));
      check(`K/${tag}/${screen}`, 'body text clears 4.5:1 on its own background',
        body >= 4.5, `${body.toFixed(2)}:1`);

      const badPills = m.pills
        .map((p) => ({ ...p, r: ratio(rgb(p.fg), rgb(p.bg)) }))
        .filter((p) => p.r < 4.5);
      check(`P/${tag}/${screen}`, 'every status pill clears 4.5:1',
        badPills.length === 0,
        badPills.map((p) => `"${p.txt}" ${p.r.toFixed(2)}:1`).join('; '));
    }
    await ctx.close();
  }
}

await browser.close();
server.close();

const pass = rows.filter((r) => r.pass).length;
const fail = rows.filter((r) => !r.pass);
console.log(`\nPlanner surface — stage-4 measurement pass`);
console.log(`Measured in a real browser at ${WIDTHS.join(' and ')} px, ${THEMES.join(' and ')}.\n`);
for (const r of fail) console.log(`  FAIL  ${r.id}  ${r.label}${r.detail ? `\n          ${r.detail}` : ''}`);
console.log(`\n  passed ${pass}/${rows.length}`);
if (fail.length) { console.log(`  FAILED ${fail.length}\n`); process.exit(1); }
console.log('  ALL PASS\n');
