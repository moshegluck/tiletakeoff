import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { quantityList, quantityWorkbook, artisticWaste, itemText } from '../src/lib/quantityList.js';
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

describe('Tile Quantity List (Artistic ordering document)', () => {
  it('lists page → room → each tiled surface, with the takeoff count before waste', () => {
    const q = quantityList(st);
    const text = q.rows.map((r) => (r.type === 'line' ? `  ${r.loc} | ${r.item} | ${r.unit} | ${r.count} | ${r.waste}` : `${r.type}: ${r.text}`));
    expect(text).toEqual([
      'major: PAGE 1',
      'sub: LAUNDRY',
      '  Floor | 24X24 RECTIFIED FLOOR TILE | SF | 100 | 0.2',
      'major: PAGE 3',
      'sub: GUEST SHOWER BATHROOM',
      '  Floor | 24X24 RECTIFIED FLOOR TILE | SF | 33 | 0.25',
      '  Shower Floor 5x2.75 | SHOWER FLOOR TILE | SF | 14 | 0.15',
      '  Wall | 12X24 WALL TILE | SF | 271 | 0.25',
      'sub: FOYER',
      expect.stringMatching(/^ {2}Floor \| 24X24 RECTIFIED FLOOR TILE \| SF \| \d+ \| 0\.2$/),
      expect.stringMatching(/^ {2}Border \/ Listello \| 2X12 LISTELLO \| LF \| \d+ \| 0\.1$/),
      'sub: KITCHEN',
      '  Floor | 24X24 RECTIFIED FLOOR TILE | SF | 120 | 0.2',
      "  Wall — 1.5' high | 3X12 SUBWAY | SF | 66 | 0.15",
    ]);
    // the bedroom has no tile: it is not in the ordering document
    expect(q.rows.some((r) => r.text === 'BEDROOM')).toBe(false);
    // the arithmetic rides along (a cell note on Count)
    const wall = q.rows.find((r) => r.loc === 'Wall');
    expect(wall.math).toBe("28.5 LF × 10' = 285 − 14 (door) = 271 → 271 SF");
  });

  it('agrees with the estimate: floor rows = floor tile net SF, wall rows = wall tile net SF', () => {
    const q = quantityList(st);
    const e = estimateProject(wholeProject(st));
    const net = (type) => e.lines.filter((l) => (l.material.type === 'wall') === (type === 'wall')).reduce((a, l) => a + l.netSf, 0);
    // the listello is ordered by the LF here; the estimate carries it as SF
    const listelloSf = e.lines.find((l) => l.material.id === 'L').netSf;
    expect(q.floorSf).toBe(net('floor') - listelloSf);
    expect(q.wallSf).toBe(net('wall'));
    expect(q.showerSf).toBe(14);
    expect(q.lf).toBeGreaterThan(0);
  });

  it("standard waste from Moshe's Truman list", () => {
    expect(artisticWaste('floor', mat('a', 'floor', '24X48', 24, 48), 'living')).toBe(0.25);   // large format anywhere
    expect(artisticWaste('floor', mat('a', 'floor', 'Plank', 8, 48), 'bedroom')).toBe(0.22);    // plank
    expect(artisticWaste('floor', mat('a', 'floor', 'Plank', 8, 48), 'bath')).toBe(0.22);
    expect(artisticWaste('floor', mat('a', 'floor', '12X24', 12, 24), 'bath')).toBe(0.25);      // bathroom floors & walls
    expect(artisticWaste('wall', mat('a', 'wall', 'Subway', 3, 12), 'bath')).toBe(0.25);
    expect(artisticWaste('wall', mat('a', 'wall', 'Subway', 3, 12), 'kitchen')).toBe(0.15);     // subway
    expect(artisticWaste('floor', mat('a', 'floor', '12X12 Pebbles', 12, 12), 'hall')).toBe(0.15); // mosaic / pebbles
    expect(artisticWaste('floor', mat('a', 'floor', '12X24', 12, 24), 'hall')).toBe(0.2);       // open-area rectified
    expect(artisticWaste('shower', null, 'bath')).toBe(0.15);
    expect(artisticWaste('border', null, 'hall')).toBe(0.1);
  });

  it('the Item is the tile spec in caps', () => {
    expect(itemText(mat('a', 'floor', 'Floor Tile', 12, 12))).toBe('12X12 FLOOR TILE');
    expect(itemText(mat('a', 'floor', '12x12 Pebbles', 12, 12, { sku: '254' }))).toBe('12X12 PEBBLES (254)');
    expect(itemText(mat('a', 'floor', '8 × 48 plank', 8, 48))).toBe('8X48 PLANK');
    expect(itemText(null)).toBe('TILE NOT PICKED');
  });

  it('before any tile is picked, every traced room is a floor line (tile to be picked)', () => {
    const bare = { ...st, materials: [], rooms: st.rooms.map((r) => ({ ...r, assigned: [], zones: [] })), pageData: {} };
    const q = quantityList(bare);
    expect(q.rows.filter((r) => r.type === 'sub').length).toBe(4);
    expect(q.rows.find((r) => r.loc === 'Floor').item).toBe('TILE NOT PICKED');
    expect(q.rows.find((r) => r.type === 'line' && r.loc === 'Floor').waste).toBe(0.25); // the bath first
  });

  it('writes the sheet in the Artistic layout: bands, header, ROUNDUP totals, separate SF / LF totals', async () => {
    const q = quantityList(st);
    const wb = quantityWorkbook(ExcelJS, q, { date: '10/16/2026' });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await wb.xlsx.writeBuffer());
    const ws = back.getWorksheet('Tile Quantity List');
    expect(ws).toBeTruthy();
    expect(ws.getCell('F1').value).toBe('TILE QUANTITY LIST');
    expect(ws.getCell('B1').fill.fgColor.argb).toBe('FF5C1A3A');
    expect(ws.getCell('B5').fill.fgColor.argb).toBe('FFC9B3C2');
    expect(ws.getCell('B6').value).toBe('Project: Willow Tree');
    expect(ws.getCell('H6').value).toBe('10/16/2026');
    expect([2, 3, 4, 5, 6, 7, 8, 9].map((c) => ws.getCell(8, c).value)).toEqual(['Location', 'Item', 'Unit', 'Count', 'Waste %', 'Total', 'On Order', 'Difference']);
    expect(ws.getCell('B8').fill.fgColor.argb).toBe('FF6B2D5C');
    expect(ws.getCell('B9').value).toBe('PAGE 1');
    expect(ws.getCell('B9').fill.fgColor.argb).toBe('FF6B2D5C');
    expect(ws.getCell('B10').value).toBe('LAUNDRY');
    expect(ws.getCell('B10').fill.fgColor.argb).toBe('FFEDE3EA');
    // a line: count, waste as a fraction shown as %, total = ROUNDUP(count × (1 + waste))
    expect(ws.getCell('E11').value).toBe(100);
    expect(ws.getCell('F11').value).toBe(0.2);
    expect(ws.getCell('F11').numFmt).toBe('0%');
    expect(ws.getCell('G11').value).toMatchObject({ formula: 'ROUNDUP(E11*(1+F11),0)', result: 120 });
    expect(ws.getCell('I11').value).toMatchObject({ formula: 'IF(H11="","",H11-G11)' });
    expect(ws.getCell('H11').value).toBe(null);
    // the bath wall: 271 × 1.25 = 338.75 → 339, with the arithmetic as a note
    const wallRow = [...Array(ws.rowCount).keys()].map((i) => i + 1).find((r) => ws.getCell(r, 2).value === 'Wall');
    expect(ws.getCell(wallRow, 7).value.result).toBe(339);
    expect(JSON.stringify(ws.getCell(wallRow, 5).note)).toContain('28.5 LF');
    // totals: SF and LF in their own bands
    const labels = [...Array(ws.rowCount).keys()].map((i) => ws.getCell(i + 1, 2).value);
    const sfRow = labels.indexOf('TOTAL — ALL TILE (SF)') + 1, lfRow = labels.indexOf('TOTAL — LF ITEMS') + 1;
    expect(sfRow).toBeGreaterThan(0);
    expect(lfRow).toBe(sfRow + 1);
    expect(ws.getCell(sfRow, 5).value.result).toBe(q.floorSf + q.wallSf + q.showerSf);
    expect(ws.getCell(lfRow, 5).value.result).toBe(q.lf);
    const listelloRow = labels.indexOf('Border / Listello') + 1;
    expect(ws.getCell(lfRow, 5).value.formula).toBe(`E${listelloRow}`);
    expect(ws.getCell(sfRow, 5).value.formula.split('+')).not.toContain(`E${listelloRow}`);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 8 });
  });
});
