import { describe, it, expect } from 'vitest';
import { readScale, scaleNotes, planTitles, planScale } from '../src/engine/trace/sheetScale.js';
import { runTrace } from '../src/engine/trace/index.js';

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
