import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildProposal, proposalWorkbook, officeUse, installTier, tileLines, ARTISTIC_RATES } from '../src/lib/proposal.js';
import { wallParts, wetRun } from '../src/engine/takeoffRules.js';
import { quantityList } from '../src/lib/quantityList.js';
import { summarize } from '../src/lib/markedPdf.js';
import { estimateProject } from '../src/engine/estimate.js';

// Proposal #41765 (110 E Willow Tree) is the answer key: the rooms below are
// its bathrooms and dining room with the tile sizes of its selection sheet.
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const room = (name, pts, extra = {}) => ({ id: name, name, points: pts, assigned: [], ...extra });
const mat = (id, type, name, tw, th) => ({ id, type, name, tw, th, grout: 0.125, pattern: 'grid', waste: 10, price: 0, priceUnit: 'sf', sfPerBox: 15 });

const MATS = [
  mat('F24', 'floor', '24X24 floor', 24, 24), mat('F1224', 'floor', '12X24 floor', 12, 24), mat('F48', 'floor', '48X48 floor', 48, 48),
  mat('W24', 'wall', '24X24 wall', 24, 24), mat('W1240', 'wall', '12X40 wall', 12, 40), mat('W1224', 'wall', '12X24 wall', 12, 24),
  mat('W1235', 'wall', '12X35 wall', 12, 35), mat('W1848', 'wall', '18X48 wall', 18, 48), mat('MOS', 'wall', '2X2 mosaic', 2, 2),
];
const GUEST = room('GUEST SHOWER BATHROOM', sq(0, 0, 9.25, 5), {
  assigned: ['F24', 'W24', 'W1240'], wallHeight: 10, finish: { wetWallMaterialId: 'W1240' },
  fixtures: { doors: 1, showers: [{ w: 5, d: 2.75 }], seats: 1, windows: [{ w: 5.75, h: 6.25 }] },
});
const TUB4 = room('TUB BATHROOM #4', sq(20, 0, 10, 5), { assigned: ['F1224', 'W1224', 'W1235'], wallHeight: 9, fixtures: { doors: 1, tubs: 1 } });
const TUB5 = room('TUB BATHROOM #5', sq(40, 0, 10, 5), { assigned: ['F24', 'W1848'], wallHeight: 9, fixtures: { doors: 1, tubs: 1 } });
const DINING = room('DINING ROOM', sq(60, 0, 18, 18), { assigned: ['F48'] });
const st = {
  name: 'Willow Tree', unitSystem: 'imperial_ft_in', materials: MATS, pdfPage: 1, scale: 1 / 36,
  job: { proposal: '41765', customer: 'Salamon Home Improvement Inc.', address: '110 E Willow Tree' },
  rooms: [GUEST, TUB4, TUB5, DINING], markups: [], pageData: {},
};
const roomLines = (q, name) => {
  const i = q.rows.findIndex((r) => r.type === 'sub' && r.text.startsWith(name));
  const out = [];
  for (let k = i + 1; k < q.rows.length && q.rows[k].type === 'line'; k++) out.push(q.rows[k]);
  return out;
};
const brief = (l) => `${l.desc} | ${l.qty} | ${l.item} | ${l.rate}`;

describe('wall split: a bath\'s shower / tub walls in their own tile (Willow Tree #41765)', () => {
  it('shower walls = (W + 2·D) × ceiling; the rest carries the door', () => {
    expect(wetRun(GUEST).lf).toBeCloseTo(10.5, 6);
    const [wet, rest] = wallParts(GUEST, ['W24', 'W1240'], 10);
    expect(wet).toMatchObject({ materialId: 'W1240', part: 'wet', label: 'Shower walls', sf: 105 });
    expect(rest).toMatchObject({ materialId: 'W24', part: 'rest', sf: 166 });
    expect(wet.text).toBe("5 + 2×2.75 = 10.5 LF × 10' = 105 → 105 SF");
    expect(rest.text).toBe("(28.5 − 10.5) LF × 10' = 180 − 14 (door) = 166 → 166 SF");
  });

  it('tub walls = 10 LF × ceiling; the 10 SF tub deduction comes off the rest; second tile picked is the tub walls by default', () => {
    const [wet, rest] = wallParts(TUB4, ['W1224', 'W1235'], 9);
    expect(wet).toMatchObject({ materialId: 'W1235', label: 'Tub walls', sf: 90 });
    expect(rest).toMatchObject({ materialId: 'W1224', sf: 156 });
    // one wall tile: the whole wall with every deduction
    expect(wallParts(TUB5, ['W1848'], 9)).toEqual([expect.objectContaining({ part: 'all', sf: 246 })]);
  });

  it('the estimate, the quantity list and the marked-up plan count each part once', () => {
    const e = estimateProject(st);
    const line = (id) => e.lines.find((l) => l.materialId === id || l.material?.id === id || l.name === MATS.find((m) => m.id === id).name);
    expect(line('W1240').netSf).toBe(105);
    expect(line('W24').netSf).toBe(166);
    const q = quantityList(st);
    const guest = roomLines(q, 'GUEST');
    expect(guest.filter((l) => l.kind === 'wall').map((l) => `${l.loc} ${l.count}`)).toEqual(['Shower walls 105', 'Rest of Walls 166']);
    const sum = summarize(st);
    const g = sum.pages[0].rooms.find((r) => r.name.startsWith('GUEST'));
    expect(g.wallSf).toBe(271);
    expect(g.lines.filter((l) => /walls/i.test(l.label)).map((l) => l.qty)).toEqual([105, 166]);
  });
});

describe('Artistic proposal (priced, QuickBooks-style)', () => {
  it('prices the guest bath line by line like #41765', () => {
    const q = buildProposal(st);
    expect(roomLines(q, 'GUEST').map(brief)).toEqual([
      'Floor Tile Install 24X24 | 33 | Rectified | 7.75',
      'Install standard shower floor (14sf) | 1 | Shower Fl | 185',
      'Install large wall tile 12X40 - SHOWER WALLS | 105 | Large wall tile | 8.75',
      'Wall Tile Install 24X24 - REST OF WALLS | 166 | Rectified W | 7.75',
      'Labor to cut tiles around window (5.75x6.25) | 1 | Window | 145',
      'Niche in shower | 1 | Niche | 145',
      'Custom shower seat | 1 | Shower Seat | 250',
      '*OPTIONAL* 45 Miter cut corner with epoxy for niche & window (per lf) | 30.25 | Miter LF | 65',
    ]);
    expect(q.rows.find((r) => r.type === 'sub' && r.text.startsWith('GUEST')).text).toBe("GUEST SHOWER BATHROOM (9.25x5 sf5x2.75) 10' ceiling - fully tiled");
  });

  it('tub baths, the x-large upcharge, Ram Board at 0.00 and the office calc', () => {
    const q = buildProposal(st);
    expect(roomLines(q, 'TUB BATHROOM #4').map(brief)).toEqual([
      'Floor Tile Install 12X24 | 40 | Rectified | 7.75',
      'Install large wall tile 12X35 - TUB WALLS | 90 | Large wall tile | 8.75',
      'Wall Tile Install 12X24 - REST OF WALLS | 156 | Rectified W | 7.75',
      'Niche in tub | 1 | Niche | 145',
      '*OPTIONAL* 45 Miter cut corner with epoxy for niche (per lf) | 6.25 | Miter LF | 65',
    ]);
    expect(roomLines(q, 'TUB BATHROOM #5').map(brief)).toEqual([
      'Floor Tile Install 24X24 | 40 | Rectified | 7.75',
      'Install large wall tile 18X48 | 246 | Large wall tile | 8.75',
      'Niche in tub | 1 | Niche | 145',
      '*OPTIONAL* 45 Miter cut corner with epoxy for niche (per lf) | 6.25 | Miter LF | 65',
    ]);
    expect(roomLines(q, 'DINING').map(brief)).toEqual([
      'Install large floor tile 48X48 | 324 | Large floor tile | 8.75',
      'Upcharge for x-large format tiles 48X48 | 324 | Upcharge X Large | 2',
    ]);
    // floors: 33 + 40 + 40 + 324; walls 105 + 166 + 90 + 156 + 246
    expect(q.floorSf).toBe(437);
    expect(q.wallSf).toBe(763);
    const ram = q.rows.find((r) => r.item === 'Ram Board');
    expect(ram).toMatchObject({ qty: 437, rate: 0, optional: true });
    expect(ram.desc).toBe('*OPTIONAL* Cover floors with ram-board as protection for tiles $0.95 per sf = $415.15');
    expect(q.office).toMatch(/\(total f437sf w763sf\)$/);
    // the subtotal is the sum of rate × qty (optional lines included, as on #41765)
    const sum = q.rows.filter((r) => r.type === 'line').reduce((a, r) => a + r.qty * (r.rate || 0), 0);
    expect(q.subtotal).toBeCloseTo(sum, 6);
    expect(q.flags).toEqual([]);
  });

  it("the office calc reproduces #41765's numbers from its totals", () => {
    expect(officeUse(1772, 1406)).toBe('*FOR OFFICE USE* Sand 12 yards / Portland 57 bags / Wire Mesh 13 bundles / Black Felt 7 rolls / Thinset Floors 28 bags / Thinset Walls 39 bags / Ram Board 7 rolls / Tape 4 rolls (total f1772sf w1406sf)');
  });

  it('never guesses a price: no tile picked, or a size off the rate card, gets no rate and a flag', () => {
    expect(installTier({ tw: 12, th: 24 })).toEqual({ tier: 'rectified', xl: false });
    expect(installTier({ tw: 24, th: 48 })).toEqual({ tier: 'large', xl: false });
    expect(installTier({ tw: 48, th: 48 })).toEqual({ tier: 'large', xl: true });
    expect(tileLines('wall', { tw: 2, th: 2 }, 50)[0]).toMatchObject({ rate: null, flag: '2X2 is not on the rate card' });
    // (no floor tile picked anywhere: every floor counts, flagged unpriced)
    const q = buildProposal({ ...st, rooms: [room('POWDER', sq(0, 0, 5, 8), { assigned: ['MOS'], fixtures: { doors: 1 } })] });
    expect(q.flags).toEqual(['POWDER: floor tile not picked', 'POWDER: 2X2 is not on the rate card']);
    expect(q.rows.filter((r) => r.type === 'line' && r.rate == null).length).toBe(2);
    // a window the trace found has a width but no height: cut charged, miter asks for its size
    const w = buildProposal({ ...st, rooms: [{ ...TUB5, wallLf: 30, openings: [{ type: 'window', width: 3 }] }] });
    expect(roomLines(w, 'TUB BATHROOM #5').map((l) => l.desc)).toContain("Labor to cut tiles around window (3' wide)");
    expect(w.flags).toEqual(['TUB BATHROOM #5: window size (W x H) needed for the miter']);
  });

  it('writes the workbook: Total = qty × rate per line, Subtotal / Sales Tax 0.00% / TOTAL', async () => {
    const q = buildProposal(st);
    const wb = proposalWorkbook(ExcelJS, q, { date: '10/16/2026' });
    const buf = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    const ws = back.getWorksheet('Proposal');
    expect(ws.getCell('C1').value).toBe('PROPOSAL');
    expect(ws.getCell('B6').value).toBe('Project: Willow Tree  ·  Proposal #41765  ·  Customer: Salamon Home Improvement Inc.  ·  110 E Willow Tree');
    expect(['B8', 'C8', 'D8', 'E8', 'F8'].map((c) => ws.getCell(c).value)).toEqual(['Description', 'SF/LF/PC', 'Item', 'Rate', 'Total']);
    let total = null, sub = null;
    ws.eachRow((row, n) => {
      const b = row.getCell(2).value;
      if (b === 'Subtotal') sub = n;
      if (b === 'TOTAL') total = n;
      if (n > 8 && sub == null && row.getCell(6).value?.formula) expect(row.getCell(6).value.formula).toBe(`C${n}*E${n}`);
    });
    expect(ws.getCell(sub, 6).value.formula).toBe('SUM(F9:F' + (sub - 1) + ')');
    expect(ws.getCell(sub, 6).value.result).toBeCloseTo(q.subtotal, 6);
    expect(ws.getCell(sub + 1, 2).value).toBe('Sales Tax (0.00%)');
    expect(ws.getCell(total, 6).value.formula).toBe(`F${sub}+F${sub + 1}`);
    expect(ARTISTIC_RATES.miter).toBe(65);
  });
});
