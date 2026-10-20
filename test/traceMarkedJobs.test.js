import { describe, it, expect } from 'vitest';
import { pairWalls } from '../src/engine/trace/walls.js';
import { evidenceToFeet } from '../src/lib/planEvidence.js';
import { cadText, markGlyphs } from '../src/lib/pdfVectors.js';
import { arcsFromDashes, isDoorSwing } from '../src/engine/trace/arcs.js';
import { runTrace } from '../src/engine/trace/index.js';
import { roomTypeOf } from '../src/engine/trace/analyze.js';
import { joinWalls, bridgeOpenings } from '../src/engine/trace/graph.js';

// Regressions from Moshe's marked jobs (454 Saddle River Rd, the Herzka
// residence, Promenade at Middletown): AutoCAD sheets whose SHX text is
// plotted as strokes, poché drawn as hatch strokes, layers named in Russian
// and French. Each case below read wrong before.

const IN = 1 / 12;
const HEAVY = 2.88 / 36;   // the sheet's wall pen, in feet
const hline = (y, x0, x1, w = HEAVY) => ({ a: { x: x0, y }, b: { x: x1, y }, w });
const vline = (x, y0, y1, w = HEAVY) => ({ a: { x, y: y0 }, b: { x, y: y1 }, w });

describe('marked jobs (Saddle River, Herzka, Promenade)', () => {
  it('reads AutoCAD text codes as words: %%u underlines drop out', () => {
    expect(cadText('%%uGUEST %%uBATH #3')).toBe('GUEST BATH #3');
    expect(cadText('%%uPOWDER #1')).toBe('POWDER #1');
    expect(cadText('45%%d')).toBe('45°');
    expect(cadText('%%c4" PIPE')).toBe('Ø4" PIPE');
    expect(cadText('50%%% OFF')).toBe('50% OFF');
  });

  it("a room name's letters and underline are text, not walls (Herzka's FAMILY ROOM)", () => {
    // "FAMILY" and "ROOM" as SHX annotations, each underlined by a heavy
    // stroke inside its box: the two underlines 31 px apart read as a 10"
    // wall that cut the family room in two
    const texts = [
      { str: 'FAMILY', x: 3467, y: 1801, w: 94, h: 34, rot: 0, shx: true },
      { str: 'ROOM', x: 3467, y: 1832, w: 78, h: 32, rot: 0, shx: true },
    ];
    const lines = [
      { a: { x: 3424.3, y: 1810.4 }, b: { x: 3506.2, y: 1810.4 }, w: 2.16 },   // FAMILY's underline
      { a: { x: 3432.2, y: 1841.8 }, b: { x: 3498.2, y: 1841.8 }, w: 2.16 },   // ROOM's underline
      { a: { x: 3440, y: 1790 }, b: { x: 3440, y: 1812 }, w: 2.16 },           // the F's stem
      { a: { x: 3169, y: 1826 }, b: { x: 3763, y: 1826 }, w: 2.88 },           // a wall running past the label
    ];
    markGlyphs(lines, texts);
    expect(lines.map((l) => !!l.glyph)).toEqual([true, true, true, false]);
    const k = 1 / 36;
    const input = evidenceToFeet({ lines, curves: [], texts }, k, null);
    expect(input.lines.length).toBe(1);
    expect(input.lines[0].a.y).toBeCloseTo(1826 * k, 6);
  });

  it("a wall's face crossing the poché strokes of the wall it meets still pairs (Herzka's family room)", () => {
    // an exterior wall (5.5") running down x = 0, its poché drawn as short
    // strokes across it every 14.5"; at its top corner an exterior wall
    // runs east, 5.6" thick, its lower face in line with the strokes. The
    // face was taken as one more stroke and the east wall lost — the family
    // room behind it leaked out through the slider beside it
    const t = 5.5 * IN, s = 14.56 * IN, top = 0, bot = 5.6 * IN;
    const lines = [
      vline(0, top, 30), vline(t, bot, 30),
      hline(top, 0, 3.71), hline(bot, 0, 3.71),
    ];
    for (let k = 1; k <= 24; k++) lines.push(hline(bot + k * s, 0, t, 0));
    const res = pairWalls(lines, {});
    const east = res.bodies.find((b) => Math.abs(b.a.y - b.b.y) < 1e-6 && Math.max(b.a.x, b.b.x) > 3);
    expect(east).toBeTruthy();
    expect(east.t * 12).toBeCloseTo(5.6, 1);
    // the strokes are still a pattern, never walls
    expect(res.bodies.every((b) => Math.abs(b.a.y - b.b.y) < 1e-6 ? Math.max(b.a.x, b.b.x) > 3 : true)).toBe(true);
  });

  it('reads a door swing plotted dashed (Saddle River: every door, 45° open)', () => {
    // hinge (0,0), r = 3', closed along +x, open at 45°: the arc as dashes of
    // two short pieces each, gaps between; the leaf drawn as a thin
    // rectangle whose corner meets the arc's open end
    const r = 3, pts = (a0, a1) => [a0, (a0 + a1) / 2, a1].map((a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }));
    const lines = [];
    const deg = Math.PI / 180;
    for (let a = 0; a < 45 - 1e-9; a += 9) {
      const p = pts(a * deg, (a + 6) * deg);
      lines.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] });
    }
    const open = { x: r * Math.cos(45 * deg), y: r * Math.sin(45 * deg) };
    lines.push({ a: open, b: { x: open.x - 0.06, y: open.y + 0.06 } });     // the leaf's short side at the open end
    // a straight dashed line nearby is no swing
    for (let x = 0; x < 6; x += 0.5) lines.push({ a: { x, y: -1 }, b: { x: x + 0.3, y: -1 } });
    const arcs = arcsFromDashes(lines);
    expect(arcs.length).toBe(1);
    expect(arcs[0].r).toBeCloseTo(3, 2);
    expect(arcs[0].c.x).toBeCloseTo(0, 2);
    expect(arcs[0].sweepDeg).toBeGreaterThan(35);
    expect(arcs[0].sweepDeg).toBeLessThan(50);   // (the leaf's side, tangent at the open end, carries it on a little)
    // a full swing plotted dashed is a door swing like any other
    const full = [];
    for (let a = 0; a < 90 - 1e-9; a += 9) { const p = pts(a * deg, (a + 6) * deg); full.push({ a: p[0], b: p[1] }, { a: p[1], b: p[2] }); }
    const f = arcsFromDashes(full);
    expect(f.length).toBe(1);
    expect(isDoorSwing(f[0])).toBe(true);
  });

  it("a corner pier between two windows is wall, not a fixture (Promenade's INDOOR ACTIVITY)", () => {
    // 20' x 15' outside, 6" walls; the south wall stops 2'-10" short of the
    // corner and the east wall 2'-10" short of it — windows — leaving an L of
    // wall 1.2' each way at the corner, detached from the rest by the glass
    const t = 0.5;
    const lines = [
      hline(0, 0, 20), hline(t, t, 20 - t), vline(0, 0, 15), vline(t, t, 15 - t),
      hline(15, 0, 16), hline(15 - t, t, 16), vline(16, 15 - t, 15),
      hline(15, 18.8, 20), hline(15 - t, 18.8, 20 - t), vline(18.8, 15 - t, 15),
      vline(20, 0, 11), vline(20 - t, t, 11), hline(11, 20 - t, 20),
      vline(20, 13.8, 15), vline(20 - t, 13.8, 15 - t), hline(13.8, 20 - t, 20),
    ];
    const hints = [
      ...[-t / 4, 0, t / 4].map((d) => ({ a: { x: 16, y: 15 - t / 2 + d }, b: { x: 18.8, y: 15 - t / 2 + d }, kind: 'window' })),
      ...[-t / 4, 0, t / 4].map((d) => ({ a: { x: 20 - t / 2 + d, y: 11 }, b: { x: 20 - t / 2 + d, y: 13.8 }, kind: 'window' })),
    ];
    const res = runTrace({ lines, hints });
    expect(res.rooms.length).toBe(1);
    expect(res.rooms[0].area).toBeCloseTo((20 - 2 * t) * (15 - 2 * t), 0);
    expect(res.openings.map((o) => o.openingType)).toEqual(['window', 'window']);
  });

  it("a glazed partition on the window layer divides rooms like a wall (Saddle River's lecture room)", () => {
    // a 40' x 30' hall on a layered sheet, 6" walls on A-WALL; a glass wall
    // (two hairlines 5½" apart on A-Glaz) runs right across it at x = 20'.
    // West of it the floor is open to the assembly below
    const px = 36, k = 1 / px;   // 1/4" at 144 px / inch
    const L = (x1, y1, x2, y2, layer, w, n = 10) => Array.from({ length: n }, (_, i) => ({
      a: { x: (x1 + ((x2 - x1) * i) / n) * px, y: (y1 + ((y2 - y1) * i) / n) * px },
      b: { x: (x1 + ((x2 - x1) * (i + 1)) / n) * px, y: (y1 + ((y2 - y1) * (i + 1)) / n) * px }, w, layer,
    }));
    const t = 0.5, g = 5.5 / 12, x0 = 20 - g / 2;
    const lines = [
      ...L(0, 0, 40, 0, 'A-WALL', 2.04), ...L(t, t, 40 - t, t, 'A-WALL', 2.04),
      ...L(0, 30, 40, 30, 'A-WALL', 2.04), ...L(t, 30 - t, 40 - t, 30 - t, 'A-WALL', 2.04),
      ...L(0, 0, 0, 30, 'A-WALL', 2.04), ...L(t, t, t, 30 - t, 'A-WALL', 2.04),
      ...L(40, 0, 40, 30, 'A-WALL', 2.04), ...L(40 - t, t, 40 - t, 30 - t, 'A-WALL', 2.04),
      ...L(x0, t, x0, 30 - t, 'A-Glaz', 0.72, 1), ...L(x0 + g, t, x0 + g, 30 - t, 'A-Glaz', 0.72, 1),
    ];
    const texts = [{ str: 'LECTURE ROOM 01', x: 30 * px, y: 15 * px }, { str: 'OPEN TO ASSEMBLY', x: 10 * px, y: 15 * px }];
    const res = runTrace(evidenceToFeet({ lines, curves: [], texts }, k, null));
    const lecture = res.rooms.find((r) => r.name === 'LECTURE ROOM 01');
    expect(lecture).toBeTruthy();
    expect(lecture.area).toBeCloseTo((40 - t - (x0 + g)) * (30 - 2 * t), 0);
    // the void west of the glass is no floor
    expect(roomTypeOf('OPEN TO ASSEMBLY')).toBe('nofloor');
    expect(roomTypeOf('OPEN TO BELOW')).toBe('nofloor');
    expect(res.rooms.find((r) => r.name === 'OPEN TO ASSEMBLY')?.type ?? 'nofloor').toBe('nofloor');
  });

  it("a layered wall's faces where it stops at a door are no hatch (Saddle River's dining room)", () => {
    // block with a stud wall either side: four face lines 6" apart in the
    // wall pen, 3.7' long between the door and the corner — four short evenly
    // spaced lines, which read as a hatch pattern and left the room open
    const ys = [0, 0.5, 1, 1.5];
    const res = pairWalls(ys.map((y) => hline(y, 0, 3.7)), {});
    expect(res.bodies.length).toBeGreaterThan(0);
    // the same four strokes drawn light are a pattern (a tile field, treads)
    const light = pairWalls([...ys.map((y) => hline(y, 0, 3.7, HEAVY * 0.3)), hline(5, 0, 20), hline(5.5, 0, 20)], {});
    expect(light.bodies.every((b) => Math.min(b.a.y, b.b.y) >= 4.9)).toBe(true);
  });

  it("the sheet's details beside the plan are other views, not rooms (Herzka's sill details)", () => {
    // the house (40' x 30') and, 30' to its west, a sill detail drawn at 1½":
    // a box with its own title and scale note under it
    const t = 0.5;
    const box = (x0, y0, x1, y1) => [[x0, y0, x1, y0], [x0, y1, x1, y1], [x0, y0, x0, y1], [x1, y0, x1, y1]].map(([a, b, c, d]) => ({ a: { x: a, y: b }, b: { x: c, y: d }, t }));
    const bodies = [...box(60, 10, 100, 40), ...box(10, 20, 22, 28)];
    const texts = [
      { str: 'LIVING ROOM', x: 80, y: 25, h: 0.5 },
      { str: 'FIRST FLOOR PLAN', x: 70, y: 44, h: 0.6 }, { str: 'SCALE: 1/4" = 1\'-0"', x: 76, y: 45, h: 0.4 },
      { str: 'TYPICAL SILL DETAIL', x: 14, y: 29.5, h: 0.5 }, { str: 'SCALE: 1 1/2" = 1\'-0"', x: 14, y: 30.3, h: 0.4 },
    ];
    const res = runTrace({ bodies, texts, labels: texts });
    expect(res.rooms.map((r) => r.name)).toEqual(['LIVING ROOM']);
    expect(res.flags.filter((f) => f.severity === 'error')).toEqual([]);
    expect(res.flags.some((f) => f.kind === 'frame')).toBe(true);
  });

  it("a doorway framed at both jambs on the door layer is a door, even beside another door's jamb (Carlton Rd's vanity rooms)", () => {
    // the vanity under the bath: the bath's door above (y = 0), the linen
    // closet's door on the right (x = 6.56), and the way out below (y = 3): a
    // pocket door, only its frame drawn at each jamb, a dashed line across.
    // Its right jamb is the closet door's jamb too.
    const t = 4 * IN;
    const walls = [
      { a: { x: 0, y: 3 }, b: { x: 3.31, y: 3 }, t }, { a: { x: 6.56, y: 3 }, b: { x: 8.06, y: 3 }, t },
      { a: { x: 0, y: 0 }, b: { x: 3.33, y: 0 }, t }, { a: { x: 6.56, y: 0 }, b: { x: 8.06, y: 0 }, t },
      { a: { x: 8.06, y: 0 }, b: { x: 8.06, y: 3 }, t },
    ];
    const arcs = [{ c: { x: 6.22, y: 0.5 }, r: 2, sweepDeg: 90, p0: { x: 6.22, y: 2.5 }, p3: { x: 4.22, y: 0.5 } }];   // the closet's door
    const square = (x0, x1, y0, y1) => [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]
      .map(([ax, ay, bx, by]) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, kind: 'door' }));
    const frames = [...square(3.31, 3.47, 3 - t / 2, 3 + t / 2), ...square(5.97, 6.14, 3 - t / 2, 3 + t / 2),
      ...square(3.33, 3.5, -t / 2, t / 2), ...square(5.83, 6.0, -t / 2, t / 2)];
    const run = (hints) => {
      const j = joinWalls(walls.map((w) => ({ ...w, kind: 'wall' })));
      return bridgeOpenings(j.segs, j.ends, arcs, {}, [], hints);
    };
    const across = (os) => os.find((o) => Math.abs(o.a.y - 3) < 0.05 && Math.abs(o.b.y - 3) < 0.05);
    const out = run(frames);
    expect(across(out)).toBeTruthy();
    expect(across(out).width).toBeCloseTo(6.56 - 3.31, 1);
    // two doors' frames one above the other are no doorway between them (through the vanity)
    expect(out.some((o) => Math.abs(o.a.x - o.b.x) < 0.1 && o.a.x < 4)).toBe(false);
    // nothing drawn at its jambs: an inferred gap at the closet door's jamb stays open, as before
    expect(across(run([]))).toBeFalsy();
  });

  it("a wall's heavy faces pair before a heavy face and the hairline beside it (22 Rita's baths)", () => {
    // a sheet drawn with pen weights: 10.5" exterior walls and 3.5" partitions,
    // all heavy. One partition's far face is drawn in two pieces; a hairline
    // (the tub's apron) runs 10.4" off its near face the whole length — longer
    // than either piece, and a typical thickness on this sheet
    const HAIR = 0.6 / 36, t = 3.5 * IN, T = 10.4 * IN;
    const lines = [
      hline(0, 0, 30), hline(T, T, 30 - T), hline(20, 0, 30), hline(20 - T, T, 30 - T),
      vline(0, 0, 20), vline(T, T, 20 - T), vline(30, 0, 20), vline(30 - T, T, 20 - T),
      vline(10, T, 20 - T), vline(10 + t, T, 9.5), vline(10 + t, 9.8, 20 - T),
      vline(10 - T, T + 0.2, 20 - T - 0.2, HAIR),
      hline(5, 20, 30 - T), hline(5 + t, 20, 30 - T),
    ];
    const { bodies } = pairWalls(lines);
    const near = (x) => bodies.filter((b) => Math.abs(b.a.x - x) < 0.05 && Math.abs(b.b.x - x) < 0.05);
    // the partition: 3.5" thick wherever its far face is drawn
    const part = near(10 + t / 2);
    expect(part.length).toBeGreaterThanOrEqual(2);
    expect(part.every((b) => Math.abs(b.t - t) < 0.01)).toBe(true);
    expect(part.reduce((a, b) => a + Math.abs(b.b.y - b.a.y), 0)).toBeGreaterThan(20 - 2 * T - 1);
    // and no 10" wall made of its face and the tub
    expect(near(10 - T / 2).length).toBe(0);
  });

  it("a thick wall's face lying along a long hairline (a grid line run through it) is still a wall pen there (the nursing facility's stair shaft)", () => {
    // a sheet with pen weights: a 40' x 30' building of 6" walls; its west
    // side is an 18" masonry wall whose outer face a 90' grid line (a
    // hairline) runs straight along — merged into one run, mostly hairline
    const HAIR = 0.48 / 36, T = 18 * IN, t = 6 * IN;
    const lines = [
      hline(0, 0, 40), hline(t, T, 40 - t), hline(30, 0, 40), hline(30 - t, T, 40 - t),
      vline(40, 0, 30), vline(40 - t, t, 30 - t),
      vline(0, 0, 30), vline(T, t, 30 - t),
      vline(0, -30, 60, HAIR),
    ];
    const { bodies } = pairWalls(lines);
    const west = bodies.filter((b) => Math.abs(b.a.x - T / 2) < 0.05 && Math.abs(b.b.x - T / 2) < 0.05);
    expect(west.length).toBe(1);
    expect(west[0].t).toBeCloseTo(T, 2);
  });

  it("a storefront running on from a thick wall cut back at the building's corner meets it (the nursing facility's corridor end)", () => {
    // an 18" wall drawn on 1' past the corner it turns with a 14" wall; the
    // storefront (7", along the 18" wall's outer half) carries on from where
    // the 18" wall was drawn to end — too far off the 14" wall to meet it
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, t: 1.5 },
      { a: { x: 19, y: 10 }, b: { x: 19, y: 0.6 }, t: 14 * IN },
      { a: { x: 20.4, y: -0.5 }, b: { x: 30, y: -0.5 }, t: 7 * IN },
    ];
    const { segs: out } = joinWalls(segs);
    // the corner closed at (19, 0)…
    expect(out[0].b.x).toBeCloseTo(19, 6);
    // …and the storefront's end is tied to it, not left open
    const tie = out.slice(3).find((s) => [s.a, s.b].some((p) => Math.hypot(p.x - 20.4, p.y + 0.5) < 1e-6) && [s.a, s.b].some((p) => Math.hypot(p.x - 19, p.y) < 1e-6));
    expect(tie).toBeTruthy();
  });

  it("a door tag written along its leaf doesn't hide the swing's dashes (22 Rita's WC)", () => {
    // a 2'0" swing plotted dashed (6° dashes, 4° gaps) about a hinge at
    // (100, 100) px; the SHX door tag "2'0" X 6'8"" written along the leaf
    // has a box square to the sheet, and the dashes from 25° to 85° lie in it
    const k = 1 / 36, r = 72, lines = [];
    for (let a0 = 0; a0 < 90; a0 += 10) {
      const at = (deg) => ({ x: 100 + r * Math.cos((deg * Math.PI) / 180), y: 100 - r * Math.sin((deg * Math.PI) / 180) });
      const glyph = a0 >= 25 && a0 <= 85;
      lines.push({ a: at(a0), b: at(a0 + 3), w: 0.24, ...(glyph ? { glyph } : {}) }, { a: at(a0 + 3), b: at(a0 + 6), w: 0.24, ...(glyph ? { glyph } : {}) });
    }
    const { arcs } = evidenceToFeet({ lines, curves: [], texts: [] }, k, null);
    const swing = arcs.find((a) => Math.hypot(a.c.x - 100 * k, a.c.y - 100 * k) < 0.2);
    expect(swing).toBeTruthy();
    expect(swing.r).toBeCloseTo(2, 1);
  });

  it("a wall built in layers shares the face line between them: one wall, both layers thick (Bais Rochel's lunchroom)", () => {
    // a sheet with pen weights: a 30' x 20' room of 6" walls; its west wall is
    // an 8" block wall with a 6" lining against it — three heavy face lines,
    // the middle one the face of both. The lining took it alone and the
    // block wall was lost, leaving the lunchroom open past the lining's end
    const t = 6 * IN, B = 8 * IN, Lg = 6 * IN;
    const lines = [
      hline(0, 0, 30), hline(t, B + Lg, 30 - t), hline(20, 0, 30), hline(20 - t, B + Lg, 30 - t),
      vline(30, 0, 20), vline(30 - t, t, 20 - t),
      vline(0, 0, 20), vline(B, t, 20 - t), vline(B + Lg, t, 20 - t),
    ];
    const { bodies } = pairWalls(lines);
    const west = bodies.filter((b) => Math.abs(b.a.x - b.b.x) < 0.01 && Math.max(b.a.x, b.b.x) < 2 && Math.abs(b.b.y - b.a.y) > 10);
    expect(west.length).toBe(1);
    expect(west[0].t).toBeCloseTo(B + Lg, 2);
    expect(west[0].a.x).toBeCloseTo((B + Lg) / 2, 2);
  });

  it("the paper between the sheet's border and the building is no room, joined to it or not (22 Rita)", () => {
    // a 40' x 30' house on a 100' x 80' sheet; its border drawn as a wall
    // would be, and a grid line drawn heavy runs from the house to the border
    const T = 0.5, b = (x1, y1, x2, y2, t = T) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, t });
    const bodies = [
      b(1, 1, 99, 1), b(99, 1, 99, 79), b(99, 79, 1, 79), b(1, 79, 1, 1),            // the border
      b(30, 20, 70, 20), b(70, 20, 70, 50), b(70, 50, 30, 50), b(30, 50, 30, 20),   // the house
      b(1, 35, 30, 35, 0.3),                                                          // the grid line
    ];
    const res = runTrace({ bodies, texts: [{ str: 'LIVING ROOM', x: 50, y: 35 }], sheet: { x0: 0, y0: 0, x1: 100, y1: 80 } });
    expect(res.rooms.map((r) => r.name)).toEqual(['LIVING ROOM']);
    expect(res.rooms[0].area).toBeCloseTo((40 - T) * (30 - T), 0);
  });
});

