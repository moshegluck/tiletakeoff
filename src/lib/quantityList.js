// ============================================================
// quantityList.js — Artistic's TILE QUANTITY LIST (the ordering document),
// built to the current standard of Moshe's artistic-quantity-sheet skill:
// maroon title band (logo at B1, TILE QUANTITY LIST centred in C1:E3),
// lavender job band (project · proposal #, customer · site address, date),
// purple header row (Location | Item | Unit | Count | Waste % | Total |
// On Order | Difference), a purple band per plan page and a lavender band
// per room carrying the proposal-style room header, one line per tiled
// surface. Nothing below the title block is merged, so the AutoFilter on
// row 8 works (the sheet gets filtered by SKU to total an order).
//
// Count is the takeoff number before waste — the estimate's arithmetic
// (engine/takeoffRules.js), shown as a cell note. Total =
// ROUNDUP(Count × (1 + Waste), 1). The total band sums SF rows only
// (SUMIF on Unit), so LF listello never adds to square feet. The Item names
// a product the store can pull (size + type, never "large" / "rectified");
// no tile picked → NA. Labor (niches, window cuts…) is not in it.
// ============================================================

import { floorTakeoff, wallTakeoff, wallTileHeight, roomFixtures, roundUp } from '../engine/takeoffRules.js';
import { roomRegions } from '../engine/zones.js';
import { roomPattern } from '../engine/patterns.js';
import { roomTypeOf } from '../engine/trace/analyze.js';
import { takeoffPages, markContext, roomMarks } from './markedPdf.js';

const n2 = (x) => String(+(+x).toFixed(2));
const ftTxt = (h) => (Math.abs(h - Math.round(h)) < 0.01 ? `${Math.round(h)}'` : `${n2(h)}'`);
/** Total = ROUNDUP(Count × (1 + Waste), 1), as the sheet's formula has it. */
export const orderTotal = (count, waste) => Math.max(0, Math.ceil(count * (1 + waste) * 10 - 1e-6) / 10);
/** A border band this narrow is a listello / strip: ordered by the LF. */
export const LISTELLO_MAX_FT = 0.5;
const MOSAIC = /mosaic|pebble|penny|subway|hex/i;
const PATTERNED = /herringbone|chevron|basketweave|versailles|pinwheel/i;

/**
 * Waste (a fraction) by Moshe's current table, first matching row wins:
 * 48X48 in a bath 35% · any other tile in a bath (and an NA line there) 25% ·
 * 48X48 elsewhere 25% · other large format (24X48, 36X36, 12X36, 10X30,
 * 8X48 / 9X48 plank) 22% · mosaic / pebble / 3X12 subway 15% · 24X24 /
 * 12X24 in open areas 20% · herringbone / patterned layouts 15% · shower
 * floors 15% · borders / listello 10% · default 10%.
 * @param {'floor'|'wall'|'shower'|'border'} surface
 * @param {object|null} m material (null = no tile picked)
 * @param {string} roomType
 * @param {string} [pattern] the layout the room lays it in
 */
export function artisticWaste(surface, m, roomType, pattern = 'grid') {
  if (surface === 'border') return 0.10;
  if (surface === 'shower') return 0.15;
  const a = Math.max(+m?.tw || 0, +m?.th || 0), b = Math.min(+m?.tw || 0, +m?.th || 0);
  const sized = a > 0 && b > 0;
  const xl = sized && b >= 48;
  if (roomType === 'bath') return xl ? 0.35 : 0.25;
  if (!sized) return 0.10;
  if (xl) return 0.25;
  if (a >= 30) return 0.22;
  if (MOSAIC.test(m?.name || '') || b <= 4) return 0.15;
  if (a >= 24 && b >= 12) return 0.20;
  if (PATTERNED.test(pattern || '')) return 0.15;
  return 0.10;
}

/**
 * The Item cell — a product the store can order: size + type in caps
 * ("24X48 FLOOR TILE", "16X48 WALL TILE", "12X12 PEBBLES (254)", "3X12
 * SUBWAY"), never an install label. No tile picked (or no size) → NA.
 */
export function itemText(m) {
  if (!m || !(+m.tw > 0) || !(+m.th > 0)) return 'NA';
  const size = `${n2(m.tw)}X${n2(m.th)}`;
  const name = String(m.name || '');
  const type = /pebble/i.test(name) ? 'PEBBLES' : /subway/i.test(name) ? 'SUBWAY' : MOSAIC.test(name) ? 'MOSAIC'
    : /listello/i.test(name) ? 'LISTELLO' : m.type === 'wall' ? 'WALL TILE' : 'FLOOR TILE';
  return `${size} ${type}${m.sku ? ` (${String(m.sku).toUpperCase()})` : ''}`;
}

/**
 * The quantity list of the whole job, page by page (pure; tested).
 * floorSf / wallSf are the Floor… / Wall… rows (they tie to the proposal's
 * office-use note); shower floors, borders and listello sit outside both.
 */
export function quantityList(st) {
  const pages = takeoffPages(st);
  const ctx = markContext(st, pages.flatMap((p) => p.rooms));
  const mat = (id) => st.materials.find((m) => m.id === id) || null;
  const rows = [];
  const sum = { floorSf: 0, wallSf: 0, showerSf: 0, borderSf: 0, lf: 0 };
  const naRooms = [];
  for (const p of pages) {
    const pageRows = [];
    for (const r of p.rooms) {
      const type = r.roomType && r.roomType !== 'nofloor' ? r.roomType : roomTypeOf(r.name);
      const lines = [];
      const fx = roomFixtures(r);
      if (ctx.allFloor) {
        // nothing picked yet: the takeoff of what was traced, tile to be picked
        const f = floorTakeoff(r);
        lines.push({ loc: 'Floor', item: 'NA', unit: 'SF', count: f.sf, waste: artisticWaste('floor', null, type), math: f.text, kind: 'floor' });
      } else {
        const floorMats = (r.assigned || []).map(mat).filter((m) => m && m.type !== 'wall');
        const reg = floorMats.length || (r.zones || []).some((z) => z.materialId) ? roomRegions(r) : null;
        for (const m of floorMats) {
          const f = floorTakeoff(r, reg?.fieldArea);
          lines.push({ loc: 'Floor', item: itemText(m), unit: 'SF', count: f.sf, waste: artisticWaste('floor', m, type, roomPattern(r, m)), math: f.text, kind: 'floor' });
        }
        for (const z of reg ? reg.inlays : []) {
          const m = mat(z.zone.materialId);
          if (!m) continue;
          lines.push({ loc: `Floor — ${z.zone.name} (inlay)`, item: itemText(m), unit: 'SF', count: roundUp(z.area), waste: artisticWaste('floor', m, type, z.zone.layout?.pattern || m.pattern), math: `${n2(z.area)} SF inlay`, kind: 'floor' });
        }
        for (const b of reg ? reg.bands : []) {
          const m = mat(b.zone.materialId);
          if (!m) continue;
          const w = b.zone.width || 0;
          lines.push((w <= LISTELLO_MAX_FT + 1e-9)
            ? { loc: `Listello — ${b.zone.name} (${n2(b.lf)} LF)`, item: itemText(m), unit: 'LF', count: roundUp(b.lf), waste: 0.10, math: `${n2(b.lf)} LF along the walls`, kind: 'lf' }
            : { loc: `Border — ${b.zone.name} (${n2(b.lf)} LF × ${n2(w * 12)}")`, item: itemText(m), unit: 'SF', count: roundUp(b.area), waste: 0.10, math: `${n2(b.area)} SF band, ${n2(w * 12)}" wide`, kind: 'border' });
        }
      }
      for (const s of fx.showers) {
        lines.push({ loc: `Shower Floor (${n2(s.w)}x${n2(s.d)})`, item: 'NA', unit: 'SF', count: roundUp(s.w * s.d), waste: artisticWaste('shower', null, type), math: `${n2(s.w)} × ${n2(s.d)} = ${n2(s.w * s.d)}`, kind: 'shower' });
      }
      for (const m of (r.assigned || []).map(mat).filter((x) => x && x.type === 'wall')) {
        const h = wallTileHeight(r);
        const w = wallTakeoff(r, h);
        const full = h >= (r.wallHeight ?? 8) - 1e-6;
        lines.push({ loc: full ? 'Wall' : `Wall — ${ftTxt(h)} high`, item: itemText(m), unit: 'SF', count: w.sf, waste: artisticWaste('wall', m, type, roomPattern(r, m)), math: w.text.replace(/ · .*$/, ''), kind: 'wall' });
      }
      if (!lines.length) continue;
      // the room header as the proposal writes it: dims, shower, ceiling, scope
      pageRows.push({ type: 'sub', text: roomMarks(r, ctx).header });
      for (const l of lines) {
        pageRows.push({ type: 'line', ...l });
        sum[{ floor: 'floorSf', wall: 'wallSf', shower: 'showerSf', border: 'borderSf', lf: 'lf' }[l.kind]] += l.count;
      }
      if (lines.some((l) => l.item === 'NA')) naRooms.push(r.name);
    }
    if (pageRows.length) rows.push({ type: 'major', text: `PAGE ${p.page}` }, ...pageRows);
  }
  const job = st.job || {};
  return {
    project: st.name || 'Takeoff', proposal: job.proposal || '',
    customer: [job.customer, job.address].map((x) => String(x || '').trim()).filter(Boolean).join('  ·  '),
    rows, ...sum, naRooms,
  };
}

// ---- the workbook (the builder's layout, colours and widths) ----------
const MAROON = 'FF5C1A3A', PURPLE = 'FF6B2D5C', LAV = 'FFC9B3C2', LTLAV = 'FFEDE3EA', DARK = 'FF3A2230', WHITE = 'FFFFFFFF';
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const arial = (size, extra = {}) => ({ name: 'Arial', size, ...extra });
const WIDTHS = [2.4, 34, 50, 6, 9, 15.3, 10, 11, 11];

/**
 * Write the quantity list into an ExcelJS workbook.
 * @param {any} ExcelJS  the exceljs module
 * @param {ReturnType<typeof quantityList>} q
 * @param {{ date?: string, logo?: ArrayBuffer|Uint8Array|null }} [opt]
 */
export function quantityWorkbook(ExcelJS, q, { date = new Date().toLocaleDateString('en-US'), logo = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TileTakeoff';
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet('Tile Quantity List');
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  // a band is a fill across B:I with the text in B — never merged
  const band = (r, argb) => { for (let c = 2; c <= 9; c++) ws.getCell(r, c).fill = solid(argb); };
  const thin = { style: 'thin', color: { argb: 'FFD9CBD4' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };

  // title block (rows 1-3): logo at B1, the title centred in C1:E3, F1:I3 empty
  for (const r of [1, 2, 3]) { ws.getRow(r).height = 19.5; band(r, MAROON); }
  ws.mergeCells('C1:E3');
  Object.assign(ws.getCell('C1'), {
    value: 'TILE QUANTITY LIST', font: { name: 'Calibri', size: 28, bold: true, color: { argb: WHITE } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  });
  ws.mergeCells('F1:I3');
  if (logo) {
    const id = wb.addImage({ buffer: logo, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 0 }, ext: { width: Math.round(72 * 600 / 214), height: 72 } });
  }
  ws.getRow(4).height = 6;

  // job band (rows 5-6)
  for (const r of [5, 6]) band(r, LAV);
  ws.getRow(6).height = 18;
  Object.assign(ws.getCell('B5'), { value: 'ARTISTIC TILE INSTALLATION   ·   191 NY-59, Monsey NY', font: arial(10, { bold: true, color: { argb: MAROON } }) });
  Object.assign(ws.getCell('B6'), { value: `Project: ${q.project}  ·  Proposal #${q.proposal || ''}`, font: arial(10, { bold: true, color: { argb: DARK } }) });
  Object.assign(ws.getCell('C6'), { value: `Customer: ${q.customer || ''}`, font: arial(10, { color: { argb: DARK } }) });
  Object.assign(ws.getCell('G6'), { value: 'Date:', font: arial(9, { bold: true, color: { argb: DARK } }) });
  Object.assign(ws.getCell('H6'), { value: date, font: arial(10, { bold: true, color: { argb: 'FF000000' } }) });

  // header row 8
  ws.getRow(8).height = 24;
  ['Location', 'Item', 'Unit', 'Count', 'Waste %', 'Total', 'On Order', 'Difference'].forEach((h, i) => {
    Object.assign(ws.getCell(8, i + 2), {
      value: h, font: arial(10, { bold: true, color: { argb: WHITE } }), fill: solid(PURPLE),
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    });
  });

  const first = 9;
  let r = first;
  const sf = { E: 0, G: 0 };
  for (const row of q.rows) {
    if (row.type === 'major' || row.type === 'sub') {
      const major = row.type === 'major';
      band(r, major ? PURPLE : LTLAV);
      Object.assign(ws.getCell(r, 2), { value: row.text, font: arial(major ? 11 : 10, { bold: true, color: { argb: major ? WHITE : MAROON } }) });
    } else {
      const total = orderTotal(row.count, row.waste);
      if (row.unit === 'SF') { sf.E += row.count; sf.G += total; }
      ws.getRow(r).height = 15;
      const cells = [
        [row.loc, arial(10)], [row.item, arial(9)], [row.unit, arial(10)], [row.count, arial(10)], [row.waste, arial(10)],
        [{ formula: `ROUNDUP(E${r}*(1+F${r}),1)`, result: total }, arial(10, { bold: true })],
        [null, arial(10)], [{ formula: `IF(H${r}="","",H${r}-G${r})`, result: '' }, arial(10)],
      ];
      cells.forEach(([value, font], i) => {
        const c = ws.getCell(r, i + 2);
        if (value != null) c.value = value;
        c.font = font; c.border = box;
      });
      ws.getCell(r, 6).numFmt = '0%';
      if (row.math) ws.getCell(r, 5).note = row.math;
    }
    r++;
  }
  const last = r - 1;
  ws.autoFilter = `B8:I${last}`;

  // total band: SF rows only (listello / trim in LF never adds to square feet)
  band(r, MAROON);
  Object.assign(ws.getCell(r, 2), { value: 'TOTAL — ALL TILE (SF)', font: arial(11, { bold: true, color: { argb: WHITE } }) });
  for (const col of ['E', 'G', 'H']) {
    Object.assign(ws.getCell(`${col}${r}`), {
      value: { formula: `SUMIF($D$${first}:$D$${last},"SF",${col}${first}:${col}${last})`, result: col === 'H' ? 0 : Math.round(sf[col] * 10) / 10 },
      font: arial(11, { bold: true, color: { argb: WHITE } }),
    });
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 8, topLeftCell: 'B9' }];
  ws.pageSetup.printArea = `A1:I${r}`;
  ws.pageSetup.fitToPage = true; ws.pageSetup.fitToWidth = 1; ws.pageSetup.fitToHeight = 0;
  return wb;
}

/** Build and download "<Project> Tile Quantity List.xlsx". */
export async function downloadQuantityList(st) {
  const q = quantityList(st);
  if (!q.rows.length) throw new Error('Nothing tiled yet — trace or draw rooms first');
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const logo = await fetch('/artistic-logo.png').then((x) => (x.ok ? x.arrayBuffer() : null)).catch(() => null);
  const buf = await quantityWorkbook(ExcelJS, q, { logo }).xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${q.project} Tile Quantity List.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return q;
}
