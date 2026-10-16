import { describe, it, expect } from 'vitest';
import { roomRegions } from '../src/engine/zones.js';
import { materialArea } from '../src/engine/estimate.js';
import { buildHouseModel } from '../src/three/houseModel.js';
import { rectPoly } from '../src/engine/geometry.js';

// A traced room (12 × 10) with a 1 × 1 column, plus floor design zones.
const traced = (zones) => ({
  id: 't1', name: 'KITCHEN', points: rectPoly(0, 0, 12, 10), holes: [rectPoly(5, 4, 1, 1)],
  assigned: ['FIELD'], layout: { pattern: 'grid' }, traceId: 'r1', zones,
});
const mat = (id) => ({ id, name: id, type: 'floor', tw: 12, th: 12, grout: 0, pattern: 'grid', waste: 10, price: 1, priceUnit: 'sf', faceCoverage: 1 });

describe('traced rooms and floor design zones', () => {
  it('deducts the traced holes from the field', () => {
    const reg = roomRegions(traced([]));
    expect(reg.fieldArea).toBeCloseTo(119, 6);
    expect(materialArea(mat('FIELD'), [traced([])]).netSf).toBeCloseTo(119, 6);
  });

  it('deducts holes, bands and inlays together, with nothing counted twice', () => {
    const zones = [
      { id: 'b', kind: 'border', name: 'Border 1', inset: 0, width: 1, materialId: 'BAND' },
      { id: 'i', kind: 'inlay', name: 'Inlay 1', points: rectPoly(2, 2, 2, 2), materialId: 'INLAY' },
    ];
    const room = traced(zones);
    const reg = roomRegions(room);
    // field = 10 × 8 inside the band − the 2 × 2 inlay − the 1 × 1 column
    expect(reg.fieldArea).toBeCloseTo(80 - 4 - 1, 6);
    expect(reg.bands[0].area).toBeCloseTo(120 - 80, 6);
    const field = materialArea(mat('FIELD'), [room]).netSf;
    const band = materialArea(mat('BAND'), [room]).netSf;
    const inlay = materialArea(mat('INLAY'), [room]).netSf;
    expect(field + band + inlay).toBeCloseTo(120 - 1, 6);
  });

  it('a column inside the border band comes out of the band', () => {
    const room = { ...traced([{ id: 'b', kind: 'border', name: 'Border 1', inset: 0, width: 2, materialId: 'BAND' }]), holes: [rectPoly(0.5, 4, 1, 1)] };
    const reg = roomRegions(room);
    expect(reg.bands[0].area).toBeCloseTo(120 - 48 - 1, 6);
    expect(reg.fieldArea).toBeCloseTo(48, 6);
  });

  it('the 3D house lays the zones over the floor in their own materials', () => {
    const room = traced([
      { id: 'b', kind: 'border', name: 'Border 1', inset: 0.5, width: 1, materialId: 'BAND' },
      { id: 'i', kind: 'inlay', name: 'Inlay 1', points: rectPoly(2, 2, 2, 2), materialId: null, color: '#1d6fb0' },
    ]);
    const m = buildHouseModel({ rooms: [room], materials: [mat('FIELD'), { ...mat('BAND'), color: '#222222' }], trace: null });
    const zs = m.rooms[0].zones;
    expect(zs).toHaveLength(2);
    expect(zs[0]).toMatchObject({ id: 'b', holes: [expect.any(Array)] });
    expect(zs[0].spec.color).toBe('#222222');
    expect(zs[1].spec.color).toBe('#1d6fb0');
    expect(zs[1].lift).toBeGreaterThan(zs[0].lift);
  });
});
