// ============================================================
// proposal.js — the priced Artistic Tile Installation proposal, laid out
// like the QuickBooks proposal Moshe sends (Description | SF/LF/PC | Item |
// Rate | Total), by his marked-plan-takeoff-artistic skill and rate card
// (proposal #41765, 110 E Willow Tree):
//
//   page → room (bathroom header with dims, shower, ceiling) → lines:
//   floor tile by size tier (rectified 12X24 / 24X24 $7.75, large 24X48 /
//   32X32 / 36X36 / 48X48 $8.75, + $2.00 x-large upcharge from 48X48),
//   shower floor EA (standard ~14 SF $185, large ~20 SF $385), walls by
//   tier, window cut EA $145 (never a deduction), niche EA $145 (1 per tub
//   and per shower unless set), shower seat EA $250, *OPTIONAL* miter
//   $65/LF (niche 6.25 LF + window perimeter); ALL FLOORS *OPTIONAL* Ram
//   Board at 0.00 with its price in the description; *FOR OFFICE USE*
//   mud-job material calc; sales tax 0.00%; the standard footer.
//
// Quantities are the takeoff's (engine/takeoffRules.js), so the floor and
// wall totals here, on the estimate and on the quantity list agree. A line
// whose tile isn't picked, or whose size isn't on the rate card, gets no
// rate and is listed in `flags` — never a guessed price.
// ============================================================

import { floorTakeoff, wallParts, wallTileHeight, roomFixtures, roomWindows, roundUp } from '../engine/takeoffRules.js';
import { roomRegions } from '../engine/zones.js';
import { takeoffPages, markContext, roomMarks } from './markedPdf.js';

/** Rate card (proposal #41765). Confirm per job — these are the defaults. */
export const ARTISTIC_RATES = {
  rectified: 7.75, large: 8.75, xlUpcharge: 2, showerStd: 185, showerLg: 385,
  niche: 145, seat: 250, window: 145, miter: 65, ramBoard: 0.95,
};
/** A shower floor this big is "large" (~20 SF); smaller is standard (~14 SF). */
export const SHOWER_LG_SF = 17;
/** Miter around a standard niche. */
export const NICHE_MITER_LF = 6.25;
/**
 * *FOR OFFICE USE* mud-job material ratios (SF per unit) — the rate card's
 * approximate ratios, set so Willow Tree's 1,772 SF floor / 1,406 SF wall
 * comes out exactly as Moshe wrote it (12 yd sand, 57 Portland, 13 mesh…).
 */
export const OFFICE_RATIOS = [
  ['Sand', 'yards', 'f', 150], ['Portland', 'bags', 'fw', 55.8], ['Wire Mesh', 'bundles', 'f', 136.5],
  ['Black Felt', 'rolls', 'f', 255], ['Thinset Floors', 'bags', 'f', 63.5], ['Thinset Walls', 'bags', 'w', 36.1],
  ['Ram Board', 'rolls', 'f', 255], ['Tape', 'rolls', 'f', 450],
];
export const FOOTER = [
  'PLEASE ALLOW SEVEN BUSSINES DAYS FROM CONFIRMATION TO START INSTALLATION.',
  'Payment Schedule: 50% security deposit mandatory in order to schedule the job',
  'Additional 40% required upon completion of mud',
  "Remaining balance required when job is complete to customers' satisfaction.",
];

const n2 = (x) => String(+(+x).toFixed(2));
const money = (x) => `$${(+x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ftTxt = (h) => (Math.abs(h - Math.round(h)) < 0.01 ? `${Math.round(h)}'` : `${n2(h)}'`);

/**
 * The rate tier of a tile by its size: large (a side 30" or more; x-large
 * upcharge at 48X48 and up), rectified (12X24 / 24X24 class), else not on
 * the rate card (mosaic, subway…). null when no tile / no size.
 */
export function installTier(m) {
  const a = Math.max(+m?.tw || 0, +m?.th || 0), b = Math.min(+m?.tw || 0, +m?.th || 0);
  if (!(a > 0 && b > 0)) return null;
  if (a >= 30) return { tier: 'large', xl: b >= 48 };
  if (b >= 12) return { tier: 'rectified', xl: false };
  return { tier: 'other', xl: false };
}

/**
 * The install line(s) for a tile surface: description, item code and rate
 * by tier, plus the x-large upcharge line.
 * @param {'floor'|'wall'} surface
 * @param {object|null} m material
 * @param {number} qty SF
 * @param {string} [note] appended to the description (" - 4' high", " (border)")
 */
export function tileLines(surface, m, qty, note = '', R = ARTISTIC_RATES) {
  const t = installTier(m);
  const size = t ? `${n2(m.tw)}X${n2(m.th)}` : '';
  const Surface = surface === 'wall' ? 'Wall' : 'Floor';
  if (!t) return [{ desc: `${Surface} Tile Install${note} - tile not selected`, qty, item: '', rate: null, flag: `${surface} tile not picked` }];
  if (t.tier === 'other') return [{ desc: `${Surface} Tile Install ${size}${note}`, qty, item: '', rate: null, flag: `${size} is not on the rate card` }];
  const lines = t.tier === 'large'
    ? [{ desc: `Install large ${surface} tile ${size}${note}`, qty, item: surface === 'wall' ? 'Large wall tile' : 'Large floor tile', rate: R.large }]
    : [{ desc: `${Surface} Tile Install ${size}${note}`, qty, item: surface === 'wall' ? 'Rectified W' : 'Rectified', rate: R.rectified }];
  if (t.xl) lines.push({ desc: `Upcharge for x-large format tiles ${size}`, qty, item: 'Upcharge X Large', rate: R.xlUpcharge });
  return lines;
}

/** The *FOR OFFICE USE* material calc for a job's floor / wall SF. */
export function officeUse(f, w) {
  const parts = OFFICE_RATIOS.map(([name, unit, by, per]) => {
    const sf = by === 'f' ? f : by === 'w' ? w : f + w;
    return `${name} ${roundUp(sf / per)} ${unit}`;
  });
  return `*FOR OFFICE USE* ${parts.join(' / ')} (total f${f}sf w${w}sf)`;
}

/**
 * The priced proposal of the whole job (pure; tested).
 * @returns {{ project:string, proposal:string, customer:string, rows:any[], floorSf:number, wallSf:number, subtotal:number, office:string, flags:string[] }}
 */
export function buildProposal(st, R = ARTISTIC_RATES) {
  const pages = takeoffPages(st);
  const ctx = markContext(st, pages.flatMap((p) => p.rooms));
  const mat = (id) => st.materials.find((m) => m.id === id) || null;
  const rows = [], flags = [];
  let floorSf = 0, wallSf = 0;
  for (const p of pages) {
    const pageRows = [];
    for (const r of p.rooms) {
      const fx = roomFixtures(r);
      const lines = [];
      // floor: the field (less showers and 10 SF a tub), inlays, border bands
      if (ctx.allFloor) {
        const f = floorTakeoff(r);
        lines.push(...tileLines('floor', null, f.sf, '', R).map((l) => ({ ...l, floor: true })));
      } else {
        const floorMats = (r.assigned || []).map(mat).filter((m) => m && m.type !== 'wall');
        const reg = floorMats.length || (r.zones || []).some((z) => z.materialId) ? roomRegions(r) : null;
        for (const m of floorMats) lines.push(...tileLines('floor', m, floorTakeoff(r, reg?.fieldArea).sf, '', R).map((l) => ({ ...l, floor: true })));
        for (const z of reg ? reg.inlays : []) {
          const m = mat(z.zone.materialId);
          if (m) lines.push(...tileLines('floor', m, roundUp(z.area), ` (${z.zone.name.toLowerCase()} inlay)`, R).map((l) => ({ ...l, floor: true })));
        }
        for (const b of reg ? reg.bands : []) {
          const m = mat(b.zone.materialId);
          if (m) lines.push(...tileLines('floor', m, roundUp(b.area), ` (${b.zone.name.toLowerCase()} ${n2((b.zone.width || 0) * 12)}")`, R).map((l) => ({ ...l, floor: true })));
        }
      }
      // shower floors: 1 EA each, standard or large
      for (const s of fx.showers) {
        const sf = roundUp(s.w * s.d), lg = sf >= SHOWER_LG_SF;
        lines.push({ desc: `Install ${lg ? 'large' : 'standard'} shower floor (${sf}sf)`, qty: 1, item: lg ? 'Shower Fl Lg' : 'Shower Fl', rate: lg ? R.showerLg : R.showerStd });
      }
      // walls, then what goes with tiled walls: window cuts, niches, seats, miter
      const wallMats = (r.assigned || []).map(mat).filter((x) => x && x.type === 'wall');
      if (wallMats.length) {
        const h = wallTileHeight(r);
        const full = h >= (r.wallHeight ?? 8) - 1e-6;
        // one tile: the whole wall; a bath's second tile: its shower / tub walls
        for (const w of wallParts(r, wallMats.map((m) => m.id), h)) {
          const what = w.part === 'all' ? '' : w.part === 'wet' ? ` - ${w.label.toUpperCase()}` : ' - REST OF WALLS';
          lines.push(...tileLines('wall', mat(w.materialId), w.sf, `${what}${full ? '' : ` - ${ftTxt(h)} high`}`, R).map((l) => ({ ...l, wall: !l.item.startsWith('Upcharge'), math: w.text })));
          if (w.overlap && w.materialId === wallMats[0].id) flags.push(`${r.name}: ${wallMats.length} wall tiles — each priced on the whole wall`);
        }
        const wins = roomWindows(r);
        for (const x of wins) lines.push({ desc: `Labor to cut tiles around window (${x.h ? `${n2(x.w)}x${n2(x.h)}` : `${n2(x.w)}' wide`})`, qty: 1, item: 'Window', rate: R.window });
        if (fx.niches) {
          if (!fx.nichesSet && fx.showers.length) lines.push({ desc: 'Niche in shower', qty: fx.showers.length, item: 'Niche', rate: R.niche });
          if (!fx.nichesSet && fx.tubs) lines.push({ desc: 'Niche in tub', qty: fx.tubs, item: 'Niche', rate: R.niche });
          if (fx.nichesSet) lines.push({ desc: fx.showers.length ? 'Niche in shower' : fx.tubs ? 'Niche in tub' : 'Niche', qty: fx.niches, item: 'Niche', rate: R.niche });
        }
        if (fx.seats) lines.push({ desc: 'Custom shower seat', qty: fx.seats, item: 'Shower Seat', rate: R.seat });
        const sized = wins.filter((x) => x.h);
        const miter = fx.niches * NICHE_MITER_LF + sized.reduce((a, x) => a + 2 * (x.w + x.h), 0);
        if (miter > 0) {
          const what = [fx.niches && 'niche', sized.length && 'window'].filter(Boolean).join(' & ');
          lines.push({ desc: `*OPTIONAL* 45 Miter cut corner with epoxy for ${what} (per lf)`, qty: +miter.toFixed(2), item: 'Miter LF', rate: R.miter, optional: true });
        }
        if (wins.length > sized.length) flags.push(`${r.name}: window size (W x H) needed for the miter`);
      }
      if (!lines.length) continue;
      pageRows.push({ type: 'sub', text: roomMarks(r, ctx).header });
      for (const l of lines) {
        pageRows.push({ type: 'line', ...l });
        if (l.flag) flags.push(`${r.name}: ${l.flag}`);
        if (l.floor && !l.item.startsWith('Upcharge')) floorSf += l.qty;
        if (l.wall) wallSf += l.qty;
      }
    }
    if (pageRows.length) rows.push({ type: 'major', text: `PAGE ${p.page}` }, ...pageRows);
  }
  if (floorSf > 0) {
    rows.push({ type: 'major', text: 'ALL FLOORS' }, {
      type: 'line', desc: `*OPTIONAL* Cover floors with ram-board as protection for tiles $${R.ramBoard.toFixed(2)} per sf = ${money(floorSf * R.ramBoard)}`,
      qty: floorSf, item: 'Ram Board', rate: 0, optional: true,
    });
  }
  const subtotal = rows.filter((x) => x.type === 'line').reduce((a, x) => a + x.qty * (x.rate || 0), 0);
  const job = st.job || {};
  return {
    project: st.name || 'Takeoff', proposal: job.proposal || '',
    customer: [job.customer, job.address].map((x) => String(x || '').trim()).filter(Boolean).join('  ·  '),
    rows, floorSf, wallSf, subtotal: Math.round(subtotal * 100) / 100, office: officeUse(floorSf, wallSf), flags,
  };
}

// ---- the workbook (Artistic maroon / lavender / purple) --------------
const MAROON = 'FF5C1A3A', PURPLE = 'FF6B2D5C', LAV = 'FFC9B3C2', LTLAV = 'FFEDE3EA', DARK = 'FF3A2230', WHITE = 'FFFFFFFF';
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const arial = (size, extra = {}) => ({ name: 'Arial', size, ...extra });
const WIDTHS = [2.4, 72, 11, 17, 11, 14];
const USD = '$#,##0.00';

/**
 * Write the proposal into an ExcelJS workbook: Description | SF/LF/PC |
 * Item | Rate | Total, Total = qty × rate (so a rate edited in the sheet
 * carries through), Subtotal, Sales Tax 0.00%, Total, office note, footer.
 * @param {any} ExcelJS
 * @param {ReturnType<typeof buildProposal>} q
 * @param {{ date?: string, logo?: ArrayBuffer|Uint8Array|null }} [opt]
 */
export function proposalWorkbook(ExcelJS, q, { date = new Date().toLocaleDateString('en-US'), logo = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TileTakeoff';
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet('Proposal');
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const band = (r, argb) => { for (let c = 2; c <= 6; c++) ws.getCell(r, c).fill = solid(argb); };
  const thin = { style: 'thin', color: { argb: 'FFD9CBD4' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };

  for (const r of [1, 2, 3]) { ws.getRow(r).height = 19.5; band(r, MAROON); }
  ws.mergeCells('C1:F3');
  Object.assign(ws.getCell('C1'), {
    value: 'PROPOSAL', font: { name: 'Calibri', size: 28, bold: true, color: { argb: WHITE } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  });
  if (logo) {
    const id = wb.addImage({ buffer: logo, extension: 'png' });
    ws.addImage(id, { tl: { col: 1, row: 0 }, ext: { width: Math.round(72 * 600 / 214), height: 72 } });
  }
  ws.getRow(4).height = 6;
  for (const r of [5, 6]) band(r, LAV);
  ws.getRow(6).height = 18;
  Object.assign(ws.getCell('B5'), { value: 'ARTISTIC TILE INSTALLATION   ·   191 NY-59, Monsey NY', font: arial(10, { bold: true, color: { argb: MAROON } }) });
  Object.assign(ws.getCell('B6'), { value: `Project: ${q.project}  ·  Proposal #${q.proposal || ''}${q.customer ? `  ·  Customer: ${q.customer}` : ''}`, font: arial(10, { bold: true, color: { argb: DARK } }) });
  Object.assign(ws.getCell('E6'), { value: 'Date:', font: arial(9, { bold: true, color: { argb: DARK } }), alignment: { horizontal: 'right' } });
  Object.assign(ws.getCell('F6'), { value: date, font: arial(10, { bold: true, color: { argb: 'FF000000' } }) });

  ws.getRow(8).height = 24;
  ['Description', 'SF/LF/PC', 'Item', 'Rate', 'Total'].forEach((h, i) => {
    Object.assign(ws.getCell(8, i + 2), {
      value: h, font: arial(10, { bold: true, color: { argb: WHITE } }), fill: solid(PURPLE),
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    });
  });

  const first = 9;
  let r = first;
  for (const row of q.rows) {
    if (row.type !== 'line') {
      const major = row.type === 'major';
      band(r, major ? PURPLE : LTLAV);
      Object.assign(ws.getCell(r, 2), { value: row.text, font: arial(major ? 11 : 10, { bold: true, color: { argb: major ? WHITE : MAROON } }) });
    } else {
      const total = Math.round(row.qty * (row.rate || 0) * 100) / 100;
      const cells = [
        [row.desc, arial(10, row.optional ? { italic: true } : {})], [row.qty, arial(10)], [row.item, arial(10)],
        [row.rate, arial(10, { color: { argb: 'FF0000FF' } })],
        [{ formula: `C${r}*E${r}`, result: total }, arial(10, { bold: true })],
      ];
      cells.forEach(([value, font], i) => {
        const c = ws.getCell(r, i + 2);
        if (value != null) c.value = value;
        c.font = font; c.border = box;
      });
      ws.getCell(r, 3).alignment = { horizontal: 'center' };
      ws.getCell(r, 4).alignment = { horizontal: 'center' };
      ws.getCell(r, 5).numFmt = USD;
      ws.getCell(r, 6).numFmt = USD;
      if (row.flag) ws.getCell(r, 2).note = `No rate: ${row.flag}`;
    }
    r++;
  }
  const last = r - 1;
  const totalRow = (label, value, numFmt = USD) => {
    band(r, MAROON);
    Object.assign(ws.getCell(r, 2), { value: label, font: arial(11, { bold: true, color: { argb: WHITE } }) });
    Object.assign(ws.getCell(r, 6), { value, numFmt, font: arial(11, { bold: true, color: { argb: WHITE } }) });
    r++;
  };
  const sub = r;
  totalRow('Subtotal', { formula: `SUM(F${first}:F${last})`, result: q.subtotal });
  totalRow('Sales Tax (0.00%)', { formula: `F${sub}*0`, result: 0 });
  totalRow('TOTAL', { formula: `F${sub}+F${sub + 1}`, result: q.subtotal });
  r++;
  Object.assign(ws.getCell(r, 2), { value: q.office, font: arial(9, { italic: true, color: { argb: DARK } }) });
  r += 2;
  for (const line of FOOTER) { Object.assign(ws.getCell(r, 2), { value: line, font: arial(9, { bold: r === sub + 5 }) }); r++; }

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 8 }];
  ws.pageSetup.printArea = `A1:F${r - 1}`;
  ws.pageSetup.fitToPage = true; ws.pageSetup.fitToWidth = 1; ws.pageSetup.fitToHeight = 0;
  return wb;
}

/** Build and download "<Project> Proposal.xlsx". */
export async function downloadProposal(st) {
  const q = buildProposal(st);
  if (!q.rows.length) throw new Error('Nothing tiled yet — trace or draw rooms first');
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const logo = await fetch('/artistic-logo.png').then((x) => (x.ok ? x.arrayBuffer() : null)).catch(() => null);
  const buf = await proposalWorkbook(ExcelJS, q, { logo }).xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${q.project} Proposal.xlsx`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return q;
}
