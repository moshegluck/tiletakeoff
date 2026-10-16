// ============================================================
// canvasUtils.js — pure helpers for the 2D canvas. No React, no
// store, no DOM state: just math and small drawing primitives that
// take everything they need as arguments. Extracted from Canvas2D so
// the component shrinks to refs + handlers + effects, and so these are
// independently testable.
// ============================================================

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** rgba() string from a #rrggbb hex + alpha. */
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Lock a segment to the dominant axis (for shift-constrained ruler). */
export function axisLock(a, b) {
  return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/** Even-odd point-in-polygon on an array of screen points. */
export function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const hit = (pts[i].y > y) !== (pts[j].y > y) &&
      x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Trace a rounded rectangle path (caller fills/strokes). */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Build the view transform helpers for a given view {x,y,zoom} and
 * scale (feet per model-px). Returns the four conversions the canvas
 * uses everywhere. Pure: same inputs → same functions.
 */
export function makeTransforms(view, scale) {
  const ft2px = (ft) => (scale ? ft / scale : ft);
  const px2ft = (px) => (scale ? px * scale : px);
  const toScreen = (mx, my) => ({ x: mx * view.zoom + view.x, y: my * view.zoom + view.y });
  const toModel = (sx, sy) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom });
  return { ft2px, px2ft, toScreen, toModel };
}

/**
 * Which label lines fit inside a room on screen, and at what size. Each line
 * is tried at its own size, then smaller down to `min`; a `wrap` line that is
 * still too wide splits onto two lines at a space. A line that still doesn't
 * fit is left out (the room's card and the selection show it), so a closet's
 * label never spills over its neighbours.
 * @param {{ text: string, size: number, min: number, wrap?: boolean }[]} lines  top to bottom
 * @param {number} boxW @param {number} boxH  the room's on-screen size, px
 * @param {(text: string, size: number, i: number) => number} measure  width of line i's text at a size
 * @returns {{ text: string, size: number, i: number }[]}  i = which input line it came from
 */
export function fitLabelLines(lines, boxW, boxH, measure) {
  const out = [];
  let used = 0;
  const avail = boxW - 8;
  lines.forEach((l, i) => {
    if (!l.text || used < 0) return;
    const sizeFor = (t) => { const w = measure(t, l.size, i); return w <= avail ? l.size : Math.floor(l.size * (avail / w) * 10) / 10; };
    let parts = [l.text];
    let size = sizeFor(l.text);
    if (size < l.min && l.wrap && l.text.includes(' ')) {
      const two = splitInTwo(l.text);
      const s2 = Math.min(...two.map(sizeFor));
      if (s2 >= l.min) { parts = two; size = s2; }
    }
    if (size < l.min) return;
    const need = parts.length * size * 1.25;
    if (used + need > boxH - 4) { used = -1; return; }   // no room below this line either
    for (const t of parts) out.push({ text: t, size, i });
    used += need;
  });
  return out;
}

// "NEW OFFICE/ STUDY" → ["NEW OFFICE/", "STUDY"]: the split that makes the longer half shortest
function splitInTwo(text) {
  const words = text.split(/\s+/);
  let best = [text], worst = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    const m = Math.max(a.length, b.length);
    if (m < worst) { worst = m; best = [a, b]; }
  }
  return best;
}

const SEVERITY = { error: 3, warn: 2, review: 1, info: 0 };

/**
 * Pins that would sit on top of each other at this zoom become one pin with
 * a count — every flag stays visible, the worst one sets the colour.
 * @template {{ x: number, y: number, severity: string }} P
 * @param {P[]} pins  screen px
 * @param {number} r  pins closer than this merge
 * @returns {{ x: number, y: number, severity: string, items: P[] }[]}
 */
export function clusterPins(pins, r) {
  const order = [...pins].sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0));
  /** @type {{ x: number, y: number, severity: string, items: P[] }[]} */
  const groups = [];
  for (const p of order) {
    const g = groups.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < r);
    if (g) {
      g.items.push(p);
      // the pin sits at the group's centre
      g.x += (p.x - g.x) / g.items.length; g.y += (p.y - g.y) / g.items.length;
    } else groups.push({ x: p.x, y: p.y, severity: p.severity, items: [p] });
  }
  return groups;
}
