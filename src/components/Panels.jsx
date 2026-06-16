import React from 'react';
import { useStore, ROOM_COLORS } from '../state/store.js';
import { polygonArea, polygonPerimeter, rectPoly, centroid } from '../engine/geometry.js';
import { estimateProject, estimateMaterial } from '../engine/estimate.js';
import { formatLength, formatArea, parseLength, fromFeet } from '../engine/units.js';
import { PATTERNS } from '../engine/layouts.js';
import { TILE_CATALOG, GROUT_JOINTS } from '../data/tileCatalog.js';
import { exportCSV, exportXLSX, exportJSON } from '../lib/export.js';
import { buildProjectCutSheets, openCutSheet } from '../engine/cutSheet.js';
import { formatLength as fmtLen } from '../engine/units.js';
import { markupValue, markupCost, markupUnit, markupDims, summarizeMarkups, MARKUP_TYPES } from '../engine/markups.js';

const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Panels() {
  const tab = useStore((s) => s.tab);
  if (tab === 'rooms') return <RoomsPanel />;
  if (tab === 'materials') return <MaterialsPanel />;
  if (tab === 'markups') return <MarkupsPanel />;
  return <EstimatePanel />;
}

/* ---------------- Rooms ---------------- */
function RoomsPanel() {
  const s = useStore();
  return (
    <div className="panel">
      {!s.scale && (
        <div className="empty"><b>Set the scale first</b>Use the Ruler tool, drag along a known dimension, type its real length. Then draw rooms.</div>
      )}
      {s.rooms.length === 0 && s.scale && (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
          <b>No rooms yet</b>Use the Room or Polygon tool to trace spaces, or add a rectangle below.
        </div>
      )}
      {s.rooms.map((r) => <RoomCard key={r.id} room={r} />)}
      <button className="ghost-add" onClick={() => {
        const c = { x: 10, y: 10 };
        s.addRoom(rectPoly(c.x, c.y, 10, 12));
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
        Add rectangular room
      </button>
    </div>
  );
}

function RoomCard({ room: r }) {
  const s = useStore();
  const open = s.selection.type === 'room' && s.selection.id === r.id;
  const area = s.scale ? polygonArea(r.points) : 0;
  const isRect = r.points.length === 4;
  const b = bounds(r.points);

  return (
    <div className={'card' + (open ? ' sel' : '')}>
      <div className="card-head" onClick={() => { s.select('room', r.id); }}>
        <span className="swatch" style={{ background: r.color }} />
        <input className="card-name" value={r.name} onClick={(e) => e.stopPropagation()}
          onChange={(e) => s.updateRoom(r.id, { name: e.target.value })} />
        <span className="card-meta">{s.scale ? formatArea(area, s.unitSystem) : '—'}</span>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); if (confirm('Delete ' + r.name + '?')) s.deleteRoom(r.id); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
        </button>
      </div>
      {open && (
        <div className="card-body">
          {isRect && s.scale && (
            <div className="field"><label>Dimensions</label>
              <div className="row">
                <DimInput value={b.w} system={s.unitSystem} onCommit={(w) => resizeRect(s, r, w, b.h)} />
                <div className="units" style={{ padding: '0 2px' }}>×</div>
                <DimInput value={b.h} system={s.unitSystem} onCommit={(h) => resizeRect(s, r, b.w, h)} />
              </div>
            </div>
          )}
          {!isRect && <div className="note" style={{ marginTop: 8 }}>Polygon room · {r.points.length} vertices · drag vertices on canvas to edit.</div>}

          <div className="field"><label>Wall height (for wall tile)</label>
            <DimInput value={r.wallHeight ?? 8} system={s.unitSystem} onCommit={(h) => s.updateRoom(r.id, { wallHeight: h })} />
          </div>

          <div className="field"><label>Layout pattern (floor)</label>
            <select className="inp" value={r.layout?.pattern || 'grid'} onChange={(e) => s.setRoomLayout(r.id, { pattern: e.target.value })}>
              {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {(r.layout?.pattern === 'grid' || r.layout?.pattern?.startsWith('brick')) && (
            <div className="field"><label>Rotation (°)</label>
              <input className="inp mono" type="number" step="5" value={r.layout?.angleDeg || 0}
                onChange={(e) => s.setRoomLayout(r.id, { angleDeg: +e.target.value || 0 })} />
            </div>
          )}

          <div className="field"><label>Color</label>
            <div className="assign">
              {ROOM_COLORS.map((c) => (
                <button key={c} className={'pill' + (r.color === c ? ' on' : '')}
                  style={r.color === c ? { background: c, borderColor: c } : {}}
                  onClick={() => s.updateRoom(r.id, { color: c })}><span className="dot" style={{ background: c }} /></button>
              ))}
            </div>
          </div>

          <div className="field"><label>Materials in this room</label>
            <div className="assign">
              {s.materials.length === 0 && <span className="note" style={{ margin: 0 }}>Add a material first →</span>}
              {s.materials.map((m) => {
                const on = r.assigned.includes(m.id);
                return <button key={m.id} className={'pill' + (on ? ' on' : '')}
                  style={on ? { background: m.color, borderColor: m.color } : {}}
                  onClick={() => s.toggleAssign(r.id, m.id)}>
                  <span className="dot" style={{ background: m.color }} />{m.name}</button>;
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function resizeRect(s, r, w, h) {
  const b = bounds(r.points);
  s.updateRoom(r.id, { points: rectPoly(b.minx, b.miny, Math.max(0.25, w), Math.max(0.25, h)) });
}

function DimInput({ value, system, onCommit }) {
  const [txt, setTxt] = React.useState('');
  React.useEffect(() => { setTxt(formatLength(value, system).replace(/ (ft|in|m|cm|mm|m²|sf)$/, '')); }, [value, system]);
  return (
    <div className="units" style={{ flex: 1 }}>
      <input className="inp mono" value={txt} onChange={(e) => setTxt(e.target.value)}
        onBlur={() => { const ft = parseLength(txt, system); if (ft != null && ft > 0) onCommit(ft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
    </div>
  );
}

/* ---------------- Materials ---------------- */
function MaterialsPanel() {
  const s = useStore();
  return (
    <div className="panel">
      {s.materials.length === 0 && (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg>
          <b>No materials yet</b>Add a floor or wall tile, pick its size, grout, pattern, waste and price.
        </div>
      )}
      {s.materials.map((m) => <MaterialCard key={m.id} m={m} />)}
      <div className="row" style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => s.addMaterial('floor')}>+ Floor tile</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => s.addMaterial('wall')}>+ Wall tile</button>
      </div>
    </div>
  );
}

function MaterialCard({ m }) {
  const s = useStore();
  const open = s.selection.type === 'material' && s.selection.id === m.id;
  const est = estimateMaterial(m, s.rooms);
  return (
    <div className={'card' + (open ? ' sel' : '')}>
      <div className="card-head" onClick={() => { s.select('material', m.id); if (m.type === 'floor') s.setGridMaterial(m.id); }}>
        <span className="swatch" style={{ background: m.color }} />
        <input className="card-name" value={m.name} onClick={(e) => e.stopPropagation()}
          onChange={(e) => s.updateMaterial(m.id, { name: e.target.value })} />
        <span className="card-meta">{m.tw}×{m.th}"</span>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); if (confirm('Delete ' + m.name + '?')) s.deleteMaterial(m.id); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
        </button>
      </div>
      {open && (
        <div className="card-body">
          <div className="field"><label>Type</label>
            <div className="seg">
              {['floor', 'wall'].map((t) => <button key={t} className={m.type === t ? 'on' : ''} onClick={() => s.updateMaterial(m.id, { type: t, color: t === 'floor' ? '#caa46a' : '#6b9cc4' })}>{t === 'floor' ? 'Floor' : 'Wall'}</button>)}
            </div>
          </div>

          <div className="field"><label>Tile size (from library or custom)</label>
            <select className="inp" value="" onChange={(e) => {
              if (!e.target.value) return;
              const [tw, th] = e.target.value.split('x').map(Number);
              s.updateMaterial(m.id, { tw, th });
            }}>
              <option value="">Choose from library…</option>
              {TILE_CATALOG.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((it) => <option key={it.id} value={`${it.tw}x${it.th}`}>{it.label}</option>)}
                </optgroup>
              ))}
            </select>
            <div className="row" style={{ marginTop: 7 }}>
              <div className="units"><input className="inp mono" type="number" step="0.25" value={m.tw} onChange={(e) => s.updateMaterial(m.id, { tw: Math.max(0.25, +e.target.value || 1) })} /></div>
              <div className="units" style={{ padding: '0 2px' }}>×</div>
              <div className="units"><input className="inp mono" type="number" step="0.25" value={m.th} onChange={(e) => s.updateMaterial(m.id, { th: Math.max(0.25, +e.target.value || 1) })} /> in</div>
            </div>
          </div>

          <div className="field"><label>Pattern & grout joint</label>
            <select className="inp" value={m.pattern} onChange={(e) => s.updateMaterial(m.id, { pattern: e.target.value })}>
              {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select className="inp" style={{ marginTop: 7 }} value={m.grout} onChange={(e) => s.updateMaterial(m.id, { grout: +e.target.value })}>
              {GROUT_JOINTS.map((j) => <option key={j.id} value={j.in}>{j.label}</option>)}
            </select>
          </div>

          <div className="field"><label>Waste %</label>
            <input className="inp mono" type="number" step="1" value={m.waste} onChange={(e) => s.updateMaterial(m.id, { waste: Math.max(0, Math.min(60, +e.target.value || 0)) })} />
          </div>

          <div className="field"><label>Price</label>
            <div className="row">
              <div className="units" style={{ flex: 1 }}><span>$</span><input className="inp mono" type="number" step="0.01" value={m.price} onChange={(e) => s.updateMaterial(m.id, { price: Math.max(0, +e.target.value || 0) })} /></div>
              <select className="inp" style={{ flex: 1 }} value={m.priceUnit} onChange={(e) => s.updateMaterial(m.id, { priceUnit: e.target.value })}>
                <option value="sf">per sf</option><option value="tile">per tile</option><option value="box">per box</option>
              </select>
            </div>
          </div>
          {m.priceUnit === 'box' && (
            <div className="field"><label>Coverage per box (sf)</label>
              <input className="inp mono" type="number" step="0.1" value={m.sfPerBox} onChange={(e) => s.updateMaterial(m.id, { sfPerBox: Math.max(0.1, +e.target.value || 1) })} />
            </div>
          )}

          <div className="field"><label>This material</label>
            <div className="est-row" style={{ padding: '5px 0' }}><span>Net area</span><b>{est.netSf.toFixed(1)} sf</b></div>
            <div className="est-row" style={{ padding: '5px 0' }}><span>+{m.waste}% waste</span><b>{est.grossSf.toFixed(1)} sf</b></div>
            <div className="est-row" style={{ padding: '5px 0' }}><span>Tiles</span><b>{est.tiles}</b></div>
            <div className="est-row hi" style={{ padding: '6px 8px', borderRadius: 5 }}><span>Cost</span><b>{money(est.cost)}</b></div>
          </div>
          {m.type === 'floor' && (
            <button className="ghost-add" style={{ marginTop: 8 }} onClick={() => { s.setGridMaterial(m.id); s.setTool('grid'); }}>Show tile grid on canvas</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Markups (Bluebeam-style measurement log) ---------------- */
function MarkupsPanel() {
  const s = useStore();
  const sum = summarizeMarkups(s.markups);
  return (
    <div className="panel">
      {!s.scale && <div className="empty"><b>Set the scale first</b>Markup measurements need a calibrated scale. Use the Ruler tool.</div>}
      {s.markups.length === 0 && s.scale && (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 17L17 3M14 3h4v4" /></svg>
          <b>No markups yet</b>Use the measure tools (length, area, box, count) in the toolbar to take off quantities directly on the plan.
        </div>
      )}

      {s.markups.length > 0 && (
        <>
          <div className="est-total" style={{ background: '#1d3a4a' }}>
            <div className="lbl">Markup cost total</div>
            <div className="val">{money(sum.totalCost)}</div>
            <div className="sub">{s.markups.length} markup{s.markups.length > 1 ? 's' : ''}</div>
          </div>
          {sum.byType.map((t) => (
            <div className="est-row" key={t.type} style={{ padding: '5px 2px' }}>
              <span>{MARKUP_TYPES[t.type]?.label} ({t.count})</span>
              <b>{t.type === 'length' ? fmtLen(t.value, s.unitSystem) : t.type === 'count' ? `${t.value} ea` : formatArea(t.value, s.unitSystem)}{t.cost ? ` · ${money(t.cost)}` : ''}</b>
            </div>
          ))}
          <div style={{ height: 10 }} />
        </>
      )}

      {s.markups.map((mk) => <MarkupCard key={mk.id} mk={mk} />)}
    </div>
  );
}

function MarkupCard({ mk }) {
  const s = useStore();
  const open = s.selection.type === 'markup' && s.selection.id === mk.id;
  const val = markupValue(mk);
  const unit = markupUnit(mk);
  const dims = markupDims(mk);
  const valStr = mk.type === 'length' ? fmtLen(val, s.unitSystem)
    : mk.type === 'count' ? `${val} ea` : formatArea(val, s.unitSystem);
  return (
    <div className={'card' + (open ? ' sel' : '')}>
      <div className="card-head" onClick={() => s.select('markup', mk.id)}>
        <span className="swatch" style={{ background: mk.color }} />
        <input className="card-name" value={mk.name} onClick={(e) => e.stopPropagation()}
          onChange={(e) => s.updateMarkup(mk.id, { name: e.target.value })} />
        <span className="card-meta">{valStr}</span>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); s.deleteMarkup(mk.id); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
        </button>
      </div>
      {open && (
        <div className="card-body">
          <div className="est-row" style={{ padding: '5px 0' }}><span>Type</span><b>{MARKUP_TYPES[mk.type]?.label}</b></div>
          <div className="est-row" style={{ padding: '5px 0' }}><span>Measured</span><b>{valStr}</b></div>
          {dims && <div className="est-row" style={{ padding: '5px 0' }}><span>Dimensions</span><b>{fmtLen(dims.w, s.unitSystem)} × {fmtLen(dims.h, s.unitSystem)}</b></div>}
          <div className="field"><label>Unit cost (${unit === 'ea' ? 'each' : `per ${unit}`})</label>
            <div className="units"><span>$</span><input className="inp mono" type="number" step="0.01" value={mk.unitCost || 0}
              onChange={(e) => s.updateMarkup(mk.id, { unitCost: Math.max(0, +e.target.value || 0) })} /></div>
          </div>
          {mk.unitCost > 0 && <div className="est-row hi" style={{ padding: '6px 8px', borderRadius: 5 }}><span>Line cost</span><b>{money(markupCost(mk))}</b></div>}
          <div className="field"><label>Note</label>
            <input className="inp" value={mk.note || ''} placeholder="optional" onChange={(e) => s.updateMarkup(mk.id, { note: e.target.value })} /></div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Estimate ---------------- */
function EstimatePanel() {
  const s = useStore();
  const e = estimateProject(s);
  if (!s.materials.length || !s.scale) {
    return <div className="panel"><div className="empty"><b>Nothing to estimate yet</b>{!s.scale ? 'Set the scale, draw rooms,' : 'Add a material,'} then assign materials to rooms.</div></div>;
  }
  return (
    <div className="panel">
      <div className="est-total">
        <div className="lbl">Project Total</div>
        <div className="val">{money(e.total)}</div>
        <div className="sub">{money(e.subtotal)} + {money(e.tax)} tax · {e.floorSf.toFixed(0)} sf floor</div>
      </div>
      {e.lines.map((l) => {
        const m = l.material;
        const ci = l.cutInfo;
        const isFloor = m.type !== 'wall';
        return (
          <div className="est-block" key={m.id}>
            <h4><span className="sw" style={{ background: m.color }} />{m.name}<span className="cost">{money(l.cost)}</span></h4>

            {isFloor && (
              <div style={{ display: 'flex', gap: 6, padding: '8px 12px', alignItems: 'center', background: '#fafbfc', borderBottom: '1px solid var(--line-2)' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>Costing</span>
                <div className="seg" style={{ flex: 1, maxWidth: 190 }}>
                  <button className={l.costMode === 'waste' ? 'on' : ''} onClick={() => s.updateMaterial(m.id, { costMode: 'waste' })}>Waste %</button>
                  <button className={l.costMode === 'cuts' ? 'on' : ''} onClick={() => s.updateMaterial(m.id, { costMode: 'cuts' })}>Cut reuse</button>
                </div>
              </div>
            )}

            <div className="est-row"><span>Net area</span><b>{l.netSf.toFixed(1)} sf</b></div>

            {l.costMode === 'waste' && (
              <>
                <div className="est-row"><span>With {m.waste}% waste</span><b>{l.grossSf.toFixed(1)} sf</b></div>
                <div className="est-row"><span>Tiles ({m.tw}×{m.th}")</span><b>{l.tiles}</b></div>
              </>
            )}

            {l.costMode === 'cuts' && ci && (
              <>
                <div className="est-row"><span>Full tiles</span><b>{ci.fullTiles}</b></div>
                <div className="est-row"><span>Cut pieces needed</span><b>{ci.cutPieces}</b></div>
                <div className="est-row"><span>Tiles broken for cuts</span><b>{ci.newTilesBrokenForCuts}</b></div>
                <div className="est-row" style={{ color: 'var(--ok)' }}>
                  <span>↳ offcuts reused</span><b style={{ color: 'var(--ok)' }}>{ci.reusedOffcuts} · saved {ci.tilesSavedByReuse} tiles</b>
                </div>
                <div className="est-row"><span>+{m.cutSafetyPct ?? 5}% breakage safety</span><b>{l.tiles} tiles</b></div>
                <div style={{ display: 'flex', gap: 6, padding: '7px 12px', alignItems: 'center' }}>
                  <label style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--ink-2)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={!!m.optimizeWholeJob}
                      onChange={(ev) => s.updateMaterial(m.id, { optimizeWholeJob: ev.target.checked })} />
                    Optimize whole job (best-fit)
                  </label>
                  <span className="conf hi" style={{ marginLeft: 'auto' }}>−{ci.pctSaved.toFixed(1)}% vs naive</span>
                </div>
                {ci.note && <div className="note" style={{ margin: '0 12px 8px', fontSize: 11 }}>⚠ {ci.note}</div>}
              </>
            )}

            <div className="est-row hi"><span>Order</span><b>{l.qty % 1 ? l.qty.toFixed(1) : l.qty} {l.unit} <span className="tag">@ {money(l.unitCost)}</span></b></div>
          </div>
        );
      })}

      <div className="est-block">
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center', background: '#fafbfc' }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)' }}>Labor $/sf</label>
          <input className="inp mono" style={{ width: 80 }} type="number" step="0.25" value={s.laborRatePerSf} onChange={(ev) => s.setLabor(Math.max(0, +ev.target.value || 0))} />
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)', marginLeft: 'auto' }}>Tax %</label>
          <input className="inp mono" style={{ width: 80 }} type="number" step="0.001" value={s.taxRate} onChange={(ev) => s.setTax(Math.max(0, +ev.target.value || 0))} />
        </div>
        {e.labor > 0 && <div className="est-row"><span>Labor</span><b>{money(e.labor)}</b></div>}
      </div>

      <div className="row" style={{ display: 'flex', gap: 8 }}>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportCSV(s)}>CSV</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportXLSX(s)}>Excel</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportJSON(s)}>JSON</button>
      </div>
      <button className="ghost-add" style={{ marginTop: 8 }} onClick={() => {
        const fmt = (ft) => fmtLen(ft, s.unitSystem);
        const sheets = buildProjectCutSheets(s, fmt);
        if (!sheets.length) { window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Assign a floor material to rooms first' } })); return; }
        openCutSheet(s, sheets);
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><path d="M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h6M9 9h2" /></svg>
        Installer cut sheet
      </button>
      <div className="note">Order quantities include each material's waste allowance. Wall tile uses perimeter × wall height as a coverage proxy. Verify field conditions before ordering.</div>
    </div>
  );
}

// local bounds (avoid extra import churn)
function bounds(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}
