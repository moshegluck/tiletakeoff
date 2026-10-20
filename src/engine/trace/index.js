// ============================================================
// trace/index.js — the whole reconstruction pipeline.
//
//   linework ──► wall bodies ──► joined walls ──► openings bridged
//            ──► planar graph ──► faces (rooms) ──► takeoff + flags
//
// The sketch this produces is the source of truth for the takeoff.
// The PDF is only the evidence it was reconstructed from.
// All geometry in and out is in FEET.
// ============================================================

import { takeStairsOffFloors } from './stairs.js';
import { pairWalls, mergeBodies, WALL_DEFAULTS } from './walls.js';
import { joinWalls, dropDetached, bridgeOpenings, buildGraph, pruneGraph, GRAPH_DEFAULTS } from './graph.js';
import { analyzeGraph, parseScaleNote, parseDoorSchedule, calibrateFromDoors, roomTypeOf } from './analyze.js';
import { dist, norm, sub, add, mul } from './vec.js';
import { describeSheet } from './survey.js';
import { leafLines } from './arcs.js';

export { parseScaleNote, parseDoorSchedule, calibrateFromDoors, roomTypeOf };
export { arcFromBezier } from './arcs.js';

export const TRACE_DEFAULTS = { ...WALL_DEFAULTS, ...GRAPH_DEFAULTS, floorAtDoor: 'face' };

/**
 * @param {object} input
 * @param {{a,b,w?}[]} [input.lines]   raw linework (ft)
 * @param {{a,b,t,conf?}[]} [input.bodies] pre-paired wall bodies (raster / AI / manual) (ft)
 * @param {{c,r}[]} [input.arcs]       door-swing arcs (ft)
 * @param {{a,b}[]} [input.hints]      linework from door / window layers (ft) — doorway evidence
 * @param {{str,x,y}[]} [input.texts]  sheet text (ft) — door schedule / tags
 * @param {{str,x,y}[]} [input.labels] text that can name a room (ft); omitted = texts
 * @param {{a,b}[]} [input.removed]    walls the user erased (matched by proximity)
 * @param {{a,b,t}[]} [input.manual]   walls the user drew by hand (ft) — always win
 * @param {object|null} [input.schedule] door schedule; omitted = parsed from texts
 * @param {{x0,y0,x1,y1}} [input.sheet] page extent in feet (lets the engine recognise a sheet border)
 * @param {object} [input.options]
 */
/** Ends of the inferred openings that close off an unnamed alcove (see runTrace). */
function alcoveMouths(res) {
  // (a dashed line drawn across the mouth — the soffit over a vanity recess — says the floor changes there)
  const inferred = (o) => o.openingType === 'opening' && !o.arcs.length && !o.hint && !o.across;
  const named = new Set(res.rooms.filter((r) => r.labels.length).map((r) => r.id));
  const out = [];
  for (const r of res.rooms) {
    if (named.has(r.id)) continue;
    const ops = res.openings.filter((o) => o.rooms.includes(r.id));
    if (!ops.length || !ops.every(inferred)) continue;
    if (!ops.every((o) => named.has(o.rooms.find((id) => id !== r.id)))) continue;
    // a nook is open along much of its side; a room behind a narrow gap (a
    // stair hall through a slot in a brick wall) is a room
    if (ops.reduce((a, o) => a + (o.width || dist(o.a, o.b)), 0) < 0.5 * Math.sqrt(r.area)) continue;
    for (const o of ops) out.push({ ...o.a }, { ...o.b });
  }
  // …and a named room whose only way in is a smaller unnamed space, open to
  // it with nothing drawn across, that has one door of its own (a bathroom's
  // vanity area, split off by the stub at the end of the tub) is one room
  // with it. A hall has more doors than one; a closet is smaller than the hall.
  for (const r of res.rooms) {
    if (!named.has(r.id)) continue;
    const ops = res.openings.filter((o) => o.rooms.includes(r.id));
    if (!ops.length || !ops.every(inferred)) continue;
    const via = new Set(ops.map((o) => o.rooms.find((id) => id !== r.id)));
    if (via.size !== 1) continue;
    const s = res.rooms.find((x) => x.id === [...via][0]);
    if (!s || named.has(s.id) || s.area > r.area) continue;
    if (res.openings.filter((o) => o.rooms.includes(s.id) && !o.rooms.includes(r.id)).length !== 1) continue;
    if (ops.reduce((a, o) => a + (o.width || dist(o.a, o.b)), 0) < 0.5 * Math.sqrt(s.area)) continue;
    for (const o of ops) out.push({ ...o.a }, { ...o.b });
  }
  return out;
}

/**
 * The readings of a sheet worth trying when the first one leans on a rule
 * that could be wrong for this drawing: pen weights (furniture drawn heavy,
 * existing walls drawn light) and thick masonry pairs. Each is traced and
 * scored against the sheet's own evidence; the best one is kept.
 */
const READINGS = [
  { id: 'all-pens', label: 'every pen can draw a wall', when: (st) => st.heavyW > 0, options: { hairlineRatio: 0 } },
  { id: 'no-masonry', label: 'no walls thicker than 16"', when: (st) => st.thickBodies > 0, options: { thickMaxT: WALL_DEFAULTS.maxT } },
];

/**
 * How well a trace agrees with what the sheet itself says: printed room
 * areas it matches (or misses), named rooms each in a room of their own,
 * names merged into one room or left in no room, wall ends left open — and
 * how much of it the trace itself doubts: rooms carrying a flag, and
 * nameless pieces (furniture drawn light closes into them when every pen
 * may draw a wall).
 */
export function readingScore(res) {
  const v = res.verify || {};
  const kind = (k) => res.flags.filter((f) => f.kind === k).length;
  const named = res.rooms.filter((r) => r.labels?.length).length;
  const doubted = res.rooms.filter((r) => r.status !== 'ok').length;
  return 3 * (v.matched || 0) - 2 * (v.off || 0) + named - 2 * kind('merged_rooms') - 1.5 * kind('room_not_closed') - 0.3 * kind('open_end')
    - 0.3 * doubted - 0.1 * (res.rooms.length - named);
}

export function runTrace(input = {}) {
  const first = traceReading(input);
  const tried = [{ id: 'default', label: 'as drawn', score: readingScore(first) }];
  let best = first, bestScore = tried[0].score, chosen = 'default';
  for (const rd of READINGS) {
    if (input.options?.[Object.keys(rd.options)[0]] !== undefined || !rd.when(first.stats)) continue;
    const res = traceReading({ ...input, options: { ...(input.options || {}), ...rd.options } });
    const score = readingScore(res);
    tried.push({ id: rd.id, label: rd.label, score });
    // a different reading must do clearly better to win (ties keep the drawing as drawn)
    if (score > bestScore + 2) { best = res; bestScore = score; chosen = rd.id; }
  }
  best.readings = tried.map((t) => ({ ...t, chosen: t.id === chosen }));
  best.survey = describeSheet(input, best);
  return best;
}

function traceReading(input = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const opt = { ...TRACE_DEFAULTS, ...(input.options || {}) };
  const log = [];
  const texts = input.texts || [];
  const arcs = input.arcs || [];

  // 1. linework → wall bodies
  // (a door's leaf, drawn standing open, is never a wall's face)
  const leaves = input.lines?.length ? leafLines(arcs, input.lines) : new Set();
  const wallLines = leaves.size ? input.lines.filter((_, i) => !leaves.has(i)) : input.lines;
  const paired = wallLines?.length ? pairWalls(wallLines, opt) : { bodies: [], faces: [], lines: [], stats: {} };
  let bodies = mergeBodies([
    ...paired.bodies,
    ...(input.bodies || []).map((b) => ({ conf: 0.75, src: 'given', ...b })),
  ]);

  // a door's closed leaf is its doorway: what's drawn across it (a threshold,
  // a leaf drawn shut, a pair's meeting stiles) is no wall
  const doorways = arcs.filter((a) => a?.closed && a.c && dist(a.c, a.closed) > 1).map((a) => {
    const u = norm(sub(a.closed, a.c)), m = 2 / 12;
    return { a: add(a.c, mul(u, m)), b: sub(a.closed, mul(u, m)) };
  });
  if (doorways.length) bodies = eraseFromBodies(bodies, doorways);

  // user erasures win over evidence: cut exactly the erased stretch out of
  // whatever wall bodies it lies along (never the whole run)
  if (input.removed?.length) {
    const before = bodies.length;
    bodies = eraseFromBodies(bodies, input.removed);
    log.push({ kind: 'erase', at: null, note: `${input.removed.length} wall piece(s) removed by hand` });
    void before;
  }
  const manual = (input.manual || []).map((m) => ({ ...m, conf: 1, src: 'manual' }));
  bodies = bodies.concat(manual).map((b) => ({ ...b, kind: 'wall' }))
    .filter((b) => Number.isFinite(b.a?.x) && Number.isFinite(b.a?.y) && Number.isFinite(b.b?.x) && Number.isFinite(b.b?.y) && Number.isFinite(b.t) && b.t > 0 && dist(b.a, b.b) > 0.05);

  // 2–5. join, bridge openings, build the graph, trace rooms
  const schedule = input.schedule !== undefined ? input.schedule : parseDoorSchedule(texts);
  const solve = (keepOpen, lg) => {
    const o2 = keepOpen.length ? { ...opt, keepOpen } : opt;
    // 2. join corners / tees / drafting gaps
    const joined = joinWalls(bodies, o2, lg);
    const { segs, ends } = dropDetached(joined.segs, joined.ends, o2, lg);
    // 3. bridge doors & openings so rooms can close
    const openings = bridgeOpenings(segs, ends, arcs, o2, lg, input.hints || [], paired.lines || []);
    // 4. planar graph, cleaned
    // (an opening run on a thick wall's line closes to its thin jamb with a step)
    const steps = openings.filter((o) => o.step).map((o) => ({ ...o.step, kind: 'wall', conf: 0.6, src: 'repair' }));
    const g0 = buildGraph(segs.concat(openings, steps), o2, lg);
    const g = pruneGraph(g0, o2, lg);
    // 5. faces → rooms, LF, flags
    const res = analyzeGraph(g, { texts: input.labels || texts, allTexts: texts, arcs, schedule, options: o2, sheet: input.sheet || null, faces: paired.faces || [], drawn: input.lines || [], hints: input.hints || [], wallPen: paired.stats?.heavyW || 0 });
    return { g, res };
  };
  let { g, res } = solve([], log);
  // An unnamed space that only opens into named rooms through openings the
  // trace inferred (no door, nothing drawn across) is part of the room it
  // opens into — a study's alcove of built-ins, a nook — not a room of its
  // own: leave its mouth open and solve again.
  const mouths = alcoveMouths(res);
  if (mouths.length) {
    const log2 = [];
    const again = solve(mouths, log2);
    if (again.res.rooms.length) {
      ({ g, res } = again);
      log.length = 0; log.push(...log2);
      log.push({ kind: 'opening', at: mouths[0], note: `${mouths.length / 2} alcove${mouths.length > 2 ? 's' : ''} kept open to the room around ${mouths.length > 2 ? 'them' : 'it'}` });
    }
  }

  // stair runs: their treads are no floor (the landings are)
  if (input.stairs?.length) {
    for (const f of takeStairsOffFloors(res.rooms, input.stairs)) {
      res.flags.push(f);
      res.rooms.find((r) => r.id === f.roomId)?.flags.push(f.id);
    }
  }

  // an unexcavated area, a shaft: walled in but no floor to finish
  const floorRooms = res.rooms.filter((r) => r.type !== 'nofloor');
  const floorSf = floorRooms.reduce((s, r) => s + r.area, 0);
  const wallLf = floorRooms.reduce((s, r) => s + r.wallLf, 0);
  const centerLf = res.walls.reduce((s, w) => s + w.length, 0);
  const extLf = res.walls.filter((w) => w.exterior).reduce((s, w) => s + w.length, 0);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of res.flags) counts[f.severity]++;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    version: 1,
    rooms: res.rooms,
    voids: res.voids,
    walls: res.walls,
    openings: res.openings,
    flags: res.flags,
    repairs: log.filter((l) => l.at),
    log,
    calibration: res.calibration,
    verify: res.verify,
    schedule,
    totals: {
      rooms: floorRooms.length, floorSf, roomWallLf: wallLf, wallCenterLf: centerLf, exteriorLf: extLf,
      openings: res.openings.filter((o) => o.openingType !== 'window').length,
      doors: res.openings.filter((o) => o.openingType === 'door' || o.openingType === 'double_door').length,
      windows: res.openings.filter((o) => o.openingType === 'window').length,
    },
    status: counts.error ? 'needs_input' : counts.warn ? 'review' : 'coherent',
    counts,
    stats: { ...paired.stats, wallBodies: bodies.length, nodes: g.nodes.length, edges: g.edges.length, ms: Math.round(t1 - t0) },
    options: opt,
  };
}

/**
 * Subtract each erased segment from the wall bodies it lies along.
 * r is the traced wall piece the user clicked (graph-node coordinates, so it
 * may run a few inches past the body into a corner — that's fine).
 */
export function eraseFromBodies(bodies, removed) {
  let out = bodies;
  for (const r of removed) {
    const next = [];
    for (const b of out) {
      const L = dist(b.a, b.b);
      if (L < 1e-6) continue;
      const ux = (b.b.x - b.a.x) / L, uy = (b.b.y - b.a.y) / L;
      const off = (p) => Math.abs((p.x - b.a.x) * uy - (p.y - b.a.y) * ux);
      const along = (p) => (p.x - b.a.x) * ux + (p.y - b.a.y) * uy;
      const tol = Math.max(0.3, (b.t || 0.4) * 0.75);
      const rl = dist(r.a, r.b);
      const parallel = rl > 1e-6 && Math.abs(((r.b.x - r.a.x) * uy - (r.b.y - r.a.y) * ux) / rl) < 0.06;
      if (!parallel || off(r.a) > tol || off(r.b) > tol) { next.push(b); continue; }
      const s0 = Math.min(along(r.a), along(r.b)), s1 = Math.max(along(r.a), along(r.b));
      if (s1 <= 0.01 || s0 >= L - 0.01) { next.push(b); continue; }
      const P = (s) => ({ x: b.a.x + ux * s, y: b.a.y + uy * s });
      if (s0 > 0.1) next.push({ ...b, a: { ...b.a }, b: P(s0) });
      if (s1 < L - 0.1) next.push({ ...b, a: P(s1), b: { ...b.b } });
    }
    out = next;
  }
  return out;
}
