// ============================================================
// PatternSwatch — a small true-geometry preview of a tile laid in a
// pattern: the same layout the takeoff counts (engine/layouts.js), drawn in
// the tile's colour with its grout joint.
// ============================================================
import { useEffect, useRef } from 'react';
import { generateLayout } from '../engine/layouts.js';

const hexRgb = (hex) => {
  const h = String(hex || '#cccccc').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
};
const rgb = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
// lighten (amt > 0) or darken (amt < 0) toward white / black
const shade = (c, amt) => c.map((v) => (amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)));
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
// stable per-tile variation so a field reads as real tile, not a flat fill
const jitter = (i) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/**
 * @param {{ tw:number, th:number, grout?:number, pattern?:string, angleDeg?:number, color?:string,
 *           size?:number, span?:number, className?:string, title?:string }} p
 *   tw/th/grout in inches; span = feet shown across (default ≈ three long tiles)
 */
export default function PatternSwatch({ tw, th, grout = 0.125, pattern = 'grid', angleDeg = 0, color = '#d9d3c7', size = 64, span, className, title }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !(tw > 0 && th > 0)) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.round(size * dpr);
    if (cv.width !== W) { cv.width = W; cv.height = W; }
    const ctx = cv.getContext('2d');
    const S = span || Math.max(1.5, Math.min(10, (Math.max(tw, th) / 12) * 3.2));
    const k = W / S;                                   // px per foot
    const g = Math.max(0, +grout || 0) / 12;
    const base = hexRgb(color);
    ctx.fillStyle = rgb(lum(base) > 0.55 ? shade(base, -0.28) : shade(base, 0.45));
    ctx.fillRect(0, 0, W, W);
    const tiles = generateLayout([{ x: 0, y: 0 }, { x: S, y: 0 }, { x: S, y: S }, { x: 0, y: S }],
      { pattern, tileW: tw / 12 + g, tileH: th / 12 + g, angleDeg, origin: { x: 0, y: 0 } });
    const gap = Math.max(dpr * 0.9, g * k);            // keep joints visible on tiny swatches
    tiles.forEach((t, i) => {
      const x = t.cx * k, y = t.cy * k, w = Math.max(1, t.w * k - gap), h = Math.max(1, t.h * k - gap);
      const r = (w + h) / 2;
      if (x < -r || y < -r || x > W + r || y > W + r) return;
      ctx.save(); ctx.translate(x, y); if (t.rot) ctx.rotate(t.rot);
      ctx.fillStyle = rgb(shade(base, (jitter(i) - 0.5) * 0.1));
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    });
  }, [tw, th, grout, pattern, angleDeg, color, size, span]);
  return <canvas ref={ref} className={'swatch-cv' + (className ? ' ' + className : '')} style={{ width: size, height: size }} title={title} aria-hidden={!title} />;
}
