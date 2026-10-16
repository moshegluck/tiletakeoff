// ============================================================
// finishTextures.js — procedural, tileable finish textures drawn at
// TRUE SIZE: a 12×24 tile is 12×24 inches in the 3D house, grout joints
// are their real width, planks run their real length. Each texture is a
// colour map + a roughness map (glossy tile, matte grout) + a bump map.
// UVs in the house are in feet; set repeat = 1 / coverFt.
// ============================================================

import * as THREE from 'three';

const cache = new Map();

// ---- tiny deterministic noise ----
function hash(n) { n = (n << 13) ^ n; return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824; }
const h2 = (a, b) => hash(a * 374761393 + b * 668265263);
function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = h2(xi + seed, yi), b = h2(xi + 1 + seed, yi), c = h2(xi + seed, yi + 1), d = h2(xi + 1 + seed, yi + 1);
  const u = s(xf), v = s(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed = 0, oct = 4) { let f = 0, amp = 0.5, fr = 1; for (let i = 0; i < oct; i++) { f += amp * vnoise(x * fr, y * fr, seed + i * 17); fr *= 2; amp *= 0.5; } return f; }
const hex = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/**
 * Layout functions: map a point (inches) inside the cover to a unit id and
 * local coords. All are periodic over the cover so the texture tiles.
 */
function makeLayout(spec) {
  const g = Math.max(0, spec.grout ?? 0.125);
  const style = spec.style;
  if (style === 'hex') {
    const s = spec.tw / Math.sqrt(3); // flat-to-flat = tw
    const w = Math.sqrt(3) * s, h = 1.5 * s;
    const cols = Math.max(4, Math.round(16 / w)), rows = Math.max(4, Math.round(16 / h / 2) * 2);
    const W = cols * w, H = rows * h;
    return {
      W, H, g,
      at(x, y) {
        // pointy-top hex: axial coords
        const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / s, r = ((2 / 3) * y) / s;
        let cx = q, cz = r, cy = -q - r;
        let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
        const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
        if (dx > dy && dx > dz) rx = -ry - rz; else if (dy > dz) ry = -rx - rz; else rz = -rx - ry;
        const ccx = s * Math.sqrt(3) * (rx + rz / 2), ccy = s * 1.5 * rz;
        return { id: ((rx % cols) + cols) % cols * 1000 + ((rz % rows) + rows) % rows, lx: x - ccx, ly: y - ccy, edge: hexEdge(x - ccx, y - ccy, s) };
      },
    };
  }
  const L = spec.style === 'wood' ? Math.max(spec.tw, spec.th) : spec.tw;   // along x
  const Wd = spec.style === 'wood' ? Math.min(spec.tw, spec.th) : spec.th;  // along y
  if (spec.pattern === 'herringbone') {
    const n = Math.max(2, Math.round(L / Wd));
    const W = 2 * n * Wd;
    return {
      W, H: W, g,
      at(x, y) {
        const u = Math.floor(x / Wd), v = Math.floor(y / Wd);
        const d = (((u - v) % (2 * n)) + 2 * n) % (2 * n);
        if (d < n) {
          // horizontal plank: n cells along the row, starting where d = 0
          const k = Math.floor((u - v) / (2 * n));
          return { id: 7 * v + 13 * k, lx: x - (u - d) * Wd, ly: y - v * Wd, dir: 0 };
        }
        // vertical plank: n cells down the column, its top cell has d = 2n − 1
        const k = Math.floor((u - v - n) / (2 * n));
        const vTop = v - (2 * n - 1 - d);
        return { id: 911 + 7 * u + 13 * k, lx: y - vTop * Wd, ly: x - u * Wd, dir: 1 };
      },
      unitW: n * Wd, unitH: Wd,
    };
  }
  if (spec.pattern === 'brick_50' || spec.pattern === 'brick_33' || style === 'wood') {
    const rows = style === 'wood' ? 8 : Math.max(2, Math.round(36 / Wd / 2) * 2);
    const per = Math.max(1, Math.round(36 / L));
    const W = L * per, H = Wd * rows;
    const off = style === 'wood' ? null : spec.pattern === 'brick_33' ? 1 / 3 : 0.5;
    return {
      W, H, g,
      at(x, y) {
        const r = Math.floor(y / Wd);
        const shift = off == null ? (((h2(r, 3) + 1) / 2) * 0.8 + 0.1) * L : ((r % (off === 0.5 ? 2 : 3)) * off) * L;
        const xs = x - shift;
        const c = Math.floor(xs / L);
        return { id: r * 97 + (((c % per) + per) % per), lx: xs - c * L, ly: y - r * Wd };
      },
      unitW: L, unitH: Wd,
    };
  }
  const cols = Math.max(1, Math.round(36 / L)), rows = Math.max(1, Math.round(36 / Wd));
  return {
    W: L * cols, H: Wd * rows, g,
    at(x, y) { const c = Math.floor(x / L), r = Math.floor(y / Wd); return { id: r * 97 + c, lx: x - c * L, ly: y - r * Wd, c, r }; },
    unitW: L, unitH: Wd,
  };
}

function hexEdge(lx, ly, s) {
  // distance to the hex boundary (pointy-top, circumradius s)
  const ax = Math.abs(lx), ay = Math.abs(ly);
  const d1 = (s * Math.sqrt(3)) / 2 - ax;
  const d2 = (s * Math.sqrt(3)) / 2 - (ax * 0.5 + ay * (Math.sqrt(3) / 2));
  return Math.min(d1, d2);
}

/**
 * @param {{style,color,tw,th,grout,pattern}} spec  sizes in inches
 * @returns {{ map, roughnessMap, bumpMap, coverFt:{w,h}, roughness, metalness }}
 */
export function finishTextures(spec, anisotropy = 8) {
  const key = JSON.stringify([spec.style, spec.color, spec.tw, spec.th, spec.grout, spec.pattern]);
  if (cache.has(key)) return cache.get(key);
  const { col, rgh, lay } = renderFinish(spec);
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(rgh);
  for (const t of [map, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    t.repeat.set(12 / lay.W, 12 / lay.H);
  }
  const out = { map, roughnessMap, bumpMap: roughnessMap, coverFt: { w: lay.W / 12, h: lay.H / 12 }, roughness: 1, metalness: 0 };
  cache.set(key, out);
  return out;
}

const swatches = new Map();
/** Small preview of a finish (data URL) for the design palette. */
export function finishSwatch(spec, px = 112) {
  const key = JSON.stringify([spec.style, spec.color, spec.tw, spec.th, spec.grout, spec.pattern, px]);
  if (swatches.has(key)) return swatches.get(key);
  const { col } = renderFinish(spec, px, 30);
  const url = col.toDataURL('image/jpeg', 0.85);
  swatches.set(key, url);
  return url;
}

function renderFinish(spec, pxOverride, maxInches) {
  const lay0 = makeLayout(spec);
  // a swatch shows at most ~30" of the pattern so small tiles stay readable
  const lay = maxInches && Math.max(lay0.W, lay0.H) > maxInches
    ? { ...lay0, W: Math.min(lay0.W, Math.max(maxInches, lay0.unitW || 0)), H: Math.min(lay0.H, Math.max(maxInches, lay0.unitH || 0)) }
    : lay0;
  const PX = pxOverride || Math.max(256, Math.min(1024, Math.round(Math.max(lay.W, lay.H) * 20)));
  const sx = PX / lay.W, sy = PX / lay.H; // px per inch (may differ slightly)
  const S = PX;
  const col = document.createElement('canvas'); col.width = col.height = S;
  const rgh = document.createElement('canvas'); rgh.width = rgh.height = S;
  const cctx = col.getContext('2d'), rctx = rgh.getContext('2d');
  const cimg = cctx.createImageData(S, S), rimg = rctx.createImageData(S, S);
  const base = hex(spec.color || '#cccccc');
  const groutCol = spec.style === 'wood' ? [base[0] * 0.55, base[1] * 0.5, base[2] * 0.45]
    : spec.style === 'slate' ? [70, 70, 72] : spec.style === 'terracotta' ? [190, 180, 165] : [200, 197, 190];
  const gIn = lay.g;
  const style = spec.style;
  const tileR = { wood: 0.55, marble: 0.18, stone: 0.42, slate: 0.65, terracotta: 0.7, hex: 0.25, checker: 0.3, concrete: 0.5, gloss: 0.12, zellige: 0.15 }[style] ?? 0.4;

  for (let py = 0; py < S; py++) {
    const y = (py + 0.5) / sy;
    for (let px = 0; px < S; px++) {
      const x = (px + 0.5) / sx;
      const u = lay.at(x, y);
      // grout: near the unit boundary
      let inGrout = false;
      if (gIn > 0) {
        if (style === 'hex') inGrout = u.edge < gIn / 2;
        else {
          const half = gIn / 2;
          const a = lay.at(x + half, y), b = lay.at(x - half, y), c = lay.at(x, y + half), d = lay.at(x, y - half);
          inGrout = a.id !== u.id || b.id !== u.id || c.id !== u.id || d.id !== u.id;
        }
      } else if (style === 'wood') {
        // plank seams: a hairline, no grout
        const t = 0.035;
        const a = lay.at(x + t, y), c = lay.at(x, y + t);
        inGrout = a.id !== u.id || c.id !== u.id;
      }
      let r, g, b, rough;
      if (inGrout) {
        [r, g, b] = groutCol; rough = 0.95;
        if (style === 'wood') rough = 0.8;
      } else {
        const v = h2(u.id, 11); // per-unit variation −1..1
        let k = 1, tint = [0, 0, 0];
        if (style === 'wood') {
          const along = u.dir ? u.lx : u.lx, across = u.dir ? u.ly : u.ly;
          const grain = Math.sin((across * 6.5 + fbm(along * 0.08, across * 0.9, u.id) * 9)) * 0.5 + 0.5;
          const fine = fbm(along * 0.6, across * 4, u.id + 3);
          k = 0.86 + v * 0.1 + grain * 0.07 + fine * 0.05;
          const knot = fbm(along * 0.05, across * 0.4, u.id + 9);
          if (knot > 0.42) k -= (knot - 0.42) * 0.6;
          rough = tileR + (1 - grain) * 0.08;
        } else if (style === 'marble') {
          const n = fbm(x * 0.06, y * 0.06, 5, 5);
          const vein = Math.abs(Math.sin((x * 0.05 + y * 0.03 + n * 7.5)));
          const veinK = vein < 0.06 ? (0.06 - vein) / 0.06 : 0;
          const vein2 = Math.abs(Math.sin((x * 0.11 - y * 0.07 + n * 12)));
          const v2 = vein2 < 0.03 ? (0.03 - vein2) / 0.03 : 0;
          k = 0.99 + v * 0.015 - veinK * 0.28 - v2 * 0.14 + (fbm(x * 0.4, y * 0.4, 2) - 0.5) * 0.03;
          tint = [-veinK * 6, -veinK * 3, 0];
          rough = tileR + veinK * 0.1;
        } else if (style === 'slate') {
          const n = fbm(x * 0.25, y * 0.25, u.id, 5);
          k = 0.85 + v * 0.1 + (n - 0.5) * 0.35;
          rough = tileR + (n - 0.5) * 0.2;
        } else if (style === 'terracotta') {
          const n = fbm(x * 0.3, y * 0.3, u.id, 4);
          k = 0.9 + v * 0.12 + (n - 0.5) * 0.18;
          tint = [v * 12, v * 4, -v * 6];
          rough = tileR;
        } else if (style === 'concrete') {
          const n = fbm(x * 0.12, y * 0.12, 4, 5);
          k = 0.94 + (n - 0.5) * 0.18 + v * 0.02;
          rough = tileR + (n - 0.5) * 0.25;
        } else if (style === 'checker') {
          const dark = ((u.c ?? 0) + (u.r ?? 0)) % 2 === 1;
          if (dark) { r = 34; g = 34; b = 36; }
          k = 1 + v * 0.02;
          rough = tileR;
        } else if (style === 'zellige') {
          const n = fbm(x * 0.5, y * 0.5, u.id, 4);
          k = 0.88 + v * 0.14 + (n - 0.5) * 0.2;
          rough = 0.1 + (n - 0.5) * 0.15;
        } else if (style === 'gloss') {
          // subtle pillowed edge on subway / gloss tile
          const ex = Math.min(u.lx, lay.unitW - u.lx), ey = Math.min(u.ly, lay.unitH - u.ly);
          const e = Math.min(ex, ey);
          k = 1 + v * 0.02 - (e < 0.18 ? (0.18 - e) * 0.35 : 0);
          rough = tileR;
        } else {
          const n = fbm(x * 0.2, y * 0.2, u.id, 4);
          k = 0.97 + v * 0.03 + (n - 0.5) * 0.06;
          rough = tileR + (n - 0.5) * 0.1;
        }
        if (r === undefined) { r = base[0] * k + tint[0]; g = base[1] * k + tint[1]; b = base[2] * k + tint[2]; }
        else { r *= k; g *= k; b *= k; }
      }
      const i = (py * S + px) * 4;
      cimg.data[i] = Math.max(0, Math.min(255, r)); cimg.data[i + 1] = Math.max(0, Math.min(255, g)); cimg.data[i + 2] = Math.max(0, Math.min(255, b)); cimg.data[i + 3] = 255;
      const rv = Math.max(0, Math.min(255, rough * 255));
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = rv; rimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0); rctx.putImageData(rimg, 0, 0);
  return { col, rgh, lay };
}

/** Flat paint with a faint roller texture. */
export function paintTexture(color) {
  const key = 'paint:' + color;
  if (cache.has(key)) return cache.get(key);
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const base = hex(color);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbm(x * 0.08, y * 0.08, 1, 3) - 0.5;
    const k = 1 + n * 0.035;
    const i = (y * S + x) * 4;
    img.data[i] = Math.min(255, base[0] * k); img.data[i + 1] = Math.min(255, base[1] * k); img.data[i + 2] = Math.min(255, base[2] * k); img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / 3, 1 / 3);
  const out = { map };
  cache.set(key, out);
  return out;
}

export function disposeTextureCache() {
  for (const v of cache.values()) for (const t of Object.values(v)) if (t && t.isTexture) t.dispose();
  cache.clear();
}
