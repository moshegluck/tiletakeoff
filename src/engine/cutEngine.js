// ============================================================
// cutEngine.js — cut-piece accounting & offcut redistribution.
//
// THE PROBLEM this solves:
//   A naive estimate does:  tiles = ceil(area * (1+waste) / tileArea).
//   That silently assumes every cut tile is thrown away. In reality a
//   tile cut to fit one edge leaves an OFFCUT that often fits another
//   cut location. Good installers reuse them. This engine models that.
//
// HOW IT WORKS:
//   1. From the generated layout we separate FULL tiles from CUT tiles.
//   2. For every CUT tile we compute the piece actually installed
//      (its clipped bounding box in tile-space), and therefore the
//      OFFCUT left on the cutting bench (remainder of the full tile).
//   3. We try to satisfy each needed cut piece from the pool of offcuts
//      already produced (respecting grain direction for planks/wood-look
//      and a usable-offcut threshold). Only when no offcut fits do we
//      break a NEW full tile (which itself yields a fresh offcut).
//
//   Two modes:
//     - 'practical' (default): greedy first-fit within a room, then
//        across rooms of the same material. Mirrors real bench behavior.
//     - 'optimize' (whole job): sort needs largest-first and match to
//        the smallest sufficient offcut (best-fit decreasing) across the
//        entire material. Squeezes out the most reuse; slower but exact
//        for the rectangular-piece model.
//
// SCOPE / HONESTY:
//   This is a rectangular-piece model: each cut is treated as the AABB
//   of the installed fragment. That's how tile actually gets cut on a
//   wet saw (straight cuts), so for grid/brick/plank it's accurate. For
//   diagonal/herringbone the fragments are triangular; we model their
//   bounding rectangle, which is the right call for ORDERING (you still
//   cut from a full tile) and slightly conservative on reuse. Flagged in
//   the report so nobody over-trusts it.
//
// FLOOR DESIGN ZONES (engine/zones.js):
//   A room's field is analyzed as a region with holes (border bands and
//   inlays carved out), each inlay is its own surface with its own layout,
//   and border bands are counted as wall runs of strips (bandPieces) rather
//   than a grid, because that is how a border is installed.
// ============================================================

import { generateLayout } from './layouts.js';
import { roomRegions, classifyTileRegion, fragmentInRegion, bandPieces } from './zones.js';

const EPS = 1e-6;

// A piece is usable as a donor if BOTH its dims are >= the need, and it
// meets the minimum-usable fraction of a full tile (tiny slivers crack).
function fits(need, donor, grainLocked) {
  if (grainLocked) {
    return donor.w >= need.w - EPS && donor.h >= need.h - EPS;
  }
  // free rotation allowed: try both orientations
  return (donor.w >= need.w - EPS && donor.h >= need.h - EPS) ||
         (donor.w >= need.h - EPS && donor.h >= need.w - EPS);
}

// Given a full tile (tw x th) and the installed fragment AABB (w x h),
// return the offcut pieces. A straight-cut fragment from a corner/edge
// yields up to two rectangular offcuts (an L-shape split into two rects).
// We return the two candidate rectangles; the larger is the "primary"
// reusable strip, the smaller is usually scrap.
function offcutsFrom(tw, th, w, h) {
  const pieces = [];
  const rightW = tw - w, bottomH = th - h;
  // vertical strip on the right (full height of tile)
  if (rightW > EPS) pieces.push({ w: rightW, h: th });
  // horizontal strip on the bottom, only spanning the installed width
  if (bottomH > EPS) pieces.push({ w, h: bottomH });
  return pieces;
}

/**
 * Analyze cut redistribution for ONE material across its assigned rooms.
 * @param {import('./types.js').Room[]} rooms  rooms assigned to this material
 * @param {import('./types.js').Material} material
 * @param {{ mode?: 'practical'|'optimize', minUsableFrac?: number }} [opts]
 * @returns {import('./types.js').CutResult}
 */
export function analyzeCuts(rooms, material, opts = {}) {
  const mode = opts.mode || 'practical';
  const minUsableFrac = opts.minUsableFrac ?? 0.10; // ignore offcuts < 10% tile area as scrap
  const grainLocked = material.grainLocked ?? isPlank(material);

  const twFt = (material.tw + (material.grout || 0)) / 12;
  const thFt = (material.th + (material.grout || 0)) / 12;
  const fullTileArea = twFt * thFt;
  const minUsableArea = fullTileArea * minUsableFrac;

  // guard: a tile size of zero would divide-by-zero in the layout; bail clean.
  if (!(twFt > 0) || !(thFt > 0)) {
    return emptyResult(material, mode, grainLocked);
  }

  // 1. gather surfaces for this material, then full + cut tiles on each.
  // Field: rooms assigned to THIS material. Callers are expected to
  // pre-filter, but relying on that made the result wrong if they didn't. If
  // a room carries no `assigned` array at all we include it (back-compat with
  // direct single-material calls in tests/tools). Zones: any room whose
  // border/inlay picked this material.
  const surfaces = [];  // grid-laid regions
  const summary = [];   // per-surface rollup for the cut sheet
  const border = { lf: 0, strips: 0, tiles: 0 };
  for (const room of rooms) {
    const onField = !room.assigned || room.assigned.includes(material.id);
    const onZone = (room.zones || []).some((z) => z.materialId === material.id);
    if (!onField && !onZone) continue;
    const reg = roomRegions(room);
    if (onField) {
      const pattern = room.layout?.pattern || material.pattern || 'grid';
      // the layout always spans the whole room so pattern lines stay
      // continuous across a field that a border splits into ring + center
      for (const region of reg.field) surfaces.push({ name: room.name, region, layoutPoly: room.points, layout: room.layout, pattern });
      summary.push({ name: room.name, kind: 'field', areaSf: reg.fieldArea, pattern, cuts: 0 });
    }
    for (const z of reg.inlays) {
      if (z.zone.materialId !== material.id) continue;
      const name = `${room.name} · ${z.zone.name}`;
      const pattern = z.layout?.pattern || material.pattern || 'grid';
      surfaces.push({ name, region: { outer: z.outer, holes: [] }, layoutPoly: z.outer, layout: z.layout, pattern });
      summary.push({ name, kind: 'inlay', areaSf: z.area, pattern, cuts: 0 });
    }
    for (const b of reg.bands) {
      if (b.zone.materialId !== material.id) continue;
      const bp = bandPieces(b, material);
      border.lf += bp.lf; border.strips += bp.strips; border.tiles += bp.tiles;
      summary.push({ name: `${room.name} · ${b.zone.name}`, kind: 'border', areaSf: b.area, pattern: 'border run', cuts: bp.strips, lf: bp.lf });
    }
  }

  let fullCount = 0;
  const needs = []; // each: {w,h,area,room}
  for (const sf of surfaces) {
    const tiles = generateLayout(sf.layoutPoly, {
      pattern: sf.pattern,
      tileW: twFt, tileH: thFt,
      angleDeg: sf.layout?.angleDeg || 0,
      origin: sf.layout?.origin || { x: 0, y: 0 },
    });
    const frames = new Map();
    for (const t0 of tiles) {
      // classify in the tile's own frame, so a rotated tile (diagonal,
      // herringbone, any layout angle) is judged by its true outline and its
      // cut is measured along its own edges, as the cutter sees it
      const { region, t } = inTileFrame(t0, sf.region, frames);
      const cls = classifyTileRegion(t.cx - t.w / 2, t.cy - t.h / 2, t.w, t.h, region);
      if (cls === 'full') fullCount++;
      else if (cls === 'cut') {
        const frag = fragmentInRegion(t, region);
        if (frag && frag.area > EPS) {
          // The same tile is laid both ways in herringbone / basketweave (a
          // laid tile's w may be the material's th). Express the piece in the
          // material tile's own orientation, or cutting it from a fresh tile
          // would leave offcuts bigger than the tile.
          const swapped = Math.abs(t.w - twFt) + Math.abs(t.h - thFt) > Math.abs(t.w - thFt) + Math.abs(t.h - twFt);
          needs.push({ ...frag, ...(swapped ? { w: frag.h, h: frag.w } : {}), room: sf.name });
        }
      }
    }
  }

  // 2. redistribution
  const result = redistribute(needs, { twFt, thFt, fullTileArea, minUsableArea, grainLocked, mode });

  const cutTilesNeeded = needs.length;
  const newTilesForCuts = result.newTilesBroken;
  const naiveCutTiles = cutTilesNeeded; // naive: 1 full tile per cut
  const tilesSavedByReuse = naiveCutTiles - newTilesForCuts;

  // border strips are cut per run; reuse doesn't apply, so they add equally
  // to the real and the naive totals
  const totalTiles = fullCount + newTilesForCuts + border.tiles;
  const naiveTotal = fullCount + naiveCutTiles + border.tiles;

  for (const row of summary) if (row.kind !== 'border') row.cuts = needs.filter((n) => n.room === row.name).length;

  return {
    material: material.name,
    pattern: surfaces[0]?.pattern || material.pattern || 'grid',
    grainLocked,
    fullTiles: fullCount,
    cutPieces: cutTilesNeeded,
    newTilesBrokenForCuts: newTilesForCuts,
    reusedOffcuts: result.reuseCount,
    tilesSavedByReuse,
    scrapPieces: result.scrapCount,
    totalTiles,
    naiveTotal,
    pctSaved: naiveTotal ? (tilesSavedByReuse / naiveTotal) * 100 : 0,
    mode,
    assignments: result.assignments, // for the cut sheet
    note: surfaces.some((sf) => ANGLED.has(sf.pattern))
      ? 'Angled cuts are sized by their bounding rectangle along the tile (conservative on reuse).'
      : null,
    border,
    surfaces: summary,
  };
}

// A tile and the region in the tile's frame: the region rotated by −rot about
// (0,0) and the tile's centre with it, so the tile is axis-aligned. Each
// distinct angle's rotated region is computed once per surface.
function inTileFrame(tile, region, frames) {
  if (!tile.rot) return { region, t: tile };
  const key = tile.rot.toFixed(9);
  let f = frames.get(key);
  if (!f) {
    const c = Math.cos(tile.rot), s = Math.sin(tile.rot);
    const rot = (p) => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c });
    f = { c, s, region: { outer: region.outer.map(rot), holes: (region.holes || []).map((h) => h.map(rot)) } };
    frames.set(key, f);
  }
  return {
    region: f.region,
    t: { cx: tile.cx * f.c + tile.cy * f.s, cy: -tile.cx * f.s + tile.cy * f.c, w: tile.w, h: tile.h, rot: 0 },
  };
}

// zero-work result shape (no assigned rooms, or invalid tile size)
function emptyResult(material, mode, grainLocked) {
  return {
    material: material.name, pattern: material.pattern || 'grid', grainLocked,
    fullTiles: 0, cutPieces: 0, newTilesBrokenForCuts: 0, reusedOffcuts: 0,
    tilesSavedByReuse: 0, scrapPieces: 0, totalTiles: 0, naiveTotal: 0,
    pctSaved: 0, mode, assignments: [], note: null,
    border: { lf: 0, strips: 0, tiles: 0 }, surfaces: [],
  };
}

function redistribute(needs, ctx) {
  const { twFt, thFt, minUsableArea, grainLocked, mode } = ctx;
  const offcutPool = []; // {id,w,h,area, fromTile}
  let newTilesBroken = 0, reuseCount = 0, scrapCount = 0;
  /** @type {import('./types.js').CutAssignment[]} */
  const assignments = [];
  let pieceSeq = 0;

  // ordering of needs
  let order = needs.map((n, i) => ({ ...n, i }));
  if (mode === 'optimize') {
    // best-fit decreasing: handle the biggest pieces first
    order.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  }

  for (const need of order) {
    pieceSeq++;
    // find a donor offcut
    let donorIdx = -1;
    if (mode === 'optimize') {
      // best-fit: smallest sufficient offcut (minimize waste left)
      let best = Infinity;
      for (let k = 0; k < offcutPool.length; k++) {
        if (fits(need, offcutPool[k], grainLocked)) {
          const slack = offcutPool[k].area - need.w * need.h;
          if (slack < best) { best = slack; donorIdx = k; }
        }
      }
    } else {
      // practical first-fit
      donorIdx = offcutPool.findIndex((o) => fits(need, o, grainLocked));
    }

    if (donorIdx >= 0) {
      const donor = offcutPool.splice(donorIdx, 1)[0];
      reuseCount++;
      const produced = [];
      const sub = offcutsFrom(donor.w, donor.h, need.w, need.h);
      for (const p of sub) {
        const a = p.w * p.h;
        if (a >= minUsableArea) { const id = `O${donor.fromTile}.${++pieceSeq}`; offcutPool.push({ ...p, area: a, fromTile: donor.fromTile, id }); produced.push({ ...p, id }); }
        else if (a > EPS) scrapCount++;
      }
      assignments.push({
        piece: `C${pieceSeq}`, room: need.room, w: need.w, h: need.h,
        source: 'offcut', from: donor.id || `tile ${donor.fromTile}`, produces: produced,
      });
    } else {
      // break a fresh full tile
      newTilesBroken++;
      const produced = [];
      const sub = offcutsFrom(twFt, thFt, need.w, need.h);
      for (const p of sub) {
        const a = p.w * p.h;
        if (a >= minUsableArea) { const id = `O${newTilesBroken}.${++pieceSeq}`; offcutPool.push({ ...p, area: a, fromTile: newTilesBroken, id }); produced.push({ ...p, id }); }
        else if (a > EPS) scrapCount++;
      }
      assignments.push({
        piece: `C${pieceSeq}`, room: need.room, w: need.w, h: need.h,
        source: 'new tile', from: `tile #${newTilesBroken}`, produces: produced,
      });
    }
  }

  // any offcuts still in the pool that were never used become leftover (not scrap;
  // they're whole usable pieces the installer keeps as attic stock)
  return { newTilesBroken, reuseCount, scrapCount, assignments, leftover: offcutPool.length };
}

function isPlank(m) {
  const ratio = Math.max(m.tw, m.th) / Math.min(m.tw, m.th);
  return ratio >= 2.5; // planks / wood-look: grain matters
}
const ANGLED = new Set(['herringbone', 'diagonal', 'basketweave']);

/**
 * Compare naive waste vs redistribution for a whole project.
 * Returns per-material rows plus totals — drives the Estimate + Cut Sheet.
 */
/**
 * Compare naive / practical / optimized totals across all materials.
 * @param {import('./types.js').ProjectState} state
 * @param {{ minUsableFrac?: number }} [opts]
 */
export function analyzeProject(state, opts = {}) {
  const rows = [];
  for (const m of state.materials) {
    const rooms = state.rooms.filter((r) => r.assigned?.includes(m.id) ||
      (r.zones || []).some((z) => z.materialId === m.id));
    if (!rooms.length) continue;
    const practical = analyzeCuts(rooms, m, { ...opts, mode: 'practical' });
    const optimized = analyzeCuts(rooms, m, { ...opts, mode: 'optimize' });
    rows.push({ materialId: m.id, practical, optimized });
  }
  const totals = rows.reduce((acc, r) => {
    acc.naive += r.practical.naiveTotal;
    acc.practical += r.practical.totalTiles;
    acc.optimized += r.optimized.totalTiles;
    return acc;
  }, { naive: 0, practical: 0, optimized: 0 });
  return { rows, totals };
}
