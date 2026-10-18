import { describe, it, expect } from 'vitest';
import { readScale, scaleNotes, planTitles, planScale } from '../src/engine/trace/sheetScale.js';
import { runTrace } from '../src/engine/trace/index.js';
import { dimFeet, dimensionScale, doorTags } from '../src/engine/trace/dimScale.js';
import { detectSheetScale } from '../src/lib/planEvidence.js';

// Reading a sheet before tracing it: which scale the floor plan is drawn at,
// and which words name rooms. Cases from Moshe's marked jobs (Saddle River,
// Herzka, Promenade at Middletown), each read wrong before.

describe('the floor plan\'s scale', () => {
  it('reads scale notes, including AutoCAD SHX text that flattens a stacked fraction', () => {
    expect(readScale('SCALE: 3/16" =1\'-0"')).toBe('3/16');
    expect(readScale('1/8″ = 1′-0″')).toBe('1/8');
    expect(readScale('1 1/2" = 1\'-0"')).toBe('1-1/2');
    expect(readScale('SCALE: 1"=1\'-0"')).toBe('1');
    // SHX: the line with the fraction left out, then its digits in its place
    expect(readScale('SCALE:  "=1\'-0"12"=1\'-0"')).toBe('1/2');
    expect(readScale('SCALE: 1 "=1\'-0"12"=1\'-0"')).toBe('1-1/2');
    expect(readScale('SCALE:  "=1\'-0"     FINISHED BASEMENT FLOOR AREA = 3,600 SF14"=1\'-0"     FINISHED…')).toBe('1/4');
    expect(readScale('1" = 20\'')).toBe('e20');
    expect(readScale('3\'0" X 6\'8"')).toBe(null);
    expect(readScale('12\'-6"')).toBe(null);
  });

  it('takes the note printed with the plan\'s title, not the commonest one (the details\')', () => {
    const texts = [
      { str: 'BASEMENT PLAN', x: 575, y: 3062, h: 36 },
      { str: 'SCALE: 3/16" =1\'-0"', x: 810, y: 3098, h: 22 },
      ...[[3864, 1418], [4142, 3281], [4142, 2614], [4565, 1622], [3796, 656]].map(([x, y], i) => ({ str: `SCALE: ${i % 2 ? '3/4' : '1/2'}" =1'-0"`, x, y, h: 22 })),
      { str: 'CONC. FTG. 42" BELOW GRADE MIN. SEE PLAN FOR SIZE', x: 4262, y: 2365, h: 50 },
    ];
    expect(planTitles(texts).map((t) => t.str)).toEqual(['BASEMENT PLAN']);
    expect(planScale(texts)).toMatchObject({ id: '3/16', how: 'title', title: 'BASEMENT PLAN' });
    // with no plan title, the sheet's commonest note
    expect(planScale(texts.filter((t) => t.str !== 'BASEMENT PLAN')).how).toBe('common');
  });

  it('reads "SCALE:" and its value as two texts, and never joins a view number into the note', () => {
    const texts = [
      { str: 'FLOOR FINISH PLAN', x: 602, y: 2467, h: 56 },
      { str: '1', x: 250, y: 2500, h: 40 },          // the view's number bubble
      { str: 'SCALE:', x: 330, y: 2523, h: 25 },
      { str: '1/8" = 1\'-0"', x: 445, y: 2523, h: 25 },
    ];
    expect(scaleNotes(texts).map((n) => n.id)).toEqual(['1/8', '1/8']);
    expect(planScale(texts).id).toBe('1/8');
  });
});

describe('which words name rooms', () => {
  it('framing callouts, notes, door tags, stair notes and window codes are not room names', () => {
    const t = 5 / 12;
    const bodies = [
      [0, 0, 20, 0], [0, 12, 20, 12], [0, 0, 0, 12], [20, 0, 20, 12],
    ].map(([x1, y1, x2, y2]) => ({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, t }));
    const at = (str, x, y) => ({ str, x, y });
    const res = runTrace({
      bodies,
      texts: [
        at('BEDROOM 2', 10, 6),
        at('(2) 1 3/4"x9 1/4" LVL HEADER', 10, 5),
        at('W18x71 WIDE FLANGE STEEL BEAM', 10, 7),
        at('4" CONCRETE SLAB ABOVE', 9, 4),
        at('3\'0" X 6\'8"', 11, 4),
        at('UP 22R', 12, 8),
        at('2165 CA-3', 8, 8),
      ],
    });
    expect(res.rooms.length).toBe(1);
    expect(res.rooms[0].name).toBe('BEDROOM 2');
    expect(res.rooms[0].type).toBe('bedroom');
  });
});

describe('the scale the sheet is really drawn at (its dimension strings)', () => {
  // a dimension chain along y = 500 px: extension lines at the given x's,
  // each span's length printed above its middle (render px, 144 px / inch)
  const chain = (xs, fpi, { y = 500, rot = 0 } = {}) => {
    const lines = [{ a: { x: xs[0] - 8, y }, b: { x: xs[xs.length - 1] + 8, y } }];
    const texts = [];
    for (const x of xs) lines.push({ a: { x, y: y - 12 }, b: { x, y: y + 40 } });
    for (let k = 0; k + 1 < xs.length; k++) {
      const ft = ((xs[k + 1] - xs[k]) / 144) * fpi;
      const f = Math.floor(ft), inch = Math.round((ft - f) * 12);
      texts.push({ str: `${f}'-${inch}"`, x: (xs[k] + xs[k + 1]) / 2, y: y - 9, h: 14, rot });
    }
    return { lines, texts };
  };
  const flip = ({ lines, texts }) => ({   // the same chain turned up the sheet
    lines: lines.map((l) => ({ a: { x: l.a.y, y: l.a.x }, b: { x: l.b.y, y: l.b.x } })),
    texts: texts.map((t) => ({ ...t, x: t.y, y: t.x, rot: 90 })),
  });

  it('reads dimension strings, SHX stacked fractions too', () => {
    expect(dimFeet('12\'-6"')).toBe(12.5);
    expect(dimFeet('28\'-11"')).toBeCloseTo(28.9167, 4);
    expect(dimFeet('8\'-8 "12"')).toBeCloseTo(8 + 8.5 / 12, 6);
    expect(dimFeet('4\'-6 1/2"')).toBeCloseTo(4 + 6.5 / 12, 6);
    expect(dimFeet('3\'0" X 6\'8"')).toBe(null);
  });

  it('measures each dimension between the extension lines on either side of its text', () => {
    // 3/16" = 1'-0" (5.333 ft per inch): 216 px is 8'-0", 324 px is 12'-0"
    const h = chain([1000, 1216, 1540, 1756, 2080, 2296, 2620], 16 / 3);
    const v = flip(chain([600, 924, 1140, 1464, 1680], 16 / 3));
    const d = dimensionScale([...h.texts, ...v.texts], [...h.lines, ...v.lines], 144);
    expect(d.votes).toBe(10);
    expect(d.fpi).toBeCloseTo(16 / 3, 1);
  });

  it("the dimensions win over a note that's wrong for the sheet, and a sheet plotted at no standard scale is measured", () => {
    const note = [{ str: 'SECOND FLOOR PLAN', x: 500, y: 3225, h: 36 }, { str: 'SCALE: 1/4" =1\'-0"', x: 800, y: 3261, h: 22 }];
    const dims = chain([1000, 1216, 1540, 1756, 2080, 2296, 2620], 16 / 3);
    const sc = detectSheetScale({ texts: [...note, ...dims.texts], lines: dims.lines }, 144);
    expect(sc).toMatchObject({ id: '3/16', how: 'dimensions', note: '1/4" = 1\'-0"' });
    // plotted at 96% of 3/16": 5.53 ft per inch (Saddle River's second floor)
    const odd = chain([1000, 1216, 1540, 1756, 2080, 2296, 2620], 5.533);
    const sc2 = detectSheetScale({ texts: [...note, ...odd.texts], lines: odd.lines }, 144);
    expect(sc2.id).toBe(null);
    expect(sc2.scale * 144).toBeCloseTo(5.533, 1);
    // a note the dimensions agree with stands, confirmed
    const ok = chain([1000, 1288, 1720, 2008, 2440, 2728, 3160], 4);
    expect(detectSheetScale({ texts: [...note, ...ok.texts], lines: ok.lines }, 144)).toMatchObject({ id: '1/4', how: 'title', dims: { votes: 6 } });
  });
});

describe("the scale the sheet's doors say (door tags in their swings)", () => {
  // a door swing as one Bézier quarter circle (render px): hinge c, radius r, closed toward +x
  const K = 0.5523;
  const swing = (c, r) => ({ pieces: [{ p0: { x: c.x + r, y: c.y }, p1: { x: c.x + r, y: c.y + K * r }, p2: { x: c.x + K * r, y: c.y + r }, p3: { x: c.x, y: c.y + r } }] });
  const sheet = (fpi, widths) => {
    const curves = [], texts = [{ str: 'SECOND FLOOR PLAN', x: 500, y: 3225, h: 36 }, { str: 'SCALE: 1/4" =1\'-0"', x: 800, y: 3261, h: 22 }];
    widths.forEach((w, i) => {
      const c = { x: 600 + 300 * i, y: 1000 }, r = (w / fpi) * 144;
      curves.push(swing(c, r));
      const ft = Math.floor(w), inch = Math.round((w - ft) * 12);
      texts.push({ str: `${ft}'${inch}" X 6'8"`, x: c.x + 0.45 * r, y: c.y + 0.45 * r, h: 10 });   // the tag inside its swing
    });
    return { texts, lines: [], curves };
  };

  it('reads door tags and the leaf width they state', () => {
    expect(doorTags([{ str: '3\'0" X 6\'8"', x: 0, y: 0 }, { str: '2\'-8" x 6\'-8"', x: 0, y: 0 }, { str: '12\'-6"', x: 0, y: 0 }]).map((t) => +t.w.toFixed(3)))
      .toEqual([3, 2.667]);
  });

  it("measure a sheet plotted at no standard scale whose dimensions can't be read (Saddle River A-103)", () => {
    // the note says 1/4"; the plot is 96% of 3/16" (5.53 ft per inch), its dimensions strokes, no text
    const ev = sheet(5.533, [3, 3, 3, 2 + 8 / 12, 3, 2 + 2 / 12, 3]);
    const sc = detectSheetScale(ev, 144);
    expect(sc).toMatchObject({ id: null, how: 'doors', note: '1/4" = 1\'-0"' });
    expect(sc.scale * 144).toBeCloseTo(5.533, 1);
    // doors drawn at the noted scale confirm it
    const ok = detectSheetScale(sheet(4, [3, 3, 2.5, 3, 2 + 8 / 12]), 144);
    expect(ok).toMatchObject({ id: '1/4', how: 'title' });
    expect(ok.doors.votes).toBe(5);
    // too few tags: the note stands
    expect(detectSheetScale(sheet(5.533, [3, 3, 3]), 144)).toMatchObject({ id: '1/4', how: 'title' });
  });
});
