import { describe, it, expect } from 'vitest';
import { takeoffPages, summarize, roomMarks, markContext } from '../src/lib/markedPdf.js';

const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const room = (name, pts, extra = {}) => ({ id: name, name, points: pts, assigned: [], ...extra });
const FLOOR = { id: 'F', type: 'floor', name: '24X24' }, WALL = { id: 'W', type: 'wall', name: '12X24' };

describe('marked-up PDF: what goes on it', () => {
  const st = {
    unitSystem: 'imperial_ft_in', materials: [FLOOR, WALL], pdfPage: 3, scale: 1 / 36, archScale: '1/4',
    rooms: [
      // Willow Tree's guest shower bath: 9.25x5, shower 5x2.75, 10' ceiling fully tiled, 1 door
      room('GUEST SHOWER BATHROOM', sq(0, 0, 9.25, 5), { assigned: ['F', 'W'], wallHeight: 10, fixtures: { doors: 1, showers: [{ w: 5, d: 2.75 }] } }),
      room('FOYER', sq(20, 0, 18, 9), { assigned: ['F'] }),
      room('BEDROOM', sq(40, 0, 12, 12)),
    ],
    markups: [{ id: 'm', type: 'length', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], name: 'Base' }],
    pageData: {
      1: { rooms: [room('LAUNDRY', sq(0, 0, 10, 10), { assigned: ['F'] })], markups: [], scale: 1 / 18, archScale: '1/8' },
      2: { rooms: [], markups: [], scale: 1 / 36 },
    },
  };

  it('takes every page with rooms or markups, in page order, each with its own scale', () => {
    expect(takeoffPages(st).map((p) => [p.page, p.rooms.length, p.markups.length, p.scale])).toEqual([[1, 1, 0, 1 / 18], [3, 3, 1, 1 / 36]]);
  });

  it('reads like the proposal: bathroom header with dims, shower and ceiling; each line with its arithmetic', () => {
    const s = summarize(st);
    const bath = s.pages[1].rooms.find((r) => r.name === 'GUEST SHOWER BATHROOM');
    expect(bath.header).toBe("GUEST SHOWER BATHROOM (9.25x5 sf5x2.75) 10' ceiling - fully tiled");
    expect(bath.lines.map((l) => [l.label, l.qty, l.unit])).toEqual([
      ['Floor', 33, 'SF'], ['Shower floor 5x2.75', 14, 'SF'], ['Walls - fully tiled', 271, 'SF'],
    ]);
    expect(bath.lines[2].math).toBe("28.5 LF × 10' = 285 − 14 (door) = 271 → 271 SF");
  });

  it('only what is tiled is in it; the rest is listed as not tiled; totals add up', () => {
    const s = summarize(st);
    expect(s.pages[1].rooms.map((r) => r.name)).toEqual(['GUEST SHOWER BATHROOM', 'FOYER']);
    expect(s.pages[1].untiled).toEqual(['BEDROOM']);
    expect(s.floorSf).toBe(100 + 33 + 162);
    expect(s.wallSf).toBe(271);
    expect(s.showerFloors).toBe(1);
    expect(s.pages[1].markups[0]).toMatchObject({ name: 'Base', value: 10, unit: 'lf' });
  });

  it('before any tile is picked, every room is floor (the takeoff of what was traced)', () => {
    const bare = { ...st, materials: [], rooms: st.rooms.map((r) => ({ ...r, assigned: [] })), pageData: {} };
    const s = summarize(bare);
    expect(s.pages[0].rooms.length).toBe(3);
    expect(s.wallSf).toBe(0);
  });

  it('marks fully tiled walls blue and walls tiled partway magenta (the height noted)', () => {
    const ctx = markContext(st, st.rooms);
    expect(roomMarks(st.rooms[0], ctx)).toMatchObject({ wallTiled: true, full: true, type: 'bath', dims: '9.25x5' });
    const half = roomMarks({ ...st.rooms[0], finish: { wallTileHeight: 4 } }, ctx);
    expect(half.full).toBe(false);
    expect(half.header).toMatch(/4' tile$/);
    expect(half.walls.sf).toBe(28.5 * 4 - 8);
  });
});
