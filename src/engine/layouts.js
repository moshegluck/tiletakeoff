// ============================================================
// layouts.js — generate tile placements for a room polygon.
// Each pattern returns an array of tile quads in feet:
//   { cx, cy, w, h, rot }  (center, size, rotation radians)
// The renderer classifies each as full/cut against the room.
// Units in: tile w/h in FEET (incl. grout), origin offset, angle.
// ============================================================

import { bounds, classifyTile } from './geometry.js';

export const PATTERNS = [
  { id: 'grid',        label: 'Straight (grid)',     hasOffset: false, hasAngle: true },
  { id: 'brick_50',    label: 'Brick / running 50%', hasOffset: false, hasAngle: true },
  { id: 'brick_33',    label: 'Brick 1/3 offset',    hasOffset: false, hasAngle: true },
  { id: 'herringbone', label: 'Herringbone',         hasOffset: false, hasAngle: true },
  { id: 'diagonal',    label: 'Diagonal 45°',        hasOffset: false, hasAngle: false },
  { id: 'basketweave', label: 'Basketweave',         hasOffset: false, hasAngle: true },
];

// Every pattern is laid out in its own frame — tiles placed around (0,0),
// unrotated — and then the whole lattice is rotated by the layout angle and
// moved to the origin. (Rotating each tile about its own centre on an
// unrotated lattice leaves gaps and overlaps.) A pattern may carry its own
// base angle: diagonal is a grid at 45°, herringbone is laid with planks at
// ±45° so the zigzag runs along the room.
const BASE_ANGLE = { diagonal: 45, herringbone: -45 };

/**
 * Generate tile placements covering a room polygon (oversized; the
 * renderer clips). tileW/tileH are in FEET incl. grout.
 * @param {import('./types.js').Point[]} poly
 * @param {{pattern?:import('./types.js').PatternId, tileW:number, tileH:number, angleDeg?:number, origin?:import('./types.js').Point}} opts
 * @returns {import('./types.js').TileQuad[]}
 */
export function generateLayout(poly, opts) {
  const { pattern = 'grid', tileW, tileH, angleDeg = 0, origin = { x: 0, y: 0 } } = opts;
  if (!(tileW > 0 && tileH > 0) || !poly?.length) return [];
  const ang = (((BASE_ANGLE[pattern] || 0) + (angleDeg || 0)) * Math.PI) / 180;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  // the room's bounds in the pattern frame, padded by two tiles
  const b = bounds(poly);
  const pad = Math.max(tileW, tileH) * 2;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of [[b.minx, b.miny], [b.maxx, b.miny], [b.maxx, b.maxy], [b.minx, b.maxy]]) {
    const dx = x - origin.x, dy = y - origin.y;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;   // rotate by −ang
    minx = Math.min(minx, lx); miny = Math.min(miny, ly); maxx = Math.max(maxx, lx); maxy = Math.max(maxy, ly);
  }
  const region = { minx: minx - pad, miny: miny - pad, maxx: maxx + pad, maxy: maxy + pad };

  let local;
  switch (pattern) {
    case 'herringbone': local = herringbone(region, tileW, tileH); break;
    case 'basketweave': local = basketweave(region, tileW, tileH); break;
    case 'brick_50':    local = grid(region, tileW, tileH, 0.5); break;
    case 'brick_33':    local = grid(region, tileW, tileH, 1 / 3); break;
    case 'diagonal':
    case 'grid':
    default:            local = grid(region, tileW, tileH, 0);
  }
  if (!ang) return local.map((t) => ({ ...t, cx: t.cx + origin.x, cy: t.cy + origin.y }));
  return local.map((t) => ({
    cx: origin.x + t.cx * cos - t.cy * sin,
    cy: origin.y + t.cx * sin + t.cy * cos,
    w: t.w, h: t.h, rot: (t.rot || 0) + ang,
  }));
}

// Straight lattice with a tile edge on (0,0); every other row shifted by
// rowOffset × tile width for running bond.
function grid(region, tw, th, rowOffset = 0) {
  const tiles = [];
  const r0 = Math.floor(region.miny / th), r1 = Math.ceil(region.maxy / th);
  const c0 = Math.floor(region.minx / tw) - 1, c1 = Math.ceil(region.maxx / tw);
  for (let r = r0; r <= r1; r++) {
    const off = rowOffset ? (((r % 2) + 2) % 2) * rowOffset * tw : 0;
    for (let c = c0; c <= c1; c++) {
      const x = c * tw + off, y = r * th;
      tiles.push({ cx: x + tw / 2, cy: y + th / 2, w: tw, h: th, rot: 0 });
    }
  }
  return tiles;
}

// Herringbone: planks L×S, alternately horizontal and vertical, each end
// butting the side of its neighbour. One horizontal and one vertical plank
// repeat on the lattice  o = i·(S, S) + j·(L, −L):
//   horizontal  [o.x, o.x+L] × [o.y, o.y+S]
//   vertical    [o.x, o.x+S] × [o.y+S, o.y+S+L]
// which covers the plane exactly, for any L > S.
function herringbone(region, tw, th) {
  const tiles = [];
  const L = Math.max(tw, th), S = Math.min(tw, th);
  if (L - S < 1e-9) return grid(region, tw, th, 0);   // square tiles: no herringbone
  // lattice indices that reach the region's corners: i = (x+y)/2S, j = (x−y)/2L
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [x, y] of [[region.minx, region.miny], [region.maxx, region.miny], [region.maxx, region.maxy], [region.minx, region.maxy]]) {
    const i = (x + y) / (2 * S), j = (x - y) / (2 * L);
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  const m = Math.ceil(L / S) + 2;
  for (let i = Math.floor(i0) - m; i <= Math.ceil(i1) + m; i++) {
    for (let j = Math.floor(j0) - 2; j <= Math.ceil(j1) + 2; j++) {
      const ox = i * S + j * L, oy = i * S - j * L;
      if (ox > region.maxx || ox + L < region.minx || oy > region.maxy || oy + S + L < region.miny) continue;
      tiles.push({ cx: ox + L / 2, cy: oy + S / 2, w: L, h: S, rot: 0 });
      tiles.push({ cx: ox + S / 2, cy: oy + S + L / 2, w: S, h: L, rot: 0 });
    }
  }
  return tiles;
}

// Basketweave: square blocks of n = L/S whole tiles laid side by side,
// alternating horizontal and vertical like a checkerboard (4×8, 3×6, 2×4…).
// Square tiles have no weave, so they lay as a grid. The weave is only
// exact when L is a whole multiple of S; other ratios are approximated by
// round(L/S) tiles per L×L block.
function basketweave(region, tw, th) {
  const L = Math.max(tw, th), S = Math.min(tw, th);
  const n = Math.max(1, Math.round(L / S));
  if (n === 1) return grid(region, tw, th, 0);
  const s = L / n;                       // tile thickness inside an L×L block
  const tiles = [];
  const c0 = Math.floor(region.minx / L), c1 = Math.ceil(region.maxx / L);
  const r0 = Math.floor(region.miny / L), r1 = Math.ceil(region.maxy / L);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * L, y = r * L;
      const horiz = (((r + c) % 2) + 2) % 2 === 0;
      for (let k = 0; k < n; k++) {
        if (horiz) tiles.push({ cx: x + L / 2, cy: y + s * k + s / 2, w: L, h: s, rot: 0 });
        else tiles.push({ cx: x + s * k + s / 2, cy: y + L / 2, w: s, h: L, rot: 0 });
      }
    }
  }
  return tiles;
}

// Count full vs cut tiles for a generated layout within a room.
// For rotated/herringbone tiles we approximate using the AABB corners,
// which is accurate for grid/brick and a close estimate otherwise.
export function tally(tiles, poly) {
  let full = 0, cut = 0;
  for (const t of tiles) {
    const cls = classifyTile(t.cx - t.w / 2, t.cy - t.h / 2, t.w, t.h, poly);
    if (cls === 'full') full++;
    else if (cls === 'cut') cut++;
  }
  return { full, cut, total: full + cut };
}
