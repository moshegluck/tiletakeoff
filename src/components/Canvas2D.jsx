import React, { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../state/store.js';
import { rectPoly, bounds } from '../engine/geometry.js';
import { snap } from '../engine/units.js';
import { axisLock, inPoly, makeTransforms } from './canvasUtils.js';
import { renderScene } from './canvasRender.js';

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
  const planImg = useRef(null);
  const raf = useRef(0);

  const scale = s.scale;        // feet per model-px
  const { ft2px, px2ft, toScreen, toModel } = makeTransforms(s.view, scale);

  // load plan underlay image
  useEffect(() => {
    if (!s.planImage) { planImg.current = null; return; }
    const img = new Image();
    img.onload = () => { planImg.current = img; schedule(); };
    img.src = s.planImage;
  }, [s.planImage]);

  const schedule = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(draw);
  });

  // ---------- render ----------
  function draw() {
    const cv = cvRef.current; if (!cv) return;
    const ctx = cv.getContext('2d');
    const DPR = window.devicePixelRatio || 1;
    const W = cv.width / DPR, H = cv.height / DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    renderScene(ctx, W, H, {
      s, scale, ft2px, px2ft, toScreen,
      planImg: planImg.current,
      draft: draft.current,
      mkDraft: mkDraft.current,
      ruler: ruler.current,
    });
  }

  // ---------- interaction ----------
  function evPt(e) { const r = cvRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  const down = useRef(null);

  function onDown(e) {
    cvRef.current.setPointerCapture(e.pointerId);
    const sp = evPt(e), mp = toModel(sp.x, sp.y);
    const mfx = px2ft(mp.x), mfy = px2ft(mp.y);
    down.current = { sp, mp };

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
        const first = mkDraft.current.points[0];
        const fs = toScreen(ft2px(first.x), ft2px(first.y));
        const closeEnough = Math.hypot(sp.x - fs.x, sp.y - fs.y) < 10;
        const minPts = type === 'area' ? 3 : 2;
        if (closeEnough && mkDraft.current.points.length >= minPts) {
          commitMkDraft();
        } else mkDraft.current.points.push({ x: mfx, y: mfy });
      }
      schedule(); return;
    }
    if (s.tool === 'mk_rect') {
      mkDraft.current = { type: 'rect', ox: mfx, oy: mfy, points: [{ x: mfx, y: mfy }, { x: mfx, y: mfy }] };
      return;
    }
    if (s.tool === 'select') {
      const hit = hitTest(sp);
      if (hit) {
        s.select('room', hit.room.id); s.setTab('rooms');
        if (hit.vertex != null) drag.current = { room: hit.room, mode: 'vertex', idx: hit.vertex, mp };
        else drag.current = { room: hit.room, mode: 'move', start: hit.room.points.map((p) => ({ ...p })), mp };
      } else { s.select(null, null); pan.current = { x: s.view.x, y: s.view.y, sp }; }
      schedule(); return;
    }
    if (s.tool === 'pan') { pan.current = { x: s.view.x, y: s.view.y, sp }; }
  }

  function onMove(e) {
    const sp = evPt(e), mp = toModel(sp.x, sp.y);
    const mfx = px2ft(mp.x), mfy = px2ft(mp.y);

    if (pan.current) { s.setView({ ...s.view, x: pan.current.x + (sp.x - pan.current.sp.x), y: pan.current.y + (sp.y - pan.current.sp.y) }); schedule(); return; }
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
    if (mkDraft.current?.type === 'rect' && down.current) {
      mkDraft.current.points = [{ x: mkDraft.current.ox, y: mkDraft.current.oy }, { x: mfx, y: mfy }];
      schedule(); return;
    }
    if (mkDraft.current && (mkDraft.current.type === 'length' || mkDraft.current.type === 'area')) {
      mkDraft.current.hover = { x: mfx, y: mfy }; schedule(); return;
    }
    if (drag.current) {
      const d = drag.current; const dfx = px2ft(mp.x - d.mp.x), dfy = px2ft(mp.y - d.mp.y);
      if (d.mode === 'move') {
        const pts = d.start.map((p) => ({ x: scale ? snap(p.x + dfx, .25) : p.x + dfx, y: scale ? snap(p.y + dfy, .25) : p.y + dfy }));
        s.updateRoom(d.room.id, { points: pts });
      } else {
        const pts = d.room.points.map((p, i) => i === d.idx ? { x: scale ? snap(mfx, .25) : mfx, y: scale ? snap(mfy, .25) : mfy } : p);
        s.updateRoom(d.room.id, { points: pts });
      }
      schedule(); return;
    }
  }

  function onUp(e) {
    const sp = evPt(e), mp = toModel(sp.x, sp.y);
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
    if (mkDraft.current?.type === 'rect') {
      const [a, b] = mkDraft.current.points;
      if (Math.abs(b.x - a.x) > 0.2 && Math.abs(b.y - a.y) > 0.2) {
        s.addMarkup({ type: 'rect', points: [a, b], name: 'Area', color: '#7a3fa0' });
      }
      mkDraft.current = null; down.current = null; schedule(); return;
    }
    if (drag.current) { drag.current = null; }
    pan.current = null; down.current = null;
  }

  function commitMkDraft() {
    const d = mkDraft.current; if (!d) return;
    const name = d.type === 'length' ? 'Length' : 'Area';
    const color = d.type === 'length' ? '#1d7a4d' : '#7a3fa0';
    s.addMarkup({ type: d.type, points: d.points, name, color });
    mkDraft.current = null;
    s.setTool('select');
  }

  function promptScale(px) {
    const cur = scale ? px2ft(px).toFixed(2) : '10';
    const v = window.prompt(`Line length on screen = ${px.toFixed(0)} px.\n\nEnter its REAL length in feet (e.g. 12.5):`, cur);
    if (v == null) return;
    const ft = parseFloat(v);
    if (!(ft > 0)) return;
    s.setScale(ft / px);
    s.setTool('room');
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
  }, []);

  // redraw on any state change
  useEffect(() => { schedule(); });

  // clear in-progress markup state when switching tools
  useEffect(() => {
    if (s.tool !== 'mk_count') mkActive.current = null;
    if (!s.tool.startsWith('mk_')) mkDraft.current = null;
  }, [s.tool]);

  // expose fit via custom event
  useEffect(() => {
    const fit = () => {
      if (!s.rooms.length) { s.setView({ x: 80, y: 80, zoom: 1 }); return; }
      let b = { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
      s.rooms.forEach((r) => r.points.forEach((p) => {
        const x = ft2px(p.x), y = ft2px(p.y);
        b.minx = Math.min(b.minx, x); b.miny = Math.min(b.miny, y);
        b.maxx = Math.max(b.maxx, x); b.maxy = Math.max(b.maxy, y);
      }));
      const cv = cvRef.current, DPR = window.devicePixelRatio || 1;
      const W = cv.width / DPR, H = cv.height / DPR, pad = 60;
      const z = Math.max(0.15, Math.min(8, Math.min((W - pad * 2) / (b.maxx - b.minx || 1), (H - pad * 2) / (b.maxy - b.miny || 1))));
      s.setView({ zoom: z, x: pad - b.minx * z + (W - pad * 2 - (b.maxx - b.minx) * z) / 2, y: pad - b.miny * z + (H - pad * 2 - (b.maxy - b.miny) * z) / 2 });
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
        onPointerCancel={() => { pan.current = null; draft.current = null; ruler.current = null; drag.current = null; }}
        onWheel={onWheel}
      />
    </div>
  );
}


