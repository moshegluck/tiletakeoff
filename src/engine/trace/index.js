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
import { dist, mid, closestOnSeg } from './vec.js';

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

  const manual = (input.manual || []).map((m) => ({ ...m, conf: 1, src: 'manual' }));
  bodies = bodies.concat(manual).map((b) => ({ ...b, kind: 'wall' }));

  // 2. join corners / tees / drafting gaps
  const joined = joinWalls(bodies, opt, log);
  const { segs, ends } = dropDetached(joined.segs, joined.ends, opt, log);

  // 3. bridge doors & openings so rooms can close
  const openings = bridgeOpenings(segs, ends, arcs, opt, log);

  // 4. planar graph, cleaned
  const g0 = buildGraph(segs.concat(openings), opt, log);
  // user erasures win over evidence: drop the graph edges they cover, then re-clean
  let gE = g0;
  if (input.removed?.length) {
    const keep = g0.edges.filter((e) => e.kind !== 'wall' || !input.removed.some((r) => edgeCovered(g0.nodes[e.u], g0.nodes[e.v], r)));
    if (keep.length !== g0.edges.length) log.push({ kind: 'erase', at: null, note: `${g0.edges.length - keep.length} wall piece(s) removed by hand` });
    gE = { nodes: g0.nodes, edges: keep.map((e, i) => ({ ...e, id: i })) };
  }
  const g = pruneGraph(gE, opt, log);

  // 5. faces → rooms, LF, flags
  const schedule = input.schedule !== undefined ? input.schedule : parseDoorSchedule(texts);
  const res = analyzeGraph(g, { texts, arcs, schedule, options: opt });

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

/** Is graph edge a–b part of the wall the user erased (r = the traced wall piece they clicked)? */
function edgeCovered(a, b, r) {
  const tol = 0.25;
  const m = mid(a, b);
  return closestOnSeg(m, r.a, r.b).d <= tol && closestOnSeg(a, r.a, r.b).d <= tol && closestOnSeg(b, r.a, r.b).d <= tol && dist(a, b) > 1e-6;
}
