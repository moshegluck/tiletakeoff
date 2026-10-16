import { describe, it, expect, beforeEach } from 'vitest';
import { buildHouseModel, specFromMaterial } from '../src/three/houseModel.js';
import { estimateProject } from '../src/engine/estimate.js';
import { roomArea, roomWallLf } from '../src/engine/geometry.js';
import { FLOOR_PRESETS, WALL_TILE_PRESETS } from '../src/data/finishes.js';

// minimal localStorage for the store module
globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const { useStore } = await import('../src/state/store.js');

const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('design picks flow into the takeoff', () => {
  beforeEach(() => {
    useStore.getState().newProject();
    useStore.setState({
      rooms: [{ id: 'b', name: 'BATH', points: sq(0, 0, 10, 8), holes: [sq(4, 3, 1, 1)], assigned: [], wallHeight: 8, traceId: 'r1', roomType: 'bath', wallLf: 30, layout: { pattern: 'grid' } }],
      materials: [],
    });
  });

  it('net floor area deducts holes; wall LF uses the traced value', () => {
    const r = useStore.getState().rooms[0];
    expect(roomArea(r)).toBeCloseTo(79, 6);
    expect(roomWallLf(r)).toBe(30);
  });

  it('picking a floor preset creates one priced material and assigns it', () => {
    const marble = FLOOR_PRESETS.find((p) => p.id === 'marble-2424');
    useStore.getState().applyFinish('b', { floorPreset: marble });
    useStore.getState().applyFinish('b', { floorPreset: marble }); // twice → still one material
    const s = useStore.getState();
    expect(s.materials.length).toBe(1);
    expect(s.materials[0]).toMatchObject({ type: 'floor', tw: 24, th: 24, presetId: 'marble-2424' });
    expect(s.rooms[0].assigned).toEqual([s.materials[0].id]);
    const e = estimateProject(s);
    expect(e.lines[0].netSf).toBeCloseTo(79, 6);
  });

  it('swapping the floor replaces, not adds, the floor material on that room', () => {
    useStore.getState().applyFinish('b', { floorPreset: FLOOR_PRESETS[0] });
    useStore.getState().applyFinish('b', { floorPreset: FLOOR_PRESETS[3] });
    const s = useStore.getState();
    const floorIds = s.rooms[0].assigned.filter((id) => s.materials.find((m) => m.id === id)?.type === 'floor');
    expect(floorIds.length).toBe(1);
    expect(s.materials.find((m) => m.id === floorIds[0]).presetId).toBe(FLOOR_PRESETS[3].id);
  });

  it('wall tile is priced at traced wall LF × chosen tile height', () => {
    useStore.getState().applyFinish('b', { wallTilePreset: WALL_TILE_PRESETS[0] });
    let e = estimateProject(useStore.getState());
    expect(e.lines.find((l) => l.material.type === 'wall').netSf).toBeCloseTo(30 * 4, 6); // default 4'
    useStore.getState().applyFinish('b', { wallTileHeight: 7 });
    e = estimateProject(useStore.getState());
    expect(e.lines.find((l) => l.material.type === 'wall').netSf).toBeCloseTo(30 * 7, 6);
    useStore.getState().applyFinish('b', { wallTileHeight: null }); // full height
    e = estimateProject(useStore.getState());
    expect(e.lines.find((l) => l.material.type === 'wall').netSf).toBeCloseTo(30 * 8, 6);
    useStore.getState().applyFinish('b', { wallTileHeight: 0 }); // none → unassigned
    e = estimateProject(useStore.getState());
    expect(e.lines.find((l) => l.material.type === 'wall')?.netSf ?? 0).toBe(0);
  });

  it('the 3D model renders exactly what is priced', () => {
    useStore.getState().applyFinish('b', { floorPreset: FLOOR_PRESETS[2], wallTilePreset: WALL_TILE_PRESETS[1], paint: 'sage' });
    const m = buildHouseModel(useStore.getState());
    const room = m.rooms[0];
    const s = useStore.getState();
    const floorMat = s.materials.find((x) => x.type === 'floor');
    expect(room.floor).toEqual(specFromMaterial(floorMat));
    expect(room.wallTile).toBeTruthy();
    expect(room.wallTileHeight).toBe(4);
    expect(room.holes.length).toBe(1);
  });

  it('no wall tile shows in 3D unless it is in the estimate', () => {
    const m = buildHouseModel(useStore.getState());
    expect(m.rooms[0].wallTile).toBeNull();
  });
});

describe('review regressions — takeoff side', () => {
  it('two traced rooms with the same name keep separate ids across re-commits', () => {
    const t = (id, cx) => ({ id, name: 'BEDROOM', type: 'bedroom', poly: sq(cx - 5, 0, 10, 10), holes: [], center: { x: cx, y: 5 }, wallLf: 40, spurLf: 0, openings: [], area: 100 });
    useStore.getState().newProject();
    useStore.getState().setTrace({ result: { rooms: [t('r1', 5), t('r2', 30)], walls: [], openings: [], flags: [] } });
    useStore.getState().commitTrace();
    const first = useStore.getState().rooms.map((r) => r.id);
    useStore.getState().setTrace({ result: { rooms: [t('r1', 5.2), t('r2', 30.1)], walls: [], openings: [], flags: [] } });
    useStore.getState().commitTrace();
    const second = useStore.getState().rooms.map((r) => r.id);
    expect(new Set(second).size).toBe(2);
    expect(second.sort()).toEqual(first.sort());
  });

  it('full-height wall tile: the whole perimeter × ceiling, less 14 SF a door (Artistic rule)', () => {
    useStore.getState().newProject();
    useStore.setState({ rooms: [{ id: 'b', name: 'BATH', points: sq(0, 0, 10, 8), assigned: [], wallHeight: 8, doorHeight: 6 + 8 / 12, wallLf: 33.5, openings: [{ width: 2.5 }], layout: { pattern: 'grid' } }], materials: [] });
    useStore.getState().applyFinish('b', { wallTilePreset: WALL_TILE_PRESETS[0], wallTileHeight: null });
    const e = estimateProject(useStore.getState());
    // the traced LF is net of the 2'-6" door: put it back, × 8', − 14 SF (2 LF × 7')
    expect(e.lines.find((l) => l.material.type === 'wall').netSf).toBe((33.5 + 2.5) * 8 - 14);
  });
});

describe('rooms follow their tile\'s pattern', () => {
  beforeEach(() => { useStore.getState().newProject(); });
  it('a new room has no pattern of its own', () => {
    const st = useStore.getState();
    st.addRoom(sq(0, 0, 10, 10));
    expect(useStore.getState().rooms[0].layout.pattern).toBeUndefined();
  });
  it('an old saved project is upgraded once on load', () => {
    // saved before the upgrade: no layoutsV2 key at all
    useStore.getState().loadSnapshot({ rooms: [{ id: 'r', name: 'R', points: sq(0, 0, 5, 5), assigned: [], layout: { pattern: 'grid', angleDeg: 0, origin: { x: 0, y: 0 } } }] });
    const st = useStore.getState();
    expect(st.rooms[0].layout.pattern).toBeUndefined();
    expect(st.layoutsV2).toBe(true);
  });
});
describe('rooms follow their tile\'s pattern (already upgraded)', () => {
  it('a project saved after the upgrade keeps an explicit straight grid', () => {
    useStore.getState().loadSnapshot({ layoutsV2: true, rooms: [{ id: 'r', name: 'R', points: sq(0, 0, 5, 5), assigned: [], layout: { pattern: 'grid', angleDeg: 0, origin: { x: 0, y: 0 } } }] });
    expect(useStore.getState().rooms[0].layout.pattern).toBe('grid');
  });
});
