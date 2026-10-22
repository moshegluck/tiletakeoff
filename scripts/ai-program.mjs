// ============================================================
// ai-program.mjs — how well does a model read a floor plan's rooms?
//
// Pass 1 of the AI reading: the model looks at the plan (cropped to the
// building the trace found) and lists every room — its name, type, a point
// inside it and its box. Scored against an estimator's marked plan: each
// marked area should hold a point of its own, and the point should sit in
// the traced room that covers the area. The model never supplies geometry
// the takeoff uses; its points only say which space is which.
//
//   node scripts/ai-program.mjs manifest.json --out dir [--models claude-opus-5-5,claude-fable-5-1]
//     [--sheets "name a,name b"] [--effort high] [--jobs 3] [--reuse]
// The key is read from TILETAKEOFF_ANTHROPIC_KEY (or ANTHROPIC_API_KEY).
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors, readLayers } from '../src/lib/pdfVectors.js';
import { evidenceToFeet } from '../src/lib/planEvidence.js';
import { runTrace } from '../src/engine/trace/index.js';
import { readMarkedKeys, areaItems } from './markedKeys.mjs';
import { inPoly, inRoom } from './benchScore.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const manifest = JSON.parse(readFileSync(args.find((a) => a.endsWith('.json')), 'utf8'));
const OUT = path.resolve(opt('out', 'ai-program'));
const MODELS = opt('models', 'claude-opus-5-5').split(',');
const ONLY = opt('sheets') ? new Set(opt('sheets').split(',').map((s) => s.trim())) : null;
const EFFORT = opt('effort', 'high');
const JOBS = +opt('jobs', 3);
const REUSE = args.includes('--reuse');
const LONG = 2576;
mkdirSync(OUT, { recursive: true });

const key = process.env.TILETAKEOFF_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('No TILETAKEOFF_ANTHROPIC_KEY in the environment.'); process.exit(2); }
const client = new Anthropic({ apiKey: key, timeout: 600_000, maxRetries: 2 });

const TYPES = ['bathroom', 'wc', 'shower', 'vanity', 'closet', 'bedroom', 'living', 'dining', 'kitchen', 'pantry', 'laundry',
  'hall', 'foyer', 'stair', 'mechanical', 'storage', 'office', 'garage', 'porch', 'classroom', 'assembly', 'other'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rooms'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'type', 'x', 'y', 'box', 'dims'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: TYPES },
          x: { type: 'number' }, y: { type: 'number' },
          box: { type: 'array', items: { type: 'number' } },
          dims: { type: 'string' },
        },
      },
    },
  },
};
const prompt = (W, H) => `The image is a crop of an architectural PDF sheet showing one floor plan (parts of other drawings may show at its edges). It is ${W} × ${H} pixels; give every coordinate in these pixels, origin at the top left.

List every room and space on the floor plan — every area a floor finish could cover: rooms, closets, WCs, vanity areas, halls, stairs and landings, mechanical and laundry rooms, porches and decks. One entry per space bounded by walls and doors; an open area the plan names as two spaces (KITCHEN and FAMILY ROOM) is two entries.

For each space:
- name: as printed on the plan ("BATH 2", "W.I.C."); if nothing is printed, a short description ("closet", "hall").
- type: the kind of space.
- x, y: a point well inside the space — inside its own outline, clear of its walls, fixtures and text, never in a neighbouring space or in a wall.
- box: [left, top, right, bottom] of the space's floor, to its wall faces.
- dims: its size if the plan prints it in or by the room (11'-0" x 10'-11"), else "".

Leave out spaces drawn only in other views (details, sections, elevations, enlarged plans, key plans), the title block, and the land outside the building.`;

const docs = new Map();
const doc = async (p) => { if (!docs.has(p)) docs.set(p, await pdfjs.getDocument({ data: new Uint8Array(readFileSync(p)), disableFontFace: true, verbosity: 0 }).promise); return docs.get(p); };
const keysOf = new Map();
const marked = async (p) => { if (!keysOf.has(p)) keysOf.set(p, await readMarkedKeys(new Uint8Array(readFileSync(p)))); return keysOf.get(p); };

/** The sheet: trace it at the estimator's scale, crop to the building, render, and the marked areas in image px. */
async function prepare(sh) {
  const d = await doc(sh.pdf);
  const page = await d.getPage(sh.page || 1);
  const pages = await marked(sh.pdf);
  const k = pages[(sh.page || 1) - 1]?.ptToFt;
  if (!k) return null;
  const ev = await extractPageVectors(page, 2, pdfjs.OPS, { layers: await readLayers(d) });
  const scale = k / 2;
  const input = evidenceToFeet(ev, scale, null);
  // (the crop doesn't depend on what the rooms are told apart by)
  const res = runTrace({ ...input, options: { seedGaps: false }, sheet: { x0: 0, y0: 0, x1: ev.width * scale, y1: ev.height * scale } });
  const vp1 = page.getViewport({ scale: 1 });
  // the building: the traced rooms' extent (viewport pt), 8 ft around it; the whole page when nothing traced
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const r of res.rooms) for (const p of r.poly) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
  const ftToPt = 1 / (2 * scale);
  let crop = res.rooms.length
    ? { x0: Math.max(0, (bx0 - 8) * ftToPt), y0: Math.max(0, (by0 - 8) * ftToPt), x1: Math.min(vp1.width, (bx1 + 8) * ftToPt), y1: Math.min(vp1.height, (by1 + 8) * ftToPt) }
    : { x0: 0, y0: 0, x1: vp1.width, y1: vp1.height };
  const dpi = (LONG / Math.max(crop.x1 - crop.x0, crop.y1 - crop.y0)) * 72;
  const f = dpi / 72;
  const X = Math.round(crop.x0 * f), Y = Math.round(crop.y0 * f);
  const W = Math.min(LONG, Math.round((crop.x1 - crop.x0) * f)), H = Math.min(LONG, Math.round((crop.y1 - crop.y0) * f));
  const base = path.join(OUT, sh.name.replace(/[^\w.-]+/g, '_'));
  if (!existsSync(`${base}.png`)) {
    execFileSync('pdftoppm', ['-f', String(sh.page || 1), '-l', String(sh.page || 1), '-r', dpi.toFixed(4), '-x', String(X), '-y', String(Y), '-W', String(W), '-H', String(H), '-hide-annotations', '-gray', '-png', '-singlefile', sh.pdf, base]);
  }
  // where the image sits on the page (the bench maps the model's points back with it)
  writeFileSync(`${base}.frame.json`, JSON.stringify({ X, Y, f, W, H }));
  // image px ↔ feet
  const toImg = (u, v) => ({ x: u * f - X, y: v * f - Y });
  const imgToFt = (p) => ({ x: ((p.x + X) / f) * 2 * scale, y: ((p.y + Y) / f) * 2 * scale });
  const items = areaItems(pages[(sh.page || 1) - 1].items).filter((it) => !/deduct/i.test(it.subject) && it.sf >= 5)
    .map((it) => ({ subject: it.subject, sf: it.sf, poly: it.pts.map(([x, y]) => { const [u, v] = vp1.convertToViewportPoint(x, y); return toImg(u, v); }) }));
  return { base, W, H, res, items, imgToFt, ftPerPx: 2 * scale / f };
}

async function ask(model, png, W, H) {
  const params = {
    model, max_tokens: 64000,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync(png).toString('base64') } },
      { type: 'text', text: prompt(W, H) },
    ] }],
  };
  if (!/fable/.test(model)) params.thinking = { type: 'adaptive' };
  const t0 = Date.now();
  const msg = await client.messages.stream(params).finalMessage();
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let rooms = [];
  try { rooms = JSON.parse(text).rooms || []; } catch { /* refusal / truncation: no rooms */ }
  return { model: msg.model, stop: msg.stop_reason, usage: msg.usage, ms: Date.now() - t0, rooms };
}

/** Score the model's rooms against the marked areas and the trace. */
function scoreProgram(prep, rooms) {
  const { items, res, imgToFt } = prep;
  const seeds = rooms.map((r) => ({ ...r, ft: imgToFt({ x: r.x, y: r.y }) }));
  const per = items.map((it) => ({ subject: it.subject, sf: it.sf, seeds: seeds.filter((s) => inPoly({ x: s.x, y: s.y }, it.poly)).map((s) => s.name) }));
  // which traced room each seed lands in
  for (const s of seeds) { const i = res.rooms.findIndex((r) => inRoom(s.ft, r)); s.room = i; }
  // traced rooms holding seeds of 2+ different marked areas: the trace merged rooms the model told apart
  const byRoom = new Map();
  items.forEach((it, k) => {
    for (const s of seeds) if (inPoly({ x: s.x, y: s.y }, it.poly) && s.room >= 0) { if (!byRoom.has(s.room)) byRoom.set(s.room, new Set()); byRoom.get(s.room).add(k); }
  });
  const splits = [...byRoom.values()].filter((ks) => ks.size > 1).length;
  // box agreement for areas holding exactly one seed: IoU of the model's box and the marked area's box
  const ious = [];
  for (const it of items) {
    const inside = seeds.filter((s) => inPoly({ x: s.x, y: s.y }, it.poly));
    if (inside.length !== 1 || inside[0].box?.length !== 4) continue;
    const xs = it.poly.map((p) => p.x), ys = it.poly.map((p) => p.y);
    const A = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], B = inside[0].box;
    const ix = Math.max(0, Math.min(A[2], B[2]) - Math.max(A[0], B[0])), iy = Math.max(0, Math.min(A[3], B[3]) - Math.max(A[1], B[1]));
    const u = (A[2] - A[0]) * (A[3] - A[1]) + (B[2] - B[0]) * (B[3] - B[1]) - ix * iy;
    ious.push(u > 0 ? (ix * iy) / u : 0);
  }
  ious.sort((a, b) => a - b);
  return {
    seeds: seeds.length, areas: items.length,
    hit: per.filter((p) => p.seeds.length).length,
    multi: per.filter((p) => p.seeds.length > 1).length,
    inTrace: seeds.filter((s) => s.room >= 0).length,
    splits,
    iouMed: ious.length ? +ious[Math.floor(ious.length / 2)].toFixed(2) : null,
    iouGood: ious.filter((x) => x >= 0.5).length,
    missed: per.filter((p) => !p.seeds.length).map((p) => `${p.subject} ${p.sf}`),
  };
}

const sheets = manifest.sheets.filter((s) => s.marked && (!ONLY || ONLY.has(s.name)) && existsSync(s.pdf));
const report = [];
const run = async (sh) => {
  const prep = await prepare(sh);
  if (!prep) { console.log(`── ${sh.name}: no calibration — skipped`); return; }
  if (args.includes('--dry')) {
    // the marked areas drawn over the render: the two frames must agree
    const draw = prep.items.map((it) => `polygon ${it.poly.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}`).join(' ');
    execFileSync('convert', [`${prep.base}.png`, '-fill', 'none', '-stroke', 'red', '-strokewidth', '3', '-draw', draw || 'point 0,0', `${prep.base}.check.png`]);
    console.log(`── ${sh.name}: ${prep.W}×${prep.H}, ${prep.items.length} marked areas, ${prep.res.rooms.length} traced rooms, ${(prep.ftPerPx * 12).toFixed(2)} in/px`);
    return;
  }
  for (const model of MODELS) {
    const file = `${prep.base}.${model}.json`;
    let ans;
    if (REUSE && existsSync(file)) ans = JSON.parse(readFileSync(file, 'utf8'));
    else {
      try { ans = await ask(model, `${prep.base}.png`, prep.W, prep.H); }
      catch (e) { console.log(`── ${sh.name} ${model}: ${e?.status || ''} ${String(e?.message || e).slice(0, 200)}`); continue; }
      writeFileSync(file, JSON.stringify(ans, null, 1));
    }
    const s = scoreProgram(prep, ans.rooms);
    const u = ans.usage || {};
    report.push({ sheet: sh.name, model, ...s, ms: ans.ms, stop: ans.stop, inTok: u.input_tokens, outTok: u.output_tokens });
    console.log(`── ${sh.name} · ${model} (${(ans.ms / 1000).toFixed(0)} s, ${u.input_tokens} in / ${u.output_tokens} out, ${ans.stop}): ${s.seeds} rooms · marked areas with a point ${s.hit}/${s.areas} (2+ points ${s.multi}) · points in traced rooms ${s.inTrace} · merged rooms it splits ${s.splits} · box IoU med ${s.iouMed} (≥0.5: ${s.iouGood})`);
    if (s.missed.length) console.log(`     no point in: ${s.missed.join(', ').slice(0, 300)}`);
  }
};
const queue = sheets.slice();
await Promise.all(Array.from({ length: JOBS }, async () => { while (queue.length) await run(queue.shift()); }));
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
for (const model of MODELS) {
  const r = report.filter((x) => x.model === model);
  const sum = (k) => r.reduce((a, x) => a + (x[k] || 0), 0);
  console.log(`\n${model}: ${r.length} sheets · marked areas with a point ${sum('hit')}/${sum('areas')} (${((100 * sum('hit')) / Math.max(1, sum('areas'))).toFixed(1)}%) · 2+ points ${sum('multi')} · merged rooms split ${sum('splits')} · box IoU ≥ 0.5 ${sum('iouGood')} · tokens ${sum('inTok')} in / ${sum('outTok')} out · ${(sum('ms') / 1000).toFixed(0)} s`);
}
