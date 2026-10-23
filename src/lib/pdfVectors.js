// ============================================================
// pdfVectors.js — pull the drawing itself out of a PDF page.
//
// A CAD-exported plan already contains every wall face as an exact
// vector. We walk pdf.js's operator list, track the transform stack,
// and emit every straight segment, every curve run (door swings), and
// every text item — all in the SAME pixel space as the rendered page
// image, so the trace lines up with what the user sees.
// ============================================================

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

const mult = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/**
 * The CAD layers (PDF optional-content groups) a document carries, if any:
 * { names: { [id]: name }, hidden: Set<id> } — or null for a plain PDF.
 * AutoCAD and Revit exports keep their layers ("A-WALL", "A-DOOR",
 * "T - DIMS", …), which tell walls apart from everything else.
 * @param {object} doc  pdf.js PDFDocumentProxy
 */
export async function readLayers(doc) {
  try {
    const cfg = await doc.getOptionalContentConfig();
    if (!cfg) return null;
    const names = {}, hidden = new Set();
    let n = 0;
    for (const [id, g] of cfg) {
      names[id] = g?.name || String(id);
      if (cfg.isVisible && !cfg.isVisible(g)) hidden.add(id);
      n++;
    }
    return n ? { names, hidden } : null;
  } catch (_) { return null; }
}

/**
 * SHX text is plotted as strokes: the letters, and the underline a room name
 * often carries (%%u). A line lying inside an SHX text's box is one of them
 * (glyph: true) — never a wall face, a door leaf or a swing. A text written
 * on a slant (a door tag along its leaf) has for its box the square around
 * the slanted run, most of it no text: there only strokes as short as its
 * letters are glyphs (34 Ellish: a 45° "2/0X6/8" tag's box took in both faces
 * of the closet wall beside it).
 * @param {{a,b,glyph?:boolean}[]} lines
 * @param {{x,y,w?,h?,rot?,str?}[]} boxes  SHX texts (centre, w along, h across)
 */
export function markGlyphs(lines, boxes) {
  const C = 64, grid = new Map();
  const rects = boxes.map((t) => {
    const w = t.w || 0, h = t.h || 0, m = 0.15 * Math.min(w || h, h || w);
    const hx = (t.rot === 90 ? h : w) / 2 + m, hy = (t.rot === 90 ? w : h) / 2 + m;
    const r = [t.x - hx, t.y - hy, t.x + hx, t.y + hy];
    // far squarer than a run of its letters (~0.8 of the height wide each):
    // on a slant — or stacked on lines; its letters' strokes say which
    const n = String(t.str || '').replace(/\s+/g, '').length;
    const lo = Math.min(w, h), hi = Math.max(w, h);
    r.squat = n >= 3 && lo > 0 && hi / lo < 0.35 * n;
    // (a 45° run's box is (length + height) / √2 across)
    r.letter = r.squat ? 1.5 * (hi * Math.SQRT2) / (0.8 * n + 1) : Infinity;
    r.maxLen = Infinity;
    return r;
  });
  rects.forEach((r, i) => {
    for (let gx = Math.floor(r[0] / C); gx <= Math.floor(r[2] / C); gx++) {
      for (let gy = Math.floor(r[1] / C); gy <= Math.floor(r[3] / C); gy++) {
        const key = gx * 100003 + gy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
  });
  const inside = (r, p) => p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3];
  // a squat box's text runs the way its letters' strokes spread: on a slant
  // (15°–75° off the sheet) only strokes as short as its letters are glyphs
  const squat = rects.map((r, i) => (r.squat ? i : -1)).filter((i) => i >= 0);
  if (squat.length) {
    const acc = new Map(squat.map((i) => [i, { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }]));
    for (const l of lines) {
      const L = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
      const cell = grid.get(Math.floor(l.a.x / C) * 100003 + Math.floor(l.a.y / C));
      if (!cell) continue;
      for (const i of cell) {
        const r = rects[i];
        if (!r.squat || L > r.letter || !inside(r, l.a) || !inside(r, l.b)) continue;
        const x = (l.a.x + l.b.x) / 2, y = (l.a.y + l.b.y) / 2, s = acc.get(i);
        s.n += L; s.sx += x * L; s.sy += y * L; s.sxx += x * x * L; s.syy += y * y * L; s.sxy += x * y * L;
      }
    }
    for (const [i, s] of acc) {
      if (!s.n) continue;
      const mx = s.sx / s.n, my = s.sy / s.n;
      const cxx = s.sxx / s.n - mx * mx, cyy = s.syy / s.n - my * my, cxy = s.sxy / s.n - mx * my;
      const ang = Math.abs((0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI) % 90;
      if (ang > 15 && ang < 75) rects[i].maxLen = rects[i].letter;
    }
  }
  for (const l of lines) {
    const cell = grid.get(Math.floor(l.a.x / C) * 100003 + Math.floor(l.a.y / C));
    const L = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    if (cell && cell.some((i) => inside(rects[i], l.a) && inside(rects[i], l.b) && L <= rects[i].maxLen)) l.glyph = true;
  }
}

/**
 * AutoCAD's text control codes as the words read: %%u / %%o (underline,
 * overline on / off) drop out, %%d °, %%p ±, %%c Ø, %%% %, %%nnn a character.
 * "%%uGUEST %%uBATH #3" is GUEST BATH #3.
 */
export function cadText(str) {
  return String(str || '')
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n))
    .replace(/%%[uUoO]/g, '')
    .replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, 'Ø').replace(/%%%/g, '%')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} page   pdf.js PDFPageProxy
 * @param {number} renderScale  the scale the page image was rendered at
 * @param {object} OPS    pdfjs OPS table
 * @param {{ maxOps?: number, layers?: { names: object, hidden: Set<any> } | null }} [opts]
 * @returns {Promise<{lines, curves, texts, stats}>} px coordinates (image space);
 *   each line / curve / text carries its CAD `layer` name when the PDF has layers
 */
export async function extractPageVectors(page, renderScale, OPS, { maxOps = 2_000_000, layers = null } = {}) {
  const viewport = page.getViewport({ scale: renderScale });
  const vt = viewport.transform;
  // the drawing only: markups and comments (a reviewer's Bluebeam areas,
  // clouds, notes) are annotations — never walls
  const ops = await page.getOperatorList({ annotationMode: 0 /* AnnotationMode.DISABLE */ });
  const lines = [];
  const curves = [];
  const images = [];           // where each image is painted: its unit square's corner and axes, in px
  const opTexts = [];          // text read straight off the drawing operators (with its layer)
  let ctm = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  let sc = '#000000', fc = '#000000';   // stroke / fill colour (dimensions are often plotted in colour)
  const stack = [];
  // the clip in force: regions a mark must lie inside to be seen (null = the page)
  let clip = null, clipNext = false;
  // marked content: the layer each path / text belongs to (name null = not a layer)
  /** @type {{ name: string|null, hidden: boolean }[]} */
  const mc = [];
  const layerNow = () => { for (let k = mc.length - 1; k >= 0; k--) if (mc[k].name !== null) return mc[k].name; return null; };
  let hiddenDepth = 0;
  let painted = 0, clipOnly = 0;
  // text state
  let tm = [1, 0, 0, 1, 0, 0], lm = [1, 0, 0, 1, 0, 0];
  let fs = 0, cs = 0, ws = 0, hs = 1, leading = 0;

  const n = Math.min(ops.fnArray.length, maxOps);
  for (let i = 0; i < n; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push([ctm, lw, sc, fc, clip]); break;
      case OPS.restore: if (stack.length) [ctm, lw, sc, fc, clip] = stack.pop(); break;
      case OPS.clip: case OPS.eoClip: clipNext = true; break;
      case OPS.setStrokeRGBColor: sc = hexColor(args) ?? sc; break;
      case OPS.setFillRGBColor: fc = hexColor(args) ?? fc; break;
      case OPS.transform: ctm = mult(ctm, args); break;
      case OPS.paintFormXObjectBegin: {
        stack.push([ctm, lw, sc, fc, clip]);
        if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mult(ctm, Array.from(args[0]));
        // a form draws only inside its box
        const bb = args?.[1];
        if (bb && bb.length >= 4 && [...bb].every(Number.isFinite)) {
          const m = mult(vt, ctm);
          clip = addClip(clip, [[apply(m, bb[0], bb[1]), apply(m, bb[2], bb[1]), apply(m, bb[2], bb[3]), apply(m, bb[0], bb[3])]]);
        }
        break;
      }
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, lw, sc, fc, clip] = stack.pop(); break;
      case OPS.setLineWidth: lw = args[0]; break;
      case OPS.beginMarkedContentProps: {
        const id = args?.[0] === 'OC' ? args?.[1]?.id : null;
        const hidden = id != null && !!layers?.hidden.has(id);
        mc.push({ name: id != null && layers ? (layers.names[id] ?? String(id)) : null, hidden });
        if (hidden) hiddenDepth++;
        break;
      }
      case OPS.beginMarkedContent: mc.push({ name: null, hidden: false }); break;
      case OPS.endMarkedContent: {
        const top = mc.pop();
        if (top?.hidden) hiddenDepth = Math.max(0, hiddenDepth - 1);
        break;
      }
      case OPS.constructPath: {
        const paintOp = args[0];
        const data = Array.isArray(args[1]) ? args[1][0] : args[1];
        const m = mult(vt, ctm);
        // a clipping path (W n): nothing drawn, but from here on only what lies inside it shows
        if (clipNext && data) clip = addClip(clip, pathPolys(data, m));
        clipNext = false;
        if (paintOp === OPS.endPath) { clipOnly++; break; }
        if (hiddenDepth) break;                               // a layer that's switched off
        if (!data) break;
        const scaleK = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const wpx = Math.max(0, lw * scaleK);
        painted++;
        const l0 = lines.length, c0 = curves.length;
        const fillOnly = paintOp === OPS.fill || paintOp === OPS.eoFill;
        const filled = paintOp !== OPS.stroke && paintOp !== OPS.closeStroke;
        walkPath(data, m, wpx, lines, curves, filled);
        // what a clip hides isn't drawing: a fill clipped to a wall's outline (Revit
        // fills a rectangle through a 45° wall's clip) shows that outline, not the rectangle
        if (clip) clipPainted(lines, curves, l0, c0, clip, filled ? pathPolys(data, m) : null, wpx);
        const col = fillOnly ? fc : sc;
        for (let k = l0; k < lines.length; k++) { lines[k].col = col; lines[k].pid = painted; }
        for (let k = c0; k < curves.length; k++) curves[k].col = col;
        const layer = layerNow();
        if (layer !== null) {
          for (let k = l0; k < lines.length; k++) lines[k].layer = layer;
          for (let k = c0; k < curves.length; k++) curves[k].layer = layer;
        }
        break;
      }
      // a wall's cut can be painted as an image (Revit / Vectorworks export the
      // poché as raster strips): keep where each image lies
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject: {
        if (hiddenDepth) break;
        const m = mult(vt, ctm);
        images.push({ o: { x: m[4], y: m[5] }, u: { x: m[0], y: m[1] }, v: { x: m[2], y: m[3] }, layer: layerNow() });
        break;
      }
      // ---- text, read off the operators (position + layer) ----
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; lm = [1, 0, 0, 1, 0, 0]; break;
      case OPS.setFont: fs = Number(args?.[1]) || 0; break;
      case OPS.setCharSpacing: cs = Number(args?.[0]) || 0; break;
      case OPS.setWordSpacing: ws = Number(args?.[0]) || 0; break;
      case OPS.setHScale: hs = (Number(args?.[0]) || 100) / 100; break;
      case OPS.setLeading: leading = Number(args?.[0]) || 0; break;
      case OPS.setTextMatrix: {
        const t = args?.length >= 6 ? args : Array.from(args?.[0] || []);
        if (t.length >= 6) { tm = t.slice(0, 6).map(Number); lm = tm.slice(); }
        break;
      }
      case OPS.moveText: case OPS.setLeadingMoveText: {
        const tx = Number(args?.[0]) || 0, ty = Number(args?.[1]) || 0;
        if (fn === OPS.setLeadingMoveText) leading = -ty;
        lm = [lm[0], lm[1], lm[2], lm[3], lm[0] * tx + lm[2] * ty + lm[4], lm[1] * tx + lm[3] * ty + lm[5]];
        tm = lm.slice();
        break;
      }
      case OPS.nextLine: {
        lm = [lm[0], lm[1], lm[2], lm[3], -lm[2] * leading + lm[4], -lm[3] * leading + lm[5]];
        tm = lm.slice();
        break;
      }
      case OPS.showText: {
        const glyphs = args?.[0];
        if (!Array.isArray(glyphs) || hiddenDepth) break;
        let str = '', adv = 0;
        for (const g of glyphs) {
          if (typeof g === 'number') {
            adv -= (g * fs) / 1000;
            if (g < -250) str += ' ';              // a word gap set by kerning
            continue;
          }
          if (!g) continue;
          str += g.unicode ?? '';
          adv += ((g.width || 0) * fs) / 1000 + cs + (g.isSpace ? ws : 0);
        }
        const M = mult(vt, mult(ctm, tm));
        const h = Math.hypot(M[2], M[3]) * Math.abs(fs);
        const c = apply(M, (adv * hs) / 2, fs * 0.35);
        if (str.trim()) opTexts.push({ str: str.trim(), x: c.x, y: c.y, h, layer: layerNow() });
        // advance the text matrix past this run
        tm = [tm[0], tm[1], tm[2], tm[3], tm[0] * adv * hs + tm[4], tm[1] * adv * hs + tm[5]];
        break;
      }
      default: break;
    }
  }

  // text: pdf.js's own text reader first (best spacing / ordering); each item
  // takes the layer of the operator-read text it matches. If that reader
  // fails or finds nothing, the operator-read text stands in.
  let texts = [];
  let textError = null;
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const tmx = mult(vt, it.transform);
      const h = Math.hypot(tmx[2], tmx[3]);
      const wUser = it.width || 0;
      // centre of the text run: start + width/2 along the baseline, up a
      // third of the height (whichever way the text runs)
      const dirx = it.transform[0], diry = it.transform[1];
      const dl = Math.hypot(dirx, diry) || 1;
      const hUser = Math.hypot(it.transform[2], it.transform[3]);
      const cxUser = it.transform[4] + (dirx / dl) * wUser / 2 - (diry / dl) * hUser * 0.35;
      const cyUser = it.transform[5] + (diry / dl) * wUser / 2 + (dirx / dl) * hUser * 0.35;
      const c = apply(vt, cxUser, cyUser);
      // the way it reads on the page, as an axis (0 = across, 90 = up the sheet)
      const rot = ((Math.round((Math.atan2(vt[1] * dirx + vt[3] * diry, vt[0] * dirx + vt[2] * diry) * 180) / Math.PI) % 180) + 180) % 180;
      texts.push({ str, x: c.x, y: c.y, h, w: wUser * Math.hypot(vt[0], vt[1]), rot });
    }
  } catch (e) { textError = e?.message || String(e); }
  // AutoCAD plots its SHX-font text as strokes and lays the words over them as
  // invisible "AutoCAD SHX Text" annotations: that's where the room names are
  let shx = 0;
  try {
    for (const a of await page.getAnnotations()) {
      if (a.titleObj?.str !== 'AutoCAD SHX Text' || !a.rect) continue;
      const str = cadText(a.contentsObj?.str);
      if (!str) continue;
      const p0 = apply(vt, a.rect[0], a.rect[1]), p1 = apply(vt, a.rect[2], a.rect[3]);
      const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
      texts.push({ str, x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, h: Math.min(w, h) || h, w: Math.max(w, h), rot: w >= h ? 0 : 90, shx: true });
      shx++;
    }
  } catch { /* no annotations */ }
  if (shx) markGlyphs(lines, texts.filter((t) => t.shx));
  let textSource = 'content';
  if (!texts.length && opTexts.length) { texts = opTexts; textSource = 'operators'; }
  else if (layers && opTexts.length) {
    for (const t of texts) {
      let best = null, bd = Infinity;
      for (const o of opTexts) {
        if (o.str !== t.str && !o.str.startsWith(t.str) && !t.str.startsWith(o.str)) continue;
        const d = Math.hypot(o.x - t.x, o.y - t.y);
        if (d < bd) { bd = d; best = o; }
      }
      if (best && bd <= Math.max(4, t.h * 1.5) && best.layer != null) t.layer = best.layer;
    }
  }

  return {
    lines, curves, texts, images,
    width: Math.ceil(viewport.width), height: Math.ceil(viewport.height),
    stats: {
      ops: ops.fnArray.length, painted, clipOnly, lines: lines.length, curves: curves.length, texts: texts.length,
      textSource, ...(textError ? { textError } : {}), layered: !!layers, ...(shx ? { shxTexts: shx } : {}),
    },
  };
}

/** A colour op's argument as "#rrggbb" (pdf.js hands RGB ops a hex string). */
function hexColor(args) {
  const a = args?.[0];
  if (typeof a === 'string') return a.toLowerCase();
  if (args?.length >= 3 && args.slice(0, 3).every((v) => Number.isFinite(+v))) {
    const k = Math.max(...args.slice(0, 3)) > 1 ? 1 : 255;
    return '#' + args.slice(0, 3).map((v) => Math.round(+v * k).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

/** A colour that isn't a gray: dimension strings, grid bubbles, tags — annotation, not construction. */
export function chromatic(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const v = m.slice(1).map((x) => parseInt(x, 16));
  return Math.max(...v) - Math.min(...v) >= 48;
}

/** A path's outline in px: one polygon per subpath (a curve by points along it). */
function pathPolys(d, m) {
  const polys = [];
  let cur = null;
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
  };
  for (let i = 0; i < d.length;) {
    const op = d[i++];
    if (op === DRAW.moveTo) { cur = [apply(m, d[i++], d[i++])]; polys.push(cur); }
    else if (op === DRAW.lineTo) { const p = apply(m, d[i++], d[i++]); if (cur) cur.push(p); else polys.push(cur = [p]); }
    else if (op === DRAW.curveTo || op === DRAW.quadraticCurveTo) {
      let p1, p2;
      const q = apply(m, d[i++], d[i++]);
      const p0 = cur ? cur[cur.length - 1] : q;
      if (op === DRAW.curveTo) { p1 = q; p2 = apply(m, d[i++], d[i++]); }
      const p3 = apply(m, d[i++], d[i++]);
      if (op === DRAW.quadraticCurveTo) { p1 = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) }; p2 = { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) }; }
      if (!cur) polys.push(cur = [p0]);
      for (const t of [0.25, 0.5, 0.75]) cur.push(bez(p0, p1, p2, p3, t));
      cur.push(p3);
    } else if (op === DRAW.closePath) { cur = null; }
    else break;
  }
  return polys.filter((p) => p.length >= 3);
}

const CLIP_EPS = 0.5;   // px: a mark on the clip's edge (the fill and its clip drawn alike) shows
const boxOfPolys = (polys) => {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const P of polys) for (const p of P) { b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y); }
  return b;
};
/** The clip after a new clipping path: both must hold (an empty path leaves it as it was). */
function addClip(clip, polys) {
  if (!polys.length) return clip;
  return [...(clip || []), { polys, box: boxOfPolys(polys) }];
}
/** Inside a region (even-odd), or within `eps` of its outline. */
function inRegion(p, r, eps) {
  if (p.x < r.box.x0 - eps || p.x > r.box.x1 + eps || p.y < r.box.y0 - eps || p.y > r.box.y1 + eps) return false;
  let c = false;
  for (const P of r.polys) {
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
  }
  return c || (eps > 0 && nearEdge(p, r, eps));
}
/** The stretches [t0, t1] of a → b inside every region (`eps` grows each; negative: strictly inside). */
function segInside(a, b, regions, eps) {
  const ts = [0, 1];
  const ex = Math.max(eps, 0);
  for (const r of regions) {
    if (Math.max(a.x, b.x) < r.box.x0 - ex || Math.min(a.x, b.x) > r.box.x1 + ex || Math.max(a.y, b.y) < r.box.y0 - ex || Math.min(a.y, b.y) > r.box.y1 + ex) return [];
    for (const P of r.polys) {
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const p = P[j], q = P[i];
        const rx = b.x - a.x, ry = b.y - a.y, sx = q.x - p.x, sy = q.y - p.y;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((p.x - a.x) * sy - (p.y - a.y) * sx) / den, u = ((p.x - a.x) * ry - (p.y - a.y) * rx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }
  }
  ts.sort((x, y) => x - y);
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if ((t1 - t0) * L < 1e-6) continue;
    const tm = (t0 + t1) / 2, m = { x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm };
    const ok = regions.every((r) => (eps >= 0 ? inRegion(m, r, eps) : inRegion(m, r, 0) && !nearEdge(m, r, -eps)));
    if (!ok) continue;
    if (out.length && Math.abs(out[out.length - 1][1] - t0) < 1e-9) out[out.length - 1][1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}
function nearEdge(p, r, eps) {
  for (const P of r.polys) {
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j], b = P[i], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= eps) return true;
    }
  }
  return false;
}
/**
 * Keep only what shows of the marks a path just added (lines[l0..], curves[c0..]):
 * each line cut to its stretches inside the clip, a curve run dropped when it
 * lies wholly outside. A fill (`fill` = its outline) also shows the clip's own
 * edges where they cross its inside — the visible outline is fill ∩ clip.
 */
function clipPainted(lines, curves, l0, c0, clip, fill, w) {
  const added = lines.splice(l0);
  for (const l of added) {
    const keep = segInside(l.a, l.b, clip, CLIP_EPS);
    if (keep.length === 1 && keep[0][0] === 0 && keep[0][1] === 1) { lines.push(l); continue; }
    for (const [t0, t1] of keep) {
      const at = (t) => ({ x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t });
      lines.push({ ...l, a: at(t0), b: at(t1) });
    }
  }
  if (fill && added.length) {
    const proto = added[0];
    const fr = [{ polys: fill, box: boxOfPolys(fill) }];
    clip.forEach((r, ri) => {
      const others = clip.filter((_, k) => k !== ri);
      for (const P of r.polys) {
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const a = P[j], b = P[i];
          // strictly inside the fill (an edge the fill draws itself is there already), inside the other clips
          for (const [t0, t1] of segInside(a, b, fr, -CLIP_EPS)) {
            const at = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            const p = at(t0), q = at(t1);
            if (others.length && !segInside(p, q, others, CLIP_EPS).length) continue;
            lines.push({ ...proto, a: p, b: q, w });
          }
        }
      }
    });
  }
  for (let k = curves.length - 1; k >= c0; k--) {
    const ps = curves[k].pieces;
    if (!ps.some((pc) => clip.every((r) => inRegion(pc.p0, r, CLIP_EPS)) || clip.every((r) => inRegion(pc.p3, r, CLIP_EPS)))) curves.splice(k, 1);
  }
}

function walkPath(d, m, w, lines, curves, filled) {
  let start = null, cur = null;
  let run = [];
  const flushRun = () => { if (run.length) { curves.push({ pieces: run, w }); run = []; } };
  for (let i = 0; i < d.length;) {
    const op = d[i++];
    if (op === DRAW.moveTo) {
      flushRun();
      cur = apply(m, d[i++], d[i++]); start = cur;
    } else if (op === DRAW.lineTo) {
      flushRun();
      const p = apply(m, d[i++], d[i++]);
      if (cur) lines.push({ a: cur, b: p, w, filled });
      cur = p;
    } else if (op === DRAW.curveTo) {
      const p1 = apply(m, d[i++], d[i++]), p2 = apply(m, d[i++], d[i++]), p3 = apply(m, d[i++], d[i++]);
      if (cur) run.push({ p0: cur, p1, p2, p3 });
      cur = p3;
    } else if (op === DRAW.quadraticCurveTo) {
      const q1 = apply(m, d[i++], d[i++]), p3 = apply(m, d[i++], d[i++]);
      if (cur) {
        // elevate to cubic
        const p1 = { x: cur.x + (2 / 3) * (q1.x - cur.x), y: cur.y + (2 / 3) * (q1.y - cur.y) };
        const p2 = { x: p3.x + (2 / 3) * (q1.x - p3.x), y: p3.y + (2 / 3) * (q1.y - p3.y) };
        run.push({ p0: cur, p1, p2, p3 });
      }
      cur = p3;
    } else if (op === DRAW.closePath) {
      flushRun();
      if (cur && start && (cur.x !== start.x || cur.y !== start.y)) lines.push({ a: cur, b: start, w, filled });
      cur = start;
    } else {
      break; // unknown op — stop parsing this path
    }
  }
  flushRun();
}
