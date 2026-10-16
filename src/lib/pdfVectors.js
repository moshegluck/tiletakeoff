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
 * @param {object} page   pdf.js PDFPageProxy
 * @param {number} renderScale  the scale the page image was rendered at
 * @param {object} OPS    pdfjs OPS table
 * @returns {Promise<{lines, curves, texts, stats}>} px coordinates (image space)
 */
export async function extractPageVectors(page, renderScale, OPS, { maxOps = 2_000_000 } = {}) {
  const viewport = page.getViewport({ scale: renderScale });
  const vt = viewport.transform;
  const ops = await page.getOperatorList();
  const lines = [];
  const curves = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  const stack = [];
  let painted = 0, clipOnly = 0;

  const n = Math.min(ops.fnArray.length, maxOps);
  for (let i = 0; i < n; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push([ctm, lw]); break;
      case OPS.restore: if (stack.length) [ctm, lw] = stack.pop(); break;
      case OPS.transform: ctm = mult(ctm, args); break;
      case OPS.paintFormXObjectBegin: stack.push([ctm, lw]); if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mult(ctm, Array.from(args[0])); break;
      case OPS.paintFormXObjectEnd: if (stack.length) [ctm, lw] = stack.pop(); break;
      case OPS.setLineWidth: lw = args[0]; break;
      case OPS.constructPath: {
        const paintOp = args[0];
        if (paintOp === OPS.endPath) { clipOnly++; break; } // clipping path, not drawn
        const data = Array.isArray(args[1]) ? args[1][0] : args[1];
        if (!data) break;
        const m = mult(vt, ctm);
        const scaleK = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const wpx = Math.max(0, lw * scaleK);
        painted++;
        walkPath(data, m, wpx, lines, curves, paintOp !== OPS.stroke && paintOp !== OPS.closeStroke);
        break;
      }
      default: break;
    }
  }

  // text
  const texts = [];
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const tm = mult(vt, it.transform);
      const h = Math.hypot(tm[2], tm[3]);
      const wUser = it.width || 0;
      // centre of the text run: start + width/2 along the baseline, up half the height
      const dirx = it.transform[0], diry = it.transform[1];
      const dl = Math.hypot(dirx, diry) || 1;
      const cxUser = it.transform[4] + (dirx / dl) * wUser / 2;
      const cyUser = it.transform[5] + (diry / dl) * wUser / 2;
      const c = apply(vt, cxUser, cyUser);
      texts.push({ str, x: c.x, y: c.y - h * 0.35, h });
    }
  } catch (_) { /* text is optional */ }

  return {
    lines, curves, texts,
    width: Math.ceil(viewport.width), height: Math.ceil(viewport.height),
    stats: { ops: ops.fnArray.length, painted, clipOnly, lines: lines.length, curves: curves.length, texts: texts.length },
  };
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
