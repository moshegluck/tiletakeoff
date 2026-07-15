import { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../state/store.js';
import { rectPoly, bounds } from '../engine/geometry.js';
import { snap } from '../engine/units.js';
import { axisLock, inPoly, makeTransforms } from './canvasUtils.js';
import { renderScene } from './canvasRender.js';

// Cursor per active tool. Drawing tools get a crosshair; select/pan get a hand.
const TOOL_CURSOR = {
  select: 'default', pan: 'grab', ruler: 'crosshair', room: 'crosshair',
  polygon: 'crosshair', grid: 'default', mk_length: 'crosshair',
  mk_area: 'crosshair', mk_rect: 'crosshair', mk_count: 'crosshair',
};

// Collapse points that land within ~1/4" of their predecessor. Double-click and
// right-click finishing both leave a near-duplicate trailing point; this cleans
// that up before a markup or room is committed.
function dedupePts(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.02) out.push(p);
  }
  return out;
}

// feet<->model-px helpers depend on calibrated scale (feet per model px)
export default function Canvas2D() {
  const cvRef = useRef(null);
  const wrapRef = useRef(null);
  const s = useStore();
  const draft = useRef(null);   // in-progress rect or polygon
  const mkDraft = useRef(null);  // in-progress markup
  const mkActive = useRef(null); // active count markup id
  const ruler = useRef(null);
  const pan = useRef(null);
  const drag = useRef(null);
  const marquee = useRef(null); // rubber-band multi-select rect (screen coords)
  const planImg = useRef(null);
  const raf = useRef(0);
  const space = useRef(false);  // spacebar held → drag pans the page

  const scale = s.scale;        // feet per model-px
  const { ft2px, px2ft, toScreen, toModel } = makeTransforms(s.view, scale);

  // drawRef always points to the latest draw() so schedule() never has a stale
  // closure. Declared before the effects below because the plan-underlay effect
  // lists `schedule` in its dependency array — referencing it any later would
  // hit the temporal dead zone and crash the component on first render.
  const drawRef = useRef(null);
  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => drawRef.current && drawRef.current());
  }, []);

  // Load plan underlay image.
  // When done: store in ref (draw() picks it up on next render),
  // then fit the view to the image dimensions via the store.
  useEffect(() => {
    if (!s.planImage) { planImg.current = null; return; }
    const img = new Image();
    img.onload = () => {
      planImg.current = img;
      const iw = img.naturalWidth  || img.width;
      const ih = img.naturalHeight || img.height;

      // Sync naturalWidth into store so tt:fit handler has correct dims
      if (iw && ih && (iw !== s.planWidth || ih !== s.planHeight)) {
        useStore.getState().setPlanImage(s.planImage, iw, ih);
      }

      const fitToImage = () => {
        const wrap = wrapRef.current;
        const rect = wrap ? wrap.getBoundingClientRect() : {};
        const W = rect.width  > 10 ? rect.width  : window.innerWidth  - 56;
        const H = rect.height > 10 ? rect.height : window.innerHeight - 130;
        if (!iw || !ih) { schedule(); return; }
        const pad = 32;
        const z = Math.max(0.02, Math.min(8,
          Math.min((W - pad * 2) / iw, (H - pad * 2) / ih)
        ));
        useStore.getState().setView({
          zoom: z,
          x: Math.round((W - iw * z) / 2),
          y: Math.round((H - ih * z) / 2),
        });
        // Explicitly schedule a redraw — store update triggers re-render
        // but we also call schedule() directly so RAF fires even if view didn't change
        schedule();
      };
      fitToImage();
      setTimeout(fitToImage, 150);
      setTimeout(fitToImage, 500);
    };
    img.onerror = () => {
      planImg.current = null;
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: 'Could not display the plan image.' } }));
    };
    img.src = s.planImage;
    // planWidth/planHeight are read only for the current-vs-loaded comparison;
    // adding them would re-run the loader (which writes them back) and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.planImage, schedule]);

  // ---------- render ----------
  function draw() {
    const cv = cvRef.current; if (!cv) return;
    // If canvas has no size yet (ResizeObserver hasn't fired), size it now
    if (!cv.width || !cv.height) {
      const wrap = wrapRef.current;
      const r = wrap ? wrap.getBoundingClientRect() : null;
      const DPR2 = window.devicePixelRatio || 1;
      const w = (r && r.width  > 10) ? r.width  : window.innerWidth  - 56;
      const h = (r && r.height > 10) ? r.height : window.innerHeight - 130;
      cv.width = w * DPR2; cv.height = h * DPR2;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = cv.getContext('2d');
    const DPR = window.devicePixelRatio || 1;
    const W = cv.width / DPR, H = cv.height / DPR;
    if (!W || !H) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    renderScene(ctx, W, H, {
      s, scale, ft2px, px2ft, toScreen,
      planImg: planImg.current,
      draft: draft.current,
      mkDraft: mkDraft.current,
      ruler: ruler.current,
      marquee: marquee.current,
    });
  }

  drawRef.current = draw;

  // ---------- interaction ----------
  function evPt(e) { const r = cvRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  const down = useRef(null);

  function onDown(e) {
    cvRef.current.setPointerCapture(e.pointerId);
    const sp = evPt(e), mp = toModel(sp.x, sp.y);
    const mfx = px2ft(mp.x), mfy = px2ft(mp.y);
    down.current = { sp, mp };

    // --- universal navigation, works under any tool ---
    // middle mouse button or held spacebar → grab-pan the page
    if (e.button === 1 || space.current) {
      pan.current = { x: s.view.x, y: s.view.y, sp };
      if (cvRef.current) cvRef.current.style.cursor = 'grabbing';
      return;
    }
    // right mouse button → finish/close an in-progress measurement or polygon
    if (e.button === 2) {
      if (mkDraft.current || draft.current?.kind === 'poly') finishDraft();
      return;
    }

    if (s.tool === 'ruler') { ruler.current = { p1: mp, p2: mp }; return; }
    if (s.tool === 'room') {
      draft.current = { kind: 'rect', ox: mfx, oy: mfy, points: rectPoly(mfx, mfy, 0, 0) };
      return;
    }
    if (s.tool === 'polygon') {
      if (!draft.current) draft.current = { kind: 'poly', points: [{ x: mfx, y: mfy }] };
      else {
        const first = draft.current.points[0];
        const fs = toScreen(ft2px(first.x), ft2px(first.y));
        if (Math.hypot(sp.x - fs.x, sp.y - fs.y) < 10 && draft.current.points.length >= 3) {
          s.addRoom(draft.current.points); draft.current = null; s.setTool('select');
        } else draft.current.points.push({ x: mfx, y: mfy });
      }
      schedule(); return;
    }
    // ----- markup tools -----
    if (s.tool === 'mk_count') {
      // accumulate points onto a single active count markup
      let id = mkActive.current;
      const existing = id && s.markups.find((m) => m.id === id);
      if (existing) {
        s.updateMarkup(id, { points: [...existing.points, { x: mfx, y: mfy }] });
      } else {
        id = s.addMarkup({ type: 'count', points: [{ x: mfx, y: mfy }], name: 'Count', color: '#1d6fb0' });
        mkActive.current = id;
      }
      schedule(); return;
    }
    if (s.tool === 'mk_length' || s.tool === 'mk_area') {
      const type = s.tool === 'mk_length' ? 'length' : 'area';
      if (!mkDraft.current) mkDraft.current = { type, points: [{ x: mfx, y: mfy }] };
      else {
        const arr = mkDraft.current.points;
        // area closes back on its first point; a length ends on its last point
        const anchor = type === 'area' ? arr[0] : arr[arr.length - 1];
        const as = toScreen(ft2px(anchor.x), ft2px(anchor.y));
        const closeEnough = Math.hypot(sp.x - as.x, sp.y - as.y) < 10;
        const minPts = type === 'area' ? 3 : 2;
        if (closeEnough && arr.length >= minPts) { finishDraft(); }
        else arr.push({ x: mfx, y: mfy });
      }
      schedule(); return;
    }
    if (s.tool === 'mk_rect' || s.tool === 'mk_ellipse') {
      const type = s.tool === 'mk_ellipse' ? 'ellipse' : 'rect';
      mkDraft.current = { type, ox: mfx, oy: mfy, points: [{ x: mfx, y: mfy }, { x: mfx, y: mfy }] };
      return;
    }
    if (s.tool === 'mk_arrow') {
      mkDraft.current = { type: 'arrow', points: [{ x: mfx, y: mfy }, { x: mfx, y: mfy }] };
      return;
    }
    if (s.tool === 'mk_text') {
      s.addMarkup({ type: 'text', points: [{ x: mfx, y: mfy }], name: 'Text', color: '#10171f' });
      s.setTool('select'); s.setTab('markups');
      return;
    }
    if (s.tool === 'select') {
      const hit = hitTest(sp);
      const cur = useStore.getState().selRooms;
      if (hit) {
        // shift-click toggles membership without starting a drag
        if (e.shiftKey) { s.toggleRoomSel(hit.room.id); s.setTab('rooms'); schedule(); return; }
        // vertex editing only when this room is the sole selection
        if (hit.vertex != null && cur.length <= 1) {
          s.select('room', hit.room.id); s.setTab('rooms');
          drag.current = { room: hit.room, mode: 'vertex', idx: hit.vertex, mp };
          schedule(); return;
        }
        // drag-move: keep the group if the hit room is already in it, else select just it
        let ids = cur.includes(hit.room.id) ? cur : [hit.room.id];
        if (!cur.includes(hit.room.id)) s.select('room', hit.room.id);
        s.setTab('rooms');
        const byId = new Map(s.rooms.map((r) => [r.id, r]));
        const starts = {};
        ids.forEach((id) => { const r = byId.get(id); if (r) starts[id] = r.points.map((p) => ({ ...p })); });
        drag.current = { mode: 'move', ids, starts, mp };
      } else {
        if (!e.shiftKey) s.clearRoomSel();
        marquee.current = { sp0: sp, sp1: sp, add: e.shiftKey };
      }
      schedule(); return;
    }
    if (s.tool === 'pan') { pan.current = { x: s.view.x, y: s.view.y, sp }; }
  }

  function onMove(e) {
    const sp = evPt(e), mp = toModel(sp.x, sp.y);
    const mfx = px2ft(mp.x), mfy = px2ft(mp.y);

    if (pan.current) { s.setView({ ...s.view, x: pan.current.x + (sp.x - pan.current.sp.x), y: pan.current.y + (sp.y - pan.current.sp.y) }); schedule(); return; }
    if (marquee.current) { marquee.current.sp1 = sp; schedule(); return; }
    if (ruler.current && down.current) { ruler.current.p2 = e.shiftKey ? axisLock(ruler.current.p1, mp) : mp; schedule(); return; }
    if (draft.current?.kind === 'rect' && down.current) {
      let x = draft.current.ox, y = draft.current.oy, w = mfx - x, h = mfy - y;
      if (scale) { w = snap(w, .5); h = snap(h, .5); }
      const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h);
      draft.current.points = rectPoly(x0, y0, Math.abs(w), Math.abs(h));
      schedule(); return;
    }
    if (draft.current?.kind === 'poly') { draft.current.hover = { x: mfx, y: mfy }; schedule(); return; }
    // markup drafts
    if (mkDraft.current && (mkDraft.current.type === 'rect' || mkDraft.current.type === 'ellipse') && down.current) {
      mkDraft.current.points = [{ x: mkDraft.current.ox, y: mkDraft.current.oy }, { x: mfx, y: mfy }];
      schedule(); return;
    }
    if (mkDraft.current?.type === 'arrow' && down.current) {
      const a = mkDraft.current.points[0];
      mkDraft.current.points = [a, e.shiftKey ? axisLock(a, { x: mfx, y: mfy }) : { x: mfx, y: mfy }];
      schedule(); return;
    }
    if (mkDraft.current && (mkDraft.current.type === 'length' || mkDraft.current.type === 'area')) {
      mkDraft.current.hover = { x: mfx, y: mfy }; schedule(); return;
    }
    if (drag.current) {
      const d = drag.current;
      if (d.mode === 'move') {
        // move every selected room by the same model delta
        const dfx = px2ft(mp.x - d.mp.x), dfy = px2ft(mp.y - d.mp.y);
        d.ids.forEach((id) => {
          const start = d.starts[id]; if (!start) return;
          const pts = start.map((p) => ({ x: scale ? snap(p.x + dfx, .25) : p.x + dfx, y: scale ? snap(p.y + dfy, .25) : p.y + dfy }));
          s.updateRoom(id, { points: pts });
        });
      } else {
        const pts = d.room.points.map((p, i) => i === d.idx ? { x: scale ? snap(mfx, .25) : mfx, y: scale ? snap(mfy, .25) : mfy } : p);
        s.updateRoom(d.room.id, { points: pts });
      }
      schedule(); return;
    }
  }

  function onUp() {
    if (marquee.current) {
      const m = marquee.current; marquee.current = null;
      const moved = Math.hypot(m.sp1.x - m.sp0.x, m.sp1.y - m.sp0.y);
      if (moved >= 3) {
        const x0 = Math.min(m.sp0.x, m.sp1.x), y0 = Math.min(m.sp0.y, m.sp1.y);
        const x1 = Math.max(m.sp0.x, m.sp1.x), y1 = Math.max(m.sp0.y, m.sp1.y);
        // a room is picked if its screen bbox overlaps the marquee rect
        const hitIds = [];
        for (const r of s.rooms) {
          let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
          for (const p of r.points) {
            const q = toScreen(ft2px(p.x), ft2px(p.y));
            rx0 = Math.min(rx0, q.x); ry0 = Math.min(ry0, q.y);
            rx1 = Math.max(rx1, q.x); ry1 = Math.max(ry1, q.y);
          }
          if (rx0 <= x1 && rx1 >= x0 && ry0 <= y1 && ry1 >= y0) hitIds.push(r.id);
        }
        const base = m.add ? useStore.getState().selRooms : [];
        s.selectRooms(Array.from(new Set([...base, ...hitIds])));
      }
      down.current = null; schedule(); return;
    }
    if (ruler.current) {
      const px = Math.hypot(ruler.current.p2.x - ruler.current.p1.x, ruler.current.p2.y - ruler.current.p1.y);
      if (px > 8) promptScale(px);
      ruler.current = null; down.current = null; schedule(); return;
    }
    if (draft.current?.kind === 'rect') {
      const b = bounds(draft.current.points);
      if (b.w > 0.3 && b.h > 0.3) s.addRoom(draft.current.points);
      draft.current = null; down.current = null; schedule(); return;
    }
    if (mkDraft.current && (mkDraft.current.type === 'rect' || mkDraft.current.type === 'ellipse')) {
      const type = mkDraft.current.type;
      const [a, b] = mkDraft.current.points;
      if (Math.abs(b.x - a.x) > 0.2 && Math.abs(b.y - a.y) > 0.2) {
        s.addMarkup({
          type, points: [a, b],
          name: type === 'ellipse' ? 'Ellipse' : 'Area',
          color: type === 'ellipse' ? '#b25e00' : '#7a3fa0',
        });
      }
      mkDraft.current = null; down.current = null; schedule(); return;
    }
    if (mkDraft.current?.type === 'arrow') {
      const [a, b] = mkDraft.current.points;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.1) s.addMarkup({ type: 'arrow', points: [a, b], name: 'Arrow', color: '#c8521f' });
      mkDraft.current = null; down.current = null; schedule(); return;
    }
    if (drag.current) { drag.current = null; }
    pan.current = null; down.current = null;
    if (cvRef.current) cvRef.current.style.cursor = space.current ? 'grab' : (TOOL_CURSOR[s.tool] || 'default');
  }

  function commitMkDraft() {
    const d = mkDraft.current; if (!d) return;
    const pts = dedupePts(d.points);
    const minPts = d.type === 'area' ? 3 : 2;
    if (pts.length < minPts) { mkDraft.current = null; return; }
    const name = d.type === 'length' ? 'Length' : 'Area';
    const color = d.type === 'length' ? '#1d7a4d' : '#7a3fa0';
    s.addMarkup({ type: d.type, points: pts, name, color });
    mkDraft.current = null;
    s.setTool('select');
  }

  // Finish whatever draft is open: a measurement markup or a traced polygon room.
  function finishDraft() {
    if (mkDraft.current) { commitMkDraft(); schedule(); return; }
    if (draft.current?.kind === 'poly') {
      const pts = dedupePts(draft.current.points);
      if (pts.length >= 3) { s.addRoom(pts); s.setTool('select'); }
      draft.current = null; schedule();
    }
    mkActive.current = null; // stop an active count run
  }

  // Discard the in-progress draft without committing (Esc / pointer cancel).
  function cancelDraft() {
    mkDraft.current = null; draft.current = null; ruler.current = null; mkActive.current = null;
    schedule();
  }

  // Remove the last placed point (Backspace / Ctrl-Z) across every point tool.
  function undoPoint() {
    if (mkDraft.current) {
      mkDraft.current.points.pop();
      if (!mkDraft.current.points.length) mkDraft.current = null;
    } else if (draft.current?.kind === 'poly') {
      draft.current.points.pop();
      if (!draft.current.points.length) draft.current = null;
    } else if (mkActive.current) {
      const m = s.markups.find((x) => x.id === mkActive.current);
      if (m) {
        const np = m.points.slice(0, -1);
        if (np.length) s.updateMarkup(m.id, { points: np });
        else { s.deleteMarkup(m.id); mkActive.current = null; }
      }
    }
    schedule();
  }

  // Double-click finishes a length / area / polygon (the two rapid clicks land a
  // near-duplicate point that commit dedupes away).
  function onDbl() {
    if (mkDraft.current || draft.current?.kind === 'poly') finishDraft();
  }

  // Draft-scoped keyboard, captured before App's global handler so Backspace
  // undoes a point instead of deleting the selected room. Only swallows keys
  // while a draft is actually open.
  function onKeyCapture(e) {
    if (/input|select|textarea/i.test(e.target.tagName)) return;
    if (!mkDraft.current && draft.current?.kind !== 'poly' && !mkActive.current) return;
    const k = e.key;
    if (k === 'Enter') { e.preventDefault(); e.stopPropagation(); finishDraft(); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelDraft(); }
    else if (k === 'Backspace' || ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z'))) {
      e.preventDefault(); e.stopPropagation(); undoPoint();
    }
  }

  function promptScale(px) {
    // window.prompt is blocked on iOS Safari in async contexts.
    // Use a custom in-canvas overlay div instead.
    const cur = scale ? px2ft(px).toFixed(2) : '10';
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','inset:0','background:rgba(0,0,0,.55)',
      'display:flex','align-items:center','justify-content:center','z-index:9999'
    ].join(';');
    overlay.innerHTML = `
      <div style="background:#1e1e2e;border-radius:12px;padding:24px 20px;width:min(340px,90vw);color:#eee;font-family:sans-serif">
        <div style="font-size:15px;margin-bottom:4px;font-weight:600">Set Scale</div>
        <div style="font-size:13px;color:#aaa;margin-bottom:16px">
          You drew a ${px.toFixed(0)}px line. Enter its real-world length:
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
          <input id="scaleVal" type="number" min="0.1" step="0.1" value="${cur}"
            style="flex:1;padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:16px" />
          <select id="scaleUnit" style="padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#fff;font-size:14px">
            <option value="ft">ft</option>
            <option value="in">in</option>
            <option value="m">m</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="scaleCancel" style="padding:9px 18px;border-radius:8px;border:1px solid #444;background:transparent;color:#aaa;font-size:14px;cursor:pointer">Cancel</button>
          <button id="scaleOk" style="padding:9px 18px;border-radius:8px;border:none;background:#e05a1a;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Set Scale</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const inp = overlay.querySelector('#scaleVal');
    inp.focus(); inp.select();
    const cleanup = () => document.body.removeChild(overlay);
    const apply = () => {
      const raw = parseFloat(overlay.querySelector('#scaleVal').value);
      if (!(raw > 0)) { cleanup(); return; }
      const unit = overlay.querySelector('#scaleUnit').value;
      const ft = unit === 'in' ? raw / 12 : unit === 'm' ? raw * 3.28084 : raw;
      s.setScale(ft / px);
      s.setArchScale(null);
      s.setTool('room');
      cleanup();
    };
    overlay.querySelector('#scaleOk').addEventListener('click', apply);
    overlay.querySelector('#scaleCancel').addEventListener('click', cleanup);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') cleanup(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  }

  function hitTest(sp) {
    for (let i = s.rooms.length - 1; i >= 0; i--) {
      const r = s.rooms[i];
      if (s.selection.id === r.id && s.tool === 'select') {
        for (let v = 0; v < r.points.length; v++) {
          const vs = toScreen(ft2px(r.points[v].x), ft2px(r.points[v].y));
          if (Math.hypot(sp.x - vs.x, sp.y - vs.y) < 9) return { room: r, vertex: v };
        }
      }
      // point-in-poly on screen
      const path = r.points.map((p) => toScreen(ft2px(p.x), ft2px(p.y)));
      if (inPoly(sp.x, sp.y, path)) return { room: r, vertex: null };
    }
    return null;
  }

  function onWheel(e) {
    e.preventDefault();
    const sp = evPt(e), before = toModel(sp.x, sp.y);
    const z = Math.max(0.15, Math.min(8, s.view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const view = { ...s.view, zoom: z };
    const after = { x: (sp.x - view.x) / z, y: (sp.y - view.y) / z };
    view.x += (after.x - before.x) * z; view.y += (after.y - before.y) * z;
    s.setView(view); schedule();
  }

  // resize
  useEffect(() => {
    const cv = cvRef.current, wrap = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const DPR = window.devicePixelRatio || 1;
      const r = wrap.getBoundingClientRect();
      cv.width = r.width * DPR; cv.height = r.height * DPR;
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      schedule();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [schedule]);

  // redraw on any state change
  useEffect(() => { schedule(); });

  // Wheel zoom needs preventDefault(), but React's synthetic onWheel is attached
  // as a PASSIVE listener — calling preventDefault there is ignored and floods
  // the console with warnings, and the page scrolls instead of zooming. Attach a
  // native non-passive listener instead. The ref keeps it bound to the latest
  // onWheel closure without re-subscribing each render.
  const wheelRef = useRef(null);
  wheelRef.current = onWheel;
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const handler = (e) => wheelRef.current && wheelRef.current(e);
    cv.addEventListener('wheel', handler, { passive: false });
    return () => cv.removeEventListener('wheel', handler);
  }, []);

  // clear in-progress markup state when switching tools, and reflect the tool
  // in the cursor
  useEffect(() => {
    if (s.tool !== 'mk_count') mkActive.current = null;
    if (!s.tool.startsWith('mk_')) mkDraft.current = null;
    if (s.tool !== 'polygon') draft.current = null;
    if (cvRef.current) cvRef.current.style.cursor = space.current ? 'grab' : (TOOL_CURSOR[s.tool] || 'default');
  }, [s.tool]);

  // Spacebar held → temporary hand tool (grab-pan), the standard CAD/design idiom.
  useEffect(() => {
    const isField = (t) => /input|select|textarea/i.test(t?.tagName || '');
    const kd = (e) => {
      if (e.code === 'Space' && !space.current && !isField(e.target)) {
        space.current = true; e.preventDefault();
        if (cvRef.current && !pan.current) cvRef.current.style.cursor = 'grab';
      }
    };
    const ku = (e) => {
      if (e.code === 'Space') {
        space.current = false;
        if (cvRef.current && !pan.current) cvRef.current.style.cursor = TOOL_CURSOR[useStore.getState().tool] || 'default';
      }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  // Draft keys (Enter/Esc/Backspace/Ctrl-Z) captured before App's global keydown.
  const keyRef = useRef(null);
  keyRef.current = onKeyCapture;
  useEffect(() => {
    const h = (e) => keyRef.current && keyRef.current(e);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  // expose fit via custom event
  useEffect(() => {
    const fit = () => {
      const cv = cvRef.current; if (!cv) return;
      const wrap = wrapRef.current; if (!wrap) return;
      // Use wrapper DOM size; fall back to window dimensions minus toolbar/nav
      const rect = wrap.getBoundingClientRect();
      const W = (rect.width  > 10 ? rect.width  : window.innerWidth  - 56) || 400;
      const H = (rect.height > 10 ? rect.height : window.innerHeight - 56 - 56) || 600;
      const pad = 32;

      // --- fit to plan image (no rooms) ---
      // Use planImg ref dimensions (most reliable) with store as fallback
      const piw = planImg.current?.naturalWidth  || planImg.current?.width  || s.planWidth;
      const pih = planImg.current?.naturalHeight || planImg.current?.height || s.planHeight;
      if (!s.rooms.length && piw && pih) {
        const z = Math.max(0.02, Math.min(8,
          Math.min((W - pad * 2) / piw, (H - pad * 2) / pih)
        ));
        s.setView({
          zoom: z,
          x: Math.round((W - piw * z) / 2),
          y: Math.round((H - pih * z) / 2),
        });
        return;
      }

      // --- fit to rooms ---
      if (s.rooms.length) {
        let b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
        s.rooms.forEach((r) => r.points.forEach((p) => {
          const x = ft2px(p.x), y = ft2px(p.y);
          b.minx = Math.min(b.minx, x); b.miny = Math.min(b.miny, y);
          b.maxx = Math.max(b.maxx, x); b.maxy = Math.max(b.maxy, y);
        }));
        const bw = b.maxx - b.minx || 1, bh = b.maxy - b.miny || 1;
        const z = Math.max(0.05, Math.min(8, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
        s.setView({
          zoom: z,
          x: pad - b.minx * z + (W - pad * 2 - bw * z) / 2,
          y: pad - b.miny * z + (H - pad * 2 - bh * z) / 2,
        });
        return;
      }

      // fallback
      s.setView({ x: 80, y: 80, zoom: 1 });
    };
    window.addEventListener('tt:fit', fit);
    return () => window.removeEventListener('tt:fit', fit);
  });

  return (
    <div className="stage" ref={wrapRef}>
      <canvas
        ref={cvRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={onDbl}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
        onPointerCancel={() => { pan.current = null; draft.current = null; ruler.current = null; drag.current = null; mkDraft.current = null; marquee.current = null; }}
      />
    </div>
  );
}


