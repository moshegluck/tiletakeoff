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
    scale: state.scale, rooms: state.rooms, materials: state.materials,
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
function toCSV(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
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
export async function exportXLSX(state) {
  const XLSX = await import('xlsx');
  const e = estimateProject(state);
  const wb = XLSX.utils.book_new();

  const est = [
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
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(est), 'Estimate');

  const rooms = [
    ['Name', 'Area SF', 'Perimeter LF', 'Wall Height', 'Pattern', 'Materials'],
    ...state.rooms.map((r) => [
      r.name, round(polygonArea(r.points), 2), round(polygonPerimeter(r.points), 2),
      r.wallHeight ?? 8, r.layout?.pattern ?? 'grid',
      r.assigned.map((id) => state.materials.find((m) => m.id === id)?.name).filter(Boolean).join(' | '),
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rooms), 'Rooms');

  const mats = [
    ['Name', 'Type', 'W in', 'H in', 'Grout in', 'Pattern', 'Waste %', 'Price', 'Unit', 'SF/Box'],
    ...state.materials.map((m) => [
      m.name, m.type, m.tw, m.th, m.grout, m.pattern, m.waste, m.price, m.priceUnit, m.sfPerBox,
    ]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mats), 'Materials');

  XLSX.writeFile(wb, `${safe(state.name)}.xlsx`);
}
