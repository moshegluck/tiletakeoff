import { describe, it, expect, vi } from 'vitest';
import { labelEdits, applyLabels, labelTiles, agreesBetter } from '../src/engine/trace/labels.js';
import { cleanLabels, labelsText } from '../src/lib/labelPrompt.js';

// Claude labels numbered candidates; the engine turns labels into edits and
// keeps each only when the sheet's own checks agree better. Claude never
// supplies a coordinate.

const cands = {
  rooms: [{ tag: 'R1', id: 'r1', name: 'Space 1', center: { x: 5, y: 5 }, area: 100, doubted: true }],
  walls: [{ tag: 'W1', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
  gaps: [{ tag: 'G1', a: { x: 0, y: 5 }, b: { x: 3, y: 5 }, t: 0.4, width: 3 }],
  openings: [{ tag: 'O1', type: 'door', a: { x: 10, y: 2 }, b: { x: 10, y: 5 }, width: 3 }],
};

// a fake reading: rooms named / matched as the edits ask
const room = (extra = {}) => ({ id: 'r', status: 'ok', labels: [], poly: [], ...extra });
const reading = ({ matched = 0, off = 0, rooms = 1, notClosed = 0 } = {}) => ({
  rooms: Array.from({ length: rooms }, () => room()),
  flags: Array.from({ length: notClosed }, (_, i) => ({ id: `f${i}`, kind: 'room_not_closed', severity: 'warn' })),
  verify: { matched, off },
});

describe('labelEdits', () => {
  it('turns labels into edits for the asked tags only, and none where the label agrees with the trace', () => {
    const plan = labelEdits(cands, {
      rooms: [{ tag: 'R1', name: 'BATH', type: 'bath' }, { tag: 'R9', name: 'X', type: 'room' }],
      walls: [{ tag: 'W1', is: 'not_wall', why: 'stair edge' }],
      gaps: [{ tag: 'G1', is: 'separate', why: 'threshold' }, { tag: 'G7', is: 'separate' }],
      openings: [{ tag: 'O1', is: 'door' }],
    });
    expect(plan.edits.map((e) => [e.kind, e.tag])).toEqual([['close', 'G1'], ['remove', 'W1']]);
    expect(plan.edits[0]).toMatchObject({ a: cands.gaps[0].a, b: cands.gaps[0].b, t: 0.4 });
    expect(plan.seeds).toEqual([{ x: 5, y: 5, name: 'BATH', type: 'bath' }]);
  });
  it('a doorway read as solid wall becomes a drawn wall', () => {
    const plan = labelEdits(cands, { openings: [{ tag: 'O1', is: 'solid' }] });
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({ kind: 'solid', a: cands.openings[0].a, b: cands.openings[0].b });
  });
});

describe('applyLabels', () => {
  const input = { lines: [], removed: [], manual: [] };
  it('keeps an edit only when the sheet agrees better, and leaves the rest as notes', () => {
    const plan = labelEdits(cands, { gaps: [{ tag: 'G1', is: 'separate' }], walls: [{ tag: 'W1', is: 'not_wall', why: 'counter' }] });
    // closing G1 lets a printed area match; erasing W1 opens a room
    const trace = vi.fn((inp) => (inp.removed.length ? reading({ matched: 1, notClosed: 1 }) : inp.closures.length ? reading({ matched: 1 }) : reading()));
    const out = applyLabels(input, reading(), plan, { trace });
    expect(out.kept.map((e) => e.tag)).toEqual(['G1']);
    expect(out.input.closures).toHaveLength(1);
    expect(out.input.removed).toHaveLength(0);
    expect(out.declined.map((e) => e.tag)).toEqual(['W1']);
    const note = out.res.flags.find((f) => f.kind === 'ai_label');
    expect(note.severity).toBe('info');
    expect(note.msg).toMatch(/W1.*not a wall.*counter/);
    expect(out.tried).toBe(2);
  });
  it('never lets a label lose a printed-area match', () => {
    const plan = labelEdits(cands, { gaps: [{ tag: 'G1', is: 'separate' }] });
    const trace = () => reading({ matched: 1, rooms: 3 });
    const out = applyLabels(input, reading({ matched: 2 }), plan, { trace });
    expect(out.kept).toHaveLength(0);
  });
  it('stops trying after maxTries', () => {
    const many = { edits: Array.from({ length: 5 }, (_, i) => ({ kind: 'close', tag: `G${i}`, a: { x: i, y: 0 }, b: { x: i, y: 2 }, t: 0.4 })), seeds: [] };
    const out = applyLabels(input, reading(), many, { trace: () => reading(), maxTries: 2 });
    expect(out.tried).toBe(2);
    expect(out.declined.filter((e) => e.reason === 'not tried')).toHaveLength(3);
  });
});

describe('agreesBetter', () => {
  it('needs rooms, no lost matches, no new open rooms, and a better reading', () => {
    expect(agreesBetter(reading({ rooms: 0 }), reading())).toBe(false);
    expect(agreesBetter(reading({ matched: 1 }), reading())).toBe(true);
    expect(agreesBetter(reading({ matched: 1, notClosed: 1 }), reading())).toBe(false);
    expect(agreesBetter(reading({ matched: 2, off: 1 }), reading({ matched: 1 }))).toBe(false);
  });
});

describe('labelTiles', () => {
  it('puts every mark in exactly one tile, whole inside its frame', () => {
    const far = { ...cands, walls: [...cands.walls, { tag: 'W2', a: { x: 200, y: 0 }, b: { x: 210, y: 0 } }] };
    const tiles = labelTiles(far, { tile: 70, pad: 5 });
    const tags = tiles.flatMap((t) => t.marks.map((m) => m.x.tag)).sort();
    expect(tags).toEqual(['G1', 'O1', 'W1', 'W2']);
    for (const t of tiles) for (const m of t.marks) {
      for (const p of [m.x.a, m.x.b]) expect(p.x >= t.frame.x0 && p.x <= t.frame.x1 && p.y >= t.frame.y0 && p.y <= t.frame.y1).toBe(true);
    }
  });
});

describe('labelPrompt', () => {
  const tags = { rooms: [{ tag: 'R1', name: '', x: 10, y: 10, area: 50 }], walls: [{ tag: 'W1', x: 1, y: 2 }], gaps: [{ tag: 'G1', x: 3, y: 4, width: 2.5 }], openings: [] };
  it('keeps only answers about asked numbers, in the engine shapes', () => {
    const out = cleanLabels({
      rooms: [{ tag: 'R1', name: '  MASTER   BATH ', type: 'spa' }, { tag: 'R2', name: 'X', type: 'bath' }],
      walls: [{ tag: 'W1', is: 'not_wall', why: 'a counter' }, { tag: 'W1', is: 'maybe' }],
      gaps: [{ tag: 'G2', is: 'open' }],
      openings: [{ tag: 'O1', is: 'door' }],
    }, tags);
    expect(out).toEqual({
      rooms: [{ tag: 'R1', name: 'MASTER BATH', type: 'room' }],
      walls: [{ tag: 'W1', is: 'not_wall', why: 'a counter' }],
      gaps: [], openings: [],
    });
    expect(cleanLabels(null, tags)).toEqual({ rooms: [], walls: [], gaps: [], openings: [] });
  });
  it('sends pixel positions on the image, never feet coordinates', () => {
    const t = labelsText(800, 600, tags);
    expect(t).toMatch(/800 × 600/);
    expect(t).toContain('["W1",1,2]');
    expect(t).toContain('["G1",3,4,2.5]');
  });
});
