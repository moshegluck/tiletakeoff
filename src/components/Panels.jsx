import React, { useMemo, lazy, Suspense } from 'react';
import { useStore, useProject, ROOM_COLORS, ZONE_COLORS, allRooms, wholeProject, otherPages } from '../state/store.js';
import { rectPoly, roomArea, roomWallLf } from '../engine/geometry.js';
import { estimateProject, estimateMaterial } from '../engine/estimate.js';
import { formatLength, formatArea, parseLength } from '../engine/units.js';
import { PATTERNS } from '../engine/layouts.js';
import { roomPattern, patternLabel } from '../engine/patterns.js';
import { TILE_CATALOG, GROUT_JOINTS } from '../data/tileCatalog.js';
import { exportCSV, exportXLSX, exportJSON } from '../lib/export.js';
import { buildProjectCutSheets, openCutSheet } from '../engine/cutSheet.js';
import { formatLength as fmtLen } from '../engine/units.js';
const TracePanel = lazy(() => import('./TracePanel.jsx'));
import PatternSwatch from './PatternSwatch.jsx';
import { materialItem, saveMine } from '../lib/library.js';
import { markupValue, markupCost, markupUnit, markupDims, summarizeMarkups, MARKUP_TYPES, isMeasured } from '../engine/markups.js';
import { roomRegions, zonesOf, isAxisRect } from '../engine/zones.js';
import { roomFixtures, floorTakeoff, wallTakeoff, wallTileHeight, parseShowers, showersText } from '../engine/takeoffRules.js';

const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Panels() {
  const tab = useStore((s) => s.tab);
  if (tab === 'trace') return <Suspense fallback={<div className="panel"><div className="note">Loading…</div></div>}><TracePanel /></Suspense>;
  if (tab === 'rooms') return <RoomsPanel />;
  if (tab === 'materials') return <MaterialsPanel />;
  if (tab === 'markups') return <MarkupsPanel />;
  return <EstimatePanel />;
}

// a room's ways in (doors, openings: wall LF is net of them) and its windows (not)
const ways = (r) => (r.openings || []).filter((o) => o.type !== 'window');
const wins = (r) => (r.openings || []).filter((o) => o.type === 'window');

/* ---------------- Other pages ---------------- */
// The lists show the page on screen; this says what the plan's other pages
// hold and goes there (App renders the page).
function OtherPages({ what }) {
  const s = useProject();
  const pages = otherPages(s).filter((p) => p[what] > 0);
  if (!pages.length || !s.pdfDoc) return null;
  const noun = what === 'rooms' ? 'room' : 'markup';
  return (
    <div className="other-pages">
      <span>Page {s.pdfPage || 1} shown · also on</span>
      {pages.map((p) => (
        <button key={p.page} onClick={() => window.dispatchEvent(new CustomEvent('tt:page', { detail: p.page }))}>
          pg {p.page} · {p[what]} {noun}{p[what] > 1 ? 's' : ''}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Rooms ---------------- */
function RoomsPanel() {
  const s = useProject();
  return (
    <div className="panel">
      <OtherPages what="rooms" />
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

// open the tile library (App hosts it) aimed at rooms / zones / one tile
const openLibrary = (detail) => window.dispatchEvent(new CustomEvent('tt:library', { detail }));
async function saveToLibrary(m) {
  try {
    const saved = await saveMine(materialItem(m));
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { ok: true, msg: saved.source === 'mine' ? `Saved “${m.name}” to your library` : `Saved “${m.name}” to this device’s library` } }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Could not save: ' + e.message } }));
  }
}

function RoomCard({ room: r }) {
  const s = useProject();
  const open = s.selection.type === 'room' && s.selection.id === r.id;
  const area = s.scale ? roomArea(r) : 0;
  const isRect = r.points.length === 4;
  const b = bounds(r.points);
  // the floor tile in this room (its pattern is the room's default)
  const floorTile = s.materials.find((m) => m.type !== 'wall' && r.assigned.includes(m.id)) || null;

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
          {r.traceId && s.scale && (
            <div className="trace-facts">
              <span>Floor <b>{formatArea(area, s.unitSystem)}</b></span>
              <span>Wall LF <b>{formatLength(roomWallLf(r), s.unitSystem)}</b></span>
              {r.spurLf > 0 && <span>incl. returns <b>{formatLength(r.spurLf, s.unitSystem)}</b></span>}
              {ways(r).length > 0 && <span>net of {ways(r).length} door{ways(r).length > 1 ? 's' : ''} / opening{ways(r).length > 1 ? 's' : ''}: {ways(r).map((o) => formatLength(o.width, s.unitSystem)).join(', ')}</span>}
              {wins(r).length > 0 && <span>{wins(r).length} window{wins(r).length > 1 ? 's' : ''} (wall LF runs under)</span>}
              {r.holes?.length > 0 && <span>{r.holes.length} column/chase deducted</span>}
            </div>
          )}
          {!isRect && !r.traceId && <div className="note" style={{ marginTop: 8 }}>Polygon room · {r.points.length} vertices · drag vertices on canvas to edit.</div>}

          <div className="field"><label>Wall height (for wall tile)</label>
            <DimInput value={r.wallHeight ?? 8} system={s.unitSystem} onCommit={(h) => s.updateRoom(r.id, { wallHeight: h })} />
          </div>

          <div className="field"><label>Layout pattern (floor)</label>
            <select className="inp" value={r.layout?.pattern || ''} onChange={(e) => s.setRoomLayout(r.id, { pattern: e.target.value || undefined })}>
              <option value="">Same as the tile — {patternLabel(floorTile?.pattern || 'grid')}</option>
              {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {PATTERNS.find((p) => p.id === roomPattern(r, floorTile))?.hasAngle && (
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

          <div className="field"><label>Materials in this room{(r.zones || []).length ? ' (field & walls)' : ''}</label>
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
            <button className="ghost-add" style={{ marginTop: 8 }} onClick={() => openLibrary({ rooms: [r.id] })}>
              Choose tile &amp; pattern from the library…
            </button>
          </div>

          <RoomTakeoff room={r} />
          <FloorDesign room={r} />
        </div>
      )}
    </div>
  );
}

/* ---- Takeoff: tubs, showers, wall tile height, and the arithmetic ----
   Artistic's rules (engine/takeoffRules.js): floor = room − shower − 10 a
   tub; walls = perimeter × tiled height − 14 a door (8 at 4'), − 10 a tub;
   windows never deducted; everything rounded up. The numbers show their
   working so they can be checked against the plan. */
function RoomTakeoff({ room: r }) {
  const s = useProject();
  const fx = roomFixtures(r);
  const [shText, setShText] = React.useState(showersText(fx.showers));
  React.useEffect(() => { setShText(showersText(roomFixtures(r).showers)); }, [r.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const setFx = (patch) => s.updateRoom(r.id, { fixtures: { ...(r.fixtures || {}), ...patch } });
  const wallMat = s.materials.find((m) => m.type === 'wall' && r.assigned.includes(m.id));
  const th = r.finish?.wallTileHeight;
  const ceiling = r.wallHeight ?? 8;
  const mode = th == null || th >= ceiling ? 'full' : Math.abs(th - 4) < 1e-6 ? 'half' : 'custom';
  const traced = Number.isFinite(r.wallLf);
  if (!s.scale) return null;
  const floor = floorTakeoff(r);
  const walls = wallMat ? wallTakeoff(r, wallTileHeight(r)) : null;
  return (
    <div className="field"><label>Takeoff</label>
      <div className="row" style={{ gap: 6 }}>
        <label className="mini">Tubs<input className="inp mono" type="number" min="0" step="1" value={fx.tubs}
          onChange={(e) => setFx({ tubs: Math.max(0, Math.floor(+e.target.value || 0)) })} /></label>
        <label className="mini" style={{ flex: 2 }}>Showers (SH)<input className="inp mono" placeholder="5x2.75" value={shText}
          onChange={(e) => setShText(e.target.value)} onBlur={() => { const sh = parseShowers(shText); setFx({ showers: sh }); setShText(showersText(sh)); }} /></label>
        {!traced && <label className="mini">Doors<input className="inp mono" type="number" min="0" step="1" value={fx.doors}
          title="Doors in this room's walls (traced rooms count their own)"
          onChange={(e) => setFx({ doors: Math.max(0, Math.floor(+e.target.value || 0)) })} /></label>}
      </div>
      {wallMat && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <select className="inp" value={mode} onChange={(e) => {
            const v = e.target.value;
            if (v === 'full') s.applyFinish(r.id, { wallTileHeight: null });
            else if (v === 'half') s.applyFinish(r.id, { wallTileHeight: 4 });
            else s.applyFinish(r.id, { wallTileHeight: Math.min(ceiling, th && th < ceiling ? th : 7) });
          }}>
            <option value="full">Walls fully tiled ({formatLength(ceiling, s.unitSystem)} ceiling)</option>
            <option value="half">{"Walls half tiled 4'-0\""}</option>
            <option value="custom">Walls tiled to a set height</option>
          </select>
          {mode === 'custom' && <DimInput value={th} system={s.unitSystem} onCommit={(h) => s.applyFinish(r.id, { wallTileHeight: Math.min(h, ceiling) })} />}
        </div>
      )}
      <div className="takeoff-math">
        <div><b>Floor</b> {floor.text}</div>
        {floor.showers.map((x, i) => <div key={i}><b>Shower floor</b> {showersText([x])} = {x.sf} SF</div>)}
        {walls && <div><b>Walls</b> {walls.text}</div>}
        {!walls && <div className="dim">Assign a wall tile to take off its walls.</div>}
      </div>
    </div>
  );
}

/* ---- Floor design: borders & inlays (not walls) ----
   The room outline is the walls. A border band is derived from those walls
   (distance from wall + width), so there is nothing to trace. An inlay /
   medallion / rug inset is traced or boxed on the floor with the design
   tools (D / I) and carved out of the field. */
function FloorDesign({ room: r }) {
  const s = useProject();
  const zones = zonesOf(r);
  const reg = roomRegions(r);
  const floorMats = s.materials.filter((m) => m.type !== 'wall');
  const roomSf = roomArea(r);
  const fa = (sf) => formatArea(sf, s.unitSystem);
  const start = (tool) => { s.select('room', r.id); s.setTool(tool); };
  return (
    <div className="field"><label>Floor design · borders &amp; inlays</label>
      {zones.length === 0 && (
        <div className="note" style={{ marginTop: 0 }}>
          The room outline is the walls. Add a <b>border</b> (follows the walls at a set distance) or
          trace an <b>inlay</b> — medallion, rug inset, feature panel — on the floor.
        </div>
      )}
      {zones.map((z) => <ZoneCard key={z.id} room={r} zone={z} reg={reg} floorMats={floorMats} />)}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="ghost-add" style={{ margin: 0, flex: 1 }} onClick={() => s.addZone(r.id, { kind: 'border', inset: 0, width: 0.5 })}>+ Border</button>
        <button className="ghost-add" style={{ margin: 0, flex: 1 }} title="Click points on the floor design; click the first point, double-click or Enter to finish (D)" onClick={() => start('zone_poly')}>Trace inlay</button>
        <button className="ghost-add" style={{ margin: 0, flex: 1 }} title="Drag a rectangle on the floor (I)" onClick={() => start('zone_rect')}>Box inlay</button>
      </div>
      {zones.length > 0 && s.scale && (
        <div className="note">Field {fa(reg.fieldArea)} = room {fa(roomSf)} − design {fa(Math.max(0, roomSf - reg.fieldArea))}</div>
      )}
      {reg.warnings.map((w) => <div className="note" key={w} style={{ color: 'var(--warn, #a8430f)' }}>⚠ {w}</div>)}
    </div>
  );
}

function ZoneCard({ room: r, zone: z, reg, floorMats }) {
  const s = useProject();
  const sel = s.selZone === z.id;
  const band = reg.bands.find((b) => b.zone.id === z.id);
  const inl = reg.inlays.find((i) => i.zone.id === z.id);
  const area = band?.area ?? inl?.area ?? 0;
  const up = (patch) => s.updateZone(r.id, z.id, patch);
  const rect = z.kind === 'inlay' && isAxisRect(z.points);
  const zb = z.kind === 'inlay' && z.points?.length ? bounds(z.points) : null;
  const layout = z.layout || { pattern: 'grid' };
  const setLayout = (patch) => up({ layout: { ...layout, ...patch } });
  return (
    <div className={'card' + (sel ? ' sel' : '')} style={{ margin: '6px 0' }}>
      <div className="card-head" onClick={() => s.selectZone(r.id, z.id)}>
        <span className="swatch" style={{ background: z.color }} />
        <input className="card-name" value={z.name} onClick={(e) => e.stopPropagation()} onChange={(e) => up({ name: e.target.value })} />
        <span className="card-meta">
          {s.scale ? <>{band ? `${formatLength(band.lf, s.unitSystem)} · ` : ''}{formatArea(area, s.unitSystem)}</> : '—'}
          {!band && !inl && ' (skipped)'}
        </span>
        <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); s.deleteZone(r.id, z.id); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
        </button>
      </div>
      {sel && (
        <div className="card-body">
          <div className="field"><label>Material</label>
            <select className="inp" value={z.materialId || ''} onChange={(e) => up({ materialId: e.target.value || null })}>
              <option value="">— not estimated —</option>
              {floorMats.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.tw}×{m.th}&quot;)</option>)}
            </select>
            {!z.materialId && <div className="note" style={{ marginTop: 4 }}>Pick a floor material — until then this area is removed from the field but not ordered.</div>}
            <button className="linkbtn" onClick={() => openLibrary({ zones: [{ roomId: r.id, zoneId: z.id }] })}>Pick from the library…</button>
          </div>

          {z.kind === 'border' && (
            <div className="field"><label>Distance from wall · band width</label>
              <div className="row">
                <DimInput value={z.inset || 0} system={s.unitSystem} allowZero onCommit={(v) => up({ inset: v })} />
                <div className="units" style={{ padding: '0 2px' }}>+</div>
                <DimInput value={z.width || 0} system={s.unitSystem} onCommit={(v) => up({ width: v })} />
              </div>
              <div className="note" style={{ marginTop: 4 }}>Runs around every wall of the room, including L-shapes. Stack several bands (e.g. a listello 12&quot; in) for a layered border.</div>
            </div>
          )}

          {z.kind === 'inlay' && (
            <>
              {rect && zb && s.scale && (
                <div className="field"><label>Size</label>
                  <div className="row">
                    <DimInput value={zb.w} system={s.unitSystem} onCommit={(w) => up({ points: rectPoly(zb.minx, zb.miny, w, zb.h) })} />
                    <div className="units" style={{ padding: '0 2px' }}>×</div>
                    <DimInput value={zb.h} system={s.unitSystem} onCommit={(h) => up({ points: rectPoly(zb.minx, zb.miny, zb.w, h) })} />
                  </div>
                </div>
              )}
              {zb && (
                <button className="ghost-add" style={{ margin: '4px 0' }} onClick={() => {
                  const rb = bounds(r.points);
                  const dx = rb.minx + rb.w / 2 - (zb.minx + zb.w / 2), dy = rb.miny + rb.h / 2 - (zb.miny + zb.h / 2);
                  up({ points: z.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
                }}>Center in room</button>
              )}
              {!rect && <div className="note" style={{ marginTop: 0 }}>{z.points?.length} points · drag its corners on the canvas to adjust.</div>}
              <div className="field"><label>Inlay pattern</label>
                <select className="inp" value={layout.pattern || 'grid'} onChange={(e) => setLayout({ pattern: e.target.value })}>
                  {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
              {(layout.pattern === 'grid' || layout.pattern?.startsWith('brick')) && (
                <div className="field"><label>Rotation (°)</label>
                  <input className="inp mono" type="number" step="5" value={layout.angleDeg || 0}
                    onChange={(e) => setLayout({ angleDeg: +e.target.value || 0 })} />
                </div>
              )}
              <div className="field"><label>Tiles start from</label>
                <div className="seg">
                  {[['corner', 'Corner'], ['center', 'Center (even cuts)']].map(([id, label]) => (
                    <button key={id} className={(layout.anchor || 'corner') === id ? 'on' : ''} onClick={() => setLayout({ anchor: id })}>{label}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="field"><label>Color</label>
            <div className="assign">
              {ZONE_COLORS.map((c) => (
                <button key={c} className={'pill' + (z.color === c ? ' on' : '')}
                  style={z.color === c ? { background: c, borderColor: c } : {}}
                  onClick={() => up({ color: c })}><span className="dot" style={{ background: c }} /></button>
              ))}
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

function DimInput({ value, system, onCommit, allowZero = false }) {
  const [txt, setTxt] = React.useState('');
  React.useEffect(() => { setTxt(formatLength(value, system).replace(/ (ft|in|m|cm|mm|m²|sf)$/, '')); }, [value, system]);
  return (
    <div className="units" style={{ flex: 1 }}>
      <input className="inp mono" value={txt} onChange={(e) => setTxt(e.target.value)}
        onBlur={() => { const ft = parseLength(txt, system); if (ft != null && (ft > 0 || (allowZero && ft === 0))) onCommit(ft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
    </div>
  );
}

/* ---------------- Materials ---------------- */
function MaterialsPanel() {
  const s = useProject();
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
      <button className="ghost-add" onClick={() => openLibrary({})}>+ From the library (finishes, sizes, My tiles)</button>
    </div>
  );
}

function MaterialCard({ m }) {
  const s = useProject();
  const open = s.selection.type === 'material' && s.selection.id === m.id;
  // every page's rooms use the material
  const est = useMemo(() => estimateMaterial(m, allRooms(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, s.rooms, s.pageData]);
  return (
    <div className={'card' + (open ? ' sel' : '')}>
      <div className="card-head" onClick={() => { s.select('material', m.id); if (m.type === 'floor') s.setGridMaterial(m.id); }}>
        <span className="swatch" style={{ background: m.color }} />
        <input className="card-name" value={m.name} onClick={(e) => e.stopPropagation()}
          onChange={(e) => s.updateMaterial(m.id, { name: e.target.value })} />
        <span className="card-meta">{m.tw}×{m.th}&quot;</span>
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

          <div className="field"><label>Pattern{m.type !== 'wall' ? ' (rooms follow it unless set otherwise)' : ''} & grout joint</label>
            <div className="pat-pick">
              {PATTERNS.map((p) => (
                <button key={p.id} className={'pat-opt' + ((m.pattern || 'grid') === p.id ? ' on' : '')} title={p.label}
                  onClick={() => s.updateMaterial(m.id, { pattern: p.id })}>
                  <PatternSwatch tw={m.tw} th={m.th} grout={m.grout} pattern={p.id} color={m.color} size={38} />
                  <span>{p.label.replace(/\s*\(.*\)/, '').replace('Brick / running', 'Running')}</span>
                </button>
              ))}
            </div>
            <select className="inp" style={{ marginTop: 7 }} value={m.grout} onChange={(e) => s.updateMaterial(m.id, { grout: +e.target.value })}>
              <option value={0}>No joint (butted planks)</option>
              {GROUT_JOINTS.map((j) => <option key={j.id} value={j.in}>{j.label}</option>)}
              {+m.grout > 0 && !GROUT_JOINTS.some((j) => j.in === +m.grout) && <option value={m.grout}>{m.grout}″</option>}
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
            <div className="est-row" style={{ padding: '5px 0' }}><span>+{pct(est.wastePct ?? m.waste)}% waste{wasteMixed(est, m) ? ' (by room pattern)' : ''}</span><b>{est.grossSf.toFixed(1)} sf</b></div>
            <div className="est-row" style={{ padding: '5px 0' }}><span>Tiles</span><b>{est.tiles}</b></div>
            <div className="est-row hi" style={{ padding: '6px 8px', borderRadius: 5 }}><span>Cost</span><b>{money(est.cost)}</b></div>
          </div>
          <div className="row" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="ghost-add" style={{ margin: 0 }} onClick={() => openLibrary({ itemKey: `mat:${m.id}` })}>Lay in rooms…</button>
            <button className="ghost-add" style={{ margin: 0 }} onClick={() => saveToLibrary(m)}>Save to My tiles</button>
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
  const s = useProject();
  const sum = summarizeMarkups(s.markups);
  return (
    <div className="panel">
      <OtherPages what="markups" />
      {!s.scale && <div className="empty"><b>Set the scale first</b>Markup measurements need a calibrated scale. Use the Ruler tool.</div>}
      {s.markups.length === 0 && s.scale && (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 17L17 3M14 3h4v4" /></svg>
          <b>No markups yet</b>Use the measure tools (length, area, box, ellipse, count) plus arrow &amp; text annotations in the toolbar to take off quantities directly on the plan.
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
  const s = useProject();
  const open = s.selection.type === 'markup' && s.selection.id === mk.id;
  const measured = isMeasured(mk.type);
  const val = markupValue(mk);
  const unit = markupUnit(mk);
  const dims = markupDims(mk);
  const valStr = !measured ? ''
    : mk.type === 'length' ? fmtLen(val, s.unitSystem)
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
          {mk.type === 'text' && (
            <div className="field"><label>Text</label>
              <input className="inp" value={mk.name} onChange={(e) => s.updateMarkup(mk.id, { name: e.target.value })} /></div>
          )}
          {measured && <div className="est-row" style={{ padding: '5px 0' }}><span>Measured</span><b>{valStr}</b></div>}
          {dims && <div className="est-row" style={{ padding: '5px 0' }}><span>Dimensions</span><b>{fmtLen(dims.w, s.unitSystem)} × {fmtLen(dims.h, s.unitSystem)}</b></div>}
          {measured && (
            <>
              <div className="field"><label>Unit cost (${unit === 'ea' ? 'each' : `per ${unit}`})</label>
                <div className="units"><span>$</span><input className="inp mono" type="number" step="0.01" value={mk.unitCost || 0}
                  onChange={(e) => s.updateMarkup(mk.id, { unitCost: Math.max(0, +e.target.value || 0) })} /></div>
              </div>
              {mk.unitCost > 0 && <div className="est-row hi" style={{ padding: '6px 8px', borderRadius: 5 }}><span>Line cost</span><b>{money(markupCost(mk))}</b></div>}
            </>
          )}
          <div className="field"><label>Note</label>
            <input className="inp" value={mk.note || ''} placeholder="optional" onChange={(e) => s.updateMarkup(mk.id, { note: e.target.value })} /></div>
        </div>
      )}
    </div>
  );
}

// waste % as shown: whole numbers stay whole, mixes show one decimal
const pct = (v) => (+v).toFixed(1).replace(/\.0$/, '');
// true when some room lays this tile in another pattern, so the waste is a blend
const wasteMixed = (est, m) => (est.usedRooms || []).some((u) => u.pattern && u.pattern !== 'border' && u.pattern !== (m.pattern || 'grid'));

/* ---------------- Estimate ---------------- */
function EstimatePanel() {
  const s = useProject();
  // the cut optimizer can be heavy: recompute only when the inputs change
  // the whole job: every page's rooms
  const e = useMemo(() => estimateProject(wholeProject(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.rooms, s.pageData, s.materials, s.taxRate, s.laborRatePerSf]);
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
            {(l.usedRooms || []).length > 0 && (
              <details className="est-rooms">
                <summary>{l.usedRooms.length} room{l.usedRooms.length > 1 ? 's' : ''} — how each was taken off</summary>
                {l.usedRooms.map((u, i) => <div key={i}><b>{u.name}</b> {u.text || `${u.sf} SF`}</div>)}
              </details>
            )}
            {(l.usedRooms || []).some((u) => u.lf) && (
              <div className="est-row"><span>Border run</span><b>{fmtLen((l.usedRooms || []).reduce((a, u) => a + (u.lf || 0), 0), s.unitSystem)}</b></div>
            )}

            {l.costMode === 'waste' && (
              <>
                <div className="est-row"><span>With {pct(l.wastePct ?? m.waste)}% waste{wasteMixed(l, m) ? ' (by room pattern)' : ''}</span><b>{l.grossSf.toFixed(1)} sf</b></div>
                <div className="est-row"><span>Tiles ({m.tw}×{m.th}&quot;)</span><b>{l.tiles}</b></div>
              </>
            )}

            {l.costMode === 'cuts' && ci && (
              <>
                <div className="est-row"><span>Full tiles</span><b>{ci.fullTiles}</b></div>
                <div className="est-row"><span>Cut pieces needed</span><b>{ci.cutPieces}</b></div>
                <div className="est-row"><span>Tiles broken for cuts</span><b>{ci.newTilesBrokenForCuts}</b></div>
                {ci.border?.tiles > 0 && (
                  <div className="est-row"><span>Border strips ({ci.border.strips} pcs)</span><b>{ci.border.tiles} tiles</b></div>
                )}
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
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => window.dispatchEvent(new Event('tt:export-marked'))}>Marked PDF</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportCSV(s)}>CSV</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportXLSX(s)}>Excel</button>
        <button className="ghost-add" style={{ margin: 0 }} onClick={() => exportJSON(s)}>JSON</button>
      </div>
      <button className="ghost-add" style={{ marginTop: 8 }} onClick={() => {
        const fmt = (ft) => fmtLen(ft, s.unitSystem);
        const sheets = buildProjectCutSheets(wholeProject(s), fmt);
        if (!sheets.length) { window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Assign a floor material to rooms first' } })); return; }
        openCutSheet(wholeProject(s), sheets);
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><path d="M6 2h9l5 5v15H6zM15 2v5h5M9 13h6M9 17h6M9 9h2" /></svg>
        Installer cut sheet
      </button>
      <div className="note">Order quantities include each material&rsquo;s waste allowance. Wall tile uses perimeter × wall height as a coverage proxy. Verify field conditions before ordering.</div>
    </div>
  );
}

// local bounds (avoid extra import churn)
function bounds(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}
