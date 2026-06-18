import React, { useMemo, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import * as THREE from "three";

function materialOf(tile) {
  const s = `${tile?.collection || ""} ${tile?.name || ""}`.toLowerCase();
  if (/marble|calacatta|carrara|onyx|stone look/.test(s)) return "marble";
  if (/wood|oak|walnut|plank|timber|teak/.test(s)) return "wood";
  if (/concrete|cement|terrazzo/.test(s)) return "concrete";
  return "stone";
}
function roughFromFinish(f) {
  return ({ polished: 0.12, gloss: 0.08, honed: 0.5, matte: 0.85, textured: 0.95 })[(f || "matte").toLowerCase()] ?? 0.7;
}
function shade(hex, amt) {
  try { const n = parseInt(hex.replace("#", ""), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt)), g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt)), b = Math.max(0, Math.min(255, (n & 255) + amt));
    return `rgb(${r},${g},${b})`; } catch { return hex; }
}

function veins(ctx, S, light) {
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    let x = Math.random() * S, y = -10;
    ctx.moveTo(x, y);
    while (y < S + 10) { x += (Math.random() - 0.5) * 80; y += 18 + Math.random() * 26; ctx.lineTo(x, y); }
    ctx.strokeStyle = (i % 3 === 0 ? `rgba(120,110,90,${0.10 + Math.random() * 0.12})` : `rgba(255,255,255,${0.12 + Math.random() * 0.14})`);
    ctx.lineWidth = 1 + Math.random() * 3; ctx.stroke();
  }
}
function grain(ctx, x, y, w, h, base) {
  const horiz = w >= h;
  for (let i = 0; i < (horiz ? h : w); i += 2) {
    ctx.strokeStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
    ctx.beginPath();
    if (horiz) { ctx.moveTo(x, y + i + Math.sin(i * 0.3) * 1.5); ctx.lineTo(x + w, y + i + Math.cos(i * 0.2) * 1.5); }
    else { ctx.moveTo(x + i + Math.sin(i * 0.3) * 1.5, y); ctx.lineTo(x + i + Math.cos(i * 0.2) * 1.5, y + h); }
    ctx.stroke();
  }
}
function noise(ctx, x, y, w, h) {
  for (let i = 0; i < w * h * 0.04; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 1.2, 1.2);
  }
}

function drawTile(ctx, x, y, w, h, base, mat) {
  const v = (Math.random() - 0.5) * 14;
  ctx.fillStyle = shade(base, v);
  ctx.fillRect(x, y, w, h);
  if (mat === "wood") grain(ctx, x, y, w, h, base);
  else if (mat === "concrete") noise(ctx, x, y, w, h);
  else { const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, "rgba(255,255,255,0.07)"); g.addColorStop(1, "rgba(0,0,0,0.05)"); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); }
  ctx.strokeStyle = "rgba(0,0,0,0.18)"; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
}

function makeTileTexture(tile, pattern) {
  const S = 512;
  const c = document.createElement("canvas"); c.width = c.height = S;
  const ctx = c.getContext("2d");
  const color = tile?.color || "#cbd5e1";
  const mat = materialOf(tile);
  const pat = (pattern || tile?.pattern || "grid").toLowerCase();
  ctx.fillStyle = "#d9dde2"; ctx.fillRect(0, 0, S, S); // grout
  const g = 3;
  const aspect = (tile?.height || 12) / (tile?.width || 12);

  if (pat === "checkerboard") {
    const n = 6, t = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) drawTile(ctx, i * t + g, j * t + g, t - 2 * g, t - 2 * g, (i + j) % 2 ? shade(color, -34) : color, mat);
  } else if (pat === "brick" || pat === "offset") {
    const n = 5, t = S / n, th = t / Math.max(aspect, 1);
    for (let row = 0; row * th < S; row++) { const off = (row % 2) * (t / 2);
      for (let i = -1; i < n + 1; i++) drawTile(ctx, i * t + off + g, row * th + g, t - 2 * g, th - 2 * g, color, mat); }
  } else if (pat === "herringbone" || pat === "chevron") {
    const L = S / 4.2, W = L / 3; ctx.save();
    for (let yy = -L; yy < S + L; yy += W * 2) for (let xx = -L; xx < S + L; xx += L) {
      ctx.save(); ctx.translate(xx, yy); ctx.rotate(Math.PI / 4); drawTile(ctx, 0, 0, L - g, W - g, color, mat); ctx.restore();
      ctx.save(); ctx.translate(xx + L * 0.71, yy + L * 0.0); ctx.rotate(pat === "chevron" ? Math.PI / 4 : -Math.PI / 4); drawTile(ctx, 0, 0, L - g, W - g, color, mat); ctx.restore();
    }
    ctx.restore();
  } else if (pat === "basketweave") {
    const n = 4, t = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const horiz = (i + j) % 2 === 0;
      for (let k = 0; k < 2; k++) horiz ? drawTile(ctx, i * t + g, j * t + k * t / 2 + g, t - 2 * g, t / 2 - 2 * g, color, mat)
        : drawTile(ctx, i * t + k * t / 2 + g, j * t + g, t / 2 - 2 * g, t - 2 * g, shade(color, -18), mat); }
  } else if (pat === "diagonal") {
    ctx.save(); ctx.translate(S / 2, S / 2); ctx.rotate(Math.PI / 4); ctx.translate(-S, -S);
    const n = 10, t = (2 * S) / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) drawTile(ctx, i * t + g, j * t + g, t - 2 * g, t - 2 * g, color, mat); ctx.restore();
  } else {
    const n = 6, t = S / n, th = t * Math.min(Math.max(aspect, 0.5), 2);
    for (let i = 0; i < n; i++) for (let j = 0; j * th < S; j++) drawTile(ctx, i * t + g, j * th + g, t - 2 * g, th - 2 * g, color, mat);
  }
  if (mat === "marble") veins(ctx, S, true);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return { tex, mat };
}

function RoomMesh({ pts, tile, pattern, wallHeight }) {
  const { tex } = useMemo(() => makeTileTexture(tile, pattern), [tile?.id, tile?.color, pattern]);
  const rough = roughFromFinish(tile?.finish);
  const { shape, edges, w, d } = useMemo(() => {
    const shape = new THREE.Shape();
    pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
    shape.closePath();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const edges = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
      edges.push({ len: Math.hypot(b[0] - a[0], b[1] - a[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) }); }
    return { shape, edges, w: maxX - minX, d: maxY - minY };
  }, [pts]);

  const tileFt = ((tile?.width || 12) / 12);
  const reps = Math.max(Math.min(w / (tileFt * 6), 30), 0.5);
  tex.repeat.set(reps, reps * (d / Math.max(w, 1)));

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial map={tex} side={THREE.DoubleSide} roughness={rough} metalness={0.02} />
      </mesh>
      {edges.map((e, i) => (
        <mesh key={i} position={[e.mid[0], wallHeight / 2, e.mid[1]]} rotation={[0, -e.ang, 0]} castShadow receiveShadow>
          <boxGeometry args={[e.len, wallHeight, 0.25]} />
          <meshStandardMaterial color="#f2f0ec" roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

export default function Room3D({ rooms, scale, wallHeight = 8, tilesMap, defaultTile }) {
  const data = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rooms.forEach((m) => m.points.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanPx = Math.max(maxX - minX, maxY - minY, 1);
    const fpp = scale || 28 / spanPx;
    return rooms.map((m) => ({ tile: tilesMap[m.tile_id] || defaultTile, pattern: m.pattern || (tilesMap[m.tile_id] || defaultTile)?.pattern,
      pts: m.points.map(([x, y]) => [(x - cx) * fpp, (y - cy) * fpp]) }));
  }, [rooms, scale, tilesMap, defaultTile]);

  const span = 32;
  return (
    <Canvas shadows dpr={[1, 1.8]} camera={{ position: [span * 0.5, span * 0.8, span], fov: 45 }} style={{ background: "linear-gradient(#e6edf4,#9fb0c2)" }}>
      <ambientLight intensity={0.55} />
      <directionalLight position={[18, 40, 22]} intensity={1.25} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-far={120} shadow-camera-left={-60} shadow-camera-right={60} shadow-camera-top={60} shadow-camera-bottom={-60} />
      <hemisphereLight args={["#ffffff", "#9098a0", 0.45]} />
      <Suspense fallback={null}>
        {data.map((r, i) => <RoomMesh key={i} pts={r.pts} tile={r.tile} pattern={r.pattern} wallHeight={wallHeight} />)}
        <ContactShadows position={[0, 0.01, 0]} opacity={0.45} scale={120} blur={2.4} far={40} />
      </Suspense>
      <OrbitControls enablePan enableZoom maxPolarAngle={Math.PI / 2.05} target={[0, 0, 0]} />
    </Canvas>
  );
}
