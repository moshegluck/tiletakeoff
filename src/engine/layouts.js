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

// Generate placements covering the polygon bounds (oversized so the
// renderer can clip). tileW/tileH are in feet and INCLUDE the grout
// joint already (caller adds joint).
/**
 * Generate tile placements covering a room polygon (oversized; the
 * renderer clips). tileW/tileH are in FEET incl. grout.
 * @param {import('./types.js').Point[]} poly
 * @param {{pattern?:import('./types.js').PatternId, tileW:number, tileH:number, angleDeg?:number, origin?:import('./types.js').Point}} opts
 * @returns {import('./types.js').TileQuad[]}
 */
export function generateLayout(poly, opts) {
  const { pattern = 'grid', tileW, tileH, angleDeg = 0, origin = { x: 0, y: 0 } } = opts;
  const b = bounds(poly);
  // pad bounds by 2 tiles each side
  const pad = Math.max(tileW, tileH) * 2;
  const region = { minx: b.minx - pad, miny: b.miny - pad, maxx: b.maxx + pad, maxy: b.maxy + pad };

  switch (pattern) {
    case 'herringbone': return herringbone(region, tileW, tileH, origin);
    case 'diagonal':    return grid(region, tileW, tileH, origin, 45);
    case 'basketweave': return basketweave(region, tileW, tileH, origin);
    case 'brick_50':    return grid(region, tileW, tileH, origin, angleDeg, 0.5);
    case 'brick_33':    return grid(region, tileW, tileH, origin, angleDeg, 1 / 3);
    case 'grid':
    default:            return grid(region, tileW, tileH, origin, angleDeg, 0);
  }
}

function grid(region, tw, th, origin, angleDeg = 0, rowOffset = 0) {
  const tiles = [];
  const rot = (angleDeg * Math.PI) / 180;
  // Anchor the grid so a tile edge falls on (origin.x, origin.y). Walking out
  // from that anchor (rather than from a padded region edge) keeps tiles that
  // sit flush with the room boundary classified as full, not spuriously cut.
  const startX = origin.x - Math.ceil((origin.x - region.minx) / tw) * tw;
  const startY = origin.y - Math.ceil((origin.y - region.miny) / th) * th;
  const cols = Math.ceil((region.maxx - startX) / tw) + 1;
  const rows = Math.ceil((region.maxy - startY) / th) + 1;
  for (let r = 0; r < rows; r++) {
    const off = (rowOffset && r % 2) ? rowOffset * tw : 0;
    for (let c = -1; c <= cols; c++) {
      const x = startX + c * tw + off;
      const y = startY + r * th;
      tiles.push({ cx: x + tw / 2, cy: y + th / 2, w: tw, h: th, rot });
    }
  }
  return tiles;
}

function herringbone(region, tw, th, _origin) {
  // classic herringbone: planks alternate 0/90°, interlocking
  const tiles = [];
  const long = Math.max(tw, th), short = Math.min(tw, th);
  const step = long + short;
  const cols = Math.ceil((region.maxx - region.minx) / step) + 3;
  const rows = Math.ceil((region.maxy - region.miny) / step) + 3;
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c < cols; c++) {
      const bx = region.minx + c * step + (r % 2 ? step / 2 : 0);
      const by = region.miny + r * step;
      // horizontal plank
      tiles.push({ cx: bx + long / 2, cy: by + short / 2, w: long, h: short, rot: 0 });
      // vertical plank tucked into the L
      tiles.push({ cx: bx + long + short / 2, cy: by + short + long / 2, w: short, h: long, rot: 0 });
    }
  }
  return tiles;
}

function basketweave(region, tw, th, _origin) {
  const tiles = [];
  const unit = tw * 2; // 2 tiles per weave block (assumes square-ish)
  const cols = Math.ceil((region.maxx - region.minx) / unit) + 2;
  const rows = Math.ceil((region.maxy - region.miny) / unit) + 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = region.minx + c * unit, y = region.miny + r * unit;
      const horiz = (r + c) % 2 === 0;
      if (horiz) {
        tiles.push({ cx: x + tw / 2, cy: y + th / 4, w: tw, h: th / 2, rot: 0 });
        tiles.push({ cx: x + tw / 2, cy: y + (th * 3) / 4, w: tw, h: th / 2, rot: 0 });
      } else {
        tiles.push({ cx: x + tw / 4, cy: y + th / 2, w: tw / 2, h: th, rot: 0 });
        tiles.push({ cx: x + (tw * 3) / 4, cy: y + th / 2, w: tw / 2, h: th, rot: 0 });
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
