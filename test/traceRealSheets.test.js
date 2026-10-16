import { describe, it, expect } from 'vitest';
import { runTrace, parseScaleNote } from '../src/engine/trace/index.js';
import { pairWalls } from '../src/engine/trace/walls.js';
import { arcFromBezier } from '../src/engine/trace/arcs.js';
import { wallsToLines, quarterArc } from './fixtures/planFactory.js';

// Regressions from a real CAD sheet (a NY basement renovation set): layered
// foundation walls, a deck edge beside them, stair treads, hatched new walls,
// bifold closets, doors between wall stubs. Every case below failed before.

const IN = 1 / 12;
const EXT = 8 * IN, INT = 4 * IN;
const errors = (res) => res.flags.filter((f) => f.severity === 'error');
const box = (W, H, t = EXT) => [
  { x1: 0, y1: 0, x2: W, y2: 0, t }, { x1: 0, y1: H, x2: W, y2: H, t },
  { x1: 0, y1: 0, x2: 0, y2: H, t }, { x1: W, y1: 0, x2: W, y2: H, t },
];
const hline = (y, x0, x1) => ({ a: { x: x0, y }, b: { x: x1, y } });
const vline = (x, y0, y1) => ({ a: { x, y: y0 }, b: { x, y: y1 } });

describe('trace — real CAD sheets', () => {
  it('a layered exterior wall with a deck edge beside it is a wall, not floor hatch', () => {
    // north wall: old 6½" wall + a new 6½" layer built against it (three faces
    // 6½" apart), and the deck's edge drawn 7" outside it — four near-evenly
    // spaced parallels, which the old rule threw away as a tile pattern
    const W = 14, H = 10, L = 13 * IN;
    const lines = wallsToLines([
      { x1: 0, y1: 0, x2: W, y2: 0, t: L }, { x1: 0, y1: H, x2: W, y2: H, t: EXT },
      { x1: 0, y1: 0, x2: 0, y2: H, t: EXT }, { x1: W, y1: 0, x2: W, y2: H, t: EXT },
    ], [], W, H);
    lines.push(hline(0, -L / 2, W + L / 2));              // the seam between the two layers
    lines.push(hline(-L / 2 - 7 * IN, -L / 2, W + L / 2)); // deck edge
    const res = runTrace({ lines });
    expect(res.stats.hatchLines).toBe(0);
    expect(res.rooms.length).toBe(1);
    expect(errors(res)).toEqual([]);
    // the seam is shared by both layers, so the room may run to it (known gap: < 6½" along that wall)
    const area = res.rooms[0].area, full = (W - EXT) * (H - EXT / 2 - L / 2);
    expect(area).toBeGreaterThanOrEqual(full - 0.1);
    expect(area).toBeLessThanOrEqual(full + (W - EXT) * L / 2 + 0.1);
  });

  it('stair treads are rejected as a pattern; the room around them stays', () => {
    const W = 14, H = 12;
    const lines = wallsToLines(box(W, H), [], W, H);
    for (let k = 0; k < 8; k++) lines.push(hline(2 + k * 10 * IN, 4, 7.5));   // 8 treads, 10" apart
    const res = runTrace({ lines });
    expect(res.stats.hatchLines).toBeGreaterThanOrEqual(8);
    expect(res.rooms.length).toBe(1);
    expect(errors(res)).toEqual([]);
  });

  it('a long wall face beside a row of short strokes at the same spacing stays a wall', () => {
    // east wall 6" thick; outside it, short window-frame strokes every 6"
    const W = 14, H = 12, T = 6 * IN;
    const lines = wallsToLines([...box(W, H).slice(0, 3), { x1: W, y1: 0, x2: W, y2: H, t: T }], [], W, H);
    for (let k = 1; k <= 4; k++) lines.push(vline(W + T / 2 + k * T, 4, 5.2));
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    expect(errors(res)).toEqual([]);
  });

  it('a partition stopping 6½" short of a wall (a missing scrap of inner layer) still closes', () => {
    const W = 20, H = 12;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: 10, y1: EXT / 2 + 6.5 * IN + INT / 2, x2: 10, y2: H, t: INT, capA: 0 },
    ], [], W, H);
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(2);
    expect(errors(res)).toEqual([]);
  });

  it('bifold closets close across their fronts when the door layer draws them', () => {
    // three closets along the west wall, split by two 3' partitions; no swing
    // arcs — only the bifold leaves on the sheet's door layer
    const W = 20, H = 15;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: 0, y1: 5, x2: 3, y2: 5, t: INT }, { x1: 0, y1: 10, x2: 3, y2: 10, t: INT },
    ], [], W, H);
    const zigzag = (y0, y1) => {
      const out = [];
      for (let y = y0, k = 0; y < y1 - 0.01; y += 1.25, k++) out.push({ a: { x: 3 + (k % 2) * 0.4, y }, b: { x: 3 + ((k + 1) % 2) * 0.4, y: Math.min(y1, y + 1.25) } });
      return out;
    };
    const hints = [...zigzag(EXT / 2, 5 - INT / 2), ...zigzag(5 + INT / 2, 10 - INT / 2), ...zigzag(10 + INT / 2, H - EXT / 2)];
    const without = runTrace({ lines });
    expect(without.rooms.length).toBe(1);                  // the fronts stay open
    const res = runTrace({ lines, hints });
    expect(res.rooms.length).toBe(4);
    const closets = res.rooms.filter((r) => r.area < 20).map((r) => r.area).sort((a, b) => a - b);
    expect(closets.length).toBe(3);
    for (const a of closets) expect(a).toBeGreaterThan(11);
    expect(errors(res)).toEqual([]);
  });

  it('a door between two wall stubs closes on its swing, even drawn a size small', () => {
    // a closet between two 3' stubs off the west wall; its 3'-2" doorway runs
    // across the stub ends, and the swing is drawn with a 2'-6" leaf
    const W = 16, H = 12, gap = 3 + 2 * IN;
    const y0 = 5, y1 = y0 + gap + INT;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: 0, y1: y0, x2: 3, y2: y0, t: INT }, { x1: 0, y1: y1, x2: 3, y2: y1, t: INT },
    ], [], W, H);
    const hinge = { x: 3 + INT / 2, y: y0 + INT / 2 };
    const arc = arcFromBezier(quarterArc(hinge, { x: 2.5, y: 0 }, { x: 0, y: 2.5 }).pieces);
    const res = runTrace({ lines, arcs: [arc] });
    expect(res.rooms.length).toBe(2);
    expect(res.openings.some((o) => o.openingType === 'door')).toBe(true);
  });

  it('a door from a wall end to the corner of the next room closes on its swing', () => {
    // the guest bedroom: its west wall stops flush with the vanity box's
    // bottom face; the 3'-0" door runs from that wall end to the box's corner
    // (the box's side wall meets its bottom wall there), swing drawn 2'-6"
    const W = 16, H = 14, yb = 6, xm = 5, xb = xm + INT / 2 + 3 + INT / 2;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: xb, y1: yb, x2: W, y2: yb, t: INT },                              // box bottom wall
      { x1: xb, y1: 0, x2: xb, y2: yb, t: INT },                              // box side wall
      { x1: xm, y1: yb + INT / 2, x2: xm, y2: H, t: INT, capA: 0 },           // bedroom west wall
    ], [], W, H);
    const hinge = { x: xm + INT / 2, y: yb + INT / 2 };
    const arc = arcFromBezier(quarterArc(hinge, { x: 2.5, y: 0 }, { x: 0, y: 2.5 }).pieces);
    const res = runTrace({ lines, arcs: [arc] });
    const door = res.openings.find((o) => o.openingType === 'door');
    expect(door).toBeTruthy();
    expect(door.rooms.every(Boolean)).toBe(true);
    // the bedroom is only the bedroom: not the hall strip in front of it
    const bed = res.rooms.find((r) => r.center.x > xm && r.center.y > yb);
    expect(bed.area).toBeLessThan((W - EXT / 2 - xm) * (H - EXT / 2 - yb) + 0.5);
    expect(errors(res)).toEqual([]);
  });

  it('a 45° hatch tick at an inside corner is not a wall, and sends no opening across the room', () => {
    const W = 9, H = 8;
    const lines = wallsToLines(box(W, H), [], W, H);
    // two parallel 45° strokes 4" apart, starting in the NW wall corner and
    // poking 5" into the room (the wall hatch drawn past the corner)
    const d = { x: Math.SQRT1_2, y: Math.SQRT1_2 }, n = { x: -Math.SQRT1_2 * INT, y: Math.SQRT1_2 * INT };
    const p0 = { x: 0.15, y: 0.15 };
    for (const o of [{ x: 0, y: 0 }, n]) lines.push({ a: { x: p0.x + o.x, y: p0.y + o.y }, b: { x: p0.x + o.x + d.x * 0.6, y: p0.y + o.y + d.y * 0.6 } });
    const { bodies } = pairWalls(lines);
    expect(bodies.some((b) => Math.abs(Math.abs(b.b.x - b.a.x) - Math.abs(b.b.y - b.a.y)) < 0.05 && Math.abs(b.b.x - b.a.x) > 0.05)).toBe(false);
    const res = runTrace({ lines });
    expect(res.rooms.length).toBe(1);
    expect(res.openings.length).toBe(0);
  });

  it('a closet whose side walls meet its front closes when the door layer draws its bifold', () => {
    // a 2'-2" bifold closet off a wall: both jambs are corners (the closet's
    // side walls turn into the front wall), so no wall end is left free
    const W = 12, H = 10, y = 4, xl = 5, clear = 26 * IN, xr = xl + INT + clear;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: 0, y1: y, x2: W, y2: y, t: INT },
      { x1: xl, y1: 2, x2: xl, y2: y, t: INT }, { x1: xr, y1: 2, x2: xr, y2: y, t: INT },
      { x1: xl, y1: 2, x2: xr, y2: 2, t: INT },
    ], [{ axis: 'h', c: y, s: xl + INT / 2, w: clear, t: INT }], W, H);
    const x0 = xl + INT / 2, hints = [];
    for (let k = 0; k < 4; k++) hints.push({ a: { x: x0 + k * clear / 4, y: y + (k % 2) * 0.3 }, b: { x: x0 + (k + 1) * clear / 4, y: y + ((k + 1) % 2) * 0.3 } });
    expect(runTrace({ lines }).rooms.length).toBe(2);        // nothing drawn: the closet stays open
    const res = runTrace({ lines, hints });
    expect(res.rooms.length).toBe(3);
    const closet = res.rooms.reduce((m, r) => (r.area < m.area ? r : m));
    expect(closet.area).toBeGreaterThan(clear * 1.5);
    expect(closet.area).toBeLessThan(clear * 2.2);
    const front = res.openings.find((o) => o.rooms.includes(closet.id));
    expect(front.width).toBeCloseTo(clear, 1);
    expect(errors(res)).toEqual([]);
  });

  it('a closet front running on from the corner of the wall above closes on its bifold', () => {
    // the guest bedroom closet: the mech closet's wall comes down, turns west
    // as the closet's top, and the 3'-8" bifold front runs on from that
    // corner to the exterior wall; a tee is never a jamb this way
    const W = 14, H = 10, x = 2 + 4 * IN, y = 6;
    const lines = wallsToLines([
      ...box(W, H),
      { x1: x, y1: 0, x2: x, y2: y, t: INT }, { x1: 0, y1: y, x2: x, y2: y, t: INT },
    ], [], W, H);
    const hints = [];
    for (let k = 0, y0 = y + INT / 2, y1 = H - EXT / 2; k < 4; k++) hints.push({ a: { x: x + (k % 2) * 0.35, y: y0 + k * (y1 - y0) / 4 }, b: { x: x + ((k + 1) % 2) * 0.35, y: y0 + (k + 1) * (y1 - y0) / 4 } });
    expect(runTrace({ lines }).rooms.length).toBe(2);
    const res = runTrace({ lines, hints });
    expect(res.rooms.length).toBe(3);
    const closet = res.rooms.reduce((m, r) => (r.area < m.area ? r : m));
    expect(closet.center.x).toBeLessThan(x);
    expect(closet.center.y).toBeGreaterThan(y);
    const front = res.openings.find((o) => o.rooms.includes(closet.id));
    expect(front.width).toBeCloseTo(H - EXT / 2 - y - INT / 2, 1);
    expect(errors(res)).toEqual([]);
  });

  it('a bifold front runs straight down its stub, and the pocket door beside it keeps its own 2\'-2"', () => {
    // bifold closet front from a stub's end down to the bath wall; that bath
    // wall's end is the jamb of a 2'-2" pocket door. A slanted "front" to the
    // bath wall's end, or one alongside the stub, stole that jamb and the
    // pocket door became a 5' gap running back over the wall
    const W = 12, x = 2 + 4 * IN, yb = 5.6, xe = 3 + 2 * IN, xp = xe + 26 * IN;
    const lines = wallsToLines([
      { x1: 0, y1: -3, x2: W, y2: -3, t: EXT }, { x1: 0, y1: 10, x2: W, y2: 10, t: EXT },
      { x1: 0, y1: -3, x2: 0, y2: 10, t: EXT }, { x1: W, y1: -3, x2: W, y2: 10, t: EXT },
      { x1: x, y1: 0, x2: xe + 1, y2: 0, t: INT, capB: 0 },                  // stub wall north of the closet
      { x1: x, y1: 0, x2: x, y2: 2, t: INT, capB: 0 },                       // closet's side stub
      { x1: 0, y1: 1, x2: x, y2: 1, t: INT },                                // closet top
      { x1: 0, y1: yb, x2: xe, y2: yb, t: INT, capB: 0 },                    // bath wall, west of the pocket door
      { x1: xp, y1: yb, x2: W, y2: yb, t: INT, capA: 0 },                    // bath wall, east of it
    ], [], W, 10);
    const hints = [];
    for (let k = 0, y0 = 2; k < 4; k++) hints.push({ a: { x: x + (k % 2) * 0.4, y: y0 + k * (yb - y0) / 4 }, b: { x: x + ((k + 1) % 2) * 0.4, y: y0 + (k + 1) * (yb - y0) / 4 } });
    const res = runTrace({ lines, hints });
    const pocket = res.openings.find((o) => Math.abs(o.a.y - yb) < 0.2 && Math.abs(o.b.y - yb) < 0.2);
    expect(pocket).toBeTruthy();
    expect(pocket.width).toBeCloseTo(26 * IN, 1);
    const front = res.openings.find((o) => Math.abs(o.a.x - x) < 0.2 && Math.abs(o.b.x - x) < 0.2);
    expect(front).toBeTruthy();
    const onBathWall = res.openings.filter((o) => Math.abs(o.a.y - yb) < 0.2 || Math.abs(o.b.y - yb) < 0.2);
    expect(onBathWall.every((o) => o.width < 4)).toBe(true);
  });

  it('hatch strokes inside a new wall never become walls of their own', () => {
    // a 4" wall with three 45° hatch strokes near its end (too few for a pattern)
    const lines = [hline(0, 0, 10), hline(INT, 0, 10)];
    for (const x of [0.2, 0.55, 0.9]) lines.push({ a: { x, y: INT }, b: { x: x + INT, y: 0 } });
    const { bodies } = pairWalls(lines);
    expect(bodies.length).toBe(1);
    expect(bodies[0].t * 12).toBeCloseTo(4, 3);
  });

  it('two short parallel strokes a foot apart are not a 12" wall', () => {
    const { bodies } = pairWalls([hline(0, 0, 0.47), hline(1, 0, 0.47)]);
    expect(bodies.length).toBe(0);
  });

  it('a closet label inside an open play area does not name it', () => {
    const W = 22, H = 20;
    const lines = wallsToLines(box(W, H), [], W, H);
    const res = runTrace({ lines, texts: [{ str: 'NEW PLAY AREA', x: 11, y: 10 }, { str: 'NEW CL', x: 3, y: 17 }] });
    expect(res.rooms.length).toBe(1);
    expect(res.rooms[0].name).toBe('NEW PLAY AREA');
  });

  it('reads the dashed scale note some offices print: 1/4"-1\'-0"', () => {
    expect(parseScaleNote([{ str: 'scaled: 1/4"-1\'-0"' }])).toBe('1/4');
    expect(parseScaleNote([{ str: 'SCALE: 1/8" = 1\'-0"' }])).toBe('1/8');
  });

  it('room names come from labels when given, the door schedule from all text', () => {
    const W = 12, H = 10;
    const lines = wallsToLines(box(W, H), [], W, H);
    const res = runTrace({
      lines,
      texts: [{ str: 'RENOVATION AND NEW ADDITION', x: 6, y: 5 }, { str: 'OFFICE', x: 6, y: 6 }],
      labels: [{ str: 'OFFICE', x: 6, y: 6 }],
    });
    expect(res.rooms[0].name).toBe('OFFICE');
  });
});
