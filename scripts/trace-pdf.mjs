// ============================================================
// trace-pdf.mjs — run the Trace pipeline on a plan PDF from the
// command line: the same vector read, scale pickup and solve the app
// uses, with a printed takeoff + flag report and an optional SVG
// overlay of the reconstructed model over the drawing.
//
//   node scripts/trace-pdf.mjs plan.pdf [--page 3|all] [--scale 1/4]
//                              [--svg out-dir] [--json out.json]
//
// Vector PDFs only (scans need the browser's canvas — use the app).
// ============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors } from '../src/lib/pdfVectors.js';
import { evidenceToFeet, detectSheetScale } from '../src/lib/planEvidence.js';
import { runTrace } from '../src/engine/trace/index.js';
import { ARCH_SCALES, archFeetPerPaperInch } from '../src/engine/units.js';

const RENDER_SCALE = 2;              // 144 px per paper inch, like a typical on-screen render
const PLAN_DPI = 72 * RENDER_SCALE;
const VECTOR_MIN_LINES = 150;        // same cut-off as planEvidence.js

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a) => a.toLowerCase().endsWith('.pdf'));
if (!file) {
  console.error('usage: node scripts/trace-pdf.mjs plan.pdf [--page N|all] [--scale 1/4] [--svg dir] [--json out.json]');
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function scaleFromArg(id) {
  if (!id) return null;
  const a = ARCH_SCALES.find((x) => x.id === id);
  const fpi = archFeetPerPaperInch(a);
  return a && fpi ? { id, label: a.label, scale: fpi / PLAN_DPI } : null;
}

const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), disableFontFace: true, verbosity: 0 }).promise;
const pageArg = opt('page') || 'all';
const pages = pageArg === 'all' ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : pageArg.split(',').map(Number);
const forced = scaleFromArg(opt('scale'));
if (opt('scale') && !forced) { console.error(`unknown scale "${opt('scale')}" — use an id like 1/4, 1/8, 3/16`); process.exit(2); }
const svgDir = opt('svg');
if (svgDir) mkdirSync(svgDir, { recursive: true });

const report = { file: basename(file), pages: [] };
console.log(`${basename(file)} — ${doc.numPages} page(s)\n`);

for (const n of pages) {
  const page = await doc.getPage(n);
  const ev = await extractPageVectors(page, RENDER_SCALE, pdfjs.OPS);
  const head = `── page ${n}  (${ev.stats.lines} lines, ${ev.stats.curves} curves, ${ev.stats.texts} texts)`;
  if (ev.lines.length < VECTOR_MIN_LINES) {
    console.log(`${head}\n   scanned / too little linework — trace it in the app (raster mode)\n`);
    report.pages.push({ page: n, skipped: 'raster' });
    continue;
  }
  const sheetScale = forced || detectSheetScale(ev, PLAN_DPI);
  if (!sheetScale) {
    console.log(`${head}\n   no drawing scale found on the sheet — re-run with --scale 1/4 (or the sheet's scale)\n`);
    report.pages.push({ page: n, skipped: 'no_scale' });
    continue;
  }
  const input = evidenceToFeet(ev, sheetScale.scale, null);
  const sheet = { x0: 0, y0: 0, x1: ev.width * sheetScale.scale, y1: ev.height * sheetScale.scale };
  const res = runTrace({ ...input, sheet });

  console.log(`${head}`);
  console.log(`   scale ${sheetScale.label}${forced ? ' (given)' : ' (read off the sheet)'} · ${res.status.toUpperCase()} · ${res.counts.error} error / ${res.counts.warn} review / ${res.counts.info} info · ${res.stats.ms} ms`);
  console.log(`   ${res.totals.rooms} rooms · ${num(res.totals.floorSf)} SF floor · ${num(res.totals.roomWallLf)} LF wall (room faces) · ${res.totals.doors} doors · ${res.totals.openings - res.totals.doors} openings`);
  if (res.calibration?.msg) console.log(`   ${res.calibration.msg}`);
  if (res.rooms.length) {
    console.log(`\n   ${pad('room', 26)}${pad('type', 9)}${pad('SF', 9)}${pad('wall LF', 9)}${pad('doors', 7)}status`);
    for (const r of [...res.rooms].sort((a, b) => b.area - a.area)) {
      console.log(`   ${pad(r.name, 26)}${pad(r.type, 9)}${pad(num(r.area), 9)}${pad(num(r.wallLf), 9)}${pad(r.openings.length, 7)}${r.status}`);
    }
  }
  const shown = res.flags.filter((f) => f.severity !== 'info' || ['spur', 'inferred_opening', 'frame'].includes(f.kind));
  if (shown.length) {
    console.log('\n   flags:');
    shown.forEach((f, i) => {
      const at = f.at ? ` @ (${num(f.at.x)}, ${num(f.at.y)}) ft` : '';
      console.log(`   ${String(i + 1).padStart(3)}. [${f.severity}] ${f.kind}${at} — ${f.msg}`);
    });
  }
  console.log('');

  if (svgDir) {
    const out = join(svgDir, `${basename(file, '.pdf')}-p${n}.svg`);
    writeFileSync(out, toSvg(ev, res, sheetScale.scale, shown));
    console.log(`   overlay → ${out}\n`);
  }
  report.pages.push({
    page: n, scale: sheetScale.id, status: res.status, counts: res.counts, totals: res.totals, stats: res.stats,
    rooms: res.rooms.map((r) => ({ name: r.name, type: r.type, sf: +r.area.toFixed(2), wallLf: +r.wallLf.toFixed(2), openings: r.openings.length, status: r.status })),
    flags: res.flags.map((f) => ({ severity: f.severity, kind: f.kind, at: f.at, msg: f.msg })),
  });
}
if (opt('json')) writeFileSync(opt('json'), JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------------

function toSvg(ev, res, k, flags) {
  const px = (p) => `${(p.x / k).toFixed(1)},${(p.y / k).toFixed(1)}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fill = { ok: '#2e9d5b', review: '#e0a020', error: '#d23c2c' };
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ev.width} ${ev.height}" width="${ev.width}" height="${ev.height}">`);
  o.push(`<rect width="100%" height="100%" fill="#fff"/>`);
  o.push('<g stroke="#b9b9b9" stroke-width="0.6" fill="none">');
  for (const l of ev.lines) o.push(`<line x1="${l.a.x.toFixed(1)}" y1="${l.a.y.toFixed(1)}" x2="${l.b.x.toFixed(1)}" y2="${l.b.y.toFixed(1)}"/>`);
  o.push('</g>');
  for (const r of res.rooms) {
    const holes = (r.holes || []).map((h) => ` M ${h.map(px).join(' L ')} Z`).join('');
    o.push(`<path d="M ${r.poly.map(px).join(' L ')} Z${holes}" fill="${fill[r.status] || '#888'}" fill-opacity="0.28" fill-rule="evenodd" stroke="${fill[r.status] || '#888'}" stroke-width="1.2"/>`);
  }
  o.push('<g stroke="#1d2b44" stroke-linecap="round">');
  for (const w of res.walls) o.push(`<line x1="${(w.a.x / k).toFixed(1)}" y1="${(w.a.y / k).toFixed(1)}" x2="${(w.b.x / k).toFixed(1)}" y2="${(w.b.y / k).toFixed(1)}" stroke-width="${Math.max(1.5, w.t / k * 0.35).toFixed(1)}"/>`);
  o.push('</g><g stroke="#2a6fdb" stroke-width="2.5" stroke-dasharray="4 3">');
  for (const op of res.openings) o.push(`<line x1="${(op.a.x / k).toFixed(1)}" y1="${(op.a.y / k).toFixed(1)}" x2="${(op.b.x / k).toFixed(1)}" y2="${(op.b.y / k).toFixed(1)}"/>`);
  o.push('</g><g font-family="Helvetica,Arial,sans-serif" text-anchor="middle">');
  for (const r of res.rooms) {
    const c = { x: r.center.x / k, y: r.center.y / k };
    o.push(`<text x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" font-size="11" font-weight="700" fill="#111">${esc(r.name)}</text>`);
    o.push(`<text x="${c.x.toFixed(1)}" y="${(c.y + 13).toFixed(1)}" font-size="10" fill="#333">${r.area.toFixed(1)} SF · ${r.wallLf.toFixed(1)} LF</text>`);
  }
  o.push('</g><g font-family="Helvetica,Arial,sans-serif" font-size="10" font-weight="700" text-anchor="middle">');
  flags.forEach((f, i) => {
    if (!f.at) return;
    const x = (f.at.x / k).toFixed(1), y = (f.at.y / k).toFixed(1);
    const col = f.severity === 'error' ? '#d23c2c' : f.severity === 'warn' ? '#e0a020' : '#2a6fdb';
    o.push(`<circle cx="${x}" cy="${y}" r="8" fill="${col}"/><text x="${x}" y="${(+y + 3.5).toFixed(1)}" fill="#fff">${i + 1}</text>`);
  });
  o.push('</g></svg>');
  return o.join('\n');
}
