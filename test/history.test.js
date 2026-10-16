import { describe, it, expect, beforeEach } from 'vitest';
import { createHistory } from '../src/state/history.js';

globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const { useStore } = await import('../src/state/store.js');
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

describe('history: steps', () => {
  let t = 0;
  const h = () => createHistory({ coalesceMs: 600, now: () => t });
  const st = (rooms, id = 'p') => ({ id, rooms, materials: [], markups: [] });

  it('records the state before each change, and undo / redo walk it', () => {
    const hist = h(); t = 0;
    const a = st([]), b = st([1]), c = st([1, 2]);
    expect(hist.note(a, b)).toBe(true); t = 1000;
    expect(hist.note(b, c)).toBe(true);
    expect(hist.undo(c).rooms).toEqual([1]);
    expect(hist.undo(b).rooms).toEqual([]);
    expect(hist.undo(a)).toBeNull();
    expect(hist.redo(a).rooms).toEqual([1]);
  });
  it('quick successive edits are one step; a gesture is one step', () => {
    const hist = h(); t = 0;
    const s0 = st([]), s1 = st(['a']), s2 = st(['ab']), s3 = st(['abc']);
    hist.note(s0, s1); t = 200; hist.note(s1, s2); t = 400; hist.note(s2, s3);
    expect(hist.counts().undoCount).toBe(1);
    expect(hist.undo(s3).rooms).toEqual([]);
  });
  it('a gesture is one step even when slow', () => {
    const hist = h(); t = 0;
    const s = [st([0]), st([1]), st([2]), st([3])];
    hist.begin();
    for (let i = 1; i < 4; i++) { t += 5000; hist.note(s[i - 1], s[i]); }
    hist.end();
    expect(hist.counts().undoCount).toBe(1);
    expect(hist.undo(s[3]).rooms).toEqual([0]);
  });
  it('a new edit drops redo; changes outside the project data are ignored', () => {
    const hist = h(); t = 0;
    const a = st([]), b = st([1]);
    hist.note(a, b); t = 1000;
    hist.undo(b);
    expect(hist.counts().redoCount).toBe(1);
    t = 2000; hist.note(a, st([9]));
    expect(hist.counts().redoCount).toBe(0);
    expect(hist.note({ ...a, view: 1 }, { ...a, view: 2 })).toBe(false);
  });
  it('opening another project clears it', () => {
    const hist = h(); t = 0;
    hist.note(st([]), st([1])); t = 1000;
    hist.note(st([1]), st([], 'other'));
    expect(hist.counts()).toEqual({ undoCount: 0, redoCount: 0 });
  });
  it('skips steps that no longer change anything', () => {
    const hist = h(); t = 0;
    const a = st([]), b = st([1]);
    hist.note(a, b);
    // the change was rolled back outside the history (e.g. a pinch cancelling a tap)
    expect(hist.undo(a)).toBeNull();
  });
});

describe('history: in the store', () => {
  beforeEach(() => { useStore.getState().newProject(); useStore.getState().historyEnd(); });
  const step = (fn) => { fn(useStore.getState()); useStore.getState().historyEnd(); };

  it('undo removes a drawn room, redo brings it back, counts follow', () => {
    step((s) => s.addRoom(sq(0, 0, 10, 10), 'Kitchen'));
    step((s) => s.addRoom(sq(20, 0, 10, 10), 'Bath'));
    expect(useStore.getState().undoCount).toBe(2);
    useStore.getState().undo();
    expect(useStore.getState().rooms.map((r) => r.name)).toEqual(['Kitchen']);
    expect(useStore.getState().redoCount).toBe(1);
    useStore.getState().redo();
    expect(useStore.getState().rooms.map((r) => r.name)).toEqual(['Kitchen', 'Bath']);
  });
  it('undo brings back a deleted room and clears a stale selection', () => {
    step((s) => s.addRoom(sq(0, 0, 10, 10), 'Kitchen'));
    const id = useStore.getState().rooms[0].id;
    step((s) => s.deleteRoom(id));
    expect(useStore.getState().rooms).toHaveLength(0);
    useStore.getState().undo();
    expect(useStore.getState().rooms[0].id).toBe(id);
    useStore.getState().select('room', id);
    useStore.getState().undo();                     // back before the room existed
    expect(useStore.getState().selection.id).toBeNull();
  });
  it('a drag (many moves) is one step', () => {
    step((s) => s.addRoom(sq(0, 0, 10, 10), 'Kitchen'));
    const id = useStore.getState().rooms[0].id;
    useStore.getState().historyBegin();
    for (let i = 1; i <= 5; i++) useStore.getState().updateRoom(id, { points: sq(i, 0, 10, 10) });
    useStore.getState().historyEnd();
    useStore.getState().undo();
    expect(useStore.getState().rooms[0].points[0].x).toBe(0);
  });
  it('panning is not an undo step; a new project starts clean', () => {
    step((s) => s.addRoom(sq(0, 0, 10, 10), 'Kitchen'));
    const n = useStore.getState().undoCount;
    useStore.getState().setView({ x: 5, y: 5, zoom: 2 });
    expect(useStore.getState().undoCount).toBe(n);
    useStore.getState().newProject();
    expect(useStore.getState().undoCount).toBe(0);
  });
});
