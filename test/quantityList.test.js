import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { quantityList, quantityWorkbook, artisticWaste, itemText, orderTotal } from '../src/lib/quantityList.js';
import { estimateProject } from '../src/engine/estimate.js';
import { wholeProject } from '../src/state/pages.js';

const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const room = (name, pts, extra = {}) => ({ id: name, name, points: pts, assigned: [], ...extra });
const mat = (id, type, name, tw, th, extra = {}) => ({ id, type, name, tw, th, grout: 0.125, pattern: 'grid', waste: 10, price: 0, priceUnit: 'sf', sfPerBox: 15, ...extra });

const FLOOR = mat('F', 'floor', '24X24 Rectified Floor Tile', 24, 24);
const WALL = mat('W', 'wall', 'Wall Tile', 12, 24);
const SUBWAY = mat('S', 'wall', 'Subway', 3, 12);
const LISTELLO = mat('L', 'floor', 'Listello', 2, 12);

const st = {
  name: 'Willow Tree', unitSystem: 'imperial_ft_in', materials: [FLOOR, WALL, SUBWAY, LISTELLO], pdfPage: 3, scale: 1 / 36,
  job: { proposal: '41765', customer: 'Salamon Home Improvement Inc.', address: '110 E Willow Tree, Spring Valley NY' },
  rooms: [
    // the guest shower bath of proposal #41765: 9.25x5, shower 5x2.75, 10' ceiling fully tiled, one door
    room('GUEST SHOWER BATHROOM', sq(0, 0, 9.25, 5), { assigned: ['F', 'W'], wallHeight: 10, fixtures: { doors: 1, showers: [{ w: 5, d: 2.75 }] } }),
    room('FOYER', sq(20, 0, 18, 9), {
      assigned: ['F'], zones: [{ id: 'b', kind: 'border', name: 'Listello', inset: 1, width: 2 / 12, materialId: 'L' }],
    }),
    room('KITCHEN', sq(40, 0, 12, 10), { assigned: ['F', 'S'], wallHeight: 8, finish: { wallTileHeight: 1.5 }, fixtures: { doors: 0 } }),
    room('BEDROOM', sq(60, 0, 12, 12)),
  ],
  markups: [],
  pageData: { 1: { rooms: [room('LAUNDRY', sq(0, 0, 10, 10), { assigned: ['F'] })], markups: [], scale: 1 / 18 } },
};

describe('Tile Quantity List (Artistic ordering document, current standard)', () => {
  it('lists page → room (proposal header) → each tiled surface, count before waste', () => {
    const q = quantityList(st);
    const text = q.rows.map((r) => (r.type === 'line' ? `  ${r.loc} | ${r.item} | ${r.unit} | ${r.count} | ${r.waste}` : `${r.type}: ${r.text}`));
    expect(text).toEqual([
      'major: PAGE 1',
      'sub: LAUNDRY',
      '  Floor | 24X24 FLOOR TILE | SF | 100 | 0.2',
      'major: PAGE 3',
      "sub: GUEST SHOWER BATHROOM (9.25x5 sf5x2.75) 10' ceiling - fully tiled",
      '  Floor | 24X24 FLOOR TILE | SF | 33 | 0.25',
      '  Shower Floor (5x2.75) | NA | SF | 14 | 0.15',
      '  Wall | 12X24 WALL TILE | SF | 271 | 0.25',
      'sub: FOYER',
      expect.stringMatching(/^ {2}Floor \| 24X24 FLOOR TILE \| SF \| \d+ \| 0\.2$/),
      expect.stringMatching(/^ {2}Listello — Listello \([\d.]+ LF\) \| 2X12 LISTELLO \| LF \| \d+ \| 0\.1$/),
      "sub: KITCHEN 1.5' tile",
      '  Floor | 24X24 FLOOR TILE | SF | 120 | 0.2',
      "  Wall — 1.5' high | 3X12 SUBWAY | SF | 66 | 0.15",
    ]);
    // the bedroom has no tile: it is not in the ordering document
    expect(q.rows.some((r) => /BEDROOM/.test(r.text || ''))).toBe(false);
    // the arithmetic rides along (a cell note on Count)
    expect(q.rows.find((r) => r.loc === 'Wall').math).toBe("28.5 LF × 10' = 285 − 14 (door) = 271 → 271 SF");
    // open selections are called out
    expect(q.naRooms).toEqual(['GUEST SHOWER BATHROOM']);
    expect(q.customer).toBe('Salamon Home Improvement Inc.  ·  110 E Willow Tree, Spring Valley NY');
  });

  it('agrees with the estimate: Floor rows + borders = floor tile net SF, Wall rows = wall tile net SF', () => {
    const q = quantityList(st);
    const e = estimateProject(wholeProject(st));
    const net = (wall) => e.lines.filter((l) => (l.material.type === 'wall') === wall).reduce((a, l) => a + l.netSf, 0);
    // the listello is ordered by the LF here; the estimate carries it as SF
    const listelloSf = e.lines.find((l) => l.material.id === 'L').netSf;
    expect(q.floorSf + q.borderSf).toBe(net(false) - listelloSf);
    expect(q.wallSf).toBe(net(true));
    expect(q.showerSf).toBe(14);
    expect(q.lf).toBeGreaterThan(0);
  });

  it("waste by Moshe's current table: accent beats room, room beats size", () => {
    const W = (surface, m, type, pattern) => artisticWaste(surface, m, type, pattern);
    expect(W('floor', mat('a', 'floor', '', 48, 48), 'bath')).toBe(0.35);       // 48X48 in a bath
    expect(W('floor', mat('a', 'floor', '', 48, 48), 'living')).toBe(0.25);     // 48X48 elsewhere
    expect(W('floor', mat('a', 'floor', '', 8, 48), 'bath')).toBe(0.25);        // any other tile in a bath
    expect(W('wall', mat('a', 'wall', 'Subway', 3, 12), 'bath')).toBe(0.25);
    expect(W('floor', null, 'bath')).toBe(0.25);                                // NA in a bath: the bath default
    expect(W('floor', mat('a', 'floor', '', 24, 48), 'living')).toBe(0.22);     // large format outside baths
    expect(W('floor', mat('a', 'floor', '', 8, 48), 'bedroom')).toBe(0.22);     // plank
    expect(W('floor', mat('a', 'floor', '', 10, 30), 'hall')).toBe(0.22);
    expect(W('floor', mat('a', 'floor', '', 12, 24), 'hall')).toBe(0.2);        // 24X24 / 12X24 open areas
    expect(W('floor', mat('a', 'floor', '', 24, 24), 'kitchen')).toBe(0.2);
    expect(W('wall', mat('a', 'wall', 'Subway', 3, 12), 'kitchen')).toBe(0.15); // subway
    expect(W('floor', mat('a', 'floor', '12X12 Pebbles', 12, 12), 'hall')).toBe(0.15); // mosaic / pebbles
    expect(W('floor', mat('a', 'floor', '', 8, 8), 'hall', 'herringbone')).toBe(0.15); // patterned layout
    expect(W('shower', null, 'bath')).toBe(0.15);
    expect(W('border', null, 'hall')).toBe(0.1);
    expect(W('floor', mat('a', 'floor', '', 12, 12), 'bedroom')).toBe(0.1);     // default
  });

  it('the Item names a product the store can order — size + type, never an install label; no pick → NA', () => {
    expect(itemText(mat('a', 'floor', 'Floor Tile', 12, 12))).toBe('12X12 FLOOR TILE');
    expect(itemText(mat('a', 'wall', '24x48 Large Format Rectified', 24, 48))).toBe('24X48 WALL TILE');
    expect(itemText(mat('a', 'floor', '8 x 48 plank', 8, 48))).toBe('8X48 FLOOR TILE');
    expect(itemText(mat('a', 'floor', '12x12 Pebbles', 12, 12, { sku: '254' }))).toBe('12X12 PEBBLES (254)');
    expect(itemText(mat('a', 'wall', 'White subway', 3, 12))).toBe('3X12 SUBWAY');
    expect(itemText(mat('a', 'floor', 'Hex mosaic', 2, 2))).toBe('2X2 MOSAIC');
    expect(itemText(null)).toBe('NA');
    expect(itemText(mat('a', 'floor', 'Floor Tile', 0, 0))).toBe('NA');
  });

  it('before any tile is picked, every traced room is a Floor line with Item NA', () => {
    const bare = { ...st, materials: [], rooms: st.rooms.map((r) => ({ ...r, assigned: [], zones: [] })), pageData: {} };
    const q = quantityList(bare);
    expect(q.rows.filter((r) => r.type === 'sub').length).toBe(4);
    const floors = q.rows.filter((r) => r.loc === 'Floor');
    expect(floors.every((r) => r.item === 'NA')).toBe(true);
    expect(floors[0].waste).toBe(0.25);   // the bath
    expect(q.naRooms.length).toBe(4);
  });

  it('orders to a tenth: Total = ROUNDUP(Count × (1 + Waste), 1)', () => {
    expect(orderTotal(271, 0.25)).toBe(338.8);
    expect(orderTotal(100, 0.2)).toBe(120);
    expect(orderTotal(33, 0.25)).toBe(41.3);
  });

  it('writes the sheet to the builder: centred title, unmerged bands, AutoFilter, SUMIF SF total', async () => {
    const q = quantityList(st);
    const wb = quantityWorkbook(ExcelJS, q, { date: '10/16/2026' });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer());
    const ws = back.getWorksheet('Tile Quantity List');
    expect(ws.getColumn(6).width).toBe(15.3);
    // title block: centred in C1:E3, F1:I3 an empty merged block
    expect(ws.getCell('C1').value).toBe('TILE QUANTITY LIST');
    expect(ws.getCell('C1').font).toMatchObject({ name: 'Calibri', size: 28, bold: true });
    expect(ws.getCell('C1').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' });
    expect(ws.getCell('E3').master.address).toBe('C1');
    expect(ws.getCell('I3').master.address).toBe('F1');
    expect(ws.getCell('F1').value).toBe(null);
    expect(ws.getCell('B1').fill.fgColor.argb).toBe('FF5C1A3A');
    // job band
    expect(ws.getCell('B5').fill.fgColor.argb).toBe('FFC9B3C2');
    expect(ws.getCell('B6').value).toBe('Project: Willow Tree  ·  Proposal #41765');
    expect(ws.getCell('C6').value).toBe('Customer: Salamon Home Improvement Inc.  ·  110 E Willow Tree, Spring Valley NY');
    expect(ws.getCell('H6').value).toBe('10/16/2026');
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((c) => ws.getCell(8, c).value)).toEqual(['Location', 'Item', 'Unit', 'Count', 'Waste %', 'Total', 'On Order', 'Difference']);
    expect(ws.getCell('B8').fill.fgColor.argb).toBe('FF6B2D5C');
    // bands are fills, not merges — nothing below the title block is merged
    expect(ws.getCell('B9').value).toBe('PAGE 1');
    expect(ws.getCell('I9').fill.fgColor.argb).toBe('FF6B2D5C');
    expect(ws.getCell('B10').value).toBe('LAUNDRY');
    expect(ws.getCell('I10').fill.fgColor.argb).toBe('FFEDE3EA');
    for (let r = 5; r <= ws.rowCount; r++) for (let c = 2; c <= 9; c++) expect(ws.getCell(r, c).isMerged).toBe(false);
    expect(ws.autoFilter).toBeTruthy();
    // a line: count, waste as a fraction shown as %, Total to a tenth
    expect(ws.getCell('E11').value).toBe(100);
    expect(ws.getCell('F11').value).toBe(0.2);
    expect(ws.getCell('F11').numFmt).toBe('0%');
    expect(ws.getCell('G11').value).toMatchObject({ formula: 'ROUNDUP(E11*(1+F11),1)', result: 120 });
    expect(ws.getCell('I11').value).toMatchObject({ formula: 'IF(H11="","",H11-G11)' });
    expect(ws.getCell('H11').value).toBe(null);
    const rows = [...Array(ws.rowCount).keys()].map((i) => i + 1);
    const wallRow = rows.find((r) => ws.getCell(r, 2).value === 'Wall');
    expect(ws.getCell(wallRow, 7).value.result).toBe(338.8);
    expect(JSON.stringify(ws.getCell(wallRow, 5).note)).toContain('28.5 LF');
    // one total band, SF rows only, by SUMIF on Unit
    const totals = rows.filter((r) => /^TOTAL/.test(String(ws.getCell(r, 2).value || '')));
    expect(totals.map((r) => ws.getCell(r, 2).value)).toEqual(['TOTAL — ALL TILE (SF)']);
    const t = totals[0];
    expect(ws.getCell(t, 5).value.formula).toBe(`SUMIF($D$9:$D$${t - 1},"SF",E9:E${t - 1})`);
    expect(ws.getCell(t, 5).value.result).toBe(q.floorSf + q.wallSf + q.showerSf + q.borderSf);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 8 });
  });
});

describe('job info (proposal #, customer, site address) travels with the project', () => {
  it('is set, saved, re-opened, and blank on a new project', async () => {
    globalThis.localStorage = globalThis.localStorage || { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
    const { useStore } = await import('../src/state/store.js');
    const S = () => useStore.getState();
    S().newProject();
    expect(S().job).toEqual({ proposal: '', customer: '', address: '' });
    S().setJob({ proposal: '42145' });
    S().setJob({ customer: 'Salamon Home Improvement Inc.' });
    expect(S().job).toEqual({ proposal: '42145', customer: 'Salamon Home Improvement Inc.', address: '' });
    const saved = JSON.parse(JSON.stringify({ ...S(), pdfDoc: null }));
    S().newProject();
    S().loadSnapshot(saved);
    expect(S().job.proposal).toBe('42145');
    S().loadSnapshot({ id: 'old', rooms: [], materials: [], markups: [] });   // saved before job info existed
    expect(S().job).toEqual({ proposal: '', customer: '', address: '' });
    S().loadCloudDoc({ id: 'c', name: 'X', unit_system: 'imperial_ft_in', doc: { job: { address: '24 Truman' } } });
    expect(S().job).toEqual({ proposal: '', customer: '', address: '24 Truman' });
  });
});
