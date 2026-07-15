// ============================================================
// canvasRender.js — all 2D scene drawing. Pure given a render
// context `rc` (store snapshot + transforms + transient draft refs).
// No React. The component calls renderScene() inside its RAF loop.
//
// rc shape:
//   { s, scale, ft2px, px2ft, toScreen,
//     planImg, draft, mkDraft, ruler }   (the last four are the
//   current values of those refs, not the refs themselves)
// ============================================================

import { centroid, polygonArea, bounds } from '../engine/geometry.js';
import { generateLayout } from '../engine/layouts.js';
import { formatLength, formatArea } from '../engine/units.js';
import { markupValue } from '../engine/markups.js';
import { MONO, hexA } from './canvasUtils.js';
import { roundRect } from './canvasUtils.js';

export function renderScene(ctx, W, H, rc) {
  const { s, scale, planImg } = rc;
  // plan underlay — image lives at model-px origin (0,0)
  // view.x/y is the screen offset of model origin, zoom scales it
  if (planImg) {
    const ox = s.view.x;
    const oy = s.view.y;
    // Draw the plan underlay opaque. Architectural plans are thin dark lines on
    // a white page; at low opacity over the near-white stage they're nearly
    // invisible (reads as a blank canvas). Rooms/markups draw on top with their
    // own translucent fills, so they remain clearly visible over the plan.
    ctx.globalAlpha = 1;
    // Use naturalWidth/naturalHeight — img.width/height return 0 on mobile Safari
    // for images not attached to the DOM.
    const piw = planImg.naturalWidth  || planImg.width;
    const pih = planImg.naturalHeight || planImg.height;
    if (piw && pih) {
      ctx.drawImage(planImg, ox, oy, piw * s.view.zoom, pih * s.view.zoom);
    }
    ctx.globalAlpha = 1;
  }
  if (scale && s.showGrid) drawFootGrid(ctx, W, H, rc);
  for (const r of s.rooms) drawRoom(ctx, r, rc);
  for (const mk of s.markups) drawMarkup(ctx, mk, rc);
  if (s.tool === 'grid' && s.gridMaterialId) drawTileGrid(ctx, rc);
  if (rc.draft) drawDraft(ctx, rc);
  if (rc.mkDraft) drawMkDraft(ctx, rc);
  if (rc.ruler) drawRuler(ctx, rc);
  if (rc.marquee) drawMarquee(ctx, rc.marquee);
}

// Rubber-band selection rectangle (screen coords) for multi-select.
function drawMarquee(ctx, m) {
  const x = Math.min(m.sp0.x, m.sp1.x), y = Math.min(m.sp0.y, m.sp1.y);
  const w = Math.abs(m.sp1.x - m.sp0.x), h = Math.abs(m.sp1.y - m.sp0.y);
  ctx.save();
  ctx.fillStyle = 'rgba(15,47,71,.08)'; ctx.strokeStyle = '#0f2f47';
  ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x + .5, y + .5, w, h);
  ctx.restore();
}

function rectScreen(pts, rc) {
  const { ft2px, toScreen } = rc;
  const a = toScreen(ft2px(pts[0].x), ft2px(pts[0].y));
  const b = toScreen(ft2px(pts[1].x), ft2px(pts[1].y));
  return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
}
function labelPos(mk, pts) {
  if (mk.type === 'length') { const m = pts[Math.floor(pts.length / 2)]; return { x: m.x, y: m.y - 12 }; }
  let x = 0, y = 0; pts.forEach((p) => { x += p.x; y += p.y; }); return { x: x / pts.length, y: y / pts.length };
}

// A line with a filled arrowhead at its final point (screen coords).
function drawArrowShape(ctx, pts, color, lw) {
  if (!pts || pts.length < 2) return;
  const a = pts[0], b = pts[pts.length - 1];
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  const ang = Math.atan2(b.y - a.y, b.x - a.x), hl = 13, hw = 0.42;
  ctx.beginPath(); ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - hl * Math.cos(ang - hw), b.y - hl * Math.sin(ang - hw));
  ctx.lineTo(b.x - hl * Math.cos(ang + hw), b.y - hl * Math.sin(ang + hw));
  ctx.closePath(); ctx.fill();
}

// A rounded text label anchored at a point (screen coords).
function drawTextNote(ctx, p, mk, sel) {
  if (!p) return;
  const txt = mk.name || 'Text';
  ctx.font = '600 13px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(txt).width + 14;
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  roundRect(ctx, p.x, p.y - 12, w, 24, 5); ctx.fill();
  ctx.strokeStyle = mk.color; ctx.lineWidth = sel ? 2.2 : 1.3; ctx.stroke();
  ctx.fillStyle = mk.color; ctx.fillText(txt, p.x + 7, p.y + 1);
}

export function drawMarkup(ctx, mk, rc) {
  const { s, scale, ft2px, toScreen } = rc;
  const sel = s.selection.type === 'markup' && s.selection.id === mk.id;
  const pts = (mk.points || []).map((p) => toScreen(ft2px(p.x), ft2px(p.y)));
  ctx.save();
  ctx.strokeStyle = mk.color; ctx.fillStyle = hexA(mk.color, 0.12);
  ctx.lineWidth = sel ? 3 : 2;
  if (mk.type === 'count') {
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, sel ? 9 : 7, 0, 7); ctx.fillStyle = mk.color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    });
  } else if (mk.type === 'length') {
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    pts.forEach((p) => { ctx.fillStyle = mk.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, 7); ctx.fill(); });
  } else if (mk.type === 'arrow') {
    drawArrowShape(ctx, pts, mk.color, sel ? 3 : 2);
  } else if (mk.type === 'text') {
    drawTextNote(ctx, pts[0], mk, sel);
  } else if (mk.type === 'ellipse' && mk.points.length >= 2) {
    const poly = rectScreen(mk.points, rc);
    const cx = (poly[0].x + poly[2].x) / 2, cy = (poly[0].y + poly[2].y) / 2;
    const rx = Math.abs(poly[1].x - poly[0].x) / 2, ry = Math.abs(poly[2].y - poly[1].y) / 2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7); ctx.fill(); ctx.stroke();
  } else {
    const poly = mk.type === 'rect' && mk.points.length >= 2 ? rectScreen(mk.points, rc) : pts;
    ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  // measurement label — annotations (arrow/text) have none
  if (scale && mk.points?.length && mk.type !== 'arrow' && mk.type !== 'text') {
    const c = labelPos(mk, pts);
    const val = markupValue(mk);
    const txt = mk.type === 'length' ? formatLength(val, s.unitSystem)
      : mk.type === 'count' ? `${val} ea`
      : formatArea(val, s.unitSystem);
    ctx.font = '600 11px ' + MONO; ctx.textAlign = 'center';
    const w = ctx.measureText(txt).width + 10;
    ctx.fillStyle = mk.color; roundRect(ctx, c.x - w / 2, c.y - 9, w, 17, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(txt, c.x, c.y + 3);
  }
  ctx.restore();
}

export function drawMkDraft(ctx, rc) {
  const { s, scale, ft2px, toScreen, mkDraft: d } = rc;

  // box / ellipse drafts preview their real shape (not a diagonal line)
  if ((d.type === 'rect' || d.type === 'ellipse') && d.points.length >= 2) {
    const poly = rectScreen(d.points, rc);
    const cx = (poly[0].x + poly[2].x) / 2, cy = (poly[0].y + poly[2].y) / 2;
    const rx = Math.abs(poly[1].x - poly[0].x) / 2, ry = Math.abs(poly[2].y - poly[1].y) / 2;
    ctx.save();
    ctx.strokeStyle = '#c8521f'; ctx.fillStyle = hexA('#c8521f', 0.08);
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.8;
    ctx.beginPath();
    if (d.type === 'ellipse') ctx.ellipse(cx, cy, rx, ry, 0, 0, 7);
    else { poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); }
    ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    if (scale) {
      const [a, b] = d.points;
      const val = d.type === 'ellipse'
        ? Math.PI * (Math.abs(b.x - a.x) / 2) * (Math.abs(b.y - a.y) / 2)
        : Math.abs(b.x - a.x) * Math.abs(b.y - a.y);
      const txt = formatArea(val, s.unitSystem);
      ctx.font = '600 11px ' + MONO; ctx.textAlign = 'left';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = '#c8521f'; roundRect(ctx, cx + 8, cy - 9, w, 18, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, cx + 14, cy + 3.5);
    }
    ctx.restore();
    return;
  }

  const pts = d.points.map((p) => toScreen(ft2px(p.x), ft2px(p.y)));
  const hover = d.hover ? toScreen(ft2px(d.hover.x), ft2px(d.hover.y)) : null;
  ctx.save(); ctx.strokeStyle = '#c8521f'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.8;
  ctx.beginPath();
  [...pts, ...(hover ? [hover] : [])].forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  if (d.type === 'area' && pts.length >= 2) ctx.closePath();
  ctx.stroke(); ctx.setLineDash([]);
  pts.forEach((p) => { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 7); ctx.fill(); ctx.stroke(); });

  // live readout at the cursor while drawing
  if (scale) {
    const model = [...d.points, ...(d.hover ? [d.hover] : [])];
    let txt = null;
    if (d.type === 'length' && model.length >= 2) {
      let len = 0;
      for (let i = 1; i < model.length; i++) len += Math.hypot(model[i].x - model[i - 1].x, model[i].y - model[i - 1].y);
      txt = formatLength(len, s.unitSystem);
    } else if (d.type === 'area' && model.length >= 3) {
      txt = formatArea(Math.abs(polygonArea(model)), s.unitSystem);
    }
    const anchor = hover || pts[pts.length - 1];
    if (txt && anchor) {
      ctx.font = '600 11px ' + MONO; ctx.textAlign = 'left';
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = '#c8521f'; roundRect(ctx, anchor.x + 12, anchor.y - 9, w, 18, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, anchor.x + 18, anchor.y + 3.5);
    }
  }
  ctx.restore();
}

export function drawFootGrid(ctx, W, H, rc) {
  const { s, ft2px } = rc;
  const z = s.view.zoom, step = ft2px(1) * z;
  if (step < 6) return;
  for (let i = 0; ; i++) {
    const x = ((s.view.x % step) + step) % step + i * step;
    if (x > W) break;
    const major = Math.round((x - s.view.x) / (ft2px(1) * z)) % 5 === 0;
    ctx.strokeStyle = major ? '#bcd4e4' : '#dde9f1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, H); ctx.stroke();
  }
  for (let i = 0; ; i++) {
    const y = ((s.view.y % step) + step) % step + i * step;
    if (y > H) break;
    const major = Math.round((y - s.view.y) / (ft2px(1) * z)) % 5 === 0;
    ctx.strokeStyle = major ? '#bcd4e4' : '#dde9f1'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(W, Math.round(y) + .5); ctx.stroke();
  }
}

function roomScreenPath(ctx, r, rc) {
  const { ft2px, toScreen } = rc;
  ctx.beginPath();
  r.points.forEach((p, i) => {
    const sp = toScreen(ft2px(p.x), ft2px(p.y));
    i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
  });
  ctx.closePath();
}

export function drawRoom(ctx, r, rc) {
  const { s, scale, ft2px, toScreen } = rc;
  const inMulti = s.selRooms?.includes(r.id);
  const primary = s.selection.type === 'room' && s.selection.id === r.id;
  const selected = primary || inMulti;
  ctx.save();
  roomScreenPath(ctx, r, rc);
  ctx.fillStyle = hexA(r.color, selected ? .18 : .1);
  ctx.strokeStyle = r.color; ctx.lineWidth = selected ? 2.5 : 1.6;
  ctx.fill(); ctx.stroke();
  // a dashed accent ring marks every member of a multi-selection
  if (inMulti && s.selRooms.length > 1) {
    roomScreenPath(ctx, r, rc);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2; ctx.stroke();
    ctx.setLineDash([]);
  }
  const c = centroid(r.points); const cs = toScreen(ft2px(c.x), ft2px(c.y));
  const area = scale ? polygonArea(r.points) : 0;
  ctx.fillStyle = r.color; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(r.name, cs.x, cs.y - 4);
  if (scale) {
    ctx.font = '600 11px ' + MONO; ctx.fillStyle = hexA(r.color, .85);
    ctx.fillText(formatArea(area, s.unitSystem), cs.x, cs.y + 12);
  }
  // vertex handles only when this room is the sole selection (multi-select
  // moves the group, so per-vertex editing is hidden then)
  if (primary && s.tool === 'select' && (s.selRooms?.length ?? 0) <= 1) {
    r.points.forEach((p) => {
      const sp = toScreen(ft2px(p.x), ft2px(p.y));
      ctx.fillStyle = '#fff'; ctx.strokeStyle = r.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(sp.x - 5, sp.y - 5, 10, 10); ctx.fill(); ctx.stroke();
    });
  }
  ctx.restore();
}

export function drawTileGrid(ctx, rc) {
  const { s, ft2px, toScreen } = rc;
  const m = s.materials.find((x) => x.id === s.gridMaterialId); if (!m) return;
  const twFt = (m.tw + (m.grout || 0)) / 12, thFt = (m.th + (m.grout || 0)) / 12;
  s.rooms.filter((r) => r.assigned?.includes(m.id)).forEach((r) => {
    ctx.save();
    roomScreenPath(ctx, r, rc); ctx.clip();
    const tiles = generateLayout(r.points, {
      pattern: r.layout?.pattern || m.pattern || 'grid',
      tileW: twFt, tileH: thFt,
      angleDeg: r.layout?.angleDeg || 0, origin: r.layout?.origin || { x: 0, y: 0 },
    });
    const z = s.view.zoom;
    tiles.forEach((t) => {
      const sp = toScreen(ft2px(t.cx), ft2px(t.cy));
      const w = ft2px(t.w) * z, h = ft2px(t.h) * z;
      if (w < 2 || h < 2) return;
      ctx.save(); ctx.translate(sp.x, sp.y); ctx.rotate(t.rot);
      ctx.fillStyle = hexA(m.color, .1); ctx.strokeStyle = hexA(m.color, .5); ctx.lineWidth = 1;
      ctx.fillRect(-w / 2, -h / 2, w - 1, h - 1); ctx.strokeRect(-w / 2, -h / 2, w - 1, h - 1);
      ctx.restore();
    });
    ctx.restore();
  });
}

export function drawDraft(ctx, rc) {
  const { s, scale, ft2px, toScreen, draft: d } = rc;
  ctx.save();
  ctx.setLineDash([6, 4]); ctx.lineWidth = 1.8;
  ctx.strokeStyle = '#c8521f'; ctx.fillStyle = hexA('#c8521f', .08);
  ctx.beginPath();
  d.points.forEach((p, i) => { const sp = toScreen(ft2px(p.x), ft2px(p.y)); i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y); });
  if (d.kind === 'rect') ctx.closePath();
  ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
  d.points.forEach((p) => {
    const sp = toScreen(ft2px(p.x), ft2px(p.y));
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, 7); ctx.fill(); ctx.stroke();
  });
  if (scale && d.kind === 'rect' && d.points.length === 4) {
    const b = bounds(d.points); const c = toScreen(ft2px(b.minx + b.w / 2), ft2px(b.miny + b.h / 2));
    ctx.fillStyle = '#10171f'; ctx.font = '600 12px ' + MONO; ctx.textAlign = 'center';
    ctx.fillText(`${formatLength(b.w, s.unitSystem)} × ${formatLength(b.h, s.unitSystem)}`, c.x, c.y);
  }
  ctx.restore();
}

export function drawRuler(ctx, rc) {
  const { p1, p2 } = rc.ruler;
  const { s, scale, px2ft, toScreen } = rc;
  const a = toScreen(p1.x, p1.y), b = toScreen(p2.x, p2.y);
  ctx.save(); ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2.5; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  [a, b].forEach((p) => {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); ctx.stroke();
  });
  // readout: model-px length now, or real length once a scale exists
  const dpx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dpx > 4) {
    const txt = scale ? formatLength(px2ft(dpx), s.unitSystem) : `${Math.round(dpx)} px`;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.font = '600 11px ' + MONO; ctx.textAlign = 'left';
    const w = ctx.measureText(txt).width + 12;
    ctx.fillStyle = '#c8521f'; roundRect(ctx, mx + 10, my - 20, w, 18, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(txt, mx + 16, my - 7.5);
  }
  ctx.restore();
}
