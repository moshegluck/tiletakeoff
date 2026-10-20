import { describe, it, expect } from 'vitest';
import { extractRasterWalls, estimateSkew } from '../src/lib/rasterWalls.js';
import { runTrace } from '../src/engine/trace/index.js';
import { buildHousePlan } from './fixtures/planFactory.js';

// Rasterize plan linework like a scan: 1–2 px pen, optional rotation, light noise.
function rasterize(lines, { ppf = 20, deg = 0, noise = 0, pad = 40 } = {}) {
  const W = Math.round(40 * ppf + pad * 2), H = Math.round(28 * ppf + pad * 2);
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = W / 2, cy = H / 2;
  const P = (p) => {
    const x = pad + p.x * ppf - cx, y = pad + p.y * ppf - cy;
    return { x: cx + x * c - y * s, y: cy + x * s + y * c };
  };
  const dot = (x, y) => {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const xi = Math.round(x) + dx - 1, yi = Math.round(y) + dy - 1;
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
      const i = (yi * W + xi) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
    }
  };
  for (const l of lines) {
    const A = P(l.a), B = P(l.b);
    const n = Math.ceil(Math.hypot(B.x - A.x, B.y - A.y) * 2) + 1;
    for (let k = 0; k <= n; k++) dot(A.x + (B.x - A.x) * k / n, A.y + (B.y - A.y) * k / n);
  }
  if (noise) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < W * H; i++) if (rnd() < noise) { const j = i * 4; data[j] = data[j + 1] = data[j + 2] = 0; }
  }
  return { img: { width: W, height: H, data }, ppf };
}

function traceScan(opts) {
  const plan = buildHousePlan({ messy: false });
  const { img, ppf } = rasterize(plan.lines, opts);
  const r = extractRasterWalls(img, ppf);
  const k = 1 / ppf;
  const res = runTrace({
    lines: r.lines.map((l) => ({ a: { x: l.a.x * k, y: l.a.y * k }, b: { x: l.b.x * k, y: l.b.y * k } })),
    bodies: r.bodies.map((b) => ({ a: { x: b.a.x * k, y: b.a.y * k }, b: { x: b.b.x * k, y: b.b.y * k }, t: b.t * k })),
  });
  return { res, stats: r.stats };
}

describe('raster (scanned plan) fallback', () => {
  it('reads a straight scan into the same seven rooms', () => {
    const { res } = traceScan({});
    expect(res.rooms.length).toBe(7);
    expect(res.flags.filter((f) => f.severity === 'error')).toEqual([]);
    // the vector sheet's key, floors stopping at the wall face across each doorway: 1,034.1 SF
    expect(res.totals.floorSf).toBeGreaterThan(1027);
    expect(res.totals.floorSf).toBeLessThan(1041);
  });

  it('straightens a crooked, dusty scan', () => {
    const { res, stats } = traceScan({ deg: 0.8, noise: 0.0015 });
    expect(Math.abs(stats.skewDeg - 0.8)).toBeLessThan(0.08);
    expect(res.rooms.length).toBe(7);
    expect(res.totals.floorSf).toBeGreaterThan(1026);
    expect(res.totals.floorSf).toBeLessThan(1044);
  });

  it('estimates zero skew on a square plan', () => {
    const { img } = rasterize(buildHousePlan({ messy: false }).lines, {});
    const dark = new Uint8Array(img.width * img.height);
    for (let i = 0; i < dark.length; i++) dark[i] = img.data[i * 4] < 128 ? 1 : 0;
    expect(Math.abs(estimateSkew(dark, img.width, img.height))).toBeLessThan(0.03);
  });
});
