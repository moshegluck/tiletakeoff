// ============================================================
// bench.mjs — score the trace against answer keys.
//
//   node scripts/bench.mjs manifest.json [--json out.json] [--baseline base.json]
//
// manifest: { "sheets": [ {
//   "name": "Mill 2 A101", "pdf": "/path/plan.pdf", "page": 16,
//   "printed": true,                 // the sheet's own "NNN SF" room tags are answers
//   "rooms": [ { "name": "GYM", "at": { "x": 12.5, "y": 30 }, "sf": 120.1 } ]   // hand-audited (ft, sheet frame)
// } ] }
//
// Per sheet and overall:
//   right   — the room the answer sits in is its own room, area within max(1 SF, 1%)
//   close   — within max(3 SF, 3%)
//   merged  — two answers in one traced room (that isn't a zone sum the plan check accepts)
//   missing — no traced room holds the answer
//   silent  — wrong (beyond 3%) and the room carries no flag: the one number that must be 0
// With --baseline, exits 1 when a sheet scores fewer rights or more silent errors than before.
//
// A sheet with "marked": true is an estimator's marked plan: its Bluebeam
// area polygons (scripts/markedKeys.mjs) are the answers. Each marked area is
// located in the traced room that covers most of it; a traced room's floor is
// right when it equals the marked areas inside it within max(1 SF, 1%). The
// trace never sees the markups (annotations aren't drawing).
// Client PDFs never go in the repo: the manifest points at them where they are.
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors, readLayers } from '../src/lib/pdfVectors.js';
import { evidenceToFeet, detectSheetScale } from '../src/lib/planEvidence.js';
import { runTrace } from '../src/engine/trace/index.js';
import { printedAreas } from '../src/engine/trace/analyze.js';
import { readMarkedKeys, areaItems } from './markedKeys.mjs';
import { score, scoreMarked } from './benchScore.mjs';

const RENDER_SCALE = 2, PLAN_DPI = 72 * RENDER_SCALE;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const manifestPath = args.find((a) => a.endsWith('.json') && args[args.indexOf(a) - 1] !== '--json' && args[args.indexOf(a) - 1] !== '--baseline');
if (!manifestPath) { console.error('usage: node scripts/bench.mjs manifest.json [--json out.json] [--baseline base.json]'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const doc = (() => { const cache = new Map(); return async (path) => {
  if (!cache.has(path)) cache.set(path, await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, verbosity: 0 }).promise);
  return cache.get(path);
}; })();

const markedOf = (() => { const cache = new Map(); return async (path) => {
  if (!cache.has(path)) cache.set(path, await readMarkedKeys(new Uint8Array(readFileSync(path))));
  return cache.get(path);
}; })();

const report = [];
for (const sh of manifest.sheets) {
  if (!existsSync(sh.pdf)) { console.log(`── ${sh.name}: ${sh.pdf} not found — skipped`); continue; }
  const d = await doc(sh.pdf);
  const ev = await extractPageVectors(await d.getPage(sh.page || 1), RENDER_SCALE, pdfjs.OPS, { layers: await readLayers(d) });
  let sc = detectSheetScale(ev, PLAN_DPI);
  // --key-scale: take the scale the estimator calibrated the markups with (to
  // tell a wrong scale apart from wrong geometry)
  if (sh.marked && args.includes('--key-scale')) {
    const k = (await markedOf(sh.pdf))[(sh.page || 1) - 1]?.ptToFt;
    if (k) sc = { label: 'as marked', scale: k / RENDER_SCALE };
  }
  if (!sc) { console.log(`── ${sh.name}: no scale on the sheet — skipped`); continue; }
  const input = evidenceToFeet(ev, sc.scale, null);
  const t0 = Date.now();
  const res = runTrace({ ...input, sheet: { x0: 0, y0: 0, x1: ev.width * sc.scale, y1: ev.height * sc.scale } });
  const ms = Date.now() - t0;
  const answers = [];
  if (sh.printed) for (const t of printedAreas(input.texts)) answers.push({ name: `${t.sf} SF tag`, at: { x: t.x, y: t.y }, sf: t.sf, src: 'printed' });
  for (const r of sh.rooms || []) answers.push({ ...r, src: 'audited' });
  let s;
  if (sh.marked) {
    const keys = (await markedOf(sh.pdf))[(sh.page || 1) - 1]?.items || [];
    const vp = (await d.getPage(sh.page || 1)).getViewport({ scale: RENDER_SCALE });
    const toFt = ([x, y]) => { const [px, py] = vp.convertToViewportPoint(x, y); return { x: px * sc.scale, y: py * sc.scale }; };
    const drawn = ev.lines.filter((l) => !l.glyph && !(l.filled && l.col === '#ffffff'))
      .map((l) => ({ a: { x: l.a.x * sc.scale, y: l.a.y * sc.scale }, b: { x: l.b.x * sc.scale, y: l.b.y * sc.scale } }));
    s = scoreMarked(res, areaItems(keys).map((it) => ({ ...it, poly: it.pts.map(toFt) })), 0.25, drawn);
  } else s = score(res, answers);
  const pct = (n) => (s.answers ? `${((100 * n) / s.answers).toFixed(1)}%` : '—');
  console.log(`── ${sh.name} (${basename(sh.pdf)} p${sh.page || 1}, ${ms} ms): ${res.rooms.length} rooms, ${res.counts.error} errors, scale ${sc.label || sc.scale.toFixed(4)}${sh.marked ? ` · marked ${s.keySf.toFixed(0)} SF in ${s.regions} regions, traced ${s.gotSf.toFixed(0)} SF there` : ''}`);
  console.log(`   answers ${s.answers} · right ${s.right} (${pct(s.right)}) · within 3% ${s.close} (${pct(s.close)}) · merged ${s.merged} · missing ${s.missing} · SILENT ${s.silent}`);
  if (s.geo) console.log(`   bounded by the drawing ${s.geo.answers} · right ${s.geo.right} · within 3% ${s.geo.close} · SILENT ${s.geo.silent} · scope (part of a room tiled) ${s.scope}`);
  for (const w of s.wrong) console.log(`     ${w.near ? '   near   ' : w.scope ? '   scope  ' : w.flagged === false ? '!! SILENT ' : '   flagged'} ${String(w.name).padEnd(22)} want ${String(w.sf).padStart(6)}  ${w.why}${w.at ? `  @${w.at.x.toFixed(0)},${w.at.y.toFixed(0)}` : ''}`);
  report.push({ name: sh.name, rooms: res.rooms.length, errors: res.counts.error, ms, ...s, wrong: s.wrong.map(({ at, ...w }) => w) });
}
const tot = report.reduce((a, r) => ({ answers: a.answers + r.answers, right: a.right + r.right, close: a.close + r.close, silent: a.silent + r.silent }), { answers: 0, right: 0, close: 0, silent: 0 });
console.log(`\nALL: ${tot.answers} answers · right ${tot.right} (${tot.answers ? ((100 * tot.right) / tot.answers).toFixed(1) : '—'}%) · within 3% ${tot.close} · silent ${tot.silent}`);
const geo = report.filter((r) => r.geo).reduce((a, r) => ({ answers: a.answers + r.geo.answers, right: a.right + r.geo.right, close: a.close + r.geo.close, silent: a.silent + r.geo.silent, scope: a.scope + r.scope }), { answers: 0, right: 0, close: 0, silent: 0, scope: 0 });
if (geo.answers) console.log(`BOUNDED BY THE DRAWING: ${geo.answers} answers · right ${geo.right} (${((100 * geo.right) / geo.answers).toFixed(1)}%) · within 3% ${geo.close} · silent ${geo.silent} · scope ${geo.scope}`);
if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ sheets: report, total: tot }, null, 2));
if (opt('baseline') && existsSync(opt('baseline'))) {
  const base = JSON.parse(readFileSync(opt('baseline'), 'utf8'));
  let worse = false;
  for (const r of report) {
    const b = base.sheets.find((x) => x.name === r.name);
    if (!b) continue;
    if (r.right < b.right || r.silent > b.silent) { worse = true; console.log(`WORSE: ${r.name} right ${b.right} → ${r.right}, silent ${b.silent} → ${r.silent}`); }
  }
  if (worse) process.exit(1);
}
