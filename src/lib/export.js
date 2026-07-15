// ============================================================
// export.js — full data export: JSON, CSV, XLSX (lazy-loaded).
// ============================================================

import { estimateProject } from '../engine/estimate.js';
import { polygonArea, polygonPerimeter } from '../engine/geometry.js';
import { round } from '../engine/units.js';

function downloadBlob(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const safe = (s) => String(s ?? '').replace(/\s+/g, '_');

// ---- JSON: full project, re-importable -----------------------
export function exportJSON(state) {
  const snap = {
    schema: 'tiletakeoff/v1', name: state.name, unitSystem: state.unitSystem,
    scale: state.scale, archScale: state.archScale,
    rooms: state.rooms, materials: state.materials,
    // markups are durable takeoff data — include them so the measurement log
    // survives an export/re-import round-trip.
    markups: state.markups,
    taxRate: state.taxRate, laborRatePerSf: state.laborRatePerSf,
    exportedAt: new Date().toISOString(),
  };
  downloadBlob(JSON.stringify(snap, null, 2), 'application/json', `${safe(state.name)}.json`);
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.rooms) throw new Error('Not a TileTakeoff file');
        resolve(data);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsText(file);
  });
}

// ---- CSV: estimate + rooms -----------------------------------
// Format one cell. Text cells that begin with a spreadsheet formula trigger
// (= + - @, or a leading tab/CR) are prefixed with an apostrophe so Excel/
// Sheets render them as literal text instead of evaluating them (CSV formula
// injection). Numbers are left untouched so negatives keep their sign.
function csvCell(c) {
  if (c == null) return '';
  let s = String(c);
  if (typeof c === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

export function exportCSV(state) {
  const e = estimateProject(state);
  const rows = [
    ['TileTakeoff Estimate', state.name],
    ['Generated', new Date().toLocaleString()],
    [],
    ['Material', 'Type', 'Tile (in)', 'Pattern', 'Net SF', 'Waste %', 'Gross SF', 'Tiles', 'Order Qty', 'Unit', 'Unit Cost', 'Line Cost'],
  ];
  e.lines.forEach((l) => rows.push([
    l.material.name, l.material.type, `${l.material.tw}x${l.material.th}`,
    l.material.pattern, round(l.netSf, 2), l.material.waste, round(l.grossSf, 2),
    l.tiles, l.qty % 1 ? round(l.qty, 2) : l.qty, l.unit, round(l.unitCost, 2), round(l.cost, 2),
  ]));
  rows.push([]);
  rows.push(['', '', '', '', '', '', '', '', '', '', 'Materials', round(e.materialSubtotal, 2)]);
  if (e.labor > 0) rows.push(['', '', '', '', '', '', '', '', '', '', `Labor (${e.laborRate}/sf)`, round(e.labor, 2)]);
  rows.push(['', '', '', '', '', '', '', '', '', '', 'Subtotal', round(e.subtotal, 2)]);
  rows.push(['', '', '', '', '', '', '', '', '', '', `Tax (${state.taxRate}%)`, round(e.tax, 2)]);
  rows.push(['', '', '', '', '', '', '', '', '', '', 'TOTAL', round(e.total, 2)]);
  rows.push([]);
  rows.push(['Rooms']);
  rows.push(['Name', 'Area SF', 'Perimeter LF', 'Wall Height', 'Materials']);
  state.rooms.forEach((r) => rows.push([
    r.name, round(polygonArea(r.points), 2), round(polygonPerimeter(r.points), 2),
    r.wallHeight ?? 8,
    r.assigned.map((id) => state.materials.find((m) => m.id === id)?.name).filter(Boolean).join(' | '),
  ]));
  downloadBlob(toCSV(rows), 'text/csv', `${safe(state.name)}_estimate.csv`);
}

// ---- XLSX: multi-sheet workbook (lazy import) ----------------
// Uses ExcelJS (maintained, published on npm). It writes every cell value as a
// typed string/number — a value like "=cmd|..." is stored as text, not a
// formula — so the workbook is not a formula-injection vector.
export async function exportXLSX(state) {
  const mod = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const e = estimateProject(state);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TileTakeoff';

  wb.addWorksheet('Estimate').addRows([
    ['Material', 'Type', 'Tile (in)', 'Pattern', 'Net SF', 'Waste %', 'Gross SF', 'Tiles', 'Order Qty', 'Unit', 'Unit Cost', 'Line Cost'],
    ...e.lines.map((l) => [
      l.material.name, l.material.type, `${l.material.tw}x${l.material.th}`, l.material.pattern,
      round(l.netSf, 2), l.material.waste, round(l.grossSf, 2), l.tiles,
      l.qty % 1 ? round(l.qty, 2) : l.qty, l.unit, round(l.unitCost, 2), round(l.cost, 2),
    ]),
    [],
    ['', '', '', '', '', '', '', '', '', '', 'Materials', round(e.materialSubtotal, 2)],
    ['', '', '', '', '', '', '', '', '', '', 'Labor', round(e.labor, 2)],
    ['', '', '', '', '', '', '', '', '', '', 'Subtotal', round(e.subtotal, 2)],
    ['', '', '', '', '', '', '', '', '', '', `Tax ${state.taxRate}%`, round(e.tax, 2)],
    ['', '', '', '', '', '', '', '', '', '', 'TOTAL', round(e.total, 2)],
  ]);

  wb.addWorksheet('Rooms').addRows([
    ['Name', 'Area SF', 'Perimeter LF', 'Wall Height', 'Pattern', 'Materials'],
    ...state.rooms.map((r) => [
      r.name, round(polygonArea(r.points), 2), round(polygonPerimeter(r.points), 2),
      r.wallHeight ?? 8, r.layout?.pattern ?? 'grid',
      r.assigned.map((id) => state.materials.find((m) => m.id === id)?.name).filter(Boolean).join(' | '),
    ]),
  ]);

  wb.addWorksheet('Materials').addRows([
    ['Name', 'Type', 'W in', 'H in', 'Grout in', 'Pattern', 'Waste %', 'Price', 'Unit', 'SF/Box'],
    ...state.materials.map((m) => [
      m.name, m.type, m.tw, m.th, m.grout, m.pattern, m.waste, m.price, m.priceUnit, m.sfPerBox,
    ]),
  ]);

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    '', `${safe(state.name)}.xlsx`,
  );
}
