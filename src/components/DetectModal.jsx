import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store.js';
import { detectRooms } from '../lib/aiDetect.js';
import { capturePlan } from '../lib/planCapture.js';
import { openPlanFile } from '../lib/planLoad.js';
import {
  detectionToRoom, detectionOutlinePx, inferScale, overlapsExisting,
  visiblePlanRegion, snapToPreset,
} from '../engine/detectMap.js';
import { formatLength, formatArea, ARCH_SCALES } from '../engine/units.js';
import ScaleControl from './ScaleControl.jsx';

// AI room detection on the plan that is already open.
//   setup  → choose what Claude reads (the part on screen, or the whole page)
//   busy   → Claude traces every room in that image
//   review → rooms drawn over the image; untick any, rename, then add.
// Rooms come back in the image's pixels and are mapped onto the plan, so
// they land exactly over the drawing. With no plan open, the dialog opens one.

function stageSize() {
  const cv = document.querySelector('.stage canvas');
  const r = cv?.getBoundingClientRect();
  return r && r.width > 10 && r.height > 10 ? { w: r.width, h: r.height } : null;
}

function scaleText(s) {
  if (!s.scale) return null;
  if (s.archScale) return ARCH_SCALES.find((a) => a.id === s.archScale)?.label || 'custom';
  if (s.planDpi > 0) return `1" = ${formatLength(s.scale * s.planDpi, s.unitSystem)} (custom)`;
  return 'custom (ruler)';
}

export default function DetectModal({ onClose }) {
  const s = useStore();
  const hasPlan = !!(s.planImage && s.planWidth && s.planHeight);
  const fileRef = useRef(null);

  // The part of the plan on screen when the dialog opened. If it's (nearly)
  // the whole page, "on screen" and "whole page" are the same thing.
  const [viewRegion] = useState(() => {
    const st = useStore.getState(), sz = stageSize();
    if (!sz || !st.planWidth || !st.planHeight) return null;
    const r = visiblePlanRegion(st.view, sz, { w: st.planWidth, h: st.planHeight });
    return r && r.w * r.h < 0.9 * st.planWidth * st.planHeight ? r : null;
  });
  const [mode, setMode] = useState(viewRegion ? 'view' : 'page');
  const [phase, setPhase] = useState(hasPlan ? 'setup' : 'pick');
  const [cap, setCap] = useState(null);       // captured image + ImageMap
  const [capErr, setCapErr] = useState('');
  const [opening, setOpening] = useState(false);
  const [dets, setDets] = useState(null);     // raw detections (image px)
  const [keep, setKeep] = useState({});       // index → bool (default: not already drawn)
  const [names, setNames] = useState({});
  const [err, setErr] = useState(null);       // { msg, status }
  const [warn, setWarn] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [hover, setHover] = useState(-1);
  const [useLabelScale, setUseLabelScale] = useState(false);

  // Capture what Claude will read whenever the plan or the choice changes.
  const pdfPage = s.pdfPage, planImage = s.planImage;
  useEffect(() => {
    if (!hasPlan) return undefined;
    let dead = false;
    setCap(null); setCapErr('');
    capturePlan(useStore.getState(), mode === 'view' ? viewRegion : null)
      .then((c) => { if (dead) URL.revokeObjectURL(c.url); else setCap(c); })
      .catch((e) => { if (!dead) setCapErr(e.message || 'Could not prepare the plan.'); });
    return () => { dead = true; };
  }, [hasPlan, mode, viewRegion, pdfPage, planImage]);

  // free the preview's object URL when it's replaced or the dialog closes
  const capUrl = cap?.url;
  useEffect(() => () => { if (capUrl) URL.revokeObjectURL(capUrl); }, [capUrl]);

  // elapsed-seconds counter while Claude works
  useEffect(() => {
    if (phase !== 'busy') return undefined;
    setElapsed(0);
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  async function pickFile(e) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setOpening(true); setErr(null);
    try {
      await openPlanFile(file);
      setMode('page'); setPhase('setup'); setDets(null);
      setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 60);
    } catch (ex) {
      setErr({ msg: ex.message || 'Could not open that file.' });
    } finally { setOpening(false); }
  }

  async function run() {
    if (!cap) return;
    setPhase('busy'); setErr(null); setWarn('');
    try {
      const st = useStore.getState();
      const r = await detectRooms(cap, st.scale ? st.scale * cap.map.rx : undefined);
      if (!r.rooms.length) {
        setErr({ msg: r.warning || 'No rooms found in this image. Zoom in so the floor plan fills the screen, then try again.' });
        setPhase('setup');
        return;
      }
      setDets(r.rooms); setKeep({}); setNames({}); setUseLabelScale(false);
      setWarn(r.warning || '');
      setPhase('review');
    } catch (ex) {
      setErr({ msg: ex.message || 'Detection failed. Please try again.', status: ex.status });
      setPhase('setup');
    }
  }

  // ---- scale: the project's, or one read from the printed room sizes ----
  const metric = s.unitSystem?.startsWith('metric');
  const labelScale = useMemo(() => {
    if (!dets || !cap) return null;
    const inf = inferScale(dets, cap.map);
    return inf ? { ...snapToPreset(inf.feetPerModelPx, s.planDpi, metric), samples: inf.samples } : null;
  }, [dets, cap, s.planDpi, metric]);
  const scaleDisagrees = !!(s.scale && labelScale && Math.abs(labelScale.feetPerModelPx - s.scale) / s.scale > 0.08);
  const adoptLabelScale = !!labelScale && (!s.scale || (useLabelScale && scaleDisagrees));
  const fpp = adoptLabelScale ? labelScale.feetPerModelPx : s.scale;

  const rooms = useMemo(() => {
    if (!dets || !cap || !fpp) return null;
    return dets.map((d) => {
      const room = detectionToRoom(d, cap.map, fpp);
      return { ...room, dup: overlapsExisting(room.points, s.rooms) };
    });
  }, [dets, cap, fpp, s.rooms]);
  const outlines = useMemo(() => (dets ? dets.map((d) => detectionOutlinePx(d).pts) : []), [dets]);

  const isKept = (i) => keep[i] ?? !(rooms?.[i]?.dup);
  const toggle = (i) => setKeep((k) => ({ ...k, [i]: !isKept(i) }));
  const setAll = (v) => setKeep(Object.fromEntries((dets || []).map((_, i) => [i, v])));
  const keptCount = rooms ? rooms.filter((_, i) => isKept(i)).length : 0;

  function commit() {
    if (!rooms) return;
    if (adoptLabelScale) {
      s.setScale(labelScale.feetPerModelPx);
      s.setArchScale(labelScale.id);
    }
    let added = 0;
    rooms.forEach((r, i) => {
      if (!isKept(i)) return;
      s.addRoom(r.points, (names[i] ?? r.name).trim() || r.name);
      added++;
    });
    onClose();
    window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `${added} room${added === 1 ? '' : 's'} added to the plan`, ok: true } }));
    if (mode === 'page') setTimeout(() => window.dispatchEvent(new Event('tt:fit')), 80);
  }

  const fmt = (ft) => formatLength(ft, s.unitSystem);
  const sz = cap ? { '--ar': cap.width / cap.height } : undefined;
  const mark = cap ? Math.max(cap.width, cap.height) / 55 : 20; // badge radius in image px

  return (
    <div className="modal-bg" onClick={phase === 'busy' ? undefined : onClose}>
      <div className="modal det" onClick={(e) => e.stopPropagation()}>
        <h3>AI room detection</h3>
        <div className="body">
          {phase === 'pick' && (
            <>
              <label className="drop" htmlFor="det-file">
                {opening ? <b>Opening plan…</b> : <>Open the floor plan — <b>PDF or image</b>.<br />It stays loaded as your takeoff plan, so you only open it once.</>}
              </label>
              <input id="det-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={pickFile} />
              {err && <div className="det-err">{err.msg}</div>}
            </>
          )}

          {phase !== 'pick' && (
            <>
              {phase === 'setup' && (
                <div className="seg det-seg">
                  <button className={mode === 'view' ? 'on' : ''} disabled={!viewRegion} onClick={() => setMode('view')}
                    title={viewRegion ? '' : 'The whole page is on screen — zoom in on the floor plan to read just that part'}>
                    What&rsquo;s on screen
                  </button>
                  <button className={mode === 'page' ? 'on' : ''} onClick={() => setMode('page')}>
                    {s.pdfDoc ? `Whole page ${s.pdfPage}` : 'Whole plan'}
                  </button>
                </div>
              )}

              <div className="det-prev" style={sz}>
                {cap ? <img src={cap.url} alt="Plan region Claude reads" draggable={false} />
                  : <div className="det-ph">{capErr || 'Preparing the plan…'}</div>}
                {phase === 'busy' && <div className="det-scan" />}
                {phase === 'review' && cap && dets && (
                  <svg viewBox={`0 0 ${cap.width} ${cap.height}`} preserveAspectRatio="none">
                    {outlines.map((pts, i) => {
                      const on = isKept(i), d = dets[i];
                      const cls = 'det-poly' + (on ? ' on' : '') + (hover === i ? ' hl' : '');
                      return (
                        <g key={i} onClick={() => toggle(i)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}>
                          <polygon className={cls} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} />
                          <circle className={'det-badge' + (on ? ' on' : '')} cx={d.x + d.w / 2} cy={d.y + d.h / 2} r={mark} />
                          <text className="det-badge-t" x={d.x + d.w / 2} y={d.y + d.h / 2} fontSize={mark * 1.1}>{i + 1}</text>
                        </g>
                      );
                    })}
                  </svg>
                )}
              </div>

              {phase === 'setup' && (
                <>
                  <div className="note">
                    Claude reads exactly this image. If the sheet has several drawings, close this, zoom in so the floor plan fills the screen, and open AI Detect again.
                  </div>
                  <div className={'det-scale' + (s.scale ? '' : ' warn')}>
                    {s.scale
                      ? <>Scale: <b>{scaleText(s)}</b></>
                      : <>
                          <span>No scale set. Claude will size rooms from their printed dimensions, or pick the drawing scale:</span>
                          <ScaleControl className="inp" onRuler={onClose} />
                        </>}
                  </div>
                  {err && (
                    <div className="det-err">
                      {err.msg}
                      {err.status === 401 && (
                        <button className="tbtn" onClick={() => { onClose(); setTimeout(() => window.dispatchEvent(new Event('tt:signin')), 60); }}>Sign in</button>
                      )}
                    </div>
                  )}
                  <button className="det-alt" onClick={() => fileRef.current?.click()}>{opening ? 'Opening…' : 'Use a different plan file…'}</button>
                  <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={pickFile} />
                </>
              )}

              {phase === 'busy' && (
                <div className="det-busy"><span className="spin" />Claude is tracing the rooms… {elapsed}s<small>Usually 20–60 seconds for a full floor plan.</small></div>
              )}

              {phase === 'review' && rooms && (
                <>
                  {labelScale && !s.scale && (
                    <div className="det-scale ok">Scale from the printed room sizes: <b>{labelScale.label || `1 ft = ${(1 / labelScale.feetPerModelPx).toFixed(1)} px`}</b> — it will be set when you add the rooms.</div>
                  )}
                  {scaleDisagrees && (
                    <div className="det-scale warn">
                      <span>The printed room sizes suggest <b>{labelScale.label || 'a different scale'}</b>, not your scale ({scaleText(s)}). Rooms below use {useLabelScale ? 'the printed sizes' : 'your scale'}.</span>
                      {s.rooms.length === 0 && (
                        <button className="tbtn" onClick={() => setUseLabelScale(!useLabelScale)}>{useLabelScale ? 'Use my scale' : 'Use printed sizes'}</button>
                      )}
                    </div>
                  )}
                  {warn && <div className="note">⚠ {warn}</div>}
                  <div className="det-head">
                    <span>{dets.length} room{dets.length === 1 ? '' : 's'} found · tap to include or skip</span>
                    <span><button onClick={() => setAll(true)}>All</button> · <button onClick={() => setAll(false)}>None</button></span>
                  </div>
                  {rooms.map((r, i) => {
                    const on = isKept(i);
                    return (
                      <div className={'det-row' + (on ? '' : ' off') + (hover === i ? ' hl' : '')} key={i}
                        onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}>
                        <input type="checkbox" checked={on} onChange={() => toggle(i)} aria-label={`Include ${r.name}`} />
                        <span className="det-num">{i + 1}</span>
                        <input className="det-name" value={names[i] ?? r.name} onChange={(e) => setNames({ ...names, [i]: e.target.value })} />
                        <span className="det-dim">
                          {r.shape === 'polygon' ? formatArea(r.areaSf, s.unitSystem) : `${fmt(r.wFt)} × ${fmt(r.hFt)}`}
                        </span>
                        {r.dup && <span className="conf" title="A room is already drawn here">drawn</span>}
                        {r.labelMismatch && <span className="conf lo" title={`Printed size: ${r.dimText}`}>≠ {r.dimText || 'label'}</span>}
                        {!r.dup && !r.labelMismatch && (
                          <span className={'conf ' + (r.confidence >= 0.7 ? 'hi' : 'lo')}>{Math.round(r.confidence * 100)}%</span>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {phase === 'review' && !rooms && (
                <div className="det-scale warn">
                  <span>Claude found {dets.length} rooms, but there is no scale to size them and no printed room sizes to read one from. Pick the drawing scale:</span>
                  <ScaleControl className="inp" onRuler={onClose} />
                </div>
              )}
            </>
          )}
        </div>
        <div className="foot">
          <button className="tbtn" onClick={onClose} disabled={phase === 'busy'}>Cancel</button>
          {phase === 'review' && <button className="tbtn" onClick={() => setPhase('setup')}>Back</button>}
          {(phase === 'setup' || phase === 'busy') && (
            <button className="tbtn primary" disabled={!cap || phase === 'busy'} onClick={run}>
              {phase === 'busy' ? 'Detecting…' : 'Detect rooms'}
            </button>
          )}
          {phase === 'review' && (
            <button className="tbtn primary" disabled={!rooms || !keptCount} onClick={commit}>
              Add {keptCount} room{keptCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
