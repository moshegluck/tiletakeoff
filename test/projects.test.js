import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
const { useStore, projectIndex } = await import('../src/state/store.js');
const { projectForPlan } = await import('../src/lib/planLoad.js');
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const S = () => useStore.getState();
const QUARTER = 1 / 36, EIGHTH = 1 / 18;

// Moshe goes from one plan to the next: each plan is its own project, and
// nothing of the last one — rooms, markups, trace, scale, pages, job, undo —
// carries into the next or is overwritten by it.
describe('projects: each plan its own', () => {
  beforeEach(async () => {
    for (const p of projectIndex()) await S().removeProject(p.id);
    S().newProject();
  });

  it('a new plan file starts a new project; the last one stays as it was', async () => {
    expect(await projectForPlan({ name: '22 Rita.pdf' })).toBe(false);   // nothing here yet: this project takes it
    expect(S().name).toBe('22 Rita');
    S().setScale(QUARTER);
    S().addRoom(sq(0, 0, 10, 12), 'KITCHEN');
    S().setJob({ customer: 'Rita' });
    S().switchPage(2);
    S().addRoom(sq(0, 0, 5, 8), 'BATH 2');
    const rita = S().id;

    expect(await projectForPlan({ name: '4 Howard.pdf' })).toBe(true);
    expect(S().id).not.toBe(rita);
    expect(S().name).toBe('4 Howard');
    expect(S().planName).toBe('4 Howard.pdf');
    expect(S().rooms).toEqual([]);
    expect(S().pageData).toEqual({});
    expect(S().scale).toBeNull();
    expect(S().job.customer).toBe('');
    expect(S().undoCount).toBe(0);                       // undo can't bring Rita's rooms in
    expect(projectIndex().map((p) => p.name).sort()).toEqual(['22 Rita']);   // Howard has nothing yet

    S().setScale(EIGHTH);
    S().addRoom(sq(0, 0, 20, 20), 'GARAGE');
    // back to Rita: hers, untouched
    expect(await S().openProject(rita)).toBe(true);
    expect(S().name).toBe('22 Rita');
    expect(S().rooms.map((r) => r.name)).toEqual(['BATH 2']);
    expect(S().pdfPage).toBe(2);
    expect(S().pageData[1].rooms.map((r) => r.name)).toEqual(['KITCHEN']);
    expect(S().scale).toBe(QUARTER);
    expect(S().job.customer).toBe('Rita');
    expect(projectIndex().map((p) => p.name).sort()).toEqual(['22 Rita', '4 Howard']);
  });

  it('the same plan file again stays in its project', async () => {
    await projectForPlan({ name: 'A-3 basement.pdf' });
    S().addRoom(sq(0, 0, 10, 10), 'GYM');
    const id = S().id;
    expect(await projectForPlan({ name: 'A-3 basement.pdf' })).toBe(false);
    expect(S().id).toBe(id);
    expect(S().rooms.map((r) => r.name)).toEqual(['GYM']);
  });

  it('New keeps the project on screen; deleting a project forgets it', async () => {
    await projectForPlan({ name: 'Mill 2.pdf' });
    S().addRoom(sq(0, 0, 10, 10), 'LOBBY');
    const mill = S().id;
    S().newProject();
    expect(S().rooms).toEqual([]);
    expect(projectIndex().map((p) => p.id)).toContain(mill);
    expect(projectIndex().find((p) => p.id === mill)).toMatchObject({ name: 'Mill 2', planName: 'Mill 2.pdf', rooms: 1 });
    await S().removeProject(mill);
    expect(projectIndex().map((p) => p.id)).not.toContain(mill);
    expect(await S().openProject(mill)).toBe(false);
  });
});
