// ============================================================
// ai-live.mjs — live run of the three AI features against the real model:
// the app in a headless browser (vite dev), /api/detect-plan mounted in the
// same process, and the buttons clicked as a user would:
//   detect  AI Detect on the whole page (room outlines, reviewed before adding)
//   label   "Name rooms with AI" on a sheet with no text (the crooked scan)
//   review  "Check the trace with AI" on the vector sheet
// Each call's request summary, the answer and a screenshot land in --out.
//
//   ANTHROPIC_API_KEY=… node scripts/ai-live.mjs [--out dir] [--only detect,label,review]
//     [--vector samples/sample-house.pdf] [--scan samples/sample-house-scanned.pdf] [--scan-scale 1/4]
// (TILETAKEOFF_ANTHROPIC_KEY or TT_ANTHROPIC_KEY is read when ANTHROPIC_API_KEY isn't set.) The route runs
// without sign-in here: no Supabase env reaches it.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'ai-live')));
const ONLY = new Set(arg('only', 'detect,label,review').split(','));
const VECTOR = path.resolve(arg('vector', 'samples/sample-house.pdf'));
const SCAN = path.resolve(arg('scan', 'samples/sample-house-scanned.pdf'));

process.env.ANTHROPIC_API_KEY ||= process.env.TILETAKEOFF_ANTHROPIC_KEY || process.env.TT_ANTHROPIC_KEY || '';
if (!process.env.ANTHROPIC_API_KEY) { console.error('No ANTHROPIC_API_KEY (or TILETAKEOFF_ANTHROPIC_KEY / TT_ANTHROPIC_KEY) in the environment.'); process.exit(2); }
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) delete process.env[k];
fs.mkdirSync(OUT, { recursive: true });

const { default: handler } = await import('../api/detect-plan.js');
const { createServer } = await import('vite');
// Playwright: the project's own, else the global install
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules_global', 'x'))('playwright')); }

// ---- the API route, Vercel-style req/res ----
const apiPlugin = {
  name: 'detect-plan-api',
  configureServer(server) {
    server.middlewares.use('/api/detect-plan', async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      const vres = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(o) { res.statusCode = this.statusCode; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); return this; },
      };
      try { await handler(req, vres); } catch (e) { vres.status(500).json({ error: String(e?.message || e) }); }
    });
  },
};

const server = await createServer({ plugins: [apiPlugin], server: { host: '127.0.0.1', port: 5199 }, logLevel: 'warn', clearScreen: false });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch().catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }));
const report = { at: new Date().toISOString(), runs: {} };

/** polygon area in the image's px² */
const pxArea = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;

async function openApp(pdf) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('tt.entered', '1'); } catch (_) {} });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(url);
  page.on('console', (m) => { if (m.type() === 'error') console.error('  console:', m.text()); });
  await page.setInputFiles('header input[type=file]', pdf);
  await page.locator('button.tr-run').waitFor({ timeout: 60_000 })
    .catch(async (e) => { await page.screenshot({ path: path.join(OUT, 'open-failed.png') }); throw e; });
  return { ctx, page };
}

async function trace(page, scale) {
  // a scan has no scale note to read: pick the one printed on the sheet, as a user would
  if (scale) await page.locator(`select:has(option[value="${scale}"])`).first().selectOption(scale);
  await page.locator('button.tr-run').click();
  await page.locator('button.tr-run', { hasText: 'Re-trace plan' }).waitFor({ timeout: 120_000 })
    .catch(async (e) => { await page.screenshot({ path: path.join(OUT, 'trace-failed.png') }); throw e; });
  return page.$$eval('.tr-room', (els) => els.map((el) => ({
    name: el.querySelector('.tr-name')?.value, nums: [...el.querySelectorAll('.tr-num')].map((n) => n.textContent),
  })));
}

/** click, wait for the route's answer, keep request summary + answer */
async function callAI(page, click, label) {
  const t0 = Date.now();
  const wait = page.waitForResponse((r) => r.url().includes('/api/detect-plan') && r.request().method() === 'POST', { timeout: 320_000 });
  await click();
  const r = await wait;
  const body = r.request().postDataJSON() || {};
  const answer = await r.json().catch(() => ({}));
  const { imageBase64, ...req } = body;
  console.log(`  ${label}: HTTP ${r.status()} in ${((Date.now() - t0) / 1000).toFixed(1)} s${answer.model ? ` · ${answer.model}` : ''}${answer.error ? ` · ${answer.error}` : ''}${answer.warning ? ` · ${answer.warning}` : ''}`);
  return { status: r.status(), seconds: (Date.now() - t0) / 1000, request: { ...req, imageKB: Math.round((imageBase64?.length || 0) * 0.75 / 1024) }, answer };
}

try {
  if (ONLY.has('review')) {
    console.log(`review — ${path.basename(VECTOR)}`);
    const { ctx, page } = await openApp(VECTOR);
    const rooms = await trace(page);
    const run = await callAI(page, () => page.getByRole('button', { name: /Check the trace with AI/ }).click(), 'review');
    await page.getByText(/AI checked/).waitFor({ timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'review.png') });
    run.tracedRooms = rooms;
    for (const f of run.answer.findings || []) console.log(`    ${f.kind} ${f.room || ''}${f.opening ? ' ' + f.opening : ''} (${f.confidence}): ${f.note}`);
    console.log(`    rooms ok: ${(run.answer.roomsOk || []).join(' ') || '—'}`);
    report.runs.review = run;
    await ctx.close();
  }

  if (ONLY.has('label')) {
    console.log(`label — ${path.basename(SCAN)} (named from the vector sheet's text for comparison)`);
    const truth = await (async () => {
      const { ctx, page } = await openApp(VECTOR);
      const r = await trace(page); await ctx.close(); return r;
    })();
    const { ctx, page } = await openApp(SCAN);
    const before = await trace(page, arg('scan-scale', '1/4'));
    const btn = page.getByRole('button', { name: /Name rooms with AI/ });
    if (!(await btn.count())) {
      console.log('    no "Name rooms with AI" button — every traced room already has a name');
      report.runs.label = { skipped: 'no unnamed rooms', before };
    } else {
      const run = await callAI(page, () => btn.click(), 'label');
      await page.getByRole('button', { name: /Reading labels/ }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
      const after = await page.$$eval('.tr-room', (els) => els.map((el) => ({
        name: el.querySelector('.tr-name')?.value, nums: [...el.querySelectorAll('.tr-num')].map((n) => n.textContent),
      })));
      await page.screenshot({ path: path.join(OUT, 'label.png') });
      run.before = before; run.after = after; run.vectorNames = truth;
      for (const r of run.answer.rooms || []) console.log(`    ${r.id}: ${r.name} (${r.type}${r.printed ? ', printed' : ''})`);
      console.log(`    vector sheet's names: ${truth.map((r) => `${r.name} ${r.nums[0]}`).join(' · ')}`);
      console.log(`    scan after AI:        ${after.map((r) => `${r.name} ${r.nums[0]}`).join(' · ')}`);
      report.runs.label = run;
    }
    await ctx.close();
  }

  if (ONLY.has('detect')) {
    console.log(`detect — ${path.basename(VECTOR)}, whole page`);
    const { ctx, page } = await openApp(VECTOR);
    await page.locator('header button', { hasText: 'AI Detect' }).click();
    const whole = page.getByRole('button', { name: /^Whole (page|plan)/ });
    if (await whole.count()) await whole.click();
    const go = page.locator('.det .tbtn.primary');
    await go.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !document.querySelector('.det .tbtn.primary')?.disabled, null, { timeout: 30_000 });
    const run = await callAI(page, () => go.click(), 'detect');
    await page.locator('.det-head').waitFor({ timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT, 'detect.png') });
    const fpp = +run.request.feetPerPixel || 0;
    for (const r of run.answer.rooms || []) {
      const sf = fpp && r.outline?.length >= 3 ? pxArea(r.outline) * fpp * fpp : 0;
      r.areaSf = Math.round(sf * 10) / 10;
      console.log(`    ${r.name}: ${sf ? sf.toFixed(1) + ' SF' : '? SF'}${r.dim_text ? ` · printed ${r.dim_text}` : ''} · conf ${r.confidence}`);
    }
    const total = (run.answer.rooms || []).reduce((a, r) => a + (r.areaSf || 0), 0);
    console.log(`    ${run.answer.rooms?.length || 0} rooms, ${total.toFixed(1)} SF${fpp ? '' : ' (no scale sent)'}`);
    report.runs.detect = run;
    await ctx.close();
  }
} finally {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`report: ${path.join(OUT, 'report.json')}`);
  await browser.close();
  await server.close();
}
