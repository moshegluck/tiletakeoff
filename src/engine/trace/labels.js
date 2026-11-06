// ============================================================
// labels.js — Claude labels the model; it never draws it.
//
// The trace numbers what it is unsure of, all of it taken from the PDF's own
// line data: the rooms (R), the walls around rooms it doubts (W), the gaps
// the walls leave there (G) and the doorways it bridged (O). Claude looks at
// the drawing with those numbers on it and answers per number — is W4 a
// wall, is G7 a doorway between two floors, is O2 a window, what is R3 —
// and nothing else: no coordinates, no outlines.
//
// Each answer becomes an edit to the trace's own inputs (a wall erased, a
// gap closed as an opening, a doorway drawn solid, a room's name as a seed).
// An edit is kept only when the model re-solved with it agrees better with
// the sheet's own evidence — rooms close, printed areas match, names stand
// in rooms of their own (readingScore) — and breaks nothing the sheet
// checked before. Anything else stays a flag for the estimator.
// Pure; no DOM. Units: feet.
// ============================================================
import { gapMap } from './leaks.js';
import { runTrace, readingScore } from './index.js';
import { dist, pointInPoly } from './vec.js';

export const LABEL_DEFAULTS = { maxRooms: 120, maxWalls: 70, maxGaps: 70, maxOpenings: 50, near: 6, minGap: 1.75, maxGap: 16 };

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const P = (p) => ({ x: p.x, y: p.y });

/** Rooms the trace doubts, and the places it says something is wrong. */
export function trouble(res) {
  const spotsIn = new Map();
  for (const s of res.spots || []) if (s.roomId) spotsIn.set(s.roomId, (spotsIn.get(s.roomId) || 0) + 1);
  const rooms = res.rooms.filter((r) => r.status !== 'ok' || r.flags?.length || (spotsIn.get(r.id) || 0) > 1);
  const points = [
    ...res.flags.filter((f) => f.severity !== 'info' && f.at && Number.isFinite(f.at.x)).map((f) => P(f.at)),
    ...(res.spots || []).filter((s) => !s.roomId).map(P),
  ];
  return { rooms, points };
}

function nearTrouble(p, t, near) {
  let d = Infinity;
  for (const q of t.points) d = Math.min(d, dist(p, q));
  for (const r of t.rooms) {
    if (pointInPoly(p, r.poly)) return 0;
    for (const q of r.poly) d = Math.min(d, dist(p, q));
  }
  return d <= near ? d : Infinity;
}

/**
 * What to ask about, numbered.
 * @returns {{ rooms: object[], walls: object[], gaps: object[], openings: object[] }}
 */
export function labelCandidates(res, opt = {}) {
  const o = { ...LABEL_DEFAULTS, ...opt };
  const t = trouble(res);
  const rooms = res.rooms.slice(0, o.maxRooms).map((r, i) => ({
    tag: `R${i + 1}`, id: r.id, name: r.name || '', type: r.type, center: P(r.center), area: r.area, doubted: t.rooms.includes(r),
  }));
  if (!t.rooms.length && !t.points.length) return { rooms, walls: [], gaps: [], openings: [] };
  const rank = (list, at) => list.map((x) => ({ x, d: nearTrouble(at(x), t, o.near) })).filter((e) => e.d < Infinity).sort((a, b) => a.d - b.d).map((e) => e.x);

  const walls = rank(res.walls.filter((w) => !w.exterior && w.length >= 1.5), (w) => mid(w.a, w.b)).slice(0, o.maxWalls)
    .map((w, i) => ({ tag: `W${i + 1}`, id: w.id, a: P(w.a), b: P(w.b), t: w.t, length: w.length }));

  const openings = rank(res.openings, (op) => mid(op.a, op.b)).slice(0, o.maxOpenings)
    .map((op, i) => ({ tag: `O${i + 1}`, id: op.id, a: P(op.a), b: P(op.b), t: op.t, type: op.openingType === 'window' ? 'window' : op.openingType === 'opening' ? 'opening' : 'door', width: op.width || dist(op.a, op.b) }));

  // the gaps the walls leave near the trouble: every one a doorway or a stretch of open floor
  const edges = [...res.walls, ...res.openings].map((e) => ({ a: e.a, b: e.b }));
  const nodes = [];
  const seen = new Set();
  for (const e of res.walls) for (const p of [e.a, e.b]) { const k = `${p.x.toFixed(4)},${p.y.toFixed(4)}`; if (!seen.has(k)) { seen.add(k); nodes.push(P(p)); } }
  let gaps = [];
  if (edges.length && nodes.length) {
    const all = gapMap(edges, nodes, { maxGap: o.maxGap }).gaps.filter((g) => g.gap >= o.minGap);
    // one gap per doorway: the same two jambs from either side, or two ends a hair apart
    const uniq = [];
    for (const g of all) {
      const m = mid(g.at, g.to);
      if (uniq.some((u) => dist(mid(u.at, u.to), m) < Math.max(0.75, 0.25 * Math.min(u.gap, g.gap)))) continue;
      uniq.push(g);
    }
    const thick = (p) => {
      let th = 0;
      for (const w of res.walls) if (dist(w.a, p) < 1e-6 || dist(w.b, p) < 1e-6) th = Math.max(th, w.t || 0);
      return th || 4.5 / 12;
    };
    gaps = rank(uniq, (g) => mid(g.at, g.to)).slice(0, o.maxGaps)
      .map((g, i) => ({ tag: `G${i + 1}`, a: P(g.at), b: P(g.to), t: thick(g.at), width: g.gap }));
  }
  return { rooms, walls, gaps, openings };
}

/**
 * Tiles over what's asked about: each ≤ TILE ft a side, holding the marks whose middle falls in it.
 * Each: { marks: {kind:'W'|'G'|'O', x, at}[], rooms, frame: {x0,y0,x1,y1} (ft) }
 */
export function labelTiles(c, { tile: TILE = 70, pad: PAD = 5 } = {}) {
  const marks = [
    ...c.walls.map((x) => ({ kind: 'W', x, at: { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 } })),
    ...c.gaps.map((x) => ({ kind: 'G', x, at: { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 } })),
    ...c.openings.map((x) => ({ kind: 'O', x, at: { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 } })),
  ];
  const doubted = c.rooms.filter((r) => r.doubted);
  const pts = [...marks.map((m) => m.at), ...doubted.map((r) => r.center)];
  if (!pts.length) return [];
  const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y));
  const x1 = Math.max(...pts.map((p) => p.x)), y1 = Math.max(...pts.map((p) => p.y));
  const nx = Math.max(1, Math.ceil((x1 - x0) / TILE)), ny = Math.max(1, Math.ceil((y1 - y0) / TILE));
  const w = (x1 - x0) / nx || 1, h = (y1 - y0) / ny || 1;
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const bx0 = x0 + i * w, by0 = y0 + j * h, bx1 = bx0 + w, by1 = by0 + h;
    const inT = (p) => p.x >= bx0 - 1e-6 && p.x <= bx1 + 1e-6 && p.y >= by0 - 1e-6 && p.y <= by1 + 1e-6;
    const mine = marks.filter((m) => inT(m.at) && !out.some((t) => t.marks.includes(m)));
    const rooms = c.rooms.filter((r) => inT(r.center) && !out.some((t) => t.rooms.includes(r)));
    if (!mine.length && !rooms.some((r) => r.doubted)) continue;
    // the frame: the tile, and every mark of it whole, PAD ft around
    const fx = [bx0, bx1, ...mine.flatMap((m) => [m.x.a.x, m.x.b.x])], fy = [by0, by1, ...mine.flatMap((m) => [m.x.a.y, m.x.b.y])];
    out.push({ marks: mine, rooms, frame: { x0: Math.min(...fx) - PAD, y0: Math.min(...fy) - PAD, x1: Math.max(...fx) + PAD, y1: Math.max(...fy) + PAD } });
  }
  return out;
}

export const WALL_LABELS = ['wall', 'not_wall'];
export const GAP_LABELS = ['separate', 'open'];
export const OPENING_LABELS = ['door', 'opening', 'window', 'solid'];

/**
 * The model's answers → edits to the trace's inputs. Answers about tags that
 * weren't asked are dropped. A label that agrees with the trace is no edit.
 * @param {ReturnType<typeof labelCandidates>} cands
 * @param {{ rooms?: {tag,name,type}[], walls?: {tag,is}[], gaps?: {tag,is}[], openings?: {tag,is}[] }} labels
 */
export function labelEdits(cands, labels = {}) {
  const by = (list) => new Map(list.map((c) => [c.tag, c]));
  const R = by(cands.rooms), W = by(cands.walls), G = by(cands.gaps), O = by(cands.openings);
  const edits = [];
  for (const l of labels.gaps || []) {
    const g = G.get(l?.tag);
    if (g && l.is === 'separate') edits.push({ kind: 'close', tag: g.tag, a: g.a, b: g.b, t: g.t, why: l.why || '' });
  }
  for (const l of labels.walls || []) {
    const w = W.get(l?.tag);
    if (w && l.is === 'not_wall') edits.push({ kind: 'remove', tag: w.tag, a: w.a, b: w.b, why: l.why || '' });
  }
  for (const l of labels.openings || []) {
    const op = O.get(l?.tag);
    if (op && l.is === 'solid') edits.push({ kind: 'solid', tag: op.tag, a: op.a, b: op.b, t: op.t || 4.5 / 12, why: l.why || '' });
  }
  const seeds = [];
  for (const l of labels.rooms || []) {
    const r = R.get(l?.tag);
    if (r && l.name) seeds.push({ x: r.center.x, y: r.center.y, name: String(l.name).slice(0, 40), type: l.type || 'room' });
  }
  return { edits, seeds };
}

const kinds = (res, k) => res.flags.filter((f) => f.kind === k).length;

/** Does `res` agree better with the sheet than `best`, breaking nothing the sheet checked? */
export function agreesBetter(res, best, margin = 0.25) {
  if (!res.rooms.length) return false;
  const v = res.verify || {}, b = best.verify || {};
  if ((v.matched || 0) < (b.matched || 0) || (v.off || 0) > (b.off || 0)) return false;
  if (kinds(res, 'room_not_closed') > kinds(best, 'room_not_closed')) return false;
  return readingScore(res) > readingScore(best) + margin;
}

/**
 * Apply the edits one by one, keeping each only when the model agrees better.
 * @param {object} input   the trace's input (feet), as runTrace takes it
 * @param {object} base    runTrace(input)
 * @param {{edits, seeds}} plan  from labelEdits
 * @param {{ maxTries?: number, trace?: (input) => object }} [opt]
 * @returns {{ res, input, kept: object[], declined: object[], tried: number }}
 */
export function applyLabels(input, base, plan, { maxTries = 40, trace = runTrace } = {}) {
  let cur = { ...input, removed: [...(input.removed || [])], manual: [...(input.manual || [])], closures: [...(input.closures || [])], seeds: [...(input.seeds || [])] };
  let best = base;
  const kept = [], declined = [];
  let tried = 0;
  // the names first: a seed parts two rooms the sheet names in one space
  if (plan.seeds?.length) {
    const next = { ...cur, seeds: cur.seeds.concat(plan.seeds) };
    const res = trace(next); tried++;
    if (readingScore(res) >= readingScore(best) && agreesBetter(res, best, -Infinity)) { cur = next; best = res; }
  }
  // gaps closed, then walls erased, then doorways drawn solid
  const order = { close: 0, remove: 1, solid: 2 };
  const edits = [...(plan.edits || [])].sort((a, b) => order[a.kind] - order[b.kind]);
  for (const e of edits) {
    if (tried >= maxTries) { declined.push({ ...e, reason: 'not tried' }); continue; }
    const next = { ...cur };
    if (e.kind === 'close') next.closures = cur.closures.concat({ a: e.a, b: e.b, t: e.t });
    else if (e.kind === 'remove') next.removed = cur.removed.concat({ a: e.a, b: e.b });
    else next.manual = cur.manual.concat({ a: e.a, b: e.b, t: e.t });
    const res = trace(next); tried++;
    if (agreesBetter(res, best)) { cur = next; best = res; kept.push(e); } else declined.push({ ...e, reason: 'plan disagrees' });
  }
  // what the AI said that the plan didn't bear out stays in front of the estimator
  best = { ...best, flags: [...best.flags] };
  const said = { close: 'a doorway between two floors', remove: 'not a wall', solid: 'a solid wall, not a doorway' };
  for (const [i, e] of declined.entries()) {
    best.flags.push({
      id: `al${i + 1}`, severity: 'info', kind: 'ai_label', ai: true, at: mid(e.a, e.b),
      msg: `AI reads ${e.tag} as ${said[e.kind]}${e.why ? ` (${e.why})` : ''} — not applied: the plan's own checks didn't agree. Fix it on the plan if the AI is right.`,
    });
  }
  best.aiLabels = { kept: kept.map((e) => ({ kind: e.kind, tag: e.tag, a: e.a, b: e.b })), declined: declined.length, tried };
  return { res: best, input: cur, kept, declined, tried };
}
