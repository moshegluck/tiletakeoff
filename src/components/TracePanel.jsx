import { useEffect, useRef, useState } from 'react';
import { useStore, useProject, defaultTrace } from '../state/store.js';
import { formatArea, formatLength, ARCH_SCALES } from '../engine/units.js';

const SEV = { error: 0, warn: 1, info: 2 };
const SEV_LABEL = { error: 'Needs input', warn: 'Check', info: 'Note' };

// "2 openings · 1 window": windows are listed but never taken off wall LF
function openingsTag(ops) {
  const w = ops.filter((o) => o.type === 'window').length, n = ops.length - w;
  return [n && `${n} opening${n > 1 ? 's' : ''}`, w && `${w} window${w > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
}

export default function TracePanel() {
  const s = useProject();
  const tr = s.trace || defaultTrace();
  const res = tr.result;
  const [err, setErr] = useState('');
  const [sheet, setSheet] = useState(null);     // detected sheet scale
  const [showInfo, setShowInfo] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const hasPlan = !!(s.pdfDoc || s.planImage);
  const editsKey = `${tr.manual.length}:${tr.removed.length}:${JSON.stringify(tr.region)}:${tr.settings.floorAtDoor}:${tr.settings.maxOpening}`;
  const lastEdits = useRef(editsKey);
  const runSeq = useRef(0);
  const pending = useRef(false);

  // read the sheet once a plan is loaded: is there a scale note?
  useEffect(() => {
    let alive = true;
    setSheet(null);
    if (!s.pdfDoc) return;
    (async () => {
      try {
        const { readPlan } = await import('../lib/traceClient.js');
        const { sheetScale } = await readPlan(useStore.getState());
        if (!alive) return;
        setSheet(sheetScale);
        // the sheet states its scale and none is set yet → just use it (each
        // page keeps its own scale; a page opened for the first time reads
        // its sheet in App)
        const st = useStore.getState();
        if (sheetScale && !st.scale) {
          st.setScale(sheetScale.scale); st.setArchScale(sheetScale.id);
          window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Scale read from sheet · ${sheetScale.label}`, ok: true } }));
        }
      } catch (_) { /* reading is best-effort */ }
    })();
    return () => { alive = false; };
  }, [s.pdfDoc, s.pdfPage, s.planDpi]);

  async function run() {
    const st = useStore.getState();
    if (!st.scale) { setErr('Set the scale first (use the sheet scale below, a preset, or the ruler).'); return; }
    // one solve at a time; a fix made mid-solve re-runs right after, never lost
    if (st.traceBusy) { pending.current = true; return; }
    const my = ++runSeq.current;
    const page = st.pdfPage;
    setErr(''); st.setTraceBusy(true);
    try {
      const cur = st.trace || defaultTrace();
      const { runPlanTrace } = await import('../lib/traceClient.js');
      const { result, evidence, input } = await runPlanTrace(st, {
        region: cur.region,
        options: { floorAtDoor: cur.settings.floorAtDoor, maxOpening: cur.settings.maxOpening },
        manual: cur.manual, removed: cur.removed,
      });
      // a newer run, or the user went to another page meanwhile: this result is stale
      if (my !== runSeq.current || useStore.getState().pdfPage !== page) return;
      // carry over names the user (or AI) already gave rooms in a previous run
      const names = cur.names || {};
      for (const r of result.rooms) { const k = nameKey(r); if (names[k]) { r.name = names[k]; } }
      // a new model: an earlier AI check was of the old one
      st.setTrace({ result, aiReview: null, source: { mode: evidence.mode, page: st.pdfPage, stats: evidence.stats, input, at: Date.now() } });
      st.setShowTrace(true);
      if (cur.settings.ceilingHeight == null) st.setTraceSettings({ ceilingHeight: 8 });
      if (result.schedule?.doorHeight && !cur.settings.doorHeightSet) st.setTraceSettings({ doorHeight: result.schedule.doorHeight });
    } catch (e) {
      setErr(e.message || 'Trace failed');
    } finally {
      st.setTraceBusy(false);
      if (pending.current) { pending.current = false; setTimeout(run, 0); }
    }
  }

  // re-solve after a manual fix (add / erase wall, region change)
  useEffect(() => {
    if (lastEdits.current === editsKey) return;
    lastEdits.current = editsKey;
    if (res) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editsKey]);

  function applySheetScale() {
    if (!sheet) return;
    s.setScale(sheet.scale); s.setArchScale(sheet.id);
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Scale set from sheet · ${sheet.label}`, ok: true } }));
  }

  function focus(type, id, at) {
    s.setTraceFocus({ type, id });
    if (at) window.dispatchEvent(new CustomEvent('tt:zoomto', { detail: at }));
  }

  async function aiName() {
    setAiBusy(true); setErr('');
    try {
      const { labelRoomsWithAI } = await import('../lib/aiLabel.js');
      const st = useStore.getState();
      const page = st.pdfPage;
      const out = await labelRoomsWithAI(st, res.rooms);
      if (useStore.getState().pdfPage !== page) return;   // went to another page meanwhile
      const names = { ...(st.trace.names || {}) };
      const rooms = res.rooms.map((r) => {
        const n = out[r.id];
        if (!n) return r;
        names[nameKey(r)] = n.name;
        return { ...r, name: n.name, type: n.type || r.type };
      });
      st.setTrace({ result: { ...res, rooms }, names });
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `AI named ${Object.keys(out).length} rooms`, ok: true } }));
    } catch (e) { setErr(e.message || 'AI naming failed'); }
    finally { setAiBusy(false); }
  }

  // the AI looks at the drawing with the model on it and says where they disagree
  async function aiCheck() {
    setCheckBusy(true); setErr('');
    try {
      const { reviewTraceWithAI } = await import('../lib/aiReview.js');
      const st = useStore.getState();
      const page = st.pdfPage, result = st.trace?.result;
      const out = await reviewTraceWithAI(st);
      const now = useStore.getState();
      if (now.pdfPage !== page || now.trace?.result !== result) return;   // the model changed meanwhile
      now.setTrace({ aiReview: out });
      const n = out.flags.length;
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: out.warning || (n ? `AI check: ${n} thing${n > 1 ? 's' : ''} to look at — listed under What needs a look` : 'AI check: the model matches the drawing'), ok: !out.warning } }));
    } catch (e) { setErr(e.message || 'AI check failed'); }
    finally { setCheckBusy(false); }
  }

  function renameRoom(r, name) {
    const names = { ...(tr.names || {}), [nameKey(r)]: name };
    s.setTrace({ result: { ...res, rooms: res.rooms.map((x) => (x.id === r.id ? { ...x, name } : x)) }, names });
  }

  function commit() {
    const n = s.commitTrace();
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `${n} rooms sent to the takeoff`, ok: true } }));
  }

  if (!hasPlan) {
    return (
      <div className="panel">
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" /></svg>
          <b>Load a plan to trace</b>
          Open a PDF (CAD export or scan). The tracer rebuilds the walls as a connected model, closes every room, and takes the numbers from that model — not from the pixels.
        </div>
      </div>
    );
  }

  // the engine's flags, then what the AI check found (never mixed into the numbers)
  const ai = tr?.aiReview;
  const flags = res ? [...res.flags, ...(ai?.flags || [])].sort((a, b) => SEV[a.severity] - SEV[b.severity]) : [];
  const aiRooms = new Set((ai?.flags || []).map((f) => f.roomId).filter(Boolean));
  const aiOk = new Set(ai?.okIds || []);
  const mainFlags = flags.filter((f) => f.severity !== 'info');
  const infoFlags = flags.filter((f) => f.severity === 'info');
  const u = s.unitSystem;
  const focusId = s.traceFocus?.id;

  return (
    <div className="panel trace-panel">
      {/* ---- setup ---- */}
      <div className="tr-sec">
        <div className="tr-row">
          <span className="tr-k">Scale</span>
          <span className="tr-v">{s.scale ? (s.archScale ? ARCH_SCALES.find((a) => a.id === s.archScale)?.label : 'custom (ruler)') : <em className="bad">not set</em>}</span>
        </div>
        {sheet && (!s.scale || s.archScale !== sheet.id) && (
          <button className="tr-suggest" onClick={applySheetScale}>
            Sheet says <b>{sheet.label}</b> — use it
          </button>
        )}
        <div className="tr-grid">
          <label>Ceiling height
            <input className="inp mono" type="number" step="0.25" min="6" max="30" value={tr.settings.ceilingHeight}
              onChange={(e) => s.setTraceSettings({ ceilingHeight: Math.max(6, +e.target.value || 8) })} />
          </label>
          <label>Door height
            <input className="inp mono" type="number" step="0.0833" min="6" max="12" value={+(+tr.settings.doorHeight).toFixed(3)}
              onChange={(e) => s.setTraceSettings({ doorHeight: Math.max(6, +e.target.value || 6.667), doorHeightSet: true })} />
          </label>
          <label>Floor at doors
            <select className="inp" value={tr.settings.floorAtDoor} onChange={(e) => { s.setTraceSettings({ floorAtDoor: e.target.value }); }}>
              <option value="center">to door centre</option>
              <option value="face">to wall face</option>
            </select>
          </label>
          <label>Widest opening
            <input className="inp mono" type="number" step="1" min="4" max="30" value={tr.settings.maxOpening}
              onChange={(e) => s.setTraceSettings({ maxOpening: Math.max(4, +e.target.value || 16) })} />
          </label>
        </div>
        <div className="tr-row" style={{ marginTop: 8 }}>
          <span className="tr-k">Area</span>
          <span className="tr-v">{tr.region ? 'selected box' : 'whole sheet'}</span>
          <button className={'tr-mini' + (s.tool === 'tr_region' ? ' on' : '')} onClick={() => s.setTool('tr_region')}>Box…</button>
          {tr.region && <button className="tr-mini" onClick={() => s.setTrace({ region: null })}>Clear</button>}
        </div>
        <button className="tbtn primary tr-run" disabled={s.traceBusy} onClick={run}>
          {s.traceBusy ? 'Tracing…' : res ? 'Re-trace plan' : 'Trace plan'}
        </button>
        {err && <div className="note" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>

      {res && (
        <>
          {/* ---- verdict ---- */}
          <div className={'tr-verdict ' + res.status}>
            <div className="tr-verdict-h">
              {res.status === 'coherent' ? 'Model closes — every room is a closed loop'
                : res.status === 'review' ? 'Model closes — a few things to check'
                : `${res.counts.error} spot${res.counts.error > 1 ? 's' : ''} need your input`}
            </div>
            <div className="tr-stats">
              <span><b>{res.totals.rooms}</b> rooms</span>
              <span><b>{formatArea(res.totals.floorSf, u)}</b> floor</span>
              <span><b>{formatLength(res.totals.roomWallLf, u)}</b> wall LF</span>
              <span><b>{res.totals.openings}</b> doors / openings</span>
              {res.totals.windows > 0 && <span><b>{res.totals.windows}</b> windows</span>}
            </div>
            {res.calibration?.verdict !== 'unknown' && <div className="tr-cal">{res.calibration.msg}</div>}
          </div>

          {/* ---- flags ---- */}
          {mainFlags.length > 0 && (
            <div className="tr-sec">
              <div className="tr-h">What needs a look</div>
              {mainFlags.map((f) => (
                <button key={f.id} className={'tr-flag ' + f.severity + (focusId === f.id ? ' on' : '')} onClick={() => focus('flag', f.id, f.at)}>
                  <span className="tr-sev">{SEV_LABEL[f.severity]}</span>
                  <span className="tr-msg">{f.msg}</span>
                </button>
              ))}
            </div>
          )}
          {infoFlags.length > 0 && (
            <div className="tr-sec">
              <button className="tr-h tr-toggle" onClick={() => setShowInfo(!showInfo)}>{showInfo ? '▾' : '▸'} {infoFlags.length} note{infoFlags.length > 1 ? 's' : ''} &amp; {res.repairs.length} auto-fix{res.repairs.length === 1 ? '' : 'es'}</button>
              {showInfo && (
                <>
                  {infoFlags.map((f) => (
                    <button key={f.id} className={'tr-flag info' + (focusId === f.id ? ' on' : '')} onClick={() => focus('flag', f.id, f.at)}>
                      <span className="tr-sev">Note</span><span className="tr-msg">{f.msg}</span>
                    </button>
                  ))}
                  <div className="tr-repairs">
                    {summarizeRepairs(res.repairs).map((r) => <div key={r.kind}>{r.text}</div>)}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- fixing ---- */}
          <div className="tr-sec">
            <div className="tr-h">Fix the model</div>
            <div className="tr-tools">
              <button className={'tbtn' + (s.tool === 'tr_wall' ? ' on' : '')} onClick={() => s.setTool('tr_wall')} title="Click two points to add a wall the drawing is missing">+ Wall</button>
              <button className={'tbtn' + (s.tool === 'tr_erase' ? ' on' : '')} onClick={() => s.setTool('tr_erase')} title="Click a traced wall that isn't really a wall">Erase wall</button>
              <button className="tbtn" disabled={!tr.edits?.length} onClick={() => s.undoTraceEdit()}>Undo fix</button>
            </div>
            <div className="note">Every fix re-solves the whole model, so rooms, areas and LF stay consistent.</div>
          </div>

          {/* ---- rooms ---- */}
          <div className="tr-sec">
            <div className="tr-h">Rooms</div>
            {res.rooms.map((r) => (
              <div key={r.id} className={'tr-room ' + r.status + (focusId === r.id ? ' on' : '')} onClick={() => focus('room', r.id, r.center)}>
                <input className="tr-name" value={r.name} onClick={(e) => e.stopPropagation()} onChange={(e) => renameRoom(r, e.target.value)} />
                <div className="tr-room-nums">
                  <span className="tr-num">{formatArea(r.area, u)}</span>
                  <span className="tr-num">{formatLength(r.wallLf, u)} wall LF</span>
                  {aiRooms.has(r.id) && <span className="tr-tag ai" title="The AI check found something here — see What needs a look">AI: check</span>}
                  {ai && !aiRooms.has(r.id) && aiOk.has(r.id) && <span className="tr-tag ok" title="The AI check found this room matches the drawing">AI ✓</span>}
                  {r.type === 'nofloor' && <span className="tr-tag" title="Unexcavated / shaft / open to below: kept in the wall model, left out of the floor total and the takeoff">no floor · not in takeoff</span>}
                  {r.spurLf > 0 && <span className="tr-tag" title="Includes both faces of partitions that dead-end in this room">+ returns {formatLength(r.spurLf, u)}</span>}
                  {r.openings.length > 0 && <span className="tr-tag" title={r.openings.map((o) => `${o.type === 'window' ? 'window ' : ''}${formatLength(o.width, u)} → ${o.to || '?'}`).join('\n')}>{openingsTag(r.openings)}</span>}
                </div>
              </div>
            ))}
            <button className="tbtn tr-ai" disabled={checkBusy} onClick={aiCheck} title="Claude looks at the drawing with the traced model on it and lists where they disagree. The numbers stay the trace's.">
              {checkBusy ? 'AI is checking the model against the drawing…' : ai ? 'Check again with AI' : 'Check the trace with AI'}
            </button>
            {ai && <div className="note">AI checked {new Date(ai.at).toLocaleTimeString()} · {ai.flags.length ? `${ai.flags.length} finding${ai.flags.length > 1 ? 's' : ''}` : 'no disagreements'} · {aiOk.size} room{aiOk.size === 1 ? '' : 's'} confirmed</div>}
            {res.rooms.some((r) => /^Space \d+$/.test(r.name)) && (
              <button className="tbtn tr-ai" disabled={aiBusy} onClick={aiName}>{aiBusy ? 'Reading labels…' : 'Name rooms with AI'}</button>
            )}
          </div>

          <div className="tr-sec tr-actions">
            <button className="tbtn primary" onClick={commit}>
              {tr.committedAt ? 'Update takeoff rooms' : `Send ${res.rooms.filter((r) => r.type !== 'nofloor').length} rooms to takeoff`}
            </button>
            <button className="tbtn" onClick={() => { if (!tr.committedAt) commit(); s.toggle3d(true); }}>Walk through in 3D</button>
            <label className="tr-check"><input type="checkbox" checked={s.showTrace} onChange={(e) => s.setShowTrace(e.target.checked)} /> Show traced model on plan</label>
          </div>

          <div className="tr-src">
            Read from {tr.source?.mode === 'raster' ? 'scanned image' : 'vector PDF'}
            {tr.source?.input && ` · ${tr.source.input.lines} lines, ${tr.source.input.arcs} door swings, ${tr.source.input.texts} labels`}
            {tr.source?.input?.layered ? ' · walls from the drawing\'s CAD layers' : ''}
            {tr.source?.stats?.textError && !tr.source?.stats?.texts ? ` · couldn't read the sheet's text (${tr.source.stats.textError}) — name rooms with AI` : ''}
            {tr.source?.stats?.skewDeg ? ` · straightened ${tr.source.stats.skewDeg}°` : ''}
            {` · solved in ${res.stats.ms} ms`}
          </div>
        </>
      )}
    </div>
  );
}

function nameKey(r) {
  // stable-ish identity for a room across re-traces: rounded centre
  return `${Math.round(r.center.x)}:${Math.round(r.center.y)}`;
}

function summarizeRepairs(repairs) {
  const by = {};
  for (const r of repairs) by[r.kind] = (by[r.kind] || 0) + 1;
  const T = {
    corner: (n) => `${n} corner${n > 1 ? 's' : ''} closed`,
    tee: (n) => `${n} wall${n > 1 ? 's' : ''} extended to meet a crossing wall`,
    gap: (n) => `${n} small gap${n > 1 ? 's' : ''} in a wall line closed`,
    opening: (n) => `${n} door / opening${n > 1 ? 's' : ''} bridged`,
    stub: (n) => `${n} overshoot${n > 1 ? 's' : ''} trimmed`,
  };
  return Object.entries(by).filter(([k]) => T[k]).map(([k, n]) => ({ kind: k, text: T[k](n) }));
}
