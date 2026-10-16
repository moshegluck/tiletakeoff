import { describe, it, expect } from 'vitest';
import { takeoffPages, summarize, openingsText } from '../src/lib/markedPdf.js';

const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const room = (name, pts, extra = {}) => ({ id: name, name, points: pts, assigned: [], ...extra });

describe('marked-up PDF: what goes on it', () => {
  const st = {
    unitSystem: 'imperial_ft_in', materials: [], pdfPage: 3, scale: 1 / 36, archScale: '1/4',
    rooms: [room('BATH', sq(0, 0, 5, 8), { wallLf: 21, openings: [{ width: 2.5, type: 'door' }, { width: 1, type: 'opening' }] })],
    markups: [{ id: 'm', type: 'length', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], name: 'Base' }],
    pageData: {
      1: { rooms: [room('SITE', sq(0, 0, 10, 10))], markups: [], scale: 1 / 18, archScale: '1/8' },
      2: { rooms: [], markups: [], scale: 1 / 36 },                 // visited, nothing on it
    },
  };

  it('takes every page with rooms or markups, in page order, each with its own scale', () => {
    const pages = takeoffPages(st);
    expect(pages.map((p) => [p.page, p.rooms.length, p.markups.length, p.scale])).toEqual([[1, 1, 0, 1 / 18], [3, 1, 1, 1 / 36]]);
  });

  it('sums rooms per page and for the job; wall LF is the traced net LF when there is one', () => {
    const s = summarize(st);
    expect(s.rooms).toBe(2);
    expect(s.sf).toBeCloseTo(140, 6);
    expect(s.pages[0].rooms[0]).toMatchObject({ name: 'SITE', lf: 40, traced: false });
    expect(s.pages[1].rooms[0]).toMatchObject({ name: 'BATH', lf: 21, traced: true });
    expect(s.pages[1].scale).toBe('1/4" = 1\'-0"');
    expect(s.pages[1].markups[0]).toMatchObject({ name: 'Base', value: 10, unit: 'lf' });
  });

  it('says what the wall LF was taken net of', () => {
    expect(openingsText(st.rooms[0], 'imperial_ft_in')).toMatch(/^1 door, 1 opening · 3'-6/);
    expect(openingsText(room('X', sq(0, 0, 1, 1)), 'imperial_ft_in')).toBe('');
  });
});
