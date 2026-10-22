// ============================================================
// leaks.js — where a room that doesn't close opens to the outside.
//
// A room name that lands in no closed room means its walls leak somewhere:
// a door the trace couldn't bridge, a window it didn't read, a wall piece
// missing. Saying so at the name sends the estimator hunting. Find the gap:
// every gap the walls leave (from a wall node — an open end, a corner — going
// on from its wall to the nearest wall that way, nothing in it, the space
// opening out past it) is a candidate; walk out of the room to the open sheet
// on a raster of the traced walls and openings, close the last gap the walk
// leaves by, and walk again until the room is shut in. Then keep only the
// gaps it takes.
// Pure; no DOM. Units: feet.
// ============================================================

/**
 * @param {{a:{x,y}, b:{x,y}}[]} edges  the traced walls and openings (centrelines)
 * @param {{x,y}[]} nodes  the wall graph's nodes: a gap opens at one (an open end, a corner)
 * @param {{x,y}[]} from   points in rooms that don't close (their names)
 * @param {{ maxCells?: number, maxGap?: number, maxGaps?: number }} [opt]
 * @returns {({ at: {x,y}, to: {x,y}, gap: number, gaps: {at,to,gap}[] } | null)[]}
 *   per point: the gaps that, closed, shut the room in — each from the wall
 *   node `at` to the wall across at `to`, `gap` ft wide; the first is where
 *   the way out leaves (null: no such gaps — the name stands outside the
 *   walls, or the walls are too open to say)
 */
export function leakPoints(edges, nodes, from, opt = {}) {
  if (!edges.length || !from.length || !nodes.length) return from.map(() => null);
  const m = gapMap(edges, nodes, opt);
  return from.map((p) => m.leak(p));
}

/**
 * The gaps the walls leave, on a raster of the traced walls — to ask where a
 * room opens to the outside (`leak`) or which gaps stand between two rooms
 * that share one closed space (`split`). Gaps closed with `hold` stay closed
 * for later questions.
 * @param {{a:{x,y}, b:{x,y}}[]} edges
 * @param {{x,y}[]} nodes
 * @param {{ maxCells?: number, maxGap?: number, maxGaps?: number }} [opt]
 */
export function gapMap(edges, nodes, { maxCells = 1_000_000, maxGap = 20, maxGaps = 3 } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of edges) for (const p of [e.a, e.b]) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  x0 -= 3; y0 -= 3; x1 += 3; y1 += 3;
  const cell = Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / maxCells));
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((y1 - y0) / cell) + 1, N = W * H;
  const wall = new Uint8Array(N);
  const gx = (x) => Math.min(W - 1, Math.max(0, Math.round((x - x0) / cell)));
  const gy = (y) => Math.min(H - 1, Math.max(0, Math.round((y - y0) / cell)));
  const at = (c) => ({ x: x0 + (c % W) * cell, y: y0 + Math.floor(c / W) * cell });
  // a segment as an 8-connected run of cells: a 4-connected walk can't slip through it
  const line = (a, b, visit) => {
    let cx = gx(a.x), cy = gy(a.y);
    const tx = gx(b.x), ty = gy(b.y);
    const dx = Math.abs(tx - cx), dy = -Math.abs(ty - cy), sx = cx < tx ? 1 : -1, sy = cy < ty ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      visit(cy * W + cx);
      if (cx === tx && cy === ty) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; cx += sx; }
      if (e2 <= dx) { err += dx; cy += sy; }
    }
  };
  for (const e of edges) line(e.a, e.b, (c) => { wall[c] = 1; });
  // gaps closed while looking (a count per cell: two closing lines may share one)
  const shut = new Uint8Array(N);
  // clearance: how far each cell is from the nearest wall (two-pass chamfer, in cells)
  const dt = new Float32Array(N);
  for (let i = 0; i < N; i++) dt[i] = wall[i] ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!dt[i]) continue;
    let v = dt[i];
    if (x > 0) v = Math.min(v, dt[i - 1] + 1);
    if (y > 0) { v = Math.min(v, dt[i - W] + 1); if (x > 0) v = Math.min(v, dt[i - W - 1] + D); if (x < W - 1) v = Math.min(v, dt[i - W + 1] + D); }
    dt[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!dt[i]) continue;
    let v = dt[i];
    if (x < W - 1) v = Math.min(v, dt[i + 1] + 1);
    if (y < H - 1) { v = Math.min(v, dt[i + W] + 1); if (x < W - 1) v = Math.min(v, dt[i + W + 1] + D); if (x > 0) v = Math.min(v, dt[i + W - 1] + D); }
    dt[i] = v;
  }
  const segNear = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    return { x: a.x + t * dx, y: a.y + t * dy };
  };
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  const clearAt = (p) => dt[gy(p.y) * W + gx(p.x)] * cell;
  // the walls by place, and at each node the directions its walls go on in
  const GC = 4;
  const grid = new Map();
  const put = (k, v) => { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); };
  edges.forEach((e, i) => {
    for (let x = Math.floor(Math.min(e.a.x, e.b.x) / GC); x <= Math.floor(Math.max(e.a.x, e.b.x) / GC); x++) {
      for (let y = Math.floor(Math.min(e.a.y, e.b.y) / GC); y <= Math.floor(Math.max(e.a.y, e.b.y) / GC); y++) put(`${x},${y}`, i);
    }
  });
  const near = (p, r) => {
    const out = new Set();
    for (let x = Math.floor((p.x - r) / GC); x <= Math.floor((p.x + r) / GC); x++) {
      for (let y = Math.floor((p.y - r) / GC); y <= Math.floor((p.y + r) / GC); y++) for (const i of grid.get(`${x},${y}`) || []) out.add(i);
    }
    return out;
  };
  const COS = Math.cos(20 * Math.PI / 180);
  // the gaps the walls leave: from a node, going on from one of its walls, to
  // the nearest wall that way — with nothing in the gap (its middle as clear
  // as its half-width) and the space opening out past it on one side at least
  // (a doorway, a window, a missing piece; not a room's own width)
  const gaps = [];
  for (const n of nodes) {
    const ids = near(n, maxGap);
    const out = [];
    for (const i of ids) {
      const e = edges[i];
      const o = same(e.a, n) ? e.b : same(e.b, n) ? e.a : null;
      if (!o) continue;
      const L = Math.hypot(n.x - o.x, n.y - o.y);
      if (L > 1e-9) out.push({ x: (n.x - o.x) / L, y: (n.y - o.y) / L });
    }
    if (!out.length) continue;
    let to = null, td = maxGap;
    for (const i of ids) {
      const e = edges[i];
      if (same(e.a, n) || same(e.b, n)) continue;
      const p = segNear(n, e.a, e.b), d = Math.hypot(p.x - n.x, p.y - n.y);
      if (d >= td || d < 2 * cell) continue;
      if (!out.some((o) => (o.x * (p.x - n.x) + o.y * (p.y - n.y)) / d >= COS)) continue;
      to = p; td = d;
    }
    if (!to) continue;
    const m = { x: (n.x + to.x) / 2, y: (n.y + to.y) / 2 }, half = td / 2;
    if (clearAt(m) < 0.8 * half - cell) continue;
    const nx = -(to.y - n.y) / td, ny = (to.x - n.x) / td, r = half + 1;
    if (!(clearAt({ x: m.x + nx * r, y: m.y + ny * r }) > half + cell || clearAt({ x: m.x - nx * r, y: m.y - ny * r }) > half + cell)) continue;
    gaps.push({ at: { x: n.x, y: n.y }, to, gap: td });
  }
  // where each gap lies on the raster
  const gapsAt = new Map();
  gaps.forEach((g, i) => line(g.at, g.to, (c) => { if (!wall[c]) { if (!gapsAt.has(c)) gapsAt.set(c, []); gapsAt.get(c).push(i); } }));
  const side = (g, c) => {
    const p = at(c);
    return Math.sign((g.to.x - g.at.x) * (p.y - g.at.y) - (g.to.y - g.at.y) * (p.x - g.at.x));
  };
  // the way out: the shortest walk from the name to the open sheet past the
  // walls and the gaps closed so far (none: the room is shut in)
  const seen = new Int32Array(N);
  const prev = new Int32Array(N);
  const queue = new Int32Array(N);
  let gen = 0;
  const wayOut = (s, to = -1) => {
    gen++;
    let head = 0, tail = 0;
    queue[tail++] = s; seen[s] = gen; prev[s] = s;
    while (head < tail) {
      const c = queue[head++];
      const cx = c % W, cy = (c - cx) / W;
      if (to >= 0 ? c === to : cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) {
        const path = [];
        for (let p = c; ; p = prev[p]) { path.push(p); if (p === s) break; }
        return path.reverse();
      }
      for (const n of [c - 1, c + 1, c - W, c + W]) {
        if (wall[n] || shut[n] || seen[n] === gen) continue;
        seen[n] = gen; prev[n] = c; queue[tail++] = n;
      }
    }
    return null;
  };
  // the gaps the walk goes through (from one side to the other), in order
  const crossed = (path) => {
    const out = [];
    for (let i = 1; i < path.length - 1; i++) {
      for (const k of gapsAt.get(path[i]) || []) {
        if ((gapsAt.get(path[i - 1]) || []).includes(k)) continue;
        let j = i + 1;
        while (j < path.length - 1 && (gapsAt.get(path[j]) || []).includes(k)) j++;
        const a = side(gaps[k], path[i - 1]), b = side(gaps[k], path[j]);
        if (a && b && a !== b && !out.includes(gaps[k])) out.push(gaps[k]);
      }
    }
    return out;
  };
  // the last gap the walk goes through on its way out: where the space opens
  // to the outside. (Closing the first — the mouth of a vestibule whose own
  // door is open — would cut the room in two where nothing is drawn across.)
  const through = (path) => crossed(path).pop() || null;
  const close = (g, d) => line(g.at, g.to, (c) => { shut[c] += d; });
  const cellOf = (p) => {
    const s = gy(p.y) * W + gx(p.x);
    if (!wall[s]) return s;
    const k = [s - 1, s + 1, s - W, s + W].find((c) => c >= 0 && c < N && !wall[c]);
    return k === undefined ? -1 : k;
  };
  // only the gaps it takes: one the room stays shut without is no gap of its
  let found = [];
  const prune = (s, to) => {
    for (const g of found.slice()) {
      if (found.length < 2) break;
      close(g, -1);
      if (wayOut(s, to)) close(g, 1);
      else found = found.filter((x) => x !== g);
    }
  };
  return {
    gaps,
    /** the gaps that shut the room around p in (null: none can) */
    leak(p) {
      const s = cellOf(p);
      if (s < 0) return null;
      // close the gap the way out leaves by, in turn, until the room is shut in
      found = [];
      let sealed = false;
      for (let n = 0; n <= 2 * maxGaps; n++) {
        const path = wayOut(s);
        if (!path) { sealed = found.length > 0; break; }
        const g = n < 2 * maxGaps && through(path);
        if (!g) break;
        found.push(g);
        close(g, 1);
      }
      if (sealed) prune(s, -1);
      for (const g of found) close(g, -1);
      return sealed && found.length <= maxGaps ? { ...found[0], gaps: found } : null;
    },
    /**
     * the gaps between p and q in one closed space: each way from one to the
     * other closed at the narrowest gap it goes through (a doorway is
     * narrower than the rooms it joins), until none is left (null: p and q
     * stand in one open space — nothing drawn parts them)
     */
    split(p, q, { widest = maxGap } = {}) {
      const s = cellOf(p), t = cellOf(q);
      if (s < 0 || t < 0 || s === t) return null;
      found = [];
      let parted = false;
      for (let n = 0; n <= 2 * maxGaps; n++) {
        const path = wayOut(s, t);
        if (!path) { parted = found.length > 0; break; }
        const g = n < 2 * maxGaps && crossed(path).filter((x) => x.gap <= widest).sort((x, y) => x.gap - y.gap)[0];
        if (!g) break;
        found.push(g);
        close(g, 1);
      }
      if (parted) prune(s, t);
      for (const g of found) close(g, -1);
      return parted && found.length <= maxGaps ? found : null;
    },
    /** keep these gaps closed for the questions after (or open them again) */
    hold(list) { for (const g of list) close(g, 1); },
    release(list) { for (const g of list) close(g, -1); },
    /** can one walk from p to q past the walls and the gaps held closed? */
    joined(p, q) {
      const s = cellOf(p), t = cellOf(q);
      return s >= 0 && t >= 0 && (s === t || !!wayOut(s, t));
    },
  };
}
