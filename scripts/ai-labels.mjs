// ============================================================
// ai-labels.mjs — Claude labels the trace's numbered walls, gaps, doorways
// and rooms on marked sheets (src/engine/trace/labels.js), for the bench.
//
//   node scripts/ai-labels.mjs manifest.json --out dir [--sheets "a,b"] [--ask] [--model claude-opus-5-5]
//
// Per sheet: trace at the estimator's scale (as bench.mjs --key-scale does),
// number what the trace doubts, and render the plan around it with the
// numbers drawn on (tiles of at most TILE ft, so the marks stay legible):
//   <dir>/<sheet>.cands.json   the numbered candidates (feet)
//   <dir>/<sheet>.tN.png       a tile, the numbers drawn on
//   <dir>/<sheet>.tN.json      that tile's numbers in image px + the text the model is sent
// --ask sends each tile to the model with the app's own prompt
// (src/lib/labelPrompt.js) and writes <dir>/<sheet>.tN.labels.json; labels
// written there any other way are read the same. Then:
//   node scripts/bench.mjs manifest.json --key-scale --labels dir
// The key is read from TILETAKEOFF_ANTHROPIC_KEY (or ANTHROPIC_API_KEY).
// ============================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors, readLayers } from '../src/lib/pdfVectors.js';
import { evidenceToFeet } from '../src/lib/planEvidence.js';
import { runTrace } from '../src/engine/trace/index.js';
import { labelCandidates, labelTiles } from '../src/engine/trace/labels.js';
import { LABELS_SYSTEM, LABELS_SCHEMA, labelsText, cleanLabels } from '../src/lib/labelPrompt.js';
import { readMarkedKeys } from './markedKeys.mjs';

const RENDER_SCALE = 2, LONG = 2576;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const manifest = JSON.parse(readFileSync(args.find((a) => a.endsWith('.json')), 'utf8'));
const OUT = path.resolve(opt('out', 'ai-labels'));
const ONLY = opt('sheets') ? new Set(opt('sheets').split(',').map((s) => s.trim())) : null;
mkdirSync(OUT, { recursive: true });

export const sheetBase = (dir, name) => path.join(dir, name.replace(/[^\w.-]+/g, '_'));

const COL = { R: '#7b3fa8', W: '#d0021b', G: '#0a8f3c', door: '#1d6fb0', opening: '#d9771f', window: '#14917d' };

async function prepare(sh) {
  const data = new Uint8Array(readFileSync(sh.pdf));
  const d = await pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const page = await d.getPage(sh.page || 1);
  const k = (await readMarkedKeys(new Uint8Array(readFileSync(sh.pdf))))[(sh.page || 1) - 1]?.ptToFt;
  if (!k) return null;
  const ev = await extractPageVectors(page, RENDER_SCALE, pdfjs.OPS, { layers: await readLayers(d) });
  const scale = k / RENDER_SCALE;
  const input = evidenceToFeet(ev, scale, null);
  const res = runTrace({ ...input, sheet: { x0: 0, y0: 0, x1: ev.width * scale, y1: ev.height * scale } });
  const vp1 = page.getViewport({ scale: 1 });
  return { res, scale, vp1 };
}

function render(sh, prep, tile, file) {
  const { scale, vp1 } = prep;
  const ftToPt = 1 / (RENDER_SCALE * scale);
  const cr = { x0: Math.max(0, tile.frame.x0 * ftToPt), y0: Math.max(0, tile.frame.y0 * ftToPt), x1: Math.min(vp1.width, tile.frame.x1 * ftToPt), y1: Math.min(vp1.height, tile.frame.y1 * ftToPt) };
  const dpi = (LONG / Math.max(cr.x1 - cr.x0, cr.y1 - cr.y0)) * 72;
  const f = dpi / 72;
  const X = Math.round(cr.x0 * f), Y = Math.round(cr.y0 * f);
  const W = Math.min(LONG, Math.round((cr.x1 - cr.x0) * f)), H = Math.min(LONG, Math.round((cr.y1 - cr.y0) * f));
  const raw = `${file}.raw`;
  execFileSync('pdftoppm', ['-f', String(sh.page || 1), '-l', String(sh.page || 1), '-r', dpi.toFixed(4), '-x', String(X), '-y', String(Y), '-W', String(W), '-H', String(H), '-hide-annotations', '-gray', '-png', '-singlefile', sh.pdf, raw]);
  const px = (p) => ({ x: p.x * ftToPt * f - X, y: p.y * ftToPt * f - Y });
  const lw = Math.max(2, (2 / 12) * ftToPt * f);   // ~2" on the drawing
  const fs = Math.round(Math.max(14, Math.min(22, lw * 5)));
  const mvg = [`stroke-linecap butt`, `font-size ${fs}`, `font DejaVu-Sans-Bold`];
  const tags = { rooms: [], walls: [], gaps: [], openings: [] };
  const labels = [];
  for (const m of tile.marks) {
    const a = px(m.x.a), b = px(m.x.b), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const col = m.kind === 'O' ? COL[m.x.type] : COL[m.kind];
    if (m.kind === 'G') mvg.push(`stroke ${col} stroke-width ${lw} stroke-dasharray ${lw * 3} ${lw * 2} fill none line ${a.x.toFixed(1)},${a.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)} stroke-dasharray`);
    else mvg.push(`stroke ${col} stroke-width ${m.kind === 'O' ? lw * 2.4 : lw} fill none line ${a.x.toFixed(1)},${a.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
    const list = m.kind === 'W' ? tags.walls : m.kind === 'G' ? tags.gaps : tags.openings;
    list.push({ tag: m.x.tag, x: c.x, y: c.y, width: m.x.width, type: m.x.type });
    labels.push({ tag: m.x.tag, x: c.x, y: m.kind === 'O' ? c.y - fs : c.y, col });
  }
  for (const r of tile.rooms) {
    const c = px(r.center);
    if (c.x < 0 || c.y < 0 || c.x > W || c.y > H) continue;
    tags.rooms.push({ tag: r.tag, name: r.name, x: c.x, y: c.y, area: r.area });
    labels.push({ tag: r.tag, x: c.x, y: c.y, col: COL.R });
  }
  for (const l of labels) {
    const tw = (l.tag.length * 0.66 + 0.4) * fs, th = fs * 1.25;
    mvg.push(`stroke ${l.col} stroke-width 1 fill rgba(255,255,255,0.92) rectangle ${(l.x - tw / 2).toFixed(1)},${(l.y - th / 2).toFixed(1)} ${(l.x + tw / 2).toFixed(1)},${(l.y + th / 2).toFixed(1)}`);
    mvg.push(`stroke none fill ${l.col} text ${(l.x - tw / 2 + 0.2 * fs).toFixed(1)},${(l.y + fs * 0.38).toFixed(1)} '${l.tag}'`);
  }
  // (ImageMagick's policy may refuse a draw file: the primitives go inline)
  execFileSync('convert', [`${raw}.png`, '-colorspace', 'sRGB', '-draw', mvg.join('\n'), `${file}.png`], { maxBuffer: 1 << 26 });
  rmSync(`${raw}.png`, { force: true });
  return { W, H, tags, text: labelsText(W, H, tags) };
}

async function ask(client, model, png, text) {
  const msg = await client.messages.stream({
    model, max_tokens: 32000, thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: LABELS_SCHEMA } },
    system: LABELS_SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: readFileSync(png).toString('base64') } },
      { type: 'text', text },
    ] }],
  }).finalMessage();
  const out = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(out); } catch { return {}; }
}

let client = null;
if (args.includes('--ask')) {
  const key = process.env.TILETAKEOFF_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('No TILETAKEOFF_ANTHROPIC_KEY in the environment.'); process.exit(2); }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  client = new Anthropic({ apiKey: key, timeout: 600_000, maxRetries: 2 });
}

for (const sh of manifest.sheets.filter((s) => s.marked && (!ONLY || ONLY.has(s.name)) && existsSync(s.pdf))) {
  const prep = await prepare(sh);
  if (!prep) { console.log(`── ${sh.name}: no calibration — skipped`); continue; }
  const c = labelCandidates(prep.res);
  const base = sheetBase(OUT, sh.name);
  writeFileSync(`${base}.cands.json`, JSON.stringify(c));
  const ts = labelTiles(c);
  ts.forEach((t, i) => {
    const file = `${base}.t${i + 1}`;
    const r = render(sh, prep, t, file);
    writeFileSync(`${file}.json`, JSON.stringify({ W: r.W, H: r.H, tags: r.tags, text: r.text }));
  });
  console.log(`── ${sh.name}: ${c.rooms.length} rooms (${c.rooms.filter((r) => r.doubted).length} doubted), ${c.walls.length} walls, ${c.gaps.length} gaps, ${c.openings.length} doorways · ${ts.length} tile(s)`);
  if (!client) continue;
  for (let i = 1; i <= ts.length; i++) {
    const file = `${base}.t${i}`;
    if (existsSync(`${file}.labels.json`)) continue;
    const t = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    const ans = await ask(client, opt('model', 'claude-opus-5-5'), `${file}.png`, t.text);
    writeFileSync(`${file}.labels.json`, JSON.stringify(cleanLabels(ans, t.tags)));
  }
}
