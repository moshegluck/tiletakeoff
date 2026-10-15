// ============================================================
// house3d.js — the traced model as a real, walkable house.
//
// Built from the same reconstructed wall network the takeoff uses:
// wall bodies at their true thickness, headers over every opening,
// doors hung on their hinges, floors tiled at true tile size, walls
// painted or tiled per room, baseboards, ceilings and lights.
// Plan (x, y) feet → world (x, height, y); +Y is up.
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { finishTextures, paintTexture } from './finishTextures.js';

const EYE = 5.25;          // ft
const RADIUS = 0.85;       // player collision radius, ft
const WALK = 4.5, RUN = 9; // ft/s

export function createHouseScene(canvas, { onPick, onRoom, onMode } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xdfe7ee);
  scene.background = sky;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.35;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  camera.position.set(30, 40, 60);

  // lights
  const hemi = new THREE.HemisphereLight(0xf4f7fb, 0x8d8172, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e2, 1.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);

  // ground
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xc5ccbd, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true;
  scene.add(ground);

  const house = new THREE.Group();
  scene.add(house);
  // A fixed pool of ceiling lights that follows you to the nearest rooms: the
  // light count never changes (no shader recompiles) and stays cheap on iPads.
  const pool = [0, 1, 2, 3].map(() => { const l = new THREE.PointLight(0xffe9c9, 0, 0, 1.6); l.visible = false; scene.add(l); return l; });
  let lightSpots = [];
  let lightClock = 0;
  function placeLights(x, z, force) {
    if (!force && (lightClock += 1) % 20) return;
    const near = lightSpots.map((p) => ({ p, d: Math.hypot(p.x - x, p.y - z) })).sort((a, b) => a.d - b.d).slice(0, pool.length);
    pool.forEach((l, i) => {
      const n = near[i];
      if (!n) { l.intensity = 0; return; }
      l.position.x = n.p.x; l.position.z = n.p.y;
      l.intensity = Math.min(110, 22 + n.p.area * 0.35);
    });
  }
  const ceilings = new THREE.Group();
  house.add(ceilings);

  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true; orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI / 2 - 0.03;
  orbit.minDistance = 4; orbit.maxDistance = 400;

  let model = null;
  let colliders = [];   // [{a:{x,y}, b:{x,y}, h}]
  let roomsForPick = []; // [{ id, name, poly, holes }]
  let mode = 'orbit';
  let showCeil = false;
  const pickables = [];

  // ---------------------------------------------------------------- build
  const mats = new Map();
  function matFor(key, make) { if (!mats.has(key)) mats.set(key, make()); return mats.get(key); }
  const paintMat = (color) => matFor('paint:' + color, () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: paintTexture(color).map, roughness: 0.88, metalness: 0 }));
  const finishMat = (spec) => matFor('fin:' + JSON.stringify(spec), () => {
    const t = finishTextures(spec, renderer.capabilities.getMaxAnisotropy());
    return new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0, bumpMap: t.bumpMap, bumpScale: 0.6 });
  });
  const extMat = matFor('ext', () => new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.92 }));
  const capMat = matFor('cap', () => new THREE.MeshStandardMaterial({ color: 0xf0ede6, roughness: 0.9 }));
  const trimMat = matFor('trim', () => new THREE.MeshStandardMaterial({ color: 0xf7f6f2, roughness: 0.45 }));
  const ceilMat = matFor('ceil', () => new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 0.95, side: THREE.BackSide }));
  const doorMat = matFor('door', () => new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.5 }));
  const knobMat = matFor('knob', () => new THREE.MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.25, metalness: 0.9 }));
  const lampMat = matFor('lamp', () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 2.2 }));

  function clear() {
    house.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const c of [...house.children]) if (c !== ceilings) house.remove(c);
    ceilings.clear();
    pickables.length = 0;
  }

  function build(m) {
    clear();
    model = m;
    if (!m || (!m.rooms.length && !m.walls.length)) return;
    const H = m.H, DH = Math.min(m.doorH, H - 0.25);

    // --- floors + ceilings + lights per room ---
    roomsForPick = m.rooms;
    for (const r of m.rooms) {
      const shape = shapeOf(r.poly, r.holes);
      const fg = new THREE.ShapeGeometry(shape); fg.rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(fg, finishMat(r.floor));
      floor.receiveShadow = true;
      floor.userData = { roomId: r.id, surface: 'floor' };
      house.add(floor); pickables.push(floor);

      // same footprint lifted to the ceiling; drawn from below (BackSide)
      const cg = new THREE.ShapeGeometry(shape); cg.rotateX(-Math.PI / 2); cg.translate(0, H, 0);
      const ceil = new THREE.Mesh(cg, ceilMat);
      ceil.castShadow = true; // indoors, the roof keeps the sun out
      ceilings.add(ceil);

      // fixture + light
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 28), lampMat);
      lamp.position.set(r.center.x, H - 0.05, r.center.y);
      ceilings.add(lamp);
    }
    lightSpots = m.rooms.map((r) => ({ x: r.center.x, y: r.center.y, area: Math.max(20, r.area || 100) }));
    for (const pl of pool) pl.position.y = H - 0.6;
    placeLights(walk.pos.x, walk.pos.z, true);

    // --- walls: real bodies ---
    const ends = new Map();
    const key = (p) => `${Math.round(p.x * 48)}:${Math.round(p.y * 48)}`;
    for (const w of m.walls) for (const p of [w.a, w.b]) ends.set(key(p), (ends.get(key(p)) || 0) + 1);
    colliders = [];
    for (const w of m.walls) {
      const dx = w.b.x - w.a.x, dy = w.b.y - w.a.y, L = Math.hypot(dx, dy);
      if (L < 0.02) continue;
      const ux = dx / L, uy = dy / L;
      // extend into corners only where another wall continues
      const ea = (ends.get(key(w.a)) || 0) > 1 ? w.t / 2 : 0;
      const eb = (ends.get(key(w.b)) || 0) > 1 ? w.t / 2 : 0;
      const len = L + ea + eb;
      const cx = (w.a.x + w.b.x) / 2 + ux * (eb - ea) / 2, cy = (w.a.y + w.b.y) / 2 + uy * (eb - ea) / 2;
      const g = new THREE.BoxGeometry(len, H, w.t);
      // faces: +x,-x,+y,-y,+z,-z ; local +z = left normal (−uy, ux)
      const outsideLeft = w.exterior && !insideAnyRoom({ x: cx - uy * (w.t / 2 + 0.3), y: cy + ux * (w.t / 2 + 0.3) }, m.rooms);
      const outsideRight = w.exterior && !insideAnyRoom({ x: cx + uy * (w.t / 2 + 0.3), y: cy - ux * (w.t / 2 + 0.3) }, m.rooms);
      const mesh = new THREE.Mesh(g, [capMat, capMat, capMat, capMat, outsideLeft ? extMat : capMat, outsideRight ? extMat : capMat]);
      mesh.position.set(cx, H / 2, cy);
      mesh.rotation.y = -Math.atan2(dy, dx);
      mesh.castShadow = true; mesh.receiveShadow = true;
      house.add(mesh);
      colliders.push({ a: w.a, b: w.b, r: w.t / 2 });
    }

    // --- openings: headers, casings, doors ---
    for (const o of m.openings) {
      const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const t = o.t || 0.4;
      const hh = H - DH;
      if (hh > 0.02) {
        const g = new THREE.BoxGeometry(L, hh, t);
        const mesh = new THREE.Mesh(g, capMat);
        mesh.position.set((o.a.x + o.b.x) / 2, DH + hh / 2, (o.a.y + o.b.y) / 2);
        mesh.rotation.y = -Math.atan2(dy, dx);
        mesh.castShadow = true; mesh.receiveShadow = true;
        house.add(mesh);
      }
      // casing trim around the opening, both faces
      addCasing(o, t, DH);
      // door leaves hung open on their hinge
      for (const arc of o.arcs || []) addDoorLeaf(o, arc, DH);
    }

    // --- per-room wall finishes: paint, tile, baseboard ---
    for (const r of m.rooms) addRoomWalls(r, m, H);

    // --- frame the sun + ground to the house ---
    const bb = new THREE.Box3().setFromObject(house);
    const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
    const span = Math.max(sz.x, sz.z, 20);
    ground.scale.set(span * 6, span * 6, 1); ground.position.set(c.x, -0.02, c.z);
    sun.position.set(c.x + span * 0.6, span * 1.1, c.z + span * 0.45);
    sun.target.position.set(c.x, 0, c.z);
    const sc = sun.shadow.camera;
    sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = span * 4;
    sc.updateProjectionMatrix();
    if (!build.framed) { frameOrbit(c, span); build.framed = true; }
    ceilings.visible = showCeil || mode === 'walk';
  }

  function frameOrbit(c, span) {
    orbit.target.set(c.x, 0, c.z);
    camera.position.set(c.x + span * 0.35, span * 0.95, c.z + span * 0.95);
    orbit.update();
  }

  function addCasing(o, t, DH) {
    const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const W = 0.29, D = 0.06; // 3.5" casing, 3/4" proud
    for (const side of [1, -1]) {
      const off = (t / 2 + D / 2) * side;
      const parts = [
        { cx: o.a.x - ux * W / 2, cy: o.a.y - uy * W / 2, len: W, h: DH + W, y: (DH + W) / 2 },
        { cx: o.b.x + ux * W / 2, cy: o.b.y + uy * W / 2, len: W, h: DH + W, y: (DH + W) / 2 },
        { cx: (o.a.x + o.b.x) / 2, cy: (o.a.y + o.b.y) / 2, len: L + 2 * W, h: W, y: DH + W / 2 },
      ];
      for (const p of parts) {
        const g = new THREE.BoxGeometry(p.len, p.h, D);
        const mesh = new THREE.Mesh(g, trimMat);
        mesh.position.set(p.cx + nx * off, p.y, p.cy + ny * off);
        mesh.rotation.y = -Math.atan2(dy, dx);
        mesh.castShadow = true;
        house.add(mesh);
      }
    }
  }

  function addDoorLeaf(o, arc, DH) {
    // the arc end farthest from the opening line is where the leaf stands open
    const lineD = (p) => {
      const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, L = Math.hypot(dx, dy);
      return Math.abs((p.x - o.a.x) * dy - (p.y - o.a.y) * dx) / L;
    };
    const tip = lineD(arc.p0) > lineD(arc.p3) ? arc.p0 : arc.p3;
    const hx = arc.c.x, hy = arc.c.y;
    const dx = tip.x - hx, dy = tip.y - hy, r = Math.hypot(dx, dy);
    if (r < 0.5) return;
    const ang = Math.atan2(dy, dx);
    // swing it back ~12° from fully open so it reads as a door, not a wall
    const sweepBack = 0.21 * Math.sign(cross2({ x: dx, y: dy }, { x: o.b.x - o.a.x, y: o.b.y - o.a.y }) || 1);
    const a2 = ang + sweepBack;
    const T = 0.145;
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(r - 0.05, DH - 0.06, T), doorMat);
    const piv = new THREE.Group();
    piv.position.set(hx, 0, hy);
    piv.rotation.y = -a2;
    leaf.position.set((r - 0.05) / 2, (DH - 0.06) / 2 + 0.03, 0);
    leaf.castShadow = true; leaf.receiveShadow = true;
    piv.add(leaf);
    // panel detail + knob
    for (const z of [T / 2 + 0.003, -T / 2 - 0.003]) {
      for (const [y0, hgt] of [[0.6, 2.4], [3.4, 2.6]]) {
        const pnl = new THREE.Mesh(new THREE.BoxGeometry(r - 0.75, hgt, 0.01), doorMat);
        pnl.position.set((r - 0.05) / 2, y0 + hgt / 2, z);
        piv.add(pnl);
      }
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), knobMat);
      knob.position.set(r - 0.3, 3, z * 1.9);
      piv.add(knob);
    }
    house.add(piv);
  }

  function addRoomWalls(r, m, H) {
    const poly = r.poly;
    const tileH = r.wallTile ? Math.min(H, r.wallTileHeight == null ? H : r.wallTileHeight) : 0;
    const paint = paintMat(r.paint);
    const tileM = r.wallTile ? finishMat(r.wallTile) : null;
    const BB = 0.29; // 3.5" base
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      if (L < 0.08) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (alongOpening({ x: mx, y: my }, dx / L, dy / L, m.openings)) continue;
      const nx = -dy / L, ny = dx / L; // into the room
      const rotY = Math.atan2(nx, ny);
      const panel = (y0, y1, mat, inset) => {
        if (y1 - y0 < 0.01) return;
        const g = new THREE.PlaneGeometry(L, y1 - y0);
        scaleUV(g, L, y1 - y0, y0);
        const mesh = new THREE.Mesh(g, mat);
        mesh.position.set(mx + nx * inset, (y0 + y1) / 2, my + ny * inset);
        mesh.rotation.y = rotY;
        mesh.receiveShadow = true;
        mesh.userData = { roomId: r.id, surface: 'wall' };
        house.add(mesh); pickables.push(mesh);
      };
      if (tileH > 0) panel(0, tileH, tileM, 0.012);
      panel(tileH, H, paint, 0.006);
      if (tileH <= 0.01) {
        const g = new THREE.BoxGeometry(L, BB, 0.05);
        const base = new THREE.Mesh(g, trimMat);
        base.position.set(mx + nx * 0.03, BB / 2, my + ny * 0.03);
        base.rotation.y = rotY;
        house.add(base);
      }
    }
  }

  // ---------------------------------------------------------------- walk
  const walk = { yaw: 0, pitch: 0, pos: new THREE.Vector3(), keys: new Set(), locked: false, joy: { x: 0, y: 0 }, lastRoom: null };

  function startWalk(at) {
    mode = 'walk';
    orbit.enabled = false;
    ceilings.visible = true;
    for (const l of pool) l.visible = true;
    scene.background = new THREE.Color(0xcfdbe6);
    const p = at || spawnPoint();
    walk.pos.set(p.x, EYE, p.y);
    walk.yaw = p.yaw ?? 0; walk.pitch = 0;
    applyWalkCam();
    placeLights(walk.pos.x, walk.pos.z, true);
    onMode?.('walk');
  }
  function stopWalk() {
    mode = 'orbit';
    orbit.enabled = true;
    ceilings.visible = showCeil;
    for (const l of pool) l.visible = showCeil;
    scene.background = sky;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    const bb = new THREE.Box3().setFromObject(house);
    if (!bb.isEmpty()) frameOrbit(bb.getCenter(new THREE.Vector3()), Math.max(20, bb.getSize(new THREE.Vector3()).x));
    onMode?.('orbit');
  }
  function spawnPoint() {
    if (!model?.rooms.length) return { x: 0, y: 0 };
    // start in the biggest room, facing its longest open direction
    const r = [...model.rooms].sort((a, b) => (b.area || 0) - (a.area || 0))[0];
    // face the longest clear sightline from the room centre (into the house, not a corner)
    let best = 0, bestD = -1;
    for (let k = 0; k < 24; k++) {
      const yaw = (k / 24) * Math.PI * 2;
      const dx = -Math.sin(yaw), dy = -Math.cos(yaw);
      let d = 60;
      for (const c of colliders) {
        const hit = raySeg(r.center, { x: dx, y: dy }, c.a, c.b);
        if (hit != null && hit < d) d = hit;
      }
      if (d > bestD) { bestD = d; best = yaw; }
    }
    return { x: r.center.x, y: r.center.y, yaw: best };
  }
  function applyWalkCam() {
    camera.position.copy(walk.pos);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(walk.pitch, walk.yaw, 0);
  }
  function stepWalk(dt) {
    let f = 0, s = 0;
    const k = walk.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyA')) s -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('ArrowLeft')) walk.yaw += dt * 1.8;
    if (k.has('ArrowRight')) walk.yaw -= dt * 1.8;
    f += -walk.joy.y; s += walk.joy.x;
    const mag = Math.hypot(f, s);
    if (mag > 0) {
      const sp = (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN : WALK) * dt / Math.max(1, mag);
      const fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw);
      const rx = Math.cos(walk.yaw), rz = -Math.sin(walk.yaw);
      walk.pos.x += (fx * f + rx * s) * sp;
      walk.pos.z += (fz * f + rz * s) * sp;
      collide(walk.pos);
    }
    applyWalkCam();
    placeLights(walk.pos.x, walk.pos.z, false);
    const here = roomAt({ x: walk.pos.x, y: walk.pos.z });
    if ((here?.id || null) !== walk.lastRoom) { walk.lastRoom = here?.id || null; onRoom?.(here?.name || null); }
  }
  function collide(p) {
    for (let it = 0; it < 3; it++) {
      for (const c of colliders) {
        const q = closest({ x: p.x, y: p.z }, c.a, c.b);
        const d = Math.hypot(p.x - q.x, p.z - q.y), min = c.r + RADIUS;
        if (d < min && d > 1e-6) { const k = (min - d) / d; p.x += (p.x - q.x) * k; p.z += (p.z - q.y) * k; }
      }
    }
  }
  function roomAt(p) {
    for (const r of roomsForPick) if (inPoly(p, r.poly) && !(r.holes || []).some((h) => inPoly(p, h))) return r;
    return null;
  }

  // input
  const onKeyDown = (e) => {
    if (mode !== 'walk' || /input|select|textarea/i.test(e.target.tagName)) return;
    walk.keys.add(e.code);
    if (e.code === 'Escape' && document.pointerLockElement !== canvas) stopWalk();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e) => walk.keys.delete(e.code);
  const onMouseMove = (e) => {
    if (mode !== 'walk' || document.pointerLockElement !== canvas) return;
    walk.yaw -= e.movementX * 0.0022;
    walk.pitch = Math.max(-1.35, Math.min(1.35, walk.pitch - e.movementY * 0.0022));
  };
  // touch / drag-look when not pointer-locked
  let drag = null;
  const onPointerDown = (e) => {
    drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
  };
  const onPointerMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (mode === 'walk' && document.pointerLockElement !== canvas && drag.moved) {
      walk.yaw += (e.movementX || 0) * 0.004;
      walk.pitch = Math.max(-1.35, Math.min(1.35, walk.pitch + (e.movementY || 0) * 0.004));
    }
  };
  const onPointerUp = (e) => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    // a click: pick a surface (orbit) — in walk mode, pick at the crosshair when locked
    const r = canvas.getBoundingClientRect();
    const ndc = document.pointerLockElement === canvas ? new THREE.Vector2(0, 0)
      : new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      onPick?.({ roomId: hit.object.userData.roomId, surface: hit.object.userData.surface });
    } else if (mode === 'walk' && document.pointerLockElement !== canvas && !('ontouchstart' in window)) {
      canvas.requestPointerLock?.();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // ---------------------------------------------------------------- loop
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  }
  resize();
  let raf = 0, last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (mode === 'walk') stepWalk(dt); else orbit.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    update: build,
    resize,
    walk: (at) => startWalk(at),
    orbit: () => stopWalk(),
    get mode() { return mode; },
    setCeilings(v) { showCeil = v; ceilings.visible = v || mode === 'walk'; for (const l of pool) l.visible = v || mode === 'walk'; },
    setJoystick(x, y) { walk.joy.x = x; walk.joy.y = y; },
    lock() { canvas.requestPointerLock?.(); },
    /** Put the walker at plan (x, y) feet facing yaw (radians, 0 = plan north). */
    pose(x, y, yaw = walk.yaw, pitch = 0) { if (mode !== 'walk') startWalk({ x, y, yaw }); walk.pos.set(x, EYE, y); walk.yaw = yaw; walk.pitch = pitch; applyWalkCam(); placeLights(x, y, true); },
    orbitTo(x, y, z, tx, ty, tz) { camera.position.set(x, y, z); orbit.target.set(tx, ty, tz); orbit.update(); },
    snapshot() { renderer.render(scene, camera); return canvas.toDataURL('image/jpeg', 0.9); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      orbit.dispose();
      clear();
      for (const mm of mats.values()) mm.dispose();
      envTex.dispose(); pmrem.dispose();
      ground.geometry.dispose();
      renderer.dispose();
    },
  };
}

// ------------------------------------------------------------------ helpers
function shapeOf(poly, holes = []) {
  const sh = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.y)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, -p.y))));
  return sh;
}
function scaleUV(g, w, h, y0) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h + y0);
  uv.needsUpdate = true;
}
function cross2(a, b) { return a.x * b.y - a.y * b.x; }
function raySeg(o, d, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den;
  const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den;
  return t > 0.1 && u >= 0 && u <= 1 ? t : null;
}
function closest(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return { x: a.x + dx * t, y: a.y + dy * t };
}
function inPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function insideAnyRoom(p, rooms) { return rooms.some((r) => inPoly(p, r.poly)); }
function alongOpening(m, ux, uy, openings) {
  for (const o of openings) {
    const dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    if (Math.abs(dx / L * uy - dy / L * ux) > 0.05) continue; // not parallel
    const q = closest(m, o.a, o.b);
    if (Math.hypot(q.x - m.x, q.y - m.y) <= (o.t || 0.4) / 2 + 0.08) {
      const t = ((m.x - o.a.x) * dx + (m.y - o.a.y) * dy) / (L * L);
      if (t > 0.02 && t < 0.98) return true;
    }
  }
  return false;
}
