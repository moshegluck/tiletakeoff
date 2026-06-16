import { describe, it, expect } from 'vitest';
import { buildCutSheet, buildProjectCutSheets, cutSheetHTML } from '../src/engine/cutSheet.js';
import { rectPoly } from '../src/engine/geometry.js';
import { formatLength } from '../src/engine/units.js';

const fmt = (ft) => formatLength(ft, 'imperial_ft_in');
const room = (w, h) => ({ name: 'R', points: rectPoly(0, 0, w, h), layout: { pattern: 'grid' }, assigned: ['M1'] });
const mat = (over = {}) => ({ id: 'M1', name: 'Porcelain', type: 'floor', tw: 12, th: 12, grout: 0, pattern: 'grid', ...over });

describe('cutSheet: buildCutSheet', () => {
  const sh = buildCutSheet([room(12.25, 12.25)], mat(), fmt, 'practical');

  it('reports headline counts consistent with the cut engine', () => {
    expect(sh.fullTiles).toBe(144);
    expect(sh.cutPieces).toBe(25);
    expect(sh.tilesBroken).toBe(7);
    expect(sh.saved).toBe(18);
    expect(sh.totalTiles).toBe(151);
  });

  it('per-room rollup carries area and cut count', () => {
    expect(sh.perRoom.length).toBe(1);
    expect(sh.perRoom[0].areaSf).toBeCloseTo(150.06, 1);
    expect(sh.perRoom[0].cuts).toBe(25);
  });

  it('consolidated cut list groups by size and totals the count', () => {
    const totalGrouped = sh.cutList.reduce((s, c) => s + c.count, 0);
    expect(totalGrouped).toBe(sh.cutPieces);
    expect(sh.cutList.length).toBeGreaterThan(0);
  });

  it('cutting plan only lists tiles actually broken from new stock', () => {
    expect(sh.plan.length).toBe(sh.tilesBroken);
    for (const p of sh.plan) {
      expect(p.install).toMatch(/×/);
      expect(Array.isArray(p.offcuts)).toBe(true);
    }
  });
});

describe('cutSheet: project + HTML', () => {
  const state = {
    name: 'Job',
    materials: [mat(), mat({ id: 'M2', name: 'Wall', type: 'wall' })],
    rooms: [{ ...room(12.25, 12.25) }],
  };

  it('skips wall materials in project sheets', () => {
    const sheets = buildProjectCutSheets(state, fmt);
    expect(sheets.length).toBe(1);
    expect(sheets[0].material).toBe('Porcelain');
  });

  it('renders valid standalone HTML with the key sections', () => {
    const sheets = buildProjectCutSheets(state, fmt);
    const html = cutSheetHTML(state, sheets);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Consolidated cut list');
    expect(html).toContain('Cutting plan');
    expect(html).toContain('Job'); // project name in title
  });

  it('escapes HTML in project / material names (no injection)', () => {
    const evil = { name: '<script>x</script>', materials: [mat({ name: '<b>bad</b>' })], rooms: [room(12.25, 12.25)] };
    const html = cutSheetHTML(evil, buildProjectCutSheets(evil, fmt));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
