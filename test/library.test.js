import { describe, it, expect, beforeEach } from 'vitest';
import { catalogItems, materialItem, materialFields } from '../src/lib/library.js';
import { estimateMaterial } from '../src/engine/estimate.js';
import { roomPattern } from '../src/engine/patterns.js';

globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const { useStore } = await import('../src/state/store.js');
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const item = (key) => catalogItems().find((i) => i.key === key);

describe('library: catalog', () => {
  it('has named finishes (floor and wall) and the standard sizes', () => {
    const all = catalogItems();
    expect(all.some((i) => i.key === 'cat:herring-oak' && i.pattern === 'herringbone' && i.kind === 'floor')).toBe(true);
    expect(all.some((i) => i.kind === 'wall' && i.pattern === 'brick_50')).toBe(true);
    expect(all.some((i) => i.source === 'size' && i.tw === 12 && i.th === 24)).toBe(true);
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
  });
  it('round-trips a project material', () => {
    const m = { id: 'm1', name: 'Porc', type: 'floor', tw: 12, th: 24, grout: 0.125, pattern: 'brick_33', waste: 12, price: 4, priceUnit: 'sf', sfPerBox: 15, color: '#aaa' };
    expect(materialFields(materialItem(m))).toMatchObject({ name: 'Porc', type: 'floor', tw: 12, th: 24, pattern: 'brick_33', waste: 12, price: 4 });
  });
});

describe('library: applying a tile to rooms and zones', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    const st = useStore.getState();
    st.addRoom(sq(0, 0, 10, 10), 'Kitchen');
    st.addRoom(sq(20, 0, 10, 8), 'Bath');
    st.addRoom(sq(40, 0, 6, 6), 'Hall');
  });
  const ids = () => useStore.getState().rooms.map((r) => r.id);

  it('creates one material, lays it in the target rooms in its own pattern, and prices it', () => {
    const [k, b] = ids();
    const res = useStore.getState().applyTile(item('cat:herring-oak'), { rooms: [k, b] });
    const st = useStore.getState();
    expect(res).toMatchObject({ rooms: 2, zones: 0 });
    const mat = st.materials.find((m) => m.id === res.materialId);
    expect(mat).toMatchObject({ name: 'Herringbone oak 4×24', pattern: 'herringbone', tw: 4, th: 24, price: 11 });
    const [rk, rb, rh] = st.rooms;
    expect(rk.assigned).toEqual([mat.id]);
    expect(rh.assigned).toEqual([]);
    expect(roomPattern(rk, mat)).toBe('herringbone');
    expect(rk.layout.pattern).toBeUndefined();               // inherits the tile's pattern
    expect(estimateMaterial(mat, st.rooms).netSf).toBeCloseTo(180, 9);
    // applying the same tile again reuses the material
    useStore.getState().applyTile(item('cat:herring-oak'), { rooms: [rb.id] });
    expect(useStore.getState().materials.filter((m) => m.libKey === 'cat:herring-oak')).toHaveLength(1);
  });

  it('replaces the room\'s tile of the same kind, keeps the other kind', () => {
    const [k] = ids();
    useStore.getState().applyTile(item('cat:marble-2424'), { rooms: [k] });
    useStore.getState().applyTile(item('cat:subway-white'), { rooms: [k] });   // wall tile
    useStore.getState().applyTile(item('cat:slate-1818'), { rooms: [k] });     // new floor replaces marble
    const st = useStore.getState();
    const names = st.rooms[0].assigned.map((id) => st.materials.find((m) => m.id === id).name).sort();
    expect(names).toEqual(['Charcoal slate 18×18', 'White subway 3×6']);
  });

  it('re-applying a tile in another pattern only changes the target rooms', () => {
    const [k, b] = ids();
    const first = useStore.getState().applyTile(item('cat:porc-gray-1224'), { rooms: [k, b] });   // brick_33
    useStore.getState().applyTile({ ...item('cat:porc-gray-1224'), pattern: 'grid', angleDeg: 45 }, { rooms: [b] });
    const st = useStore.getState();
    const mat = st.materials.find((m) => m.id === first.materialId);
    expect(mat.pattern).toBe('brick_33');                      // kitchen still brick
    expect(roomPattern(st.rooms[0], mat)).toBe('brick_33');
    expect(roomPattern(st.rooms[1], mat)).toBe('grid');         // bath: straight at 45°
    expect(st.rooms[1].layout.angleDeg).toBe(45);
    // when no other room uses it, the tile's own pattern changes instead
    useStore.getState().applyTile({ ...item('cat:porc-gray-1224'), pattern: 'grid' }, { rooms: [k, b] });
    const st2 = useStore.getState();
    expect(st2.materials.find((m) => m.id === first.materialId).pattern).toBe('grid');
    expect(st2.rooms[0].layout.pattern).toBeUndefined();
  });

  it('lays a floor tile in a design zone with its pattern', () => {
    const [k] = ids();
    const zid = useStore.getState().addZone(k, { kind: 'inlay', points: sq(2, 2, 3, 3) });
    const res = useStore.getState().applyTile(item('cat:herring-oak'), { zones: [{ roomId: k, zoneId: zid }] });
    const z = useStore.getState().rooms[0].zones[0];
    expect(res.zones).toBe(1);
    expect(z.materialId).toBe(res.materialId);
    expect(z.layout.pattern).toBe('herringbone');
  });
});
