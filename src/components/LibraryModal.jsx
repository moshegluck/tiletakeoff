import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../state/store.js';
import { listTiles, addTile, deleteTile } from '../lib/cloud.js';

// Shared tile library (Supabase-backed, RLS-scoped per user). Save tile specs
// once, reuse them across projects. Rows come from the `tile_library` table.
export default function LibraryModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', tw_in: '', th_in: '', price: '', price_unit: 'sf',
    sf_per_box: '', vendor: '', sku: '',
  });

  const refresh = useCallback(() => {
    listTiles().then(setRows).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const field = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const blank = () => setForm({ name: '', tw_in: '', th_in: '', price: '', price_unit: 'sf', sf_per_box: '', vendor: '', sku: '' });

  async function save() {
    if (!form.name.trim()) { setErr('Give the tile a name.'); return; }
    setBusy(true); setErr('');
    try { await addTile(form); blank(); refresh(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function saveSelectedMaterial() {
    const s = useStore.getState();
    const m = s.materials.find((x) => x.id === s.selection.id) || s.materials[0];
    if (!m) { setErr('Add or select a material in the project first.'); return; }
    setBusy(true); setErr('');
    try {
      await addTile({ name: m.name, tw_in: m.tw, th_in: m.th, price: m.price, price_unit: m.priceUnit, sf_per_box: m.sfPerBox });
      refresh();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove(id, e) {
    e.stopPropagation();
    try { await deleteTile(id); refresh(); } catch (e2) { setErr(e2.message); }
  }

  function use(t) {
    useStore.getState().addMaterialFromTile(t);
    onClose();
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Added “${t.name}” to the project`, ok: true } }));
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Tile library</h3>
        <div className="body">
          {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}

          <div className="field"><label>Add a tile</label>
            <input className="inp" placeholder="Name (e.g. Carrara 12×24 Porcelain)" value={form.name} onChange={field('name')} />
            <div className="row" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input className="inp mono" type="number" step="0.25" placeholder="W in" value={form.tw_in} onChange={field('tw_in')} />
              <input className="inp mono" type="number" step="0.25" placeholder="H in" value={form.th_in} onChange={field('th_in')} />
              <input className="inp mono" type="number" step="0.01" placeholder="Price" value={form.price} onChange={field('price')} />
              <select className="inp" value={form.price_unit} onChange={field('price_unit')} style={{ maxWidth: 92 }}>
                <option value="sf">/sf</option><option value="tile">/tile</option><option value="box">/box</option>
              </select>
            </div>
            <div className="row" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input className="inp" placeholder="Vendor" value={form.vendor} onChange={field('vendor')} />
              <input className="inp" placeholder="SKU" value={form.sku} onChange={field('sku')} />
              <input className="inp mono" type="number" step="0.1" placeholder="SF/box" value={form.sf_per_box} onChange={field('sf_per_box')} style={{ maxWidth: 92 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="tbtn primary" disabled={busy} onClick={save}>Add to library</button>
              <button className="tbtn" disabled={busy} onClick={saveSelectedMaterial}>Save selected material</button>
            </div>
          </div>

          <div style={{ height: 12 }} />

          {!rows && <div className="note">Loading…</div>}
          {rows && rows.length === 0 && <div className="note">No saved tiles yet. Add one above, or save a material from your project.</div>}
          {rows && rows.map((t) => {
            const meta = [
              `${t.tw_in}×${t.th_in} in`,
              t.price != null ? `$${Number(t.price).toFixed(2)}/${t.price_unit}` : null,
              t.vendor, t.sku,
            ].filter(Boolean).join(' · ');
            return (
              <div className="det-row" key={t.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: '#8b97a3', fontFamily: 'var(--mono)' }}>{meta}</div>
                </div>
                <button className="tbtn" onClick={() => use(t)}>Use</button>
                <button className="icon-btn" onClick={(e) => remove(t.id, e)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
                </button>
              </div>
            );
          })}
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
