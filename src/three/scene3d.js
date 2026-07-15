// ============================================================
// scene3d.js — extrude rooms to 3D and tile the floors.
// Plain Three.js (no react-three-fiber) so it stays a lazy chunk.
// Floor area is laid with the room's assigned floor material as a
// repeating grid texture; walls extrude to wallHeight.
// Coordinates: feet. We map plan (x,y) -> world (x, z) and use y up.
// ============================================================

import * as THREE from 'three';

export function createScene(canvas, project) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xeef2f5);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xeef2f5, 60, 180);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);

  // lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.9));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(30, 50, 20); scene.add(dir);

  // ground grid
  const grid = new THREE.GridHelper(200, 200, 0xc8d4dd, 0xdde6ec);
  grid.position.y = -0.02; scene.add(grid);

  const group = new THREE.Group();
  scene.add(group);

  // Free GPU memory for everything currently in the group. three's
  // Group.clear() only detaches children from the scene graph — it does NOT
  // release their geometries/materials/textures, so rebuilding on every edit
  // (update → build) leaked VRAM without this. Called before each rebuild and
  // on teardown.
  function disposeGroup() {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
    group.clear();
  }

  // ---- build geometry from project ----
  // Rooms take priority; with none, drape the plan on the floor so 3D is useful
  // before any takeoff exists; with neither, just frame the ground grid.
  function build(proj) {
    disposeGroup();
    if (proj.rooms && proj.rooms.length) { buildRooms(proj); return; }
    if (proj.planImage && proj.planWidth && proj.planHeight) { buildPlanPlane(proj); return; }
    camera.position.set(24, 20, 24);
    controls.target.set(0, 0, 0);
  }

  // Lay the uploaded plan flat as a textured floor, sized to real feet when a
  // scale is known (else normalized to ~40 ft wide), and frame it.
  function buildPlanPlane(proj) {
    const sc = proj.scale;
    let wFt, hFt;
    if (sc && proj.planWidth && proj.planHeight) { wFt = proj.planWidth * sc; hFt = proj.planHeight * sc; }
    else { wFt = 40; hFt = 40 * (proj.planHeight / proj.planWidth); }
    const tex = new THREE.TextureLoader().load(proj.planImage);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(wFt, hFt);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    mesh.position.set(wFt / 2, 0, -hFt / 2);
    group.add(mesh);
    const span = Math.max(wFt, hFt);
    const dist = Math.max(20, span * 0.9 + 10);
    camera.position.set(wFt / 2 + dist * 0.25, dist * 0.9, -hFt / 2 + dist * 0.6);
    controls.target.set(wFt / 2, 0, -hFt / 2);
  }

  function buildRooms(proj) {
    let cx = 0, cz = 0, n = 0, span = 10;

    for (const room of proj.rooms) {
      const matId = room.assigned?.find((id) => proj.materials.find((m) => m.id === id)?.type === 'floor');
      const mat = proj.materials.find((m) => m.id === matId);
      const pts = room.points;
      const shape = new THREE.Shape();
      pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.y) : shape.lineTo(p.x, -p.y)));
      shape.closePath();

      // floor
      const floorGeo = new THREE.ShapeGeometry(shape);
      floorGeo.rotateX(-Math.PI / 2);
      const tex = makeTileTexture(mat, room.color);
      const floorMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.02 });
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.y = 0;
      group.add(floor);

      // walls (extrude perimeter)
      const h = room.wallHeight ?? 8;
      const wallColor = new THREE.Color(room.color).lerp(new THREE.Color(0xffffff), 0.55);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const wallGeo = new THREE.PlaneGeometry(len, h);
        const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.95, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
        const wall = new THREE.Mesh(wallGeo, wallMat);
        const midx = (a.x + b.x) / 2, midz = -(a.y + b.y) / 2;
        wall.position.set(midx, h / 2, midz);
        wall.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
        group.add(wall);
      }

      // accumulate center
      const bx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const bz = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      cx += bx; cz += bz; n++;
      span = Math.max(span, ...pts.map((p) => Math.hypot(p.x - bx, p.y - bz)));
    }

    if (n) { cx /= n; cz /= n; }
    const dist = Math.max(20, span * 3 + 15);
    camera.position.set(cx + dist * 0.6, dist * 0.7, -cz + dist * 0.6);
    controls.target.set(cx, 0, -cz);
  }

  // procedural tile texture (grid lines on tile color)
  function makeTileTexture(mat, fallback) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const base = mat ? '#e7ddc7' : shade(fallback, 0.7);
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    const tilesPer = mat ? Math.max(1, Math.round(12 / (mat.tw / 12) / 4)) : 4;
    g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 3;
    const step = 256 / tilesPer;
    for (let i = 0; i <= tilesPer; i++) {
      g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i * step); g.lineTo(256, i * step); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const tileFt = mat ? (mat.tw / 12) * tilesPer : 4;
    tex.repeat.set(1 / tileFt, 1 / tileFt);
    return tex;
  }
  function shade(hex, f) {
    const n = parseInt((hex || '#888888').slice(1), 16);
    const r = Math.min(255, ((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * f);
    const g = Math.min(255, ((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * f);
    const b = Math.min(255, (n & 255) + (255 - (n & 255)) * f);
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  // ---- minimal orbit controls (no extra dep) ----
  const controls = makeOrbit(camera, canvas);
  build(project);

  function resize() {
    const r = canvas.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  }
  resize();

  let raf;
  function loop() { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); }
  loop();

  return {
    resize,
    update: (proj) => build(proj),
    dispose: () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      disposeGroup();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
    },
  };
}

// Lightweight orbit controller (drag-rotate, wheel-zoom, right-drag pan)
function makeOrbit(camera, dom) {
  const target = new THREE.Vector3();
  let theta = 0.9, phi = 0.9, radius = 40;
  let dragging = null, lastX = 0, lastY = 0;

  function update() {
    radius = Math.max(4, Math.min(160, radius));
    phi = Math.max(0.15, Math.min(Math.PI / 2 - 0.02, phi));
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(target);
  }
  // initialize spherical from current camera
  function sync() {
    const o = camera.position.clone().sub(target);
    radius = o.length(); phi = Math.acos(o.y / radius); theta = Math.atan2(o.x, o.z);
  }
  const onDown = (e) => { dragging = e.button === 2 ? 'pan' : 'rot'; lastX = e.clientX; lastY = e.clientY; sync(); };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    if (dragging === 'rot') { theta -= dx * 0.01; phi -= dy * 0.01; }
    else {
      const panScale = radius * 0.0015;
      const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
      target.addScaledVector(right, -dx * panScale);
      target.y += dy * panScale;
    }
  };
  const onUp = () => { dragging = null; };
  const onWheel = (e) => { e.preventDefault(); radius *= e.deltaY > 0 ? 1.1 : 0.9; };
  const onCtx = (e) => e.preventDefault();

  dom.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  dom.addEventListener('wheel', onWheel, { passive: false });
  dom.addEventListener('contextmenu', onCtx);

  return {
    update, set target(v) { target.copy(v); },
    get target() { return target; },
    dispose() {
      dom.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onCtx);
    },
  };
}
