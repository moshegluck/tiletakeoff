import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const { useStore, allRooms, allMarkups, wholeProject, otherPages } = await import('../src/state/store.js');
const { estimateProject } = await import('../src/engine/estimate.js');
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const S = () => useStore.getState();
const QUARTER = 1 / 36, EIGHTH = 1 / 18;

describe('a plan page keeps its own takeoff', () => {
  beforeEach(() => { S().newProject(); });

  it('rooms and markups drawn on one page are not on the next', () => {
    S().setScale(QUARTER);
    S().addRoom(sq(0, 0, 10, 12), 'KITCHEN');
    S().addMarkup({ type: 'length', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] });
    const fresh = S().switchPage(2);
    expect(fresh).toBe(true);                  // never worked on: no takeoff, no scale of its own
    expect(S().pdfPage).toBe(2);
    expect(S().rooms).toEqual([]);
    expect(S().markups).toEqual([]);
    expect(S().scale).toBe(QUARTER);           // carried until the sheet says otherwise
    S().switchPage(1);
    expect(S().rooms.map((r) => r.name)).toEqual(['KITCHEN']);
    expect(S().markups.length).toBe(1);
  });

  it('each page keeps its own scale and trace', () => {
    S().setScale(EIGHTH); S().setArchScale('1/8');
    S().setTrace({ result: { rooms: [], counts: {} } });
    S().switchPage(3);
    expect(S().trace).toBeNull();
    S().setScale(QUARTER); S().setArchScale('1/4');
    expect(S().switchPage(1)).toBe(false);
    expect(S().scale).toBe(EIGHTH);
    expect(S().archScale).toBe('1/8');
    expect(S().trace?.result).toBeTruthy();
    S().switchPage(3);
    expect(S().scale).toBe(QUARTER);
  });

  it('the estimate and exports see every page; the lists see this one', () => {
    S().setScale(QUARTER);
    S().addMaterial('floor');
    S().addRoom(sq(0, 0, 10, 10), 'BATH');           // 100 sf on page 1
    S().switchPage(3);
    S().addRoom(sq(0, 0, 20, 10), 'PLAY');           // 200 sf on page 3
    S().addMarkup({ type: 'count', points: [{ x: 1, y: 1 }] });
    expect(S().rooms.length).toBe(1);
    const rooms = allRooms(S());
    expect(rooms.map((r) => [r.page, r.name])).toEqual([[1, 'BATH'], [3, 'PLAY']]);
    expect(allMarkups(S()).map((m) => m.page)).toEqual([3]);
    expect(estimateProject(wholeProject(S())).floorSf).toBeCloseTo(300, 6);
    expect(otherPages(S())).toEqual([{ page: 1, rooms: 1, markups: 0 }]);
  });

  it('a trace committed on one page never replaces another page\'s rooms', () => {
    S().setScale(QUARTER);
    const res = (name) => ({ rooms: [{ id: 'r1', name, poly: sq(0, 0, 8, 8), center: { x: 4, y: 4 }, wallLf: 32 }], counts: {} });
    S().setTrace({ result: res('OFFICE') }); S().commitTrace();
    S().switchPage(2);
    S().setTrace({ result: res('GYM') }); S().commitTrace();
    expect(allRooms(S()).map((r) => [r.page, r.name])).toEqual([[1, 'OFFICE'], [2, 'GYM']]);
  });

  it('a space that is no floor (unexcavated) is not sent to the takeoff', () => {
    S().setScale(QUARTER);
    S().setTrace({ result: { rooms: [
      { id: 'a', name: 'GYM', type: 'room', poly: sq(0, 0, 10, 10), center: { x: 5, y: 5 }, wallLf: 40 },
      { id: 'b', name: 'UNEXCAVATED', type: 'nofloor', poly: sq(10, 0, 5, 10), center: { x: 12, y: 5 }, wallLf: 30 },
    ], counts: {} } });
    expect(S().commitTrace()).toBe(1);
    expect(S().rooms.map((r) => r.name)).toEqual(['GYM']);
  });

  it('undo does not reach across a page change', () => {
    S().setScale(QUARTER);
    S().addRoom(sq(0, 0, 10, 10));
    expect(S().undoCount).toBeGreaterThan(0);
    S().switchPage(2);
    expect(S().undoCount).toBe(0);
    expect(S().undo()).toBe(false);
  });

  it('a saved project comes back on the page it was left on, with every page', () => {
    S().setScale(QUARTER);
    S().addRoom(sq(0, 0, 10, 10), 'A');
    S().switchPage(4);
    S().addRoom(sq(0, 0, 5, 5), 'B');
    const saved = JSON.parse(JSON.stringify({ ...S(), pdfDoc: null }));
    S().newProject();
    expect(allRooms(S())).toEqual([]);
    S().loadSnapshot(saved);
    expect(S().pdfPage).toBe(4);
    expect(S().rooms.map((r) => r.name)).toEqual(['B']);
    expect(allRooms(S()).map((r) => [r.page, r.name])).toEqual([[1, 'A'], [4, 'B']]);
  });

  it('an older save without pages keeps its takeoff on the page its plan was on', () => {
    S().loadSnapshot({ id: 'old', rooms: [{ id: 'x', name: 'OLD', points: sq(0, 0, 4, 4), assigned: [] }], materials: [], markups: [], planFile: { page: 3 } });
    expect(S().pdfPage).toBe(3);
    expect(S().pageKnown).toBe(false);
    expect(allRooms(S()).map((r) => r.page)).toEqual([3]);
  });
});
