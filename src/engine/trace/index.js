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

import { pairWalls, mergeBodies, WALL_DEFAULTS } from './walls.js';
import { joinWalls, dropDetached, bridgeOpenings, buildGraph, pruneGraph, GRAPH_DEFAULTS } from './graph.js';
import { analyzeGraph, parseScaleNote, parseDoorSchedule, calibrateFromDoors, roomTypeOf } from './analyze.js';
import { dist } from './vec.js';

export { parseScaleNote, parseDoorSchedule, calibrateFromDoors, roomTypeOf };
export { arcFromBezier } from './arcs.js';

export const TRACE_DEFAULTS = { ...WALL_DEFAULTS, ...GRAPH_DEFAULTS, floorAtDoor: 'center' };

/**
 * @param {object} input
 * @param {{a,b,w?}[]} [input.lines]   raw linework (ft)
 * @param {{a,b,t,conf?}[]} [input.bodies] pre-paired wall bodies (raster / AI / manual) (ft)
 * @param {{c,r}[]} [input.arcs]       door-swing arcs (ft)
 * @param {{str,x,y}[]} [input.texts]  sheet text (ft)
 * @param {{a,b}[]} [input.removed]    walls the user erased (matched by proximity)
 * @param {{x0,y0,x1,y1}} [input.sheet] page extent in feet (lets the engine recognise a sheet border)
 * @param {object} [input.options]
 */
export function runTrace(input = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const opt = { ...TRACE_DEFAULTS, ...(input.options || {}) };
  const log = [];
  const texts = input.texts || [];
  const arcs = input.arcs || [];

  // 1. linework → wall bodies
  const paired = input.lines?.length ? pairWalls(input.lines, opt) : { bodies: [], stats: {} };
  let bodies = mergeBodies([
    ...paired.bodies,
    ...(input.bodies || []).map((b) => ({ conf: 0.75, src: 'given', ...b })),
  ]);

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

  // 2. join corners / tees / drafting gaps
  const joined = joinWalls(bodies, opt, log);
  const { segs, ends } = dropDetached(joined.segs, joined.ends, opt, log);

  // 3. bridge doors & openings so rooms can close
  const openings = bridgeOpenings(segs, ends, arcs, opt, log);

  // 4. planar graph, cleaned
  const g0 = buildGraph(segs.concat(openings), opt, log);
  const g = pruneGraph(g0, opt, log);

  // 5. faces → rooms, LF, flags
  const schedule = input.schedule !== undefined ? input.schedule : parseDoorSchedule(texts);
  const res = analyzeGraph(g, { texts, arcs, schedule, options: opt, sheet: input.sheet || null });

  const floorSf = res.rooms.reduce((s, r) => s + r.area, 0);
  const wallLf = res.rooms.reduce((s, r) => s + r.wallLf, 0);
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
    schedule,
    totals: {
      rooms: res.rooms.length, floorSf, roomWallLf: wallLf, wallCenterLf: centerLf, exteriorLf: extLf,
      openings: res.openings.length, doors: res.openings.filter((o) => o.openingType !== 'opening').length,
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
