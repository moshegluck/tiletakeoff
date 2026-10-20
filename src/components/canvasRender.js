// ============================================================
// canvasRender.js — all 2D scene drawing. Pure given a render
// context `rc` (store snapshot + transforms + transient draft refs).
// No React. The component calls renderScene() inside its RAF loop.
//
// rc shape:
//   { s, scale, ft2px, px2ft, toScreen,
//     planImg, draft, mkDraft, ruler, marquee, hoverSnap }   (the
//   transient ones are the current values of those refs, not the refs)
// ============================================================

import { centroid, polygonArea, bounds, roomArea, pointInPolygon } from '../engine/geometry.js';
import { generateLayout } from '../engine/layouts.js';
import { formatLength, formatArea } from '../engine/units.js';
import { markupValue } from '../engine/markups.js';
import { roomRegions, zonesOf } from '../engine/zones.js';
import { MONO, hexA, fitLabelLines, clusterPins } from './canvasUtils.js';
import { roundRect } from './canvasUtils.js';

export function renderScene(ctx, W, H, rc) {
  rc.W = W; rc.H = H;
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
    const z = s.view.zoom;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (piw && pih) {
      ctx.drawImage(planImg, ox, oy, piw * z, pih * z);
    }
    // the on-screen part re-rendered from the PDF at device resolution
    // (lib/planDetail.js); canvas px i ↔ model px d.x + i / d.k exactly
    const d = rc.planDetail;
    if (d) ctx.drawImage(d.canvas, ox + d.x * z, oy + d.y * z, (d.canvas.width / d.k) * z, (d.canvas.height / d.k) * z);
    ctx.globalAlpha = 1;
  }
  if (scale && s.showGrid) drawFootGrid(ctx, W, H, rc);
  for (const r of s.rooms) drawRoom(ctx, r, rc);
  if (scale && (s.trace || rc.trDraft)) drawTrace(ctx, rc);
  for (const mk of s.markups) drawMarkup(ctx, mk, rc);
  if (s.tool === 'grid' && s.gridMaterialId) drawTileGrid(ctx, rc);
  if (rc.draft) drawDraft(ctx, rc);
  if (rc.mkDraft) drawMkDraft(ctx, rc);
  if (rc.ruler) drawRuler(ctx, rc);
  if (rc.marquee) drawMarquee(ctx, rc.marquee);
  if (rc.hoverSnap) drawSnapMarker(ctx, rc, rc.hoverSnap);
}

// Where a click lands: a square on a line end, an × on a corner where two
// lines cross, a diamond on a line. Plan snaps are in underlay px, design
// snaps in feet.
function drawSnapMarker(ctx, rc, h) {
  const p = h.px ? rc.toScreen(h.x, h.y) : rc.toScreen(rc.ft2px(h.x), rc.ft2px(h.y));
  ctx.save();
  ctx.strokeStyle = '#1d7a4d'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(29,122,77,.12)';
  ctx.beginPath();
  if (h.kind === 'edge') { ctx.moveTo(p.x, p.y - 7); ctx.lineTo(p.x + 7, p.y); ctx.lineTo(p.x, p.y + 7); ctx.lineTo(p.x - 7, p.y); ctx.closePath(); }
  else ctx.rect(p.x - 6, p.y - 6, 12, 12);
  ctx.fill(); ctx.stroke();
  if (h.kind === 'corner') { ctx.beginPath(); ctx.moveTo(p.x - 4, p.y - 4); ctx.lineTo(p.x + 4, p.y + 4); ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(p.x - 4, p.y + 4); ctx.stroke(); }
  ctx.restore();
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
  // multiply: the grid tints the white paper but never paints over the
  // plan's dark lines and text
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  drawFootGridLines(ctx, W, H, rc);
  ctx.restore();
}

function drawFootGridLines(ctx, W, H, rc) {
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
  ctx.beginPath();
  tracePoly(ctx, r.points, rc);
  // traced rooms: holes (columns, chases) cut out with the even-odd rule
  for (const h of r.holes || []) tracePoly(ctx, h, rc);
}

// Add one closed polygon (feet) to the current path without starting a new
// one, so rings and holes can be filled/clipped with the even-odd rule.
function tracePoly(ctx, pts, rc) {
  const { ft2px, toScreen } = rc;
  pts.forEach((p, i) => {
    const sp = toScreen(ft2px(p.x), ft2px(p.y));
    i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y);
  });
  ctx.closePath();
}

// Floor design zones: border bands as tinted rings that follow the walls,
// inlays as tinted shapes with a label. A zone with no material yet is drawn
// faint and dashed so it reads as "not being estimated".
function drawZones(ctx, r, rc) {
  if (!zonesOf(r).length) return;
  const { s, scale, ft2px, toScreen } = rc;
  const reg = roomRegions(r);
  const roomSel = s.selection.type === 'room' && s.selection.id === r.id;
  for (const b of reg.bands) {
    const col = b.zone.color || '#7a3fa0';
    const sel = roomSel && s.selZone === b.zone.id;
    ctx.save();
    ctx.beginPath(); tracePoly(ctx, b.outer, rc); tracePoly(ctx, b.holes[0], rc);
    ctx.fillStyle = hexA(col, b.zone.materialId ? (sel ? .55 : .38) : .12);
    ctx.fill('evenodd');
    ctx.strokeStyle = col; ctx.lineWidth = sel ? 2.2 : 1.1;
    if (!b.zone.materialId) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  }
  for (const z of reg.inlays) {
    const col = z.zone.color || '#b25e00';
    const sel = roomSel && s.selZone === z.zone.id;
    ctx.save();
    ctx.beginPath(); tracePoly(ctx, z.outer, rc);
    ctx.fillStyle = hexA(col, z.zone.materialId ? (sel ? .5 : .32) : .1);
    ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = sel ? 2.4 : 1.4;
    if (!z.zone.materialId) ctx.setLineDash([4, 3]);
    ctx.stroke(); ctx.setLineDash([]);
    const pts = z.outer.map((p) => toScreen(ft2px(p.x), ft2px(p.y)));
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    pts.forEach((p) => { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); });
    if (maxx - minx > 46 && maxy - miny > 26) {
      const c = centroid(z.outer), cs = toScreen(ft2px(c.x), ft2px(c.y));
      ctx.textAlign = 'center'; ctx.fillStyle = col;
      ctx.font = '600 11px Inter, sans-serif'; ctx.fillText(z.zone.name, cs.x, cs.y - 2);
      if (scale) { ctx.font = '600 10px ' + MONO; ctx.fillText(formatArea(z.area, s.unitSystem), cs.x, cs.y + 11); }
    }
    if (sel && s.tool === 'select') {
      pts.forEach((p) => {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); ctx.stroke();
      });
    }
    ctx.restore();
  }
}

// The room's name and area, only as large as fits inside the room on screen
// (canvasUtils.fitLabelLines): small closets at low zoom show what fits, or
// nothing, instead of printing over their neighbours. The selected room
// always shows its label.
function drawRoomLabel(ctx, r, rc, selected) {
  const { s, ft2px, toScreen } = rc;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of r.points) {
    const q = toScreen(ft2px(p.x), ft2px(p.y));
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  }
  const lines = [
    { text: r.name, size: 12, min: 8.5, wrap: true, font: '600 {}px Inter, sans-serif', color: r.color },
    { text: s.scale ? formatArea(roomArea(r), s.unitSystem) : '', size: 11, min: 8.5, font: '600 {}px ' + MONO, color: hexA(r.color, .9) },
  ];
  const fit = selected
    ? lines.map((l, i) => ({ text: l.text, size: l.size, i })).filter((l) => l.text)
    : fitLabelLines(lines, x1 - x0, y1 - y0, measureWith(ctx, lines));
  const c = r.labelAt || centroid(r.points);
  drawLabelStack(ctx, fit, lines, toScreen(ft2px(c.x), ft2px(c.y)));
}

const measureWith = (ctx, lines) => (text, size, i) => { ctx.font = lines[i].font.replace('{}', String(size)); return ctx.measureText(text).width; };

// fitted label lines, centred on a point, each with a white halo so it reads over the drawing
function drawLabelStack(ctx, fit, lines, at) {
  if (!fit.length) return;
  let y = at.y - fit.reduce((a, l) => a + l.size * 1.25, 0) / 2;
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 3;
  for (const l of fit) {
    ctx.font = lines[l.i].font.replace('{}', String(l.size));
    ctx.strokeText(l.text, at.x, y); ctx.fillStyle = lines[l.i].color; ctx.fillText(l.text, at.x, y);
    y += l.size * 1.25;
  }
  ctx.restore();
}

export function drawRoom(ctx, r, rc) {
  const { s, ft2px, toScreen } = rc;
  const inMulti = s.selRooms?.includes(r.id);
  const primary = s.selection.type === 'room' && s.selection.id === r.id;
  const selected = primary || inMulti;
  ctx.save();
  roomScreenPath(ctx, r, rc);
  ctx.fillStyle = hexA(r.color, selected ? .18 : .1);
  ctx.strokeStyle = r.color; ctx.lineWidth = selected ? 2.5 : 1.6;
  ctx.fill('evenodd'); ctx.stroke();
  // a dashed accent ring marks every member of a multi-selection
  if (inMulti && s.selRooms.length > 1) {
    roomScreenPath(ctx, r, rc);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#c8521f'; ctx.lineWidth = 2; ctx.stroke();
    ctx.setLineDash([]);
  }
  drawZones(ctx, r, rc);
  drawRoomLabel(ctx, r, rc, primary);
  // vertex handles only when this room is the sole selection (multi-select
  // moves the group, so per-vertex editing is hidden then)
  if (primary && !s.selZone && s.tool === 'select' && (s.selRooms?.length ?? 0) <= 1) {
    r.points.forEach((p) => {
      const sp = toScreen(ft2px(p.x), ft2px(p.y));
      ctx.fillStyle = '#fff'; ctx.strokeStyle = r.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(sp.x - 5, sp.y - 5, 10, 10); ctx.fill(); ctx.stroke();
    });
  }
  ctx.restore();
}

export function drawTileGrid(ctx, rc) {
  const { s } = rc;
  const m = s.materials.find((x) => x.id === s.gridMaterialId); if (!m) return;
  const twFt = (m.tw + (m.grout || 0)) / 12, thFt = (m.th + (m.grout || 0)) / 12;
  for (const r of s.rooms) {
    const onField = r.assigned?.includes(m.id);
    const onZone = zonesOf(r).some((z) => z.materialId === m.id);
    if (!onField && !onZone) continue;
    const reg = roomRegions(r);
    if (onField) {
      // clip to the field only: room minus bands minus inlays (even-odd)
      ctx.save();
      ctx.beginPath();
      for (const f of reg.field) { tracePoly(ctx, f.outer, rc); f.holes.forEach((h) => tracePoly(ctx, h, rc)); }
      ctx.clip('evenodd');
      drawLayoutTiles(ctx, rc, m, r.points, r.layout, twFt, thFt);
      ctx.restore();
    }
    for (const z of reg.inlays) {
      if (z.zone.materialId !== m.id) continue;
      ctx.save();
      ctx.beginPath(); tracePoly(ctx, z.outer, rc); ctx.clip();
      drawLayoutTiles(ctx, rc, m, z.outer, z.layout, twFt, thFt);
      ctx.restore();
    }
    for (const b of reg.bands) if (b.zone.materialId === m.id) drawBandJoints(ctx, rc, m, b);
  }
}

// Tile layouts only change with the room or the tile, never with the view,
// so they are generated once and reused every frame (rooms are immutable:
// an edited room is a new points array).
const layoutCache = new WeakMap();
function cachedLayout(poly, opts) {
  let byPoly = layoutCache.get(poly);
  if (!byPoly) { byPoly = new Map(); layoutCache.set(poly, byPoly); }
  const key = `${opts.pattern}|${opts.tileW}|${opts.tileH}|${opts.angleDeg}|${opts.origin.x},${opts.origin.y}`;
  let tiles = byPoly.get(key);
  if (!tiles) {
    if (byPoly.size > 8) byPoly.clear();
    tiles = generateLayout(poly, opts);
    byPoly.set(key, tiles);
  }
  return tiles;
}

function drawLayoutTiles(ctx, rc, m, poly, layout, twFt, thFt) {
  const { s, ft2px, toScreen, W = Infinity, H = Infinity } = rc;
  const tiles = cachedLayout(poly, {
    pattern: layout?.pattern || m.pattern || 'grid',
    tileW: twFt, tileH: thFt,
    angleDeg: layout?.angleDeg || 0, origin: layout?.origin || { x: 0, y: 0 },
  });
  const z = s.view.zoom;
  const w = ft2px(twFt) * z, h = ft2px(thFt) * z;
  if (Math.min(w, h) < 2) return;               // too small to read: skip the grid
  // every visible tile goes into one path: one fill and one stroke per room
  const path = new Path2D();
  for (const t of tiles) {
    const sp = toScreen(ft2px(t.cx), ft2px(t.cy));
    const tw = ft2px(t.w) * z - 1, th = ft2px(t.h) * z - 1;
    const r = (tw + th) / 2 + 1;
    if (sp.x < -r || sp.y < -r || sp.x > W + r || sp.y > H + r) continue;
    if (!t.rot) { path.rect(sp.x - tw / 2 - 0.5, sp.y - th / 2 - 0.5, tw, th); continue; }
    const c = Math.cos(t.rot), si = Math.sin(t.rot), hx = tw / 2, hy = th / 2;
    path.moveTo(sp.x - hx * c + hy * si, sp.y - hx * si - hy * c);
    path.lineTo(sp.x + hx * c + hy * si, sp.y + hx * si - hy * c);
    path.lineTo(sp.x + hx * c - hy * si, sp.y + hx * si + hy * c);
    path.lineTo(sp.x - hx * c - hy * si, sp.y - hx * si + hy * c);
    path.closePath();
  }
  ctx.fillStyle = hexA(m.color, .1); ctx.strokeStyle = hexA(m.color, .5); ctx.lineWidth = 1;
  ctx.fill(path); ctx.stroke(path);
}

// Border band: a joint across the band at every piece length along each run.
function drawBandJoints(ctx, rc, m, band) {
  const { ft2px, toScreen } = rc;
  const g = (m.grout || 0) / 12;
  const L = Math.max(m.tw, m.th) / 12 + g;
  if (!(L > 0)) return;
  const half = (+band.zone.width || 0) / 2;
  const C = band.centerline;
  // inward normal sign depends on the polygon's winding
  let sa = 0;
  for (let i = 0; i < C.length; i++) { const p = C[i], q = C[(i + 1) % C.length]; sa += p.x * q.y - q.x * p.y; }
  const sgn = sa > 0 ? 1 : -1;
  ctx.save();
  ctx.strokeStyle = hexA(m.color, .9); ctx.lineWidth = 1;
  for (let i = 0; i < C.length; i++) {
    const a = C[i], b = C[(i + 1) % C.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const nx = -uy * sgn, ny = ux * sgn;
    for (let d = 0; d <= len + 1e-6; d += L) {
      const px = a.x + ux * d, py = a.y + uy * d;
      const p1 = toScreen(ft2px(px - nx * half), ft2px(py - ny * half));
      const p2 = toScreen(ft2px(px + nx * half), ft2px(py + ny * half));
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawDraft(ctx, rc) {
  const { s, scale, ft2px, toScreen, draft: d } = rc;
  // floor design drafts (zrect / zpoly) draw purple so they read as "not a wall"
  const zone = d.kind === 'zrect' || d.kind === 'zpoly';
  const col = zone ? '#7a3fa0' : '#c8521f';
  const closed = d.kind === 'rect' || d.kind === 'zrect';
  ctx.save();
  ctx.setLineDash([6, 4]); ctx.lineWidth = 1.8;
  ctx.strokeStyle = col; ctx.fillStyle = hexA(col, .08);
  ctx.beginPath();
  const path = [...d.points, ...(!closed && d.hover ? [d.hover] : [])];
  path.forEach((p, i) => { const sp = toScreen(ft2px(p.x), ft2px(p.y)); i === 0 ? ctx.moveTo(sp.x, sp.y) : ctx.lineTo(sp.x, sp.y); });
  if (closed) ctx.closePath();
  ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
  d.points.forEach((p) => {
    const sp = toScreen(ft2px(p.x), ft2px(p.y));
    ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 4, 0, 7); ctx.fill(); ctx.stroke();
  });
  // snap marker: the point landed on a room/zone corner or wall
  if (d.snap) {
    const sp = toScreen(ft2px(d.snap.x), ft2px(d.snap.y));
    ctx.strokeStyle = '#1d7a4d'; ctx.lineWidth = 2;
    ctx.strokeRect(sp.x - 6, sp.y - 6, 12, 12);
  }
  if (scale && closed && d.points.length === 4) {
    const b = bounds(d.points); const c = toScreen(ft2px(b.minx + b.w / 2), ft2px(b.miny + b.h / 2));
    ctx.fillStyle = '#10171f'; ctx.font = '600 12px ' + MONO; ctx.textAlign = 'center';
    ctx.fillText(`${formatLength(b.w, s.unitSystem)} × ${formatLength(b.h, s.unitSystem)}`, c.x, c.y);
  }
  // live segment length while tracing a design polygon
  if (scale && d.kind === 'zpoly' && d.hover && d.points.length) {
    const a = d.points[d.points.length - 1];
    const txt = formatLength(Math.hypot(d.hover.x - a.x, d.hover.y - a.y), s.unitSystem);
    const hs = toScreen(ft2px(d.hover.x), ft2px(d.hover.y));
    ctx.font = '600 11px ' + MONO; ctx.textAlign = 'left';
    const w = ctx.measureText(txt).width + 12;
    ctx.fillStyle = col; roundRect(ctx, hs.x + 12, hs.y - 9, w, 18, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(txt, hs.x + 18, hs.y + 3.5);
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

// ---------------------------------------------------------------------------
// TRACE OVERLAY — the reconstructed model drawn over the plan, so you can see
// exactly what the takeoff is made of and where it needs you.
// ---------------------------------------------------------------------------
const TR = {
  wall: 'rgba(15,47,71,.62)', wallEdge: '#0f2f47', manual: 'rgba(29,122,77,.75)', repair: 'rgba(178,94,0,.7)',
  open: '#c8521f', ok: '#1d7a4d', review: '#b25e00', error: '#b3261e',
};

// Which traced rooms the takeoff already has a room on (added by hand or by
// AI Detect): at least half of the traced room, sampled on a grid, lies
// inside takeoff rooms. Worked out once per trace result + room list.
const coverCache = new WeakMap();
function coveredByTakeoff(res, rooms) {
  const hit = coverCache.get(res);
  if (hit && hit.rooms === rooms) return hit.fn;
  const set = new Set();
  for (const r of res.rooms) {
    if (!r.poly?.length || !rooms.length) continue;
    const b = bounds(r.poly);
    let inRoom = 0, inTakeoff = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const x = b.minx + ((i + 0.5) / 8) * b.w, y = b.miny + ((j + 0.5) / 8) * b.h;
        if (!pointInPolygon(x, y, r.poly)) continue;
        inRoom++;
        if (rooms.some((t) => pointInPolygon(x, y, t.points))) inTakeoff++;
      }
    }
    if (inRoom && inTakeoff * 2 >= inRoom) set.add(r.id);
  }
  const fn = (r) => set.has(r.id);
  coverCache.set(res, { rooms, fn });
  return fn;
}

export function drawTrace(ctx, rc) {
  const { s, ft2px, toScreen } = rc;
  const res = s.trace?.result;
  const S = (p) => toScreen(ft2px(p.x), ft2px(p.y));
  const z = s.view.zoom;
  const pxPerFt = ft2px(1) * z;
  const focus = s.traceFocus;
  ctx.save();

  if (res && s.showTrace) {
    const committed = !!s.trace.committedAt;
    // a traced room the takeoff already has a room on (added by hand or by AI
    // Detect) draws as an outline only — one label per room on screen
    const covered = coveredByTakeoff(res, s.rooms);
    // rooms (only until they've been sent to the takeoff — then the room layer shows them)
    for (const r of res.rooms) {
      const on = focus?.type === 'room' && focus.id === r.id;
      if (committed && !on) continue;
      const col = TR[r.status] || TR.ok;
      const under = !on && covered(r);
      ctx.beginPath();
      for (const ring of [r.poly, ...(r.holes || [])]) {
        ring.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        ctx.closePath();
      }
      if (!under) { ctx.fillStyle = hexA(col, on ? 0.2 : 0.09); ctx.fill('evenodd'); }
      ctx.strokeStyle = hexA(col, under ? 0.5 : 0.9); ctx.lineWidth = on ? 2.5 : 1.2; ctx.stroke();
    }
    // walls as real bodies
    for (const w of res.walls) {
      const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L * w.t / 2, ny = dx / L * w.t / 2;
      const q = [S({ x: w.a.x + nx, y: w.a.y + ny }), S({ x: w.b.x + nx, y: w.b.y + ny }), S({ x: w.b.x - nx, y: w.b.y - ny }), S({ x: w.a.x - nx, y: w.a.y - ny })];
      ctx.beginPath(); q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      ctx.fillStyle = w.src === 'manual' ? TR.manual : w.src === 'repair' ? TR.repair : TR.wall;
      ctx.fill();
    }
    // openings: dashed across the gap, width label when zoomed in
    ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
    for (const o of res.openings) {
      const a = S(o.a), b = S(o.b);
      ctx.strokeStyle = o.openingType === 'opening' ? hexA(TR.open, 0.75) : TR.open;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (pxPerFt > 9) {
      ctx.font = '600 10px ' + MONO; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const o of res.openings) {
        const m = S({ x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 });
        const txt = formatLength(o.width, s.unitSystem);
        const w = ctx.measureText(txt).width + 8;
        ctx.fillStyle = 'rgba(255,255,255,.92)'; roundRect(ctx, m.x - w / 2, m.y - 8, w, 16, 4); ctx.fill();
        ctx.fillStyle = TR.open; ctx.fillText(txt, m.x, m.y + 0.5);
      }
    }
    // room labels before commit
    if (!committed) {
      for (const r of res.rooms) {
        if (!(focus?.type === 'room' && focus.id === r.id) && covered(r)) continue;
        // only as many lines as fit inside the room on screen
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of r.poly) { const q = S(p); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
        const lines = [
          { text: r.name, size: 12, min: 8.5, wrap: true, font: '700 {}px Inter, sans-serif', color: TR[r.status] || TR.ok },
          { text: formatArea(r.area, s.unitSystem), size: 10.5, min: 8.5, font: '600 {}px ' + MONO, color: '#33414f' },
          { text: `${formatLength(r.wallLf, s.unitSystem)} LF`, size: 10.5, min: 8.5, font: '600 {}px ' + MONO, color: '#5b6976' },
        ];
        drawLabelStack(ctx, fitLabelLines(lines, x1 - x0, y1 - y0, measureWith(ctx, lines)), lines, S(r.center));
      }
    }
    // auto-fixes: small ticks, only when zoomed in enough to matter
    if (pxPerFt > 14) {
      ctx.fillStyle = 'rgba(29,122,77,.8)';
      for (const r of res.repairs) { if (!r.at || r.kind === 'opening') continue; const p = S(r.at); ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, 7); ctx.fill(); }
    }
    // flags: pins. Pins that would overlap at this zoom merge into one pin
    // with a count (the worst flag sets its colour); the focused flag always
    // gets its own pin with a ring.
    const pins = [];
    let focused = null;
    for (const f of [...res.flags, ...(s.trace.aiReview?.flags || [])]) {
      if (!f.at) continue;
      const on = focus?.type === 'flag' && focus.id === f.id;
      if (on) { focused = f; continue; }
      if (f.severity === 'info') continue;
      const p = S(f.at);
      pins.push({ x: p.x, y: p.y, severity: f.severity });
    }
    const pin = (x, y, col, txt, ring) => {
      if (ring) { ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.strokeStyle = hexA(col, 0.5); ctx.lineWidth = 4; ctx.stroke(); }
      const rad = txt.length > 1 ? 11 : 9;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fillStyle = col; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '700 11px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, x, y + 0.5);
    };
    // a leak's gaps: where to close the room
    ctx.setLineDash([6, 4]); ctx.strokeStyle = TR.error; ctx.lineWidth = 2;
    for (const f of res.flags) {
      for (const gp of f.gaps || []) { const a = S(gp.at), b = S(gp.to); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    ctx.setLineDash([]);
    for (const g of clusterPins(pins, 20)) {
      pin(g.x, g.y, TR[g.severity] || TR.review, g.items.length > 1 ? String(g.items.length) : '!', false);
    }
    if (focused) { const p = S(focused.at); pin(p.x, p.y, TR[focused.severity] || TR.review, focused.severity === 'info' ? 'i' : '!', true); }
  }

  // selected trace area (px rect in plan-image space)
  const reg = s.trace?.region;
  if (reg) {
    const a = toScreen(reg.x0, reg.y0), b = toScreen(reg.x1, reg.y1);
    ctx.setLineDash([8, 5]); ctx.strokeStyle = '#1d6fb0'; ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.setLineDash([]);
  }
  // tool drafts
  const d = rc.trDraft;
  if (d?.kind === 'wall' && d.a && d.hover) {
    const a = S(d.a), b = S(d.hover);
    ctx.strokeStyle = TR.manual; ctx.lineWidth = Math.max(3, ft2px(d.t || 0.375) * z);
    ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.font = '600 11px ' + MONO; ctx.fillStyle = '#1d7a4d'; ctx.textAlign = 'left';
    ctx.fillText(formatLength(Math.hypot(d.hover.x - d.a.x, d.hover.y - d.a.y), s.unitSystem), b.x + 10, b.y - 8);
  }
  if (d?.kind === 'region' && d.p0 && d.p1) {
    const a = toScreen(d.p0.x, d.p0.y), b = toScreen(d.p1.x, d.p1.y);
    ctx.setLineDash([8, 5]); ctx.strokeStyle = '#1d6fb0'; ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(29,111,176,.06)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.setLineDash([]);
  }
  if (d?.kind === 'erase' && d.hit) {
    const w = d.hit, a = S(w.a), b = S(w.b);
    ctx.strokeStyle = TR.error; ctx.lineWidth = Math.max(4, ft2px(w.t) * z + 2);
    ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}
