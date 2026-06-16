// ============================================================
// cutSheet.js — turn cut-engine assignments into an installer
// cut sheet: per-room summary, a consolidated cut list grouped by
// size (batch cutting), and the tile-by-tile cutting plan that
// shows which offcut feeds which cut. Outputs structured data for
// on-screen display and a print-ready HTML document.
//
// Dimensions are reported in the project's unit system via a
// formatter passed in (so ft-in / metric both work).
// ============================================================

import { analyzeCuts } from './cutEngine.js';
import { polygonArea } from './geometry.js';

// group cut pieces by rounded size so installers can batch-cut
function groupBySize(assignments, fmt) {
  const map = new Map();
  for (const a of assignments) {
    const key = `${round2(a.w)}x${round2(a.h)}`;
    if (!map.has(key)) map.set(key, { w: a.w, h: a.h, count: 0, rooms: new Set() });
    const g = map.get(key);
    g.count++; g.rooms.add(a.room);
  }
  return [...map.values()]
    .sort((x, y) => (y.w * y.h) - (x.w * x.h))
    .map((g) => ({
      size: `${fmt(g.w)} × ${fmt(g.h)}`,
      count: g.count,
      rooms: [...g.rooms].join(', '),
    }));
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Build the cut sheet model for one material.
 * @param rooms rooms assigned to the material
 * @param material material def
 * @param fmt formatLength(feet) -> string (bound to unit system)
 * @param mode 'practical' | 'optimize'
 */
/**
 * Build the cut-sheet model for one material.
 * @param {import('./types.js').Room[]} rooms
 * @param {import('./types.js').Material} material
 * @param {(feet:number)=>string} fmt
 * @param {'practical'|'optimize'} [mode]
 */
export function buildCutSheet(rooms, material, fmt, mode = 'practical') {
  const info = analyzeCuts(rooms, material, { mode });

  // per-room rollup
  const perRoom = rooms.map((r) => {
    const roomCuts = info.assignments.filter((a) => a.room === r.name);
    return {
      name: r.name,
      areaSf: polygonArea(r.points),
      cuts: roomCuts.length,
      pattern: r.layout?.pattern || material.pattern || 'grid',
    };
  });

  const cutList = groupBySize(info.assignments, fmt);

  // cutting plan: only the pieces that come from NEW tiles, with the
  // offcuts they yield — this is the bench sequence that saves material
  const plan = info.assignments
    .filter((a) => a.source === 'new tile')
    .map((a) => ({
      tile: a.from,
      install: `${fmt(a.w)} × ${fmt(a.h)}`,
      room: a.room,
      offcuts: (a.produces || []).map((p) => `${fmt(p.w)} × ${fmt(p.h)}`),
    }));

  return {
    material: material.name,
    tile: `${material.tw} × ${material.th}"`,
    pattern: info.pattern,
    grainLocked: info.grainLocked,
    fullTiles: info.fullTiles,
    cutPieces: info.cutPieces,
    tilesBroken: info.newTilesBrokenForCuts,
    reused: info.reusedOffcuts,
    saved: info.tilesSavedByReuse,
    totalTiles: info.totalTiles,
    pctSaved: info.pctSaved,
    mode,
    note: info.note,
    perRoom, cutList, plan,
  };
}

export function buildProjectCutSheets(state, fmt) {
  const sheets = [];
  for (const m of state.materials) {
    if (m.type === 'wall') continue;
    const rooms = state.rooms.filter((r) => r.assigned?.includes(m.id));
    if (!rooms.length) continue;
    const mode = m.optimizeWholeJob ? 'optimize' : 'practical';
    sheets.push(buildCutSheet(rooms, m, fmt, mode));
  }
  return sheets;
}

// ---- print-ready HTML document ----
export function cutSheetHTML(state, sheets) {
  const css = `
    *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#10171f;margin:0;padding:32px;font-size:13px}
    h1{font-size:20px;margin:0 0 4px} .sub{color:#667;font-size:12px;margin-bottom:20px}
    h2{font-size:15px;margin:24px 0 8px;padding-bottom:5px;border-bottom:2px solid #c8521f;color:#0f2f47}
    .stat-row{display:flex;gap:18px;flex-wrap:wrap;margin:10px 0 14px}
    .stat{background:#f6f8fa;border:1px solid #e0e6eb;border-radius:7px;padding:8px 13px;min-width:92px}
    .stat .n{font:700 18px ui-monospace,monospace;color:#0f2f47} .stat .l{font-size:10.5px;color:#667;text-transform:uppercase;letter-spacing:.5px}
    .stat.save .n{color:#1d7a4d}
    table{width:100%;border-collapse:collapse;margin:8px 0 16px} th,td{text-align:left;padding:6px 9px;border-bottom:1px solid #e8edf1;font-size:12px}
    th{background:#0f2f47;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
    tr:nth-child(even) td{background:#fafbfc} .mono{font-family:ui-monospace,monospace}
    .badge{display:inline-block;background:#e3f5ea;color:#1d7a4d;font:600 11px ui-monospace,monospace;padding:2px 8px;border-radius:10px}
    .note{background:#fffaf0;border:1px solid #e8d2a8;border-radius:6px;padding:8px 11px;font-size:11.5px;color:#7a5a14;margin:8px 0}
    .grain{font-size:11px;color:#667} @media print{body{padding:14px} h2{page-break-after:avoid} table{page-break-inside:auto} tr{page-break-inside:avoid}}
    .foot{margin-top:28px;padding-top:12px;border-top:1px solid #e8edf1;color:#99a;font-size:11px}
  `;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const sections = sheets.map((sh) => `
    <h2>${esc(sh.material)} · ${esc(sh.tile)} · ${esc(sh.pattern)}${sh.grainLocked ? ' <span class="grain">(grain-locked)</span>' : ''}</h2>
    <div class="stat-row">
      <div class="stat"><div class="n">${sh.fullTiles}</div><div class="l">Full tiles</div></div>
      <div class="stat"><div class="n">${sh.cutPieces}</div><div class="l">Cut pieces</div></div>
      <div class="stat"><div class="n">${sh.tilesBroken}</div><div class="l">Tiles to cut</div></div>
      <div class="stat save"><div class="n">${sh.saved}</div><div class="l">Saved by reuse</div></div>
      <div class="stat"><div class="n">${sh.totalTiles}</div><div class="l">Total order</div></div>
    </div>
    ${sh.note ? `<div class="note">⚠ ${esc(sh.note)}</div>` : ''}

    <table><thead><tr><th>Room</th><th>Area</th><th>Pattern</th><th>Cut pieces</th></tr></thead><tbody>
      ${sh.perRoom.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.areaSf.toFixed(1)} sf</td><td>${esc(r.pattern)}</td><td class="mono">${r.cuts}</td></tr>`).join('')}
    </tbody></table>

    <strong>Consolidated cut list</strong> <span class="badge">batch-cut these</span>
    <table><thead><tr><th>Cut size</th><th>Qty</th><th>Rooms</th></tr></thead><tbody>
      ${sh.cutList.map((c) => `<tr><td class="mono">${esc(c.size)}</td><td class="mono">${c.count}</td><td>${esc(c.rooms)}</td></tr>`).join('')}
    </tbody></table>

    <strong>Cutting plan</strong> <span class="grain">— ${sh.tilesBroken} tiles broken; reuse offcuts as shown to save ${sh.saved} tiles</span>
    <table><thead><tr><th>Tile</th><th>Install piece</th><th>Room</th><th>Usable offcut(s)</th></tr></thead><tbody>
      ${sh.plan.map((p) => `<tr><td class="mono">${esc(p.tile)}</td><td class="mono">${esc(p.install)}</td><td>${esc(p.room)}</td><td class="mono">${p.offcuts.length ? esc(p.offcuts.join(' · ')) : '—'}</td></tr>`).join('')}
    </tbody></table>
  `).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Cut Sheet — ${esc(state.name)}</title><style>${css}</style></head>
  <body>
    <h1>Cut Sheet — ${esc(state.name)}</h1>
    <div class="sub">Generated ${new Date().toLocaleString()} · TileTakeoff</div>
    ${sections || '<p>No floor materials with assigned rooms.</p>'}
    <div class="foot">Cut sizes include the grout joint. Verify field conditions before cutting. Offcut reuse assumes straight wet-saw cuts; angled/herringbone fragments are modeled as bounding rectangles.</div>
  </body></html>`;
}

export function openCutSheet(state, sheets) {
  const html = cutSheetHTML(state, sheets);
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
  else {
    // popup blocked: download instead
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${state.name.replace(/\s+/g, '_')}_cutsheet.html`; a.click();
    URL.revokeObjectURL(a.href);
  }
}
