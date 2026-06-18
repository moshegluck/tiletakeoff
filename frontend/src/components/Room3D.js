import React, { useMemo, Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

function tileTexture(tile) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#dfe3e8"; ctx.fillRect(0, 0, 128, 128); // grout
  ctx.fillStyle = tile?.color || "#cbd5e1";
  ctx.fillRect(5, 5, 118, 118);
  ctx.strokeStyle = "rgba(0,0,0,0.08)"; ctx.lineWidth = 2; ctx.strokeRect(5, 5, 118, 118);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function RoomMesh({ pts, tile, wallHeight }) {
  const tex = useMemo(() => tileTexture(tile), [tile]);
  const { shape, edges, w, d } = useMemo(() => {
    const shape = new THREE.Shape();
    pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
    shape.closePath();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      edges.push({ len, mid, ang });
    }
    return { shape, edges, w: maxX - minX, d: maxY - minY };
  }, [pts]);

  const tileWFt = (tile?.width || 12) / 12, tileHFt = (tile?.height || 12) / 12;
  tex.repeat.set(Math.max(w / tileWFt, 1), Math.max(d / tileHFt, 1));

  return (
    <group>
      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial map={tex} side={THREE.DoubleSide} roughness={0.7} />
      </mesh>
      {/* walls */}
      {edges.map((e, i) => (
        <mesh key={i} position={[e.mid[0], wallHeight / 2, e.mid[1]]} rotation={[0, -e.ang, 0]} castShadow>
          <boxGeometry args={[e.len, wallHeight, 0.25]} />
          <meshStandardMaterial color="#eef1f4" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

export default function Room3D({ rooms, scale, wallHeight = 8, tilesMap, defaultTile }) {
  // convert world-px polygons -> centered feet
  const data = useMemo(() => {
    const ftScale = scale || null;
    let allX = [], allY = [];
    const conv = rooms.map((m) => {
      const pts = m.points.map(([x, y]) => [x, y]);
      return { m, pts };
    });
    // bounds in px
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    conv.forEach(({ pts }) => pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const spanPx = Math.max(maxX - minX, maxY - minY, 1);
    // feet per px: real scale, or fit to ~28ft span
    const fpp = ftScale || 28 / spanPx;
    return conv.map(({ m, pts }) => ({
      tile: tilesMap[m.tile_id] || defaultTile,
      pts: pts.map(([x, y]) => [(x - cx) * fpp, (y - cy) * fpp]),
    }));
  }, [rooms, scale, tilesMap, defaultTile]);

  const span = 30;
  return (
    <Canvas shadows camera={{ position: [span * 0.6, span * 0.7, span * 0.9], fov: 45 }} style={{ background: "linear-gradient(#dbe3ec,#aab6c4)" }}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[20, 35, 15]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#ffffff", "#8a8a8a", 0.4]} />
      <Suspense fallback={null}>
        {data.map((r, i) => <RoomMesh key={i} pts={r.pts} tile={r.tile} wallHeight={wallHeight} />)}
      </Suspense>
      <gridHelper args={[120, 60, "#94a3b8", "#cbd5e1"]} position={[0, -0.02, 0]} />
      <OrbitControls enablePan enableZoom maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}
