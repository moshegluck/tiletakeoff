// ============================================================
// quantityList.js — Artistic's TILE QUANTITY LIST (the ordering document),
// as Moshe builds it: maroon title band with the logo, lavender job band,
// purple header row (Location | Item | Unit | Count | Waste % | Total |
// On Order | Difference), a purple band per plan page, a lavender band per
// room, one line per tiled surface. Count is the takeoff number before
// waste (the same arithmetic as the estimate, engine/takeoffRules.js, shown
// as a cell note); Total = ROUNDUP(Count × (1 + Waste), 0); On Order is left
// for Moshe. SF and LF get separate total bands — they never add up.
// Labor-only items (window cuts, niches…) are not in it.
// ============================================================

import { floorTakeoff, wallTakeoff, wallTileHeight, roomFixtures, roundUp } from '../engine/takeoffRules.js';
import { roomRegions } from '../engine/zones.js';
import { roomTypeOf } from '../engine/trace/analyze.js';
import { takeoffPages, markContext } from './markedPdf.js';

const n2 = (x) => String(+(+x).toFixed(2));
const ftTxt = (h) => (Math.abs(h - Math.round(h)) < 0.01 ? `${Math.round(h)}'` : `${n2(h)}'`);
/** A border band this narrow is a listello / strip: ordered by the LF. */
export const LISTELLO_MAX_FT = 0.5;

/**
 * Standard waste (a fraction) by surface and tile, from Moshe's Truman list:
 * borders 10%; shower floors 15%; large format (24X48, 36X36, 48X48) 25%
 * anywhere; 8X48 plank 22%; bathroom floors and walls 25%; subway /
 * mosaic / pebbles 15%; open-area floors 20%; other walls 25%.
 * @param {'floor'|'wall'|'shower'|'border'} surface
 * @param {object|null} m material
 * @param {string} roomType
 */
export function artisticWaste(surface, m, roomType) {
  if (surface === 'border') return 0.10;
  if (surface === 'shower') return 0.15;
  const a = Math.max(+m?.tw || 0, +m?.th || 0), b = Math.min(+m?.tw || 0, +m?.th || 0);
  if (a >= 36 && b >= 24) return 0.25;
  if (a >= 36 && b > 0 && a / b >= 4) return 0.22;
  if (roomType === 'bath') return 0.25;
  if (/mosaic|pebble|penny|subway|hex/i.test(m?.name || '') || (b > 0 && b <= 4)) return 0.15;
  return surface === 'floor' ? 0.20 : 0.25;
}

/** The Item cell: the tile spec in caps ("24X24 RECTIFIED FLOOR TILE", "12X12 PEBBLES (254)"). */
export function itemText(m) {
  if (!m) return 'TILE NOT PICKED';
  const name = String(m.name || '').trim().toUpperCase().replace(/\s*[×]\s*/g, 'X');
  const spec = /\d\s*X\s*\d/.test(name) ? name : `${n2(m.tw)}X${n2(m.th)} ${name || (m.type === 'wall' ? 'WALL TILE' : 'FLOOR TILE')}`;
  return m.sku ? `${spec} (${String(m.sku).toUpperCase()})` : spec;
}

/**
 * The quantity list of the whole job, page by page (pure; tested).
 * @returns {{ project:string, rows:any[], floorSf:number, wallSf:number, showerSf:number, lf:number }}
 */
export function quantityList(st) {
  const pages = takeoffPages(st);
  const ctx = markContext(st, pages.flatMap((p) => p.rooms));
  const mat = (id) => st.materials.find((m) => m.id === id) || null;
  const rows = [];
  let floorSf = 0, wallSf = 0, showerSf = 0, lf = 0;
  for (const p of pages) {
    const pageRows = [];
    for (const r of p.rooms) {
      const type = r.roomType && r.roomType !== 'nofloor' ? r.roomType : roomTypeOf(r.name);
      const lines = [];
      const fx = roomFixtures(r);
      if (ctx.allFloor) {
        // nothing picked yet: the takeoff of what was traced, tile to be picked
        const f = floorTakeoff(r);
        lines.push({ loc: 'Floor', item: itemText(null), unit: 'SF', count: f.sf, waste: artisticWaste('floor', null, type), math: f.text, kind: 'floor' });
      } else {
        const floorMats = (r.assigned || []).map(mat).filter((m) => m && m.type !== 'wall');
        const reg = floorMats.length || (r.zones || []).some((z) => z.materialId) ? roomRegions(r) : null;
        for (const m of floorMats) {
          const f = floorTakeoff(r, reg?.fieldArea);
          lines.push({ loc: 'Floor', item: itemText(m), unit: 'SF', count: f.sf, waste: artisticWaste('floor', m, type), math: f.text, kind: 'floor' });
        }
        for (const z of reg ? reg.inlays : []) {
          const m = mat(z.zone.materialId);
          if (!m) continue;
          lines.push({ loc: `Floor — ${z.zone.name}`, item: itemText(m), unit: 'SF', count: roundUp(z.area), waste: artisticWaste('floor', m, type), math: `${n2(z.area)} SF inlay`, kind: 'floor' });
        }
        for (const b of reg ? reg.bands : []) {
          const m = mat(b.zone.materialId);
          if (!m) continue;
          const strip = (b.zone.width || 0) <= LISTELLO_MAX_FT + 1e-9;
          lines.push(strip
            ? { loc: 'Border / Listello', item: itemText(m), unit: 'LF', count: roundUp(b.lf), waste: 0.10, math: `${n2(b.lf)} LF along the walls`, kind: 'lf' }
            : { loc: `Border / ${b.zone.name}`, item: itemText(m), unit: 'SF', count: roundUp(b.area), waste: 0.10, math: `${n2(b.lf)} LF × ${n2(b.zone.width)}' = ${n2(b.area)} SF`, kind: 'floor' });
        }
      }
      for (const s of fx.showers) {
        const sf = roundUp(s.w * s.d);
        lines.push({ loc: `Shower Floor ${n2(s.w)}x${n2(s.d)}`, item: 'SHOWER FLOOR TILE', unit: 'SF', count: sf, waste: artisticWaste('shower', null, type), math: `${n2(s.w)} × ${n2(s.d)} = ${n2(s.w * s.d)}`, kind: 'shower' });
      }
      for (const m of (r.assigned || []).map(mat).filter((x) => x && x.type === 'wall')) {
        const h = wallTileHeight(r);
        const w = wallTakeoff(r, h);
        const full = h >= (r.wallHeight ?? 8) - 1e-6;
        lines.push({ loc: full ? 'Wall' : `Wall — ${ftTxt(h)} high`, item: itemText(m), unit: 'SF', count: w.sf, waste: artisticWaste('wall', m, type), math: w.text.replace(/ · .*$/, ''), kind: 'wall' });
      }
      if (!lines.length) continue;
      pageRows.push({ type: 'sub', text: String(r.name || 'ROOM').toUpperCase() });
      for (const l of lines) {
        pageRows.push({ type: 'line', ...l });
        if (l.kind === 'floor') floorSf += l.count;
        else if (l.kind === 'wall') wallSf += l.count;
        else if (l.kind === 'shower') showerSf += l.count;
        else lf += l.count;
      }
    }
    if (pageRows.length) rows.push({ type: 'major', text: `PAGE ${p.page}` }, ...pageRows);
  }
  return { project: st.name || 'Takeoff', rows, floorSf, wallSf, showerSf, lf };
}

// ---- the workbook (Moshe's layout, colours and widths) ---------------
const MAROON = 'FF5C1A3A', PURPLE = 'FF6B2D5C', LAV = 'FFC9B3C2', LTLAV = 'FFEDE3EA', DARK = 'FF3A2230', WHITE = 'FFFFFFFF';
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const arial = (size, extra = {}) => ({ name: 'Arial', size, ...extra });
const WIDTHS = [2.4, 34, 50, 6, 9, 8.5, 10, 11, 11];

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
  const band = (r, argb) => { for (let c = 2; c <= 9; c++) ws.getCell(r, c).fill = solid(argb); };
  const thin = { style: 'thin', color: { argb: 'FFD9CBD4' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };

  // title band (rows 1-3): the logo left, TILE QUANTITY LIST right
  for (const r of [1, 2, 3]) { ws.getRow(r).height = 19.5; band(r, MAROON); }
  ws.mergeCells('F1:I3');
  Object.assign(ws.getCell('F1'), {
    value: 'TILE QUANTITY LIST', font: arial(22, { bold: true, color: { argb: WHITE } }),
    alignment: { horizontal: 'right', vertical: 'middle' },
  });
  if (logo) {
    const id = wb.addImage({ buffer: logo, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 0 }, ext: { width: Math.round(72 * 600 / 214), height: 72 } });
  }
  ws.getRow(4).height = 6;

  // job band (rows 5-6)
  for (const r of [5, 6]) band(r, LAV);
  ws.getRow(6).height = 18;
  Object.assign(ws.getCell('B5'), { value: 'ARTISTIC TILE INSTALLATION   ·   191 NY-59, Monsey NY', font: arial(10, { bold: true, color: { argb: MAROON } }) });
  Object.assign(ws.getCell('B6'), { value: `Project: ${q.project}`, font: arial(10, { bold: true, color: { argb: DARK } }) });
  Object.assign(ws.getCell('C6'), { value: 'Customer:', font: arial(10, { color: { argb: DARK } }) });
  Object.assign(ws.getCell('G6'), { value: 'Date:', font: arial(9, { bold: true, color: { argb: DARK } }) });
  ws.mergeCells('H6:I6');
  Object.assign(ws.getCell('H6'), { value: date, font: arial(10, { bold: true }) });

  // header row 8
  ws.getRow(8).height = 24;
  ['Location', 'Item', 'Unit', 'Count', 'Waste %', 'Total', 'On Order', 'Difference'].forEach((h, i) => {
    Object.assign(ws.getCell(8, i + 2), {
      value: h, font: arial(10, { bold: true, color: { argb: WHITE } }), fill: solid(PURPLE),
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    });
  });

  let r = 9;
  const sfRows = [], lfRows = [];
  for (const row of q.rows) {
    if (row.type === 'major' || row.type === 'sub') {
      const major = row.type === 'major';
      ws.mergeCells(r, 2, r, 9);
      band(r, major ? PURPLE : LTLAV);
      Object.assign(ws.getCell(r, 2), { value: row.text, font: arial(major ? 11 : 10, { bold: true, color: { argb: major ? WHITE : MAROON } }) });
    } else {
      const total = roundUp(row.count * (1 + row.waste));
      (row.unit === 'LF' ? lfRows : sfRows).push({ r, count: row.count, total });
      const cells = [
        [row.loc, arial(10)], [row.item, arial(9)], [row.unit, arial(10)], [row.count, arial(10)], [row.waste, arial(10)],
        [{ formula: `ROUNDUP(E${r}*(1+F${r}),0)`, result: total }, arial(10, { bold: true })],
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

  // totals: SF and LF never share a band
  const totalBand = (label, rows) => {
    band(r, MAROON);
    Object.assign(ws.getCell(r, 2), { value: label, font: arial(11, { bold: true, color: { argb: WHITE } }) });
    const sums = { E: rows.reduce((a, x) => a + x.count, 0), G: rows.reduce((a, x) => a + x.total, 0), H: 0 };
    for (const col of ['E', 'G', 'H']) {
      Object.assign(ws.getCell(`${col}${r}`), { value: { formula: rows.map((x) => `${col}${x.r}`).join('+'), result: sums[col] }, font: arial(11, { bold: true, color: { argb: WHITE } }) });
    }
    r++;
  };
  if (sfRows.length) totalBand('TOTAL — ALL TILE (SF)', sfRows);
  if (lfRows.length) totalBand('TOTAL — LF ITEMS', lfRows);

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 8, topLeftCell: 'B9' }];
  ws.pageSetup.printArea = `A1:I${r - 1}`;
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
