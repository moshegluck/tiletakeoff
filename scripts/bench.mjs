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
// Client PDFs never go in the repo: the manifest points at them where they are.
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors, readLayers } from '../src/lib/pdfVectors.js';
import { evidenceToFeet, detectSheetScale } from '../src/lib/planEvidence.js';
import { runTrace } from '../src/engine/trace/index.js';
import { printedAreas } from '../src/engine/trace/analyze.js';

const RENDER_SCALE = 2, PLAN_DPI = 72 * RENDER_SCALE;
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const manifestPath = args.find((a) => a.endsWith('.json') && args[args.indexOf(a) - 1] !== '--json' && args[args.indexOf(a) - 1] !== '--baseline');
if (!manifestPath) { console.error('usage: node scripts/bench.mjs manifest.json [--json out.json] [--baseline base.json]'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const inPoly = (p, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};
const inRoom = (p, r) => inPoly(p, r.poly) && !(r.holes || []).some((h) => inPoly(p, h));

/** Score one traced sheet against its answers. */
export function score(res, answers) {
  const out = { answers: answers.length, right: 0, close: 0, merged: 0, missing: 0, silent: 0, wrong: [] };
  const byRoom = new Map();
  for (const a of answers) {
    const r = res.rooms.find((rm) => inRoom(a.at, rm));
    if (!r) { out.missing++; out.wrong.push({ ...a, why: 'no room' }); continue; }
    if (!byRoom.has(r)) byRoom.set(r, []);
    byRoom.get(r).push(a);
  }
  for (const [r, as] of byRoom) {
    const want = as.reduce((s, a) => s + a.sf, 0);
    // a printed tag measures to the wall faces across doorways; a hand-audited
    // room is the takeoff's own floor (to the door's centre)
    const got = as[0].src === 'printed' ? (r.areaFaces ?? r.area) : r.area;
    const d = Math.abs(got - want);
    const zones = as.length > 1 && r.printedParts && r.areaCheck === 'match';
    if (as.length > 1 && !zones) {
      out.merged += as.length;
      for (const a of as) out.wrong.push({ ...a, why: `merged into ${r.name} (${r.area.toFixed(0)} SF)`, flagged: r.status !== 'ok' });
      if (r.status === 'ok') out.silent += as.length;
      continue;
    }
    const n = as.length;
    if (d <= Math.max(1, 0.01 * want)) { out.right += n; out.close += n; continue; }
    if (d <= Math.max(3, 0.03 * want)) { out.close += n; out.wrong.push(...as.map((a) => ({ ...a, why: `${got.toFixed(1)} SF (${(((got - want) / want) * 100).toFixed(1)}%)`, flagged: r.status !== 'ok', near: true }))); continue; }
    const flagged = r.status !== 'ok';
    if (!flagged) out.silent += n;
    out.wrong.push(...as.map((a) => ({ ...a, why: `${r.name}: ${got.toFixed(0)} SF (${(((got - want) / want) * 100).toFixed(0)}%)`, flagged })));
  }
  return out;
}

const doc = (() => { const cache = new Map(); return async (path) => {
  if (!cache.has(path)) cache.set(path, await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), disableFontFace: true, verbosity: 0 }).promise);
  return cache.get(path);
}; })();

const report = [];
for (const sh of manifest.sheets) {
  if (!existsSync(sh.pdf)) { console.log(`── ${sh.name}: ${sh.pdf} not found — skipped`); continue; }
  const d = await doc(sh.pdf);
  const ev = await extractPageVectors(await d.getPage(sh.page || 1), RENDER_SCALE, pdfjs.OPS, { layers: await readLayers(d) });
  const sc = detectSheetScale(ev, PLAN_DPI);
  if (!sc) { console.log(`── ${sh.name}: no scale on the sheet — skipped`); continue; }
  const input = evidenceToFeet(ev, sc.scale, null);
  const t0 = Date.now();
  const res = runTrace({ ...input, sheet: { x0: 0, y0: 0, x1: ev.width * sc.scale, y1: ev.height * sc.scale } });
  const ms = Date.now() - t0;
  const answers = [];
  if (sh.printed) for (const t of printedAreas(input.texts)) answers.push({ name: `${t.sf} SF tag`, at: { x: t.x, y: t.y }, sf: t.sf, src: 'printed' });
  for (const r of sh.rooms || []) answers.push({ ...r, src: 'audited' });
  const s = score(res, answers);
  const pct = (n) => (s.answers ? `${((100 * n) / s.answers).toFixed(1)}%` : '—');
  console.log(`── ${sh.name} (${basename(sh.pdf)} p${sh.page || 1}, ${ms} ms): ${res.rooms.length} rooms, ${res.counts.error} errors`);
  console.log(`   answers ${s.answers} · right ${s.right} (${pct(s.right)}) · within 3% ${s.close} (${pct(s.close)}) · merged ${s.merged} · missing ${s.missing} · SILENT ${s.silent}`);
  for (const w of s.wrong) console.log(`     ${w.near ? '   near   ' : w.flagged === false ? '!! SILENT ' : '   flagged'} ${String(w.name).padEnd(22)} want ${String(w.sf).padStart(6)}  ${w.why}${w.at ? `  @${w.at.x.toFixed(0)},${w.at.y.toFixed(0)}` : ''}`);
  report.push({ name: sh.name, rooms: res.rooms.length, errors: res.counts.error, ms, ...s, wrong: s.wrong.map(({ at, ...w }) => w) });
}
const tot = report.reduce((a, r) => ({ answers: a.answers + r.answers, right: a.right + r.right, close: a.close + r.close, silent: a.silent + r.silent }), { answers: 0, right: 0, close: 0, silent: 0 });
console.log(`\nALL: ${tot.answers} answers · right ${tot.right} (${tot.answers ? ((100 * tot.right) / tot.answers).toFixed(1) : '—'}%) · within 3% ${tot.close} · silent ${tot.silent}`);
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
