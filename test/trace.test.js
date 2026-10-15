import { describe, it, expect } from 'vitest';
import { runTrace, parseScaleNote, parseDoorSchedule } from '../src/engine/trace/index.js';
import { arcFromBezier, isDoorSwing } from '../src/engine/trace/arcs.js';
import { mergeCollinear, pairWalls } from '../src/engine/trace/walls.js';
import { buildHousePlan } from './fixtures/planFactory.js';

const IN = 1 / 12;
const EXT = 8 * IN, INT = 4.5 * IN;
const room = (res, name) => res.rooms.find((r) => r.name === name);
const errors = (res) => res.flags.filter((f) => f.severity === 'error');

function trace(opts = {}, mutate) {
  const plan = buildHousePlan(opts);
  if (mutate) mutate(plan);
  const arcs = plan.arcs.map((a) => arcFromBezier(a.pieces)).filter(Boolean);
  return { plan, res: runTrace({ lines: plan.lines, arcs, texts: plan.texts }) };
}

describe('trace — clean CAD-style plan', () => {
  const { res } = trace({ messy: false });

  it('reconstructs every room by name', () => {
    expect(res.rooms.map((r) => r.name).sort()).toEqual(['BATH', 'BEDROOM', 'HALL', 'KITCHEN', 'LIVING', 'MASTER BEDROOM', 'W.I.C.']);
  });
  it('is coherent: no open ends, no unclosed rooms', () => {
    expect(errors(res)).toEqual([]);
  });
  it('classifies room types from labels', () => {
    expect(room(res, 'BATH').type).toBe('bath');
    expect(room(res, 'W.I.C.').type).toBe('closet');
    expect(room(res, 'MASTER BEDROOM').type).toBe('bedroom');
  });
});

describe('trace — messy plan (doubled traces, hatch, gaps, overshoot, furniture)', () => {
  const { res } = trace({ messy: true });

  it('still finds exactly the same seven rooms with no errors', () => {
    expect(res.rooms.length).toBe(7);
    expect(errors(res)).toEqual([]);
  });

  it('kitchen floor = finished faces, to the centre of each opening', () => {
    // 11.479 × 15.479 inside faces + half-wall strip under the 8' cased opening and the 5' opening
    const inside = (12 - EXT / 2 - INT / 2) * (16 - EXT / 2 - INT / 2);
    const expected = inside + 8 * (INT / 2) + 5 * (INT / 2);
    // doubled traces are drawn 0.2" off on purpose; merging them may move a face ≤ 1/8"
    expect(room(res, 'KITCHEN').area).toBeCloseTo(expected, 1);
  });

  it('bedroom wall LF = finished perimeter net of the door', () => {
    const w = 40 - EXT / 2 - (24 + INT / 2), h = 16 - EXT / 2 - INT / 2;
    expect(Math.abs(room(res, 'BEDROOM').wallLf - (2 * (w + h) - (2 + 8 / 12)))).toBeLessThan(0.25 * IN);
  });

  it('counts the bath pony wall in AND out (no double-walk, no miss)', () => {
    const bath = room(res, 'BATH');
    // 5' partition dead-ending inside: two faces from its end to the exterior face
    const faceRun = 28 - EXT / 2 - 23 + INT / 2; // 4.854'
    expect(bath.spurLf).toBeCloseTo(2 * faceRun, 2);
    const side = 12 - EXT / 2 - INT / 2;
    expect(bath.wallLf).toBeCloseTo(4 * side - 2.5 - 5 + 2 * faceRun, 2);
    expect(res.flags.some((f) => f.kind === 'spur' && f.roomId === bath.id)).toBe(true);
  });

  it('reads door widths from the swings', () => {
    const hall = room(res, 'HALL');
    const ws = hall.openings.map((o) => Math.round(o.width * 12)).sort((a, b) => a - b);
    expect(ws).toEqual([30, 30, 32]);
    expect(hall.openings.every((o) => o.type === 'door')).toBe(true);
  });

  it('flags a door that makes no sense for its room', () => {
    const f = res.flags.find((x) => x.kind === 'door_width');
    expect(f).toBeTruthy();
    expect(f.msg).toMatch(/bathroom/);
  });

  it('accepts a wide opening where it makes sense (8\' cased kitchen↔living, 4\' closet)', () => {
    const wic = room(res, 'W.I.C.');
    expect(wic.openings[0].width).toBeCloseTo(4, 3);
    expect(res.flags.filter((x) => x.kind === 'door_width').length).toBe(1);
  });

  it('confirms the scale from the door swings', () => {
    expect(res.calibration.verdict).toBe('confirmed');
  });

  it('ignores the evenly spaced floor-tile hatch', () => {
    expect(res.stats.hatchLines).toBeGreaterThanOrEqual(20);
  });
});

describe('trace — failure modes become located flags, not silent garbage', () => {
  it('a missing wall between two rooms is reported, not papered over', () => {
    // delete the hall/master wall's faces entirely (and its door swing) → HALL and MASTER merge
    const { res } = trace({ messy: false }, (plan) => {
      plan.lines = plan.lines.filter((l) => !(Math.abs(l.a.x - l.b.x) < 1e-9 && Math.abs(Math.abs(l.a.x - 16) - INT / 2) < 1e-6 && l.a.y > 15.9));
      plan.arcs = plan.arcs.filter((a) => !(Math.abs(a.c.x - (16 + INT / 2)) < 1e-6));
    });
    expect(res.flags.some((f) => f.kind === 'merged_rooms' && /HALL|MASTER/.test(f.msg))).toBe(true);
    expect(res.rooms.length).toBe(6);
  });

  it('a wrong scale is caught by the door swings', () => {
    const { plan } = trace({ messy: false });
    const k = 2;
    const sc = (p) => ({ x: p.x * k, y: p.y * k });
    const arcs = plan.arcs.map((a) => arcFromBezier(a.pieces.map((pc) => ({ p0: sc(pc.p0), p1: sc(pc.p1), p2: sc(pc.p2), p3: sc(pc.p3) })))).filter(Boolean);
    const res = runTrace({ lines: plan.lines.map((l) => ({ a: sc(l.a), b: sc(l.b) })), arcs, texts: plan.texts.map((t) => ({ ...t, ...sc(t) })), options: { maxT: 32 * IN, minT: 5 * IN, minTAtypical: 7 * IN } });
    expect(res.calibration.verdict).toBe('off');
    expect(res.flags.some((f) => f.kind === 'scale')).toBe(true);
  });

  it('a wall with a dangling end in open space is an open-end error', () => {
    const res = runTrace({
      bodies: [
        { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, t: INT }, { a: { x: 10, y: 0 }, b: { x: 10, y: 10 }, t: INT },
        { a: { x: 10, y: 10 }, b: { x: 0, y: 10 }, t: INT }, { a: { x: 0, y: 10 }, b: { x: 0, y: 0 }, t: INT },
        { a: { x: 10, y: 5 }, b: { x: 30, y: 5 }, t: INT }, // sticks out into nothing
      ],
    });
    expect(res.rooms.length).toBe(1);
    expect(res.flags.some((f) => f.kind === 'open_end' && f.at.x > 29)).toBe(true);
  });
});

describe('trace — building blocks', () => {
  it('merges a doubled trace into one line', () => {
    const m = mergeCollinear([
      { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { a: { x: 4, y: 0.01 }, b: { x: 14, y: 0.01 } },
    ]);
    expect(m.length).toBe(1);
    expect(m[0].b.x - m[0].a.x).toBeCloseTo(14, 1);
  });

  it('pairs two faces into a wall body with the right thickness', () => {
    const { bodies } = pairWalls([{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }, { a: { x: 0, y: INT }, b: { x: 10, y: INT } }]);
    expect(bodies.length).toBe(1);
    expect(bodies[0].t * 12).toBeCloseTo(4.5, 3);
    expect(bodies[0].a.y).toBeCloseTo(INT / 2, 6);
  });

  it('recognises a quarter-circle door swing and its radius', () => {
    const K = 0.5522847498, r = 2.5;
    const arc = arcFromBezier([{ p0: { x: r, y: 0 }, p1: { x: r, y: r * K }, p2: { x: r * K, y: r }, p3: { x: 0, y: r } }]);
    expect(arc.r).toBeCloseTo(2.5, 4);
    expect(arc.c.x).toBeCloseTo(0, 4);
    expect(arc.sweepDeg).toBeCloseTo(90, 1);
    expect(isDoorSwing(arc)).toBe(true);
  });

  it('rejects curves that are not circular', () => {
    expect(arcFromBezier([{ p0: { x: 0, y: 0 }, p1: { x: 1, y: 3 }, p2: { x: 2, y: -3 }, p3: { x: 3, y: 0 } }])).toBeNull();
  });

  it('reads the drawing scale note', () => {
    expect(parseScaleNote([{ str: "FIRST FLOOR PLAN  SCALE: 1/4\" = 1'-0\"" }])).toBe('1/4');
    expect(parseScaleNote([{ str: '3/16" = 1\'-0"' }])).toBe('3/16');
    expect(parseScaleNote([{ str: 'no scale here' }])).toBeNull();
  });

  it('reads door sizes from schedule / tag text', () => {
    const s = parseDoorSchedule([{ str: "2'-8\" x 6'-8\"" }, { str: "3'-0\" X 6'-8\"" }, { str: "2'-6\"x6'-8\"" }]);
    expect(s.widths.map((w) => Math.round(w * 12))).toEqual([30, 32, 36]);
    expect(s.doorHeight).toBeCloseTo(6 + 8 / 12, 4);
  });
});
