// ============================================================
// make-sample-plan.mjs — write a realistic vector floor-plan PDF
// (ARCH C 24"×18", 1/4" = 1'-0") from the test house, with door
// swings, room labels, dimensions, a door schedule, title block and
// a double sheet border. Used for end-to-end testing of the trace.
//
//   node scripts/make-sample-plan.mjs [out.pdf] [--clean]
// ============================================================
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildHousePlan } from '../test/fixtures/planFactory.js';

const out = process.argv.find((a) => a.endsWith('.pdf')) || 'samples/sample-house.pdf';
const messy = !process.argv.includes('--clean');
const plan = buildHousePlan({ messy });

const PT_PER_FT = 18;            // 1/4" = 1'-0"  → 0.25 in × 72 pt
const PAGE_W = 24 * 72, PAGE_H = 18 * 72;
const OX = 2.5 * 72, OY = 2.5 * 72; // plan origin offset from top-left (pt)
const X = (ft) => OX + ft * PT_PER_FT;
const Y = (ft) => PAGE_H - (OY + ft * PT_PER_FT);

const ops = [];
const num = (v) => (+v.toFixed(3)).toString();
const line = (x1, y1, x2, y2) => ops.push(`${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const text = (s, x, y, size = 10, font = 'F1') => ops.push(`BT /${font} ${size} Tf ${num(x)} ${num(y)} Td (${esc(s)}) Tj ET`);
const centered = (s, x, y, size) => text(s, x - s.length * size * 0.28, y - size * 0.35, size);
const rect = (x, y, w, h) => ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re S`);

// --- walls & linework (heavier pen for walls happens naturally: we only have lines) ---
ops.push('0 0 0 RG 0.9 w 1 J 1 j');
for (const l of plan.lines) line(X(l.a.x), Y(l.a.y), X(l.b.x), Y(l.b.y));

// --- door swings (thin) ---
ops.push('0.35 w');
for (const a of plan.arcs) {
  for (const pc of a.pieces) {
    ops.push(`${num(X(pc.p0.x))} ${num(Y(pc.p0.y))} m ${num(X(pc.p1.x))} ${num(Y(pc.p1.y))} ${num(X(pc.p2.x))} ${num(Y(pc.p2.y))} ${num(X(pc.p3.x))} ${num(Y(pc.p3.y))} c S`);
  }
}

// --- dimension strings above the plan ---
ops.push('0.3 w');
const dimY = -3;
const ticks = [0, 12, 24, 40];
line(X(0), Y(dimY), X(40), Y(dimY));
for (const t of ticks) line(X(t), Y(dimY - 0.4), X(t), Y(dimY + 0.4));
for (let i = 0; i + 1 < ticks.length; i++) centered(`${ticks[i + 1] - ticks[i]}'-0"`, X((ticks[i] + ticks[i + 1]) / 2), Y(dimY - 0.9), 8);

// --- labels ---
for (const t of plan.texts) {
  if (/SCALE|FLOOR PLAN/.test(t.str)) continue;
  const size = /\d'-/.test(t.str) ? 7 : 11;
  centered(t.str, X(t.x), Y(t.y), size);
}
text('FIRST FLOOR PLAN', X(0), Y(31.5), 16, 'F2');
text("SCALE: 1/4\" = 1'-0\"", X(0), Y(32.6), 10);

// --- door schedule table ---
const tx = PAGE_W - 7.2 * 72, ty = PAGE_H - 2.2 * 72;
text('DOOR SCHEDULE', tx, ty + 6, 11, 'F2');
const rows = [['MARK', 'SIZE', 'TYPE'], ['1', "3'-0\" x 6'-8\"", 'ENTRY'], ['2', "2'-8\" x 6'-8\"", 'PANEL'], ['3', "2'-6\" x 6'-8\"", 'PANEL'], ['4', "4'-0\" x 6'-8\"", 'BIFOLD']];
ops.push('0.5 w');
rows.forEach((r, i) => {
  const y = ty - 6 - i * 16;
  rect(tx, y - 16, 3.6 * 72, 16);
  text(r[0], tx + 6, y - 11, 8); text(r[1], tx + 50, y - 11, 8); text(r[2], tx + 170, y - 11, 8);
});

// --- title block + double sheet border ---
ops.push('1.6 w');
rect(0.5 * 72, 0.5 * 72, PAGE_W - 72, PAGE_H - 72);
ops.push('0.5 w');
rect(0.5 * 72 + 9, 0.5 * 72 + 9, PAGE_W - 72 - 18, PAGE_H - 72 - 18);
const tbx = PAGE_W - 0.5 * 72 - 9 - 3.2 * 72, tby = 0.5 * 72 + 9;
rect(tbx, tby, 3.2 * 72, 2.4 * 72);
line(tbx, tby + 1.6 * 72, tbx + 3.2 * 72, tby + 1.6 * 72);
line(tbx, tby + 0.8 * 72, tbx + 3.2 * 72, tby + 0.8 * 72);
text('SAMPLE RESIDENCE', tbx + 10, tby + 1.95 * 72, 13, 'F2');
text('TILE TAKEOFF TEST SET', tbx + 10, tby + 1.15 * 72, 9);
text('SHEET A-101', tbx + 10, tby + 0.35 * 72, 12, 'F2');

// --- assemble PDF ---
const content = ops.join('\n');
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
];
let pdf = '%PDF-1.4\n';
const offs = [];
objs.forEach((o, i) => { offs.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offs) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, pdf);
console.log(`wrote ${out} (${(pdf.length / 1024).toFixed(1)} KB, ${plan.lines.length} lines, ${plan.arcs.length} swings)`);
