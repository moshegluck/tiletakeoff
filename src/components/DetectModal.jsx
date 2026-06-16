import React, { useState } from 'react';
import { useStore } from '../state/store.js';
import { detectRooms } from '../lib/aiDetect.js';
import { rectPoly } from '../engine/geometry.js';

// Hybrid detection: upload plan -> AI proposes rooms -> user reviews,
// edits dimensions, toggles which to keep -> commit to canvas.
export default function DetectModal({ onClose }) {
  const s = useStore();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rooms, setRooms] = useState(null); // proposed
  const [ppf, setPpf] = useState(s.scale ? Math.round(1 / s.scale) : '');

  async function run() {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      const r = await detectRooms(file, ppf ? +ppf : undefined);
      setRooms(r.map((x) => ({ ...x, keep: true })));
      if (!r.length) setErr('No rooms detected. Try a clearer image or set pixels-per-foot.');
    } catch (e) {
      setErr(e.message + '  — is ANTHROPIC_API_KEY set on the server?');
    } finally { setBusy(false); }
  }

  function commit() {
    if (!s.scale) {
      // adopt a default scale so the rooms render; user can recalibrate
      s.setScale(1 / (ppf ? +ppf : 20));
    }
    let added = 0;
    rooms.filter((r) => r.keep).forEach((r) => {
      s.addRoom(rectPoly(r.x || 0, r.y || 0, Math.max(1, r.w), Math.max(1, r.h)), r.name);
      added++;
    });
    // store the plan image as underlay
    if (file) {
      const rd = new FileReader();
      rd.onload = () => s.setPlanImage(rd.result);
      rd.readAsDataURL(file);
    }
    onClose();
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `${added} rooms added`, ok: true } }));
    setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 100);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>AI floor-plan detection</h3>
        <div className="body">
          {!rooms && (
            <>
              <label className="drop" htmlFor="planfile">
                {file ? <b>{file.name}</b> : 'Click to choose a floor-plan image (PNG/JPG). The plan is sent to your server route, analyzed by Claude, and returned as editable rooms.'}
              </label>
              <input id="planfile" type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                onChange={(e) => setFile(e.target.files?.[0] || null)} />
              <div className="field"><label>Pixels per foot (optional — improves accuracy)</label>
                <input className="inp mono" type="number" value={ppf} placeholder="e.g. 20"
                  onChange={(e) => setPpf(e.target.value)} />
              </div>
              {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
            </>
          )}
          {rooms && (
            <>
              <div className="note" style={{ marginTop: 0 }}>Review and edit. Untick any false positives. Dimensions are in feet.</div>
              {rooms.map((r, i) => (
                <div className="det-row" key={i}>
                  <input type="checkbox" checked={r.keep} style={{ width: 'auto' }}
                    onChange={(e) => setRooms(rooms.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x))} />
                  <input value={r.name} style={{ width: 110 }}
                    onChange={(e) => setRooms(rooms.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <input type="number" step="0.5" value={r.w}
                    onChange={(e) => setRooms(rooms.map((x, j) => j === i ? { ...x, w: +e.target.value } : x))} />
                  <span style={{ color: '#9aa6b1' }}>×</span>
                  <input type="number" step="0.5" value={r.h}
                    onChange={(e) => setRooms(rooms.map((x, j) => j === i ? { ...x, h: +e.target.value } : x))} />
                  <span className={'conf ' + (r.confidence >= 0.7 ? 'hi' : 'lo')}>{Math.round((r.confidence ?? 0.5) * 100)}%</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose}>Cancel</button>
          {!rooms && <button className="tbtn primary" disabled={!file || busy} onClick={run}>{busy ? 'Analyzing…' : 'Detect rooms'}</button>}
          {rooms && <button className="tbtn primary" onClick={commit}>Add {rooms.filter((r) => r.keep).length} rooms</button>}
        </div>
      </div>
    </div>
  );
}
