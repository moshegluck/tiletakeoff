// ============================================================
// Library — pick a tile, choose how it is laid, and lay it in rooms.
// Catalog finishes and sizes, your saved tiles (account or this device) and
// the project's materials, each with a true-geometry pattern preview. The
// chosen tile becomes one priced material; the rooms / design zones ticked
// get it in the pattern chosen (store.applyTile).
// ============================================================
import { useEffect, useMemo, useState } from 'react';
import { useProject } from '../state/store.js';
import { PATTERNS } from '../engine/layouts.js';
import { patternLabel } from '../engine/patterns.js';
import { GROUT_JOINTS } from '../data/tileCatalog.js';
import { catalogItems, materialItem, listMine, saveMine, deleteMine } from '../lib/library.js';
import { roomArea } from '../engine/geometry.js';
import { formatArea } from '../engine/units.js';
import PatternSwatch from './PatternSwatch.jsx';
import Modal from './Modal.jsx';
import { useBackLayer } from '../lib/backStack.js';

const FILTERS = [
  { id: 'all', label: 'All' }, { id: 'floor', label: 'Floor' }, { id: 'wall', label: 'Wall' },
  { id: 'mine', label: 'My tiles' }, { id: 'project', label: 'In this project' },
];
const SOURCE_LABEL = { catalog: 'Catalog', size: 'Size', mine: 'My tiles', device: 'This device', project: 'Project' };
const money = (v) => `$${(+v || 0).toFixed(2)}`;
const size = (it) => `${+it.tw}×${+it.th}"`;
const toast = (msg, ok = true) => window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg, ok } }));

/**
 * @param {{ onClose: () => void, target?: { rooms?: string[], zones?: {roomId:string,zoneId:string}[], itemKey?: string } }} p
 */
export default function Library({ onClose, target }) {
  const s = useProject();
  const [mine, setMine] = useState({ items: [], cloud: false, loading: true });
  const [filter, setFilter] = useState(target?.zones?.length ? 'floor' : 'all');
  const [q, setQ] = useState('');
  const [selKey, setSelKey] = useState(target?.itemKey || null);
  const [draft, setDraft] = useState(null);
  const [roomSel, setRoomSel] = useState(() => new Set(target?.rooms || (target?.zones ? [] : s.selRooms)));
  const [zoneSel, setZoneSel] = useState(() => new Set((target?.zones || []).map((z) => `${z.roomId}|${z.zoneId}`)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refreshMine = () => listMine()
    .then((r) => setMine({ ...r, loading: false }))
    .catch((e) => { setMine({ items: [], cloud: false, loading: false }); setErr(e.message); });
  useEffect(() => { refreshMine(); }, []);

  const catalog = useMemo(() => catalogItems(), []);
  const project = useMemo(() => s.materials.map(materialItem), [s.materials]);
  const all = useMemo(() => [...project, ...mine.items, ...catalog], [project, mine.items, catalog]);

  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((it) => {
      if (filter === 'floor' && it.kind !== 'floor') return false;
      if (filter === 'wall' && it.kind !== 'wall') return false;
      if (filter === 'mine' && it.source !== 'mine' && it.source !== 'device') return false;
      if (filter === 'project' && it.source !== 'project') return false;
      const hay = `${it.name} ${size(it)} ${it.vendor || ''} ${it.sku || ''} ${patternLabel(it.pattern)} ${it.group || ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [all, filter, q]);

  // keep the draft in step with the selected item (a fresh copy to edit)
  useEffect(() => {
    if (!selKey) { setDraft(null); return; }
    const it = all.find((x) => x.key === selKey);
    if (it && (!draft || draft.key !== it.key)) setDraft({ ...it });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, all]);
  const sel = draft;
  // on a phone the tile's page sits over the list: Back returns to the list
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  useBackLayer(!!selKey && phone, () => setSelKey(null));
  const up = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const floorZones = useMemo(() => s.rooms.flatMap((r) => (r.zones || []).map((z) => ({ room: r, zone: z }))), [s.rooms]);
  const nRooms = roomSel.size, nZones = sel?.kind === 'floor' ? zoneSel.size : 0;
  const toggle = (set, setter, key) => { const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); setter(n); };
  const tileIn = (r, kind) => s.materials.find((m) => r.assigned.includes(m.id) && (m.type === 'wall' ? 'wall' : 'floor') === kind);

  function apply() {
    if (!sel) return;
    const res = s.applyTile(sel, { rooms: [...roomSel], zones: [...zoneSel].map((k) => { const [roomId, zoneId] = k.split('|'); return { roomId, zoneId }; }) });
    const where = [res.rooms && `${res.rooms} room${res.rooms > 1 ? 's' : ''}`, res.zones && `${res.zones} design zone${res.zones > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    toast(where ? `${sel.name} laid in ${where} · ${patternLabel(sel.pattern)}` : `${sel.name} added to the project`);
    onClose();
  }
  async function save() {
    if (!sel) return;
    setBusy(true); setErr('');
    try {
      const saved = await saveMine(sel);
      await refreshMine();
      setSelKey(saved.key); setDraft({ ...saved });
      toast(saved.source === 'mine' ? 'Saved to your library' : 'Saved to this device’s library — sign in to keep it in your account');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!sel || !confirm(`Remove “${sel.name}” from your library?`)) return;
    setBusy(true); setErr('');
    try { await deleteMine(sel); await refreshMine(); setSelKey(null); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const isMine = sel && (sel.source === 'mine' || sel.source === 'device');
  const applyLabel = nRooms + nZones
    ? `Lay in ${[nRooms && `${nRooms} room${nRooms > 1 ? 's' : ''}`, nZones && `${nZones} zone${nZones > 1 ? 's' : ''}`].filter(Boolean).join(' + ')}`
    : 'Add to project';

  return (
    <Modal title="Tile library" className="lib" onClose={onClose}>
        <div className={'lib-body' + (sel ? ' has-sel' : '')}>
          {/* ---- browse ---- */}
          <section className="lib-list">
            <input className="inp" type="search" placeholder="Search tiles, sizes, vendors…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="lib-filters">
              {FILTERS.map((f) => <button key={f.id} className={'pill' + (filter === f.id ? ' on lib-on' : '')} onClick={() => setFilter(f.id)}>{f.label}</button>)}
            </div>
            {filter === 'mine' && !mine.loading && !mine.items.length && (
              <div className="note">No saved tiles yet. Pick any tile, set it up, and choose <b>Save to My tiles</b>.</div>
            )}
            <div className="lib-grid">
              {shown.map((it) => (
                <button key={it.key} className={'lib-card' + (selKey === it.key ? ' on' : '')} onClick={() => setSelKey(it.key)}>
                  <PatternSwatch tw={it.tw} th={it.th} grout={it.grout} pattern={it.pattern} angleDeg={it.angleDeg} color={it.color} size={56} />
                  <span className="lib-card-txt">
                    <b>{it.name}</b>
                    <small>{size(it)} · {patternLabel(it.pattern)}{it.price ? ` · ${money(it.price)}/${it.priceUnit}` : ''}</small>
                    <em className={'lib-src ' + it.source}>{SOURCE_LABEL[it.source]}{it.kind === 'wall' ? ' · wall' : ''}</em>
                  </span>
                </button>
              ))}
              {!shown.length && <div className="note">Nothing matches.</div>}
            </div>
          </section>

          {/* ---- set up & lay ---- */}
          {sel && (
            <section className="lib-detail">
              <button className="lib-back" onClick={() => setSelKey(null)}>‹ All tiles</button>
              <div className="lib-hero">
                <PatternSwatch tw={+sel.tw} th={+sel.th} grout={+sel.grout} pattern={sel.pattern} angleDeg={+sel.angleDeg || 0} color={sel.color} size={168} />
                <div className="lib-hero-meta">
                  <input className="inp lib-name" value={sel.name} onChange={(e) => up({ name: e.target.value })} aria-label="Tile name" />
                  <div className="lib-kind">
                    {['floor', 'wall'].map((k) => <button key={k} className={'pill' + (sel.kind === k ? ' on lib-on' : '')} onClick={() => up({ kind: k })}>{k === 'floor' ? 'Floor tile' : 'Wall tile'}</button>)}
                  </div>
                  <div className="row lib-row">
                    <label>W″<input className="inp mono" type="number" min="0.25" step="0.25" value={sel.tw} onChange={(e) => up({ tw: Math.max(0.25, +e.target.value || 0.25) })} /></label>
                    <span>×</span>
                    <label>H″<input className="inp mono" type="number" min="0.25" step="0.25" value={sel.th} onChange={(e) => up({ th: Math.max(0.25, +e.target.value || 0.25) })} /></label>
                    <label>Grout<select className="inp" value={sel.grout} onChange={(e) => up({ grout: +e.target.value })}>
                      <option value={0}>None</option>
                      {GROUT_JOINTS.map((g) => <option key={g.id} value={g.in}>{g.label}</option>)}
                      {!GROUT_JOINTS.some((g) => g.in === +sel.grout) && +sel.grout > 0 && <option value={sel.grout}>{sel.grout}″</option>}
                    </select></label>
                    <label className="lib-color">Color<input type="color" value={/^#[0-9a-f]{6}$/i.test(sel.color || '') ? sel.color : '#d9d3c7'} onChange={(e) => up({ color: e.target.value })} /></label>
                  </div>
                </div>
              </div>

              <div className="field"><label>Pattern</label>
                <div className="lib-patterns">
                  {PATTERNS.map((p) => (
                    <button key={p.id} className={'lib-pat' + (sel.pattern === p.id ? ' on' : '')} onClick={() => up({ pattern: p.id })} title={p.label}>
                      <PatternSwatch tw={+sel.tw} th={+sel.th} grout={+sel.grout} pattern={p.id} color={sel.color} size={52} />
                      <span>{p.label.replace(/\s*\(.*\)/, '')}</span>
                    </button>
                  ))}
                </div>
                {PATTERNS.find((p) => p.id === sel.pattern)?.hasAngle && (
                  <div className="row lib-row" style={{ marginTop: 6 }}>
                    <label>Rotation°<input className="inp mono" type="number" step="5" value={sel.angleDeg || 0} onChange={(e) => up({ angleDeg: +e.target.value || 0 })} /></label>
                    <span className="note" style={{ margin: 0 }}>Waste default for this pattern is applied to the rooms that use it.</span>
                  </div>
                )}
              </div>

              <div className="row lib-row">
                <label>Price<input className="inp mono" type="number" min="0" step="0.01" value={sel.price} onChange={(e) => up({ price: Math.max(0, +e.target.value || 0) })} /></label>
                <label>per<select className="inp" value={sel.priceUnit} onChange={(e) => up({ priceUnit: e.target.value })}>
                  <option value="sf">sf</option><option value="tile">tile</option><option value="box">box</option>
                </select></label>
                {sel.priceUnit === 'box' && <label>sf/box<input className="inp mono" type="number" min="0.1" step="0.1" value={sel.sfPerBox || 15} onChange={(e) => up({ sfPerBox: Math.max(0.1, +e.target.value || 1) })} /></label>}
                <label>Vendor<input className="inp" value={sel.vendor || ''} onChange={(e) => up({ vendor: e.target.value })} /></label>
                <label>SKU<input className="inp" value={sel.sku || ''} onChange={(e) => up({ sku: e.target.value })} /></label>
              </div>

              <div className="field"><label>Lay it in {s.rooms.length ? '' : '(draw or trace rooms first)'}</label>
                {s.rooms.length > 0 && (
                  <>
                    <div className="lib-quick">
                      <button onClick={() => setRoomSel(new Set(s.rooms.map((r) => r.id)))}>All rooms</button>
                      <button onClick={() => setRoomSel(new Set(s.rooms.filter((r) => !tileIn(r, sel.kind)).map((r) => r.id)))}>Rooms without a {sel.kind} tile</button>
                      {s.selRooms.length > 0 && <button onClick={() => setRoomSel(new Set(s.selRooms))}>Selected on plan ({s.selRooms.length})</button>}
                      <button onClick={() => { setRoomSel(new Set()); setZoneSel(new Set()); }}>None</button>
                    </div>
                    <div className="lib-targets">
                      {s.rooms.map((r) => {
                        const cur = tileIn(r, sel.kind);
                        return (
                          <label key={r.id} className={'lib-target' + (roomSel.has(r.id) ? ' on' : '')}>
                            <input type="checkbox" checked={roomSel.has(r.id)} onChange={() => toggle(roomSel, setRoomSel, r.id)} />
                            <span className="swatch" style={{ background: r.color }} />
                            <b>{r.name}</b>
                            <small>{s.scale ? formatArea(roomArea(r), s.unitSystem) : ''}{cur ? ` · now ${cur.name}` : ''}</small>
                          </label>
                        );
                      })}
                      {sel.kind === 'floor' && floorZones.map(({ room: r, zone: z }) => {
                        const key = `${r.id}|${z.id}`;
                        return (
                          <label key={key} className={'lib-target zone' + (zoneSel.has(key) ? ' on' : '')}>
                            <input type="checkbox" checked={zoneSel.has(key)} onChange={() => toggle(zoneSel, setZoneSel, key)} />
                            <span className="swatch" style={{ background: z.color }} />
                            <b>{r.name} · {z.name}</b>
                            <small>{z.kind === 'border' ? 'border band' : 'inlay'}</small>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
            </section>
          )}
          {!sel && <section className="lib-detail lib-empty"><div className="note">Pick a tile to see it laid in each pattern, set it up, and lay it in your rooms.</div></section>}
        </div>
        <div className="foot">
          <span className="lib-foot-note">{mine.cloud ? 'My tiles are saved to your account.' : 'My tiles are saved on this device — sign in to keep them in your account.'}</span>
          {isMine && <button className="tbtn" disabled={busy} onClick={remove}>Remove</button>}
          {sel && <button className="tbtn" disabled={busy} onClick={save}>{isMine ? 'Save changes' : 'Save to My tiles'}</button>}
          <button className="tbtn" onClick={onClose}>Close</button>
          {sel && <button className="tbtn primary" onClick={apply}>{applyLabel}</button>}
        </div>
    </Modal>
  );
}
