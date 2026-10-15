import { describe, it, expect } from 'vitest';
import { offsetPolygon, roomRegions, classifyTileRegion, fragmentInRegion, bandPieces, isAxisRect, cleanPolygon, inlayLayout } from '../src/engine/zones.js';
import { polygonArea, rectPoly } from '../src/engine/geometry.js';
import { analyzeCuts } from '../src/engine/cutEngine.js';
import { materialArea, estimateMaterial } from '../src/engine/estimate.js';

const L_SHAPE = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
];
const mat = (id, over = {}) => ({ id, name: id, type: 'floor', tw: 12, th: 12, grout: 0, pattern: 'grid', waste: 10, price: 1, priceUnit: 'sf', faceCoverage: 1, ...over });
const roomWith = (zones, over = {}) => ({
  id: 'r1', name: 'Kitchen', points: rectPoly(0, 0, 12, 10), assigned: ['FIELD'], layout: { pattern: 'grid' }, zones, ...over,
});
const border = (over = {}) => ({ id: 'b1', kind: 'border', name: 'Border', materialId: 'BORDER', inset: 0, width: 0.5, ...over });
const inlay = (pts, over = {}) => ({ id: 'i1', kind: 'inlay', name: 'Inlay', materialId: 'INLAY', points: pts, layout: { pattern: 'grid', origin: { x: 0, y: 0 } }, ...over });

describe('zones: offsetPolygon', () => {
  it('insets a square on both windings', () => {
    const cw = offsetPolygon(rectPoly(0, 0, 10, 10), 1);
    const ccw = offsetPolygon(rectPoly(0, 0, 10, 10).slice().reverse(), 1);
    expect(polygonArea(cw)).toBeCloseTo(64, 9);
    expect(polygonArea(ccw)).toBeCloseTo(64, 9);
    for (const p of cw) { expect(p.x).toBeGreaterThanOrEqual(1 - 1e-9); expect(p.x).toBeLessThanOrEqual(9 + 1e-9); }
  });

  it('follows an L-shaped room (reflex corner included)', () => {
    const o = offsetPolygon(L_SHAPE, 1);
    expect(o).toHaveLength(6);
    const want = [[1, 1], [9, 1], [9, 3], [3, 3], [3, 9], [1, 9]];
    o.forEach((p, i) => { expect(p.x).toBeCloseTo(want[i][0], 9); expect(p.y).toBeCloseTo(want[i][1], 9); });
    expect(polygonArea(o)).toBeCloseTo(28, 9);
  });

  it('returns null when the offset collapses the room', () => {
    expect(offsetPolygon(rectPoly(0, 0, 10, 10), 5)).toBeNull();
    expect(offsetPolygon(rectPoly(0, 0, 10, 10), 6)).toBeNull();
    expect(offsetPolygon(L_SHAPE, 2)).toBeNull();     // 4 ft legs
    expect(offsetPolygon(L_SHAPE, 1.9)).not.toBeNull();
  });

  it('ignores duplicate and collinear vertices', () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(cleanPolygon(pts)).toHaveLength(4);
    expect(polygonArea(offsetPolygon(pts, 1))).toBeCloseTo(64, 9);
  });
});

describe('zones: roomRegions', () => {
  it('a room with no zones is all field', () => {
    const reg = roomRegions(roomWith(undefined));
    expect(reg.fieldArea).toBeCloseTo(120, 9);
    expect(reg.bands).toHaveLength(0);
  });

  it('border inset from the wall splits field into ring + center', () => {
    const reg = roomWith([border({ inset: 1, width: 0.5 })]);
    const r = roomRegions(reg);
    expect(r.field).toHaveLength(2);
    expect(r.field[0].area).toBeCloseTo(120 - 80, 9);   // outer ring
    expect(r.field[1].area).toBeCloseTo(9 * 7, 9);      // center
    expect(r.bands[0].area).toBeCloseTo(80 - 63, 9);
    expect(r.bands[0].lf).toBeCloseTo(2 * (9.5 + 7.5), 9); // centerline at 1.25 ft
    expect(r.fieldArea + r.bands[0].area).toBeCloseTo(120, 9);
  });

  it('an inlay is carved out of the field', () => {
    const r = roomRegions(roomWith([inlay(rectPoly(4, 3, 4, 3))]));
    expect(r.inlays[0].area).toBeCloseTo(12, 9);
    expect(r.fieldArea).toBeCloseTo(108, 9);
    expect(r.warnings).toHaveLength(0);
  });

  it('border + inlay + field add back up to the room', () => {
    const r = roomRegions(roomWith([border({ inset: 0, width: 1 }), inlay(rectPoly(4, 3, 4, 3))]));
    expect(r.fieldArea + r.bands[0].area + r.inlays[0].area).toBeCloseTo(120, 9);
  });

  it('warns about bands that do not fit or overlap, and skips them', () => {
    const tooWide = roomRegions(roomWith([border({ width: 6 })]));
    expect(tooWide.bands).toHaveLength(0);
    expect(tooWide.fieldArea).toBeCloseTo(120, 9);
    expect(tooWide.warnings[0]).toMatch(/too wide/);

    const overlap = roomRegions(roomWith([border({ id: 'a', name: 'A', inset: 0, width: 1 }), border({ id: 'b', name: 'B', inset: 0.5, width: 1 })]));
    expect(overlap.bands).toHaveLength(1);
    expect(overlap.warnings[0]).toMatch(/overlaps/);
  });

  it('warns when an inlay sits outside the field (e.g. on the border)', () => {
    const r = roomRegions(roomWith([border({ inset: 0, width: 1 }), inlay(rectPoly(0.1, 0.1, 0.5, 0.5))]));
    expect(r.warnings.some((w) => /isn't inside the field/.test(w))).toBe(true);
  });
});

describe('zones: tile classification with holes', () => {
  const region = { outer: rectPoly(0, 0, 10, 10), holes: [rectPoly(3, 3, 4, 4)] };
  it('tile inside a hole is out, flush to a hole is full, across a hole edge is cut', () => {
    expect(classifyTileRegion(4, 4, 1, 1, region)).toBe('out');
    expect(classifyTileRegion(2, 4, 1, 1, region)).toBe('full');
    expect(classifyTileRegion(2.5, 4, 1, 1, region)).toBe('cut');
  });
  it('without holes it matches the plain room classification', () => {
    const plain = { outer: rectPoly(0, 0, 10, 10), holes: [] };
    expect(classifyTileRegion(9.5, 0, 1, 1, plain)).toBe('cut');
    expect(classifyTileRegion(0, 0, 1, 1, plain)).toBe('full');
  });
  it('a hole edge straight across a tile leaves a strip', () => {
    const f = fragmentInRegion({ cx: 3.25, cy: 4.5, w: 1, h: 1, rot: 0 }, { outer: rectPoly(0, 0, 10, 10), holes: [rectPoly(3.5, 3.5, 3, 3)] });
    expect(f.w).toBeCloseTo(0.75, 9);
    expect(f.h).toBeCloseTo(1, 9);
    expect(f.area).toBeCloseTo(0.75, 9);
  });
});

describe('zones: cut engine', () => {
  it('grid-aligned inlay: field loses exactly the inlay tiles, inlay gets its own', () => {
    const room = { name: 'R', points: rectPoly(0, 0, 10, 10), assigned: ['FIELD'], layout: { pattern: 'grid' }, zones: [inlay(rectPoly(3, 3, 4, 4))] };
    const field = analyzeCuts([room], mat('FIELD'));
    expect(field.fullTiles).toBe(84);
    expect(field.cutPieces).toBe(0);
    const ins = analyzeCuts([room], mat('INLAY'));
    expect(ins.fullTiles).toBe(16);
    expect(ins.surfaces[0].name).toBe('R · Inlay');
  });

  it('off-grid inlay: tiles crossing its edge become cuts', () => {
    const room = { name: 'R', points: rectPoly(0, 0, 10, 10), assigned: ['FIELD'], layout: { pattern: 'grid' }, zones: [inlay(rectPoly(3.5, 3.5, 3, 3))] };
    const r = analyzeCuts([room], mat('FIELD'));
    expect(r.fullTiles).toBe(84);
    expect(r.cutPieces).toBe(12);
  });

  it('border bands are counted as wall runs of strips', () => {
    // 4" band on the wall, 4×12 border tile → centerline 11.667 × 9.667
    const room = roomWith([border({ inset: 0, width: 4 / 12 })]);
    const bp = bandPieces(roomRegions(room).bands[0], mat('BORDER', { tw: 4, th: 12 }));
    expect(bp.courses).toBe(1);
    expect(bp.stripsPerTile).toBe(1);
    expect(bp.strips).toBe(12 + 10 + 12 + 10);
    expect(bp.tiles).toBe(44);

    // same band from 12×12 ripped into 6" strips → two strips per tile
    const r6 = roomWith([border({ inset: 0, width: 0.5 })]);
    const bp6 = bandPieces(roomRegions(r6).bands[0], mat('BORDER'));
    expect(bp6.stripsPerTile).toBe(2);
    expect(bp6.tiles).toBe(Math.ceil(bp6.strips / 2));

    // 6" band from 4×12 (with grout): one full 4" course + a 1⅞" rip course,
    // and each 4" tile yields two rip strips
    const r4 = roomWith([border({ inset: 0, width: 0.5 })]);
    const bp4 = bandPieces(roomRegions(r4).bands[0], mat('BORDER', { tw: 4, th: 12, grout: 0.125 }));
    const runPieces = bp4.runs.reduce((a, r) => a + r.pieces, 0);
    expect(bp4.fullCourses).toBe(1);
    expect(bp4.ripWidth * 12).toBeCloseTo(1.875, 9);
    expect(bp4.stripsPerTile).toBe(2);
    expect(bp4.tiles).toBe(runPieces + Math.ceil(runPieces / 2));

    const cuts = analyzeCuts([room], mat('BORDER', { tw: 4, th: 12 }));
    expect(cuts.border.tiles).toBe(44);
    expect(cuts.totalTiles).toBe(44);
    expect(cuts.naiveTotal).toBe(44);
  });
});

describe('zones: estimate', () => {
  const room = roomWith([border({ inset: 0, width: 1 }), inlay(rectPoly(4, 3, 4, 3))]);
  it('each material gets its own share of the floor', () => {
    const f = materialArea(mat('FIELD'), [room]);
    const b = materialArea(mat('BORDER'), [room]);
    const i = materialArea(mat('INLAY'), [room]);
    expect(f.netSf).toBeCloseTo(10 * 8 - 12, 9);
    expect(b.netSf).toBeCloseTo(120 - 80, 9);
    expect(b.usedRooms[0]).toMatchObject({ name: 'Kitchen · Border' });
    expect(b.usedRooms[0].lf).toBeCloseTo(2 * (11 + 9), 9);
    expect(i.netSf).toBeCloseTo(12, 9);
    expect(f.netSf + b.netSf + i.netSf).toBeCloseTo(120, 9);
  });
  it('cut-reuse mode estimates a zone-only material', () => {
    const e = estimateMaterial(mat('INLAY', { costMode: 'cuts', priceUnit: 'tile', cutSafetyPct: 0 }), [room]);
    expect(e.cutInfo.fullTiles).toBe(12);
    expect(e.tiles).toBe(12);
  });
  it('a zone with no material is carved out but not charged to anyone', () => {
    const r = roomWith([inlay(rectPoly(4, 3, 4, 3), { materialId: null })]);
    expect(materialArea(mat('FIELD'), [r]).netSf).toBeCloseTo(108, 9);
  });
});

describe('zones: isAxisRect', () => {
  it('detects boxes, rejects other shapes', () => {
    expect(isAxisRect(rectPoly(1, 1, 3, 2))).toBe(true);
    expect(isAxisRect([{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 3 }, { x: 0, y: 2 }])).toBe(false);
    expect(isAxisRect(L_SHAPE)).toBe(false);
  });
});

describe('zones: inlayLayout anchor', () => {
  it('pins the tile origin to the inlay so tiles move with it', () => {
    const z = inlay(rectPoly(2.5, 3.5, 3, 2), { layout: { pattern: 'grid', anchor: 'corner' } });
    expect(inlayLayout(z).origin).toEqual({ x: 2.5, y: 3.5 });
    expect(inlayLayout({ ...z, layout: { pattern: 'grid', anchor: 'center' } }).origin).toEqual({ x: 4, y: 4.5 });
  });
  it('corner anchor on an off-grid 3×2 inlay gives whole tiles, no cuts', () => {
    const room = roomWith([inlay(rectPoly(2.5, 3.5, 3, 2), { layout: { pattern: 'grid', anchor: 'corner' } })]);
    const r = analyzeCuts([room], mat('INLAY'));
    expect(r.fullTiles).toBe(6);
    expect(r.cutPieces).toBe(0);
  });
  it('center anchor puts a joint on the center lines (even cuts both sides)', () => {
    const room = roomWith([inlay(rectPoly(2, 2, 3, 3), { layout: { pattern: 'grid', anchor: 'center' } })]);
    const r = analyzeCuts([room], mat('INLAY'));
    // joints at x = 2.5, 3.5, 4.5 → one full column each side of center, half tiles at the edges
    expect(r.fullTiles).toBe(4);
    expect(r.cutPieces).toBe(12);
    for (const a of r.assignments) expect(Math.min(a.w, a.h)).toBeCloseTo(0.5, 9);
  });
});
