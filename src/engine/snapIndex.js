// ============================================================
// snapIndex.js — snap a point to the drawing: the plan's own lines (a
// vector PDF's wall faces, or strokes found on a scan), in underlay px.
//
// Query order: a point feature within reach (a line end, or a corner where
// two lines cross, even if their ends don't meet) wins; otherwise the
// nearest point on a line. A grid hash keeps queries fast on sheets with
// tens of thousands of lines. Pure; no DOM.
// ============================================================

/** @typedef {{ x: number, y: number, kind: 'end'|'corner'|'edge' }} SnapHit */

const key = (cx, cy) => cx * 73856093 ^ cy * 19349663;

/**
 * @param {{a:{x:number,y:number}, b:{x:number,y:number}}[]} lines  underlay px
 * @param {{ cell?: number, minLen?: number }} [opts]
 */
export function buildSnapIndex(lines, { cell = 32, minLen = 1.5 } = {}) {
  /** @type {Map<number, {ends:number[], segs:number[]}>} */
  const grid = new Map();
  const ex = [], ey = [];             // de-duplicated line ends
  const seen = new Map();
  const sx0 = [], sy0 = [], sx1 = [], sy1 = [];
  const bucket = (cx, cy) => {
    const k = key(cx, cy);
    let b = grid.get(k);
    if (!b) { b = { ends: [], segs: [] }; grid.set(k, b); }
    return b;
  };
  const addEnd = (x, y) => {
    const k = `${Math.round(x * 2)},${Math.round(y * 2)}`;   // within ½ px is the same end
    if (seen.has(k)) return;
    seen.set(k, ex.length);
    bucket(Math.floor(x / cell), Math.floor(y / cell)).ends.push(ex.length);
    ex.push(x); ey.push(y);
  };
  for (const l of lines || []) {
    const ax = l.a.x, ay = l.a.y, bx = l.b.x, by = l.b.y;
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by))) continue;
    if (Math.hypot(bx - ax, by - ay) < minLen) continue;
    const i = sx0.length;
    sx0.push(ax); sy0.push(ay); sx1.push(bx); sy1.push(by);
    addEnd(ax, ay); addEnd(bx, by);
    // walk the cells along the segment (a little padded)
    const c0 = Math.floor(Math.min(ax, bx) / cell), c1 = Math.floor(Math.max(ax, bx) / cell);
    const r0 = Math.floor(Math.min(ay, by) / cell), r1 = Math.floor(Math.max(ay, by) / cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) <= 64) {
      for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) bucket(cx, cy).segs.push(i);
    } else {
      // long diagonal: only the cells it passes through
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / (cell / 2));
      let last = '';
      for (let t = 0; t <= n; t++) {
        const cx = Math.floor((ax + ((bx - ax) * t) / n) / cell), cy = Math.floor((ay + ((by - ay) * t) / n) / cell);
        const k = cx + ',' + cy;
        if (k !== last) { bucket(cx, cy).segs.push(i); last = k; }
      }
    }
  }

  return {
    size: sx0.length,
    /**
     * @param {number} x @param {number} y  underlay px
     * @param {number} r  reach, underlay px
     * @returns {SnapHit | null}
     */
    query(x, y, r) {
      if (!(r > 0) || !sx0.length) return null;
      const c0 = Math.floor((x - r) / cell), c1 = Math.floor((x + r) / cell);
      const r0 = Math.floor((y - r) / cell), r1 = Math.floor((y + r) / cell);
      /** @type {SnapHit | null} */
      let best = null, bestD = r;
      const segs = new Set();
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const b = grid.get(key(cx, cy));
          if (!b) continue;
          for (const e of b.ends) {
            const d = Math.hypot(ex[e] - x, ey[e] - y);
            if (d <= bestD) { bestD = d; best = { x: ex[e], y: ey[e], kind: 'end' }; }
          }
          for (const s of b.segs) segs.add(s);
        }
      }
      // nearest points on lines within reach
      const near = [];
      for (const s of segs) {
        const ax = sx0[s], ay = sy0[s], dx = sx1[s] - ax, dy = sy1[s] - ay;
        const L2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px - x, py - y);
        if (d <= r) near.push({ s, px, py, d });
      }
      near.sort((a, b) => a.d - b.d);
      // corners: where two nearby lines cross (or would meet, within reach)
      const k = Math.min(near.length, 8);
      for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
          const p = cross(near[i].s, near[j].s);
          if (!p) continue;
          const d = Math.hypot(p.x - x, p.y - y);
          // a real line end at the same spot is the better answer
          if (d < bestD - 1e-6) { bestD = d; best = { x: p.x, y: p.y, kind: 'corner' }; }
        }
      }
      if (best) return best;
      return near.length ? { x: near[0].px, y: near[0].py, kind: /** @type {'edge'} */ ('edge') } : null;
    },
  };

  // intersection of two (infinite) lines, if they aren't near-parallel
  function cross(i, j) {
    const ax = sx0[i], ay = sy0[i], bx = sx1[i] - ax, by = sy1[i] - ay;
    const cx = sx0[j], cy = sy0[j], dx = sx1[j] - cx, dy = sy1[j] - cy;
    const den = bx * dy - by * dx;
    const la = Math.hypot(bx, by), lb = Math.hypot(dx, dy);
    if (Math.abs(den) < la * lb * 0.17) return null;          // < ~10°: no corner
    const t = ((cx - ax) * dy - (cy - ay) * dx) / den;
    return { x: ax + bx * t, y: ay + by * t };
  }
}
