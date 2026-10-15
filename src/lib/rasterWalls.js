// ============================================================
// rasterWalls.js — fallback for scanned plans (no vectors to read).
//
// Binarize the page, find long horizontal and vertical strokes, and
// measure their thickness. Thick strokes (a wall-thickness tall) are
// wall bodies directly; thin strokes are face lines that the pairing
// stage turns into walls. Everything still goes through the same
// coherence engine, so a bad scan produces flags, not fake numbers.
// Orthogonal walls only — diagonal walls on scans are flagged.
// ============================================================

/** Otsu threshold on a grayscale buffer. */
function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA
 * @param {number} pxPerFt
 * @param {object} [opt]
 * @returns {{ lines: {a,b,w}[], bodies: {a,b,t}[], stats }}  px coordinates; body t in px
 */
export function extractRasterWalls(img, pxPerFt, opt = {}) {
  const { width: W, height: H, data } = img;
  const minT = (opt.minTIn ?? 2.5) / 12 * pxPerFt;
  const maxT = (opt.maxTIn ?? 16) / 12 * pxPerFt;
  // Short wall returns (a 4" stub beside a door) are real, so strokes may be
  // short — text and specks are removed by blob size instead (below).
  const minRun = Math.max(5, Math.round(0.35 * pxPerFt));
  const minBlob = Math.max(20, 3 * pxPerFt);
  const gray = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const a = data[j + 3] / 255;
    gray[i] = Math.round((0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) * a + 255 * (1 - a));
  }
  const thr = Math.min(200, otsu(gray));
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < gray.length; i++) dark[i] = gray[i] <= thr ? 1 : 0;
  const removed = dropSmallBlobs(dark, W, H, minBlob);

  // scans are rarely square to the page — straighten before reading strokes
  const skew = opt.skewDeg ?? estimateSkew(dark, W, H);
  const work = Math.abs(skew) > 0.04 ? rotateMask(dark, W, H, -skew) : dark;

  const lines = [], bodies = [];
  const out = { lines, bodies };
  scan(work, W, H, minRun, minT, maxT, false, out);
  scan(work, W, H, minRun, minT, maxT, true, out);
  if (work !== dark) {
    const back = (p) => rotPt(p, W / 2, H / 2, skew);
    for (const l of lines) { l.a = back(l.a); l.b = back(l.b); }
    for (const b of bodies) { b.a = back(b.a); b.b = back(b.b); }
  }
  return { lines, bodies, stats: { threshold: thr, minRun, blobsRemoved: removed, skewDeg: +skew.toFixed(3), lines: lines.length, bodies: bodies.length } };
}

function rotPt(p, cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const x = p.x - cx, y = p.y - cy;
  return { x: cx + x * c - y * s, y: cy + x * s + y * c };
}

/** Rotate a binary mask by deg (nearest neighbour, about the centre). */
function rotateMask(src, W, H, deg) {
  const out = new Uint8Array(W * H);
  const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const sx = Math.round(cx + dx * c - dy * s), sy = Math.round(cy + dx * s + dy * c);
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) out[y * W + x] = src[sy * W + sx];
    }
  }
  return out;
}

/**
 * Skew estimate: the angle that makes row and column projection profiles
 * sharpest (walls line up into tall spikes). Coarse-to-fine over ±3°.
 */
export function estimateSkew(dark, W, H) {
  const pts = [];
  const step = Math.max(1, Math.round(Math.sqrt((W * H) / 400000)));
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (dark[y * W + x]) pts.push(x - W / 2, y - H / 2);
  if (pts.length < 200) return 0;
  const score = (deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const rows = new Map(), cols = new Map();
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      const r = Math.round((-x * s + y * c) / step), k = Math.round((x * c + y * s) / step);
      rows.set(r, (rows.get(r) || 0) + 1); cols.set(k, (cols.get(k) || 0) + 1);
    }
    let v = 0;
    for (const n of rows.values()) v += n * n;
    for (const n of cols.values()) v += n * n;
    return v;
  };
  let best = 0, bs = score(0);
  for (const span of [[-3, 3, 0.25], [-0.3, 0.3, 0.05], [-0.06, 0.06, 0.01]]) {
    const base = best;
    for (let d = span[0]; d <= span[1] + 1e-9; d += span[2]) {
      const deg = base + d; const v = score(deg);
      if (v > bs * 1.0005) { bs = v; best = deg; }
    }
  }
  return best;
}

// Remove 8-connected dark blobs whose bounding box is smaller than minBlob px
// (letters, numbers, symbols, dust). Wall outlines are one huge connected blob.
function dropSmallBlobs(dark, W, H, minBlob) {
  const runs = []; // per row: [x0,x1,id]
  const parent = [];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let prev = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    let x = 0;
    while (x < W) {
      if (!dark[y * W + x]) { x++; continue; }
      const x0 = x; while (x < W && dark[y * W + x]) x++;
      const id = parent.length; parent.push(id);
      const r = [x0, x - 1, id];
      for (const q of prev) if (q[1] >= x0 - 1 && q[0] <= x) { const a = find(id), b = find(q[2]); if (a !== b) parent[a] = b; }
      row.push(r);
    }
    runs.push(row); prev = row;
  }
  const box = new Map();
  runs.forEach((row, y) => { for (const [x0, x1, id] of row) {
    const r = find(id); let b = box.get(r);
    if (!b) box.set(r, (b = [x0, y, x1, y]));
    else { if (x0 < b[0]) b[0] = x0; if (x1 > b[2]) b[2] = x1; if (y > b[3]) b[3] = y; }
  } });
  let removed = 0;
  runs.forEach((row, y) => { for (const [x0, x1, id] of row) {
    const b = box.get(find(id));
    if (Math.max(b[2] - b[0], b[3] - b[1]) + 1 < minBlob) { for (let x = x0; x <= x1; x++) dark[y * W + x] = 0; removed++; }
  } });
  return removed;
}

// Scan rows (or columns when `vert`) for long runs, group runs into bands,
// split bands where their cross-section changes, classify each piece.
function scan(dark, W, H, minRun, minT, maxT, vert, out) {
  const A = vert ? W : H;      // number of scanlines
  const B = vert ? H : W;      // scanline length
  const at = vert ? (s, k) => dark[k * W + s] : (s, k) => dark[s * W + k];
  // runs per scanline
  const runs = [];
  for (let s = 0; s < A; s++) {
    const row = [];
    let k = 0;
    while (k < B) {
      if (!at(s, k)) { k++; continue; }
      const k0 = k;
      while (k < B && at(s, k)) k++;
      if (k - k0 >= minRun) row.push({ k0, k1: k - 1, s, id: -1 });
    }
    runs.push(row);
  }
  // union runs on adjacent scanlines that overlap
  const parent = [];
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  let nid = 0;
  for (let s = 0; s < A; s++) for (const r of runs[s]) { r.id = nid; parent.push(nid++); }
  for (let s = 1; s < A; s++) {
    for (const r of runs[s]) for (const q of runs[s - 1]) {
      if (q.k1 < r.k0 || q.k0 > r.k1) continue;
      const a = find(r.id), b = find(q.id); if (a !== b) parent[a] = b;
    }
  }
  const comps = new Map();
  for (let s = 0; s < A; s++) for (const r of runs[s]) {
    const c = find(r.id);
    if (!comps.has(c)) comps.set(c, []);
    comps.get(c).push(r);
  }
  for (const rs of comps.values()) {
    // per position k along the stroke: min/max scanline covered
    let kmin = Infinity, kmax = -Infinity;
    for (const r of rs) { kmin = Math.min(kmin, r.k0); kmax = Math.max(kmax, r.k1); }
    const len = kmax - kmin + 1;
    const lo = new Float64Array(len).fill(Infinity), hi = new Float64Array(len).fill(-Infinity);
    for (const r of rs) for (let k = r.k0; k <= r.k1; k++) { const i = k - kmin; if (r.s < lo[i]) lo[i] = r.s; if (r.s > hi[i]) hi[i] = r.s; }
    // split where the cross-section jumps
    let i0 = 0;
    const emit = (a, b) => {
      if (b - a + 1 < minRun) return;
      let sl = 0, sh = 0, n = 0;
      for (let i = a; i <= b; i++) if (Number.isFinite(lo[i])) { sl += lo[i]; sh += hi[i]; n++; }
      if (!n) return;
      const top = sl / n, bot = sh / n + 1;  // pixel edges
      const t = bot - top;
      const k0 = kmin + a, k1 = kmin + b + 1;
      const c = (top + bot) / 2;
      const P = (k, s) => (vert ? { x: s, y: k } : { x: k, y: s });
      if (t < minT) out.lines.push({ a: P(k0, c), b: P(k1, c), w: t });
      else if (t <= maxT) out.bodies.push({ a: P(k0, c), b: P(k1, c), t });
      else { out.lines.push({ a: P(k0, top), b: P(k1, top), w: 1 }); out.lines.push({ a: P(k0, bot), b: P(k1, bot), w: 1 }); }
    };
    for (let i = 1; i < len; i++) {
      const jump = !Number.isFinite(lo[i]) || !Number.isFinite(lo[i - 1]) || Math.abs(lo[i] - lo[i - 1]) > 1.5 || Math.abs(hi[i] - hi[i - 1]) > 1.5;
      if (jump) { emit(i0, i - 1); i0 = i; }
    }
    emit(i0, len - 1);
  }
}
