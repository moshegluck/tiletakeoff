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
  const opTexts = [];          // text read straight off the drawing operators (with its layer)
  let ctm = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  let sc = '#000000', fc = '#000000';   // stroke / fill colour (dimensions are often plotted in colour)
  const stack = [];
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
      case OPS.save: stack.push([ctm, lw, sc, fc]); break;
      case OPS.restore: if (stack.length) [ctm, lw, sc, fc] = stack.pop(); break;
      case OPS.setStrokeRGBColor: sc = hexColor(args) ?? sc; break;
      case OPS.setFillRGBColor: fc = hexColor(args) ?? fc; break;
      case OPS.transform: ctm = mult(ctm, args); break;
      case OPS.paintFormXObjectBegin: stack.push([ctm, lw, sc, fc]); if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mult(ctm, Array.from(args[0])); break;
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, lw, sc, fc] = stack.pop(); break;
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
        if (paintOp === OPS.endPath) { clipOnly++; break; } // clipping path, not drawn
        if (hiddenDepth) break;                               // a layer that's switched off
        const data = Array.isArray(args[1]) ? args[1][0] : args[1];
        if (!data) break;
        const m = mult(vt, ctm);
        const scaleK = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const wpx = Math.max(0, lw * scaleK);
        painted++;
        const l0 = lines.length, c0 = curves.length;
        const fillOnly = paintOp === OPS.fill || paintOp === OPS.eoFill;
        walkPath(data, m, wpx, lines, curves, paintOp !== OPS.stroke && paintOp !== OPS.closeStroke);
        const col = fillOnly ? fc : sc;
        for (let k = l0; k < lines.length; k++) lines[k].col = col;
        for (let k = c0; k < curves.length; k++) curves[k].col = col;
        const layer = layerNow();
        if (layer !== null) {
          for (let k = l0; k < lines.length; k++) lines[k].layer = layer;
          for (let k = c0; k < curves.length; k++) curves[k].layer = layer;
        }
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
      // centre of the text run: start + width/2 along the baseline, up half the height
      const dirx = it.transform[0], diry = it.transform[1];
      const dl = Math.hypot(dirx, diry) || 1;
      const cxUser = it.transform[4] + (dirx / dl) * wUser / 2;
      const cyUser = it.transform[5] + (diry / dl) * wUser / 2;
      const c = apply(vt, cxUser, cyUser);
      texts.push({ str, x: c.x, y: c.y - h * 0.35, h });
    }
  } catch (e) { textError = e?.message || String(e); }
  // AutoCAD plots its SHX-font text as strokes and lays the words over them as
  // invisible "AutoCAD SHX Text" annotations: that's where the room names are
  let shx = 0;
  try {
    for (const a of await page.getAnnotations()) {
      if (a.titleObj?.str !== 'AutoCAD SHX Text' || !a.rect) continue;
      const str = (a.contentsObj?.str || '').trim();
      if (!str) continue;
      const p0 = apply(vt, a.rect[0], a.rect[1]), p1 = apply(vt, a.rect[2], a.rect[3]);
      const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
      texts.push({ str, x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, h: Math.min(w, h) || h, shx: true });
      shx++;
    }
  } catch { /* no annotations */ }
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
    lines, curves, texts,
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
