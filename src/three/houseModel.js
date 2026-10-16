// ============================================================
// houseModel.js — assemble what the 3D house is built from, out of
// the project: traced walls/openings + takeoff rooms + their finishes.
// Pure (no three.js) so it stays cheap and testable.
// ============================================================
import { presetById, paintById, defaultFinishFor } from '../data/finishes.js';
import { roomTypeOf } from '../engine/trace/analyze.js';
import { roomArea } from '../engine/geometry.js';
import { interiorPoint } from '../engine/trace/vec.js';
import { roomRegions, zonesOf } from '../engine/zones.js';

const specOf = (p) => (p ? { style: p.style, color: p.color, tw: p.tw, th: p.th, grout: p.grout ?? 0.125, pattern: p.pattern || 'grid' } : null);

export function specFromMaterial(m) {
  const p = m.presetId && presetById(m.presetId);
  if (p) return specOf(p);
  return {
    style: m.finishStyle || (m.type === 'wall' ? 'gloss' : 'stone'), color: m.color || '#cccccc',
    tw: m.tw || 12, th: m.th || 12, grout: m.grout ?? 0.125, pattern: m.pattern || 'grid',
  };
}

// Floor design zones (border bands, inlays) as surfaces laid over the
// room's floor, each in its own material (or its colour if none is picked).
function zoneSurfaces(r, mats) {
  if (!zonesOf(r).length) return [];
  const reg = roomRegions(r);
  const spec = (z) => {
    const m = mats.find((x) => x.id === z.materialId);
    return m ? specFromMaterial(m) : { style: 'stone', color: z.color || '#7a3fa0', tw: 12, th: 12, grout: 0.125, pattern: 'grid' };
  };
  return [
    ...reg.bands.map((b) => ({ id: b.zone.id, poly: b.outer, holes: b.holes, spec: spec(b.zone), lift: 0.01 })),
    ...reg.inlays.map((z) => ({ id: z.zone.id, poly: z.outer, holes: [], spec: spec(z.zone), lift: 0.015 })),
  ];
}

function toRoom(r, mats) {
  const type = r.roomType || roomTypeOf(r.name);
  const fin = { ...defaultFinishFor(type), ...(r.finish || {}) };
  const assigned = r.assigned || [];
  const floorMat = mats.find((m) => m.type === 'floor' && assigned.includes(m.id));
  const wallMat = mats.find((m) => m.type === 'wall' && assigned.includes(m.id));
  const wallTile = wallMat ? specFromMaterial(wallMat) : null;
  return {
    id: r.id, name: r.name, type,
    poly: r.points, holes: r.holes || [],
    zones: zoneSurfaces(r, mats),
    center: r.labelAt || interiorPoint(r.points),
    area: roomArea(r),
    floor: floorMat ? specFromMaterial(floorMat) : specOf(presetById(fin.floor)) || specOf(presetById('oak-plank')),
    floorName: floorMat ? floorMat.name : presetById(fin.floor)?.name,
    floorPriced: !!floorMat,
    wallTile,
    wallTileName: wallMat?.name || null,
    wallTileHeight: wallTile ? (fin.wallTileHeight === undefined ? 4 : fin.wallTileHeight) : 0,
    paint: paintById(fin.paint).color,
    paintId: fin.paint,
  };
}

/** Walls for hand-drawn rooms (no trace): every room edge becomes a 4½" wall just outside the floor. */
function wallsFromRooms(rooms) {
  const t = 4.5 / 12;
  const walls = [];
  for (const r of rooms) {
    const pts = r.poly;
    let A = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; A += p.x * q.y - q.x * p.y; }
    const sgn = A >= 0 ? -1 : 1; // outward = right of travel for a positive loop
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const nx = (-dy / L) * sgn * (t / 2), ny = (dx / L) * sgn * (t / 2);
      walls.push({ a: { x: a.x + nx, y: a.y + ny }, b: { x: b.x + nx, y: b.y + ny }, t, exterior: true });
    }
  }
  return walls;
}

export function buildHouseModel(st) {
  const tr = st.trace;
  const res = tr?.result;
  const H = tr?.settings?.ceilingHeight ?? (st.rooms.find((r) => r.wallHeight)?.wallHeight ?? 8);
  const doorH = tr?.settings?.doorHeight ?? 6 + 8 / 12;
  let rooms;
  if (st.rooms.length) rooms = st.rooms.map((r) => toRoom(r, st.materials));
  else if (res) rooms = res.rooms.map((r) => toRoom({ id: r.id, name: r.name, points: r.poly, holes: r.holes, roomType: r.type, labelAt: r.center }, st.materials));
  else rooms = [];
  const fromTrace = !!res && (st.rooms.length === 0 || st.rooms.some((r) => r.traceId));
  return {
    H, doorH, rooms,
    walls: fromTrace ? res.walls : wallsFromRooms(rooms),
    openings: fromTrace ? res.openings : [],
    fromTrace,
  };
}
