import { useRef, useEffect, useState, useCallback } from 'react';
import { useStore } from '../state/store.js';
import { buildHouseModel } from '../three/houseModel.js';
import { FLOOR_PRESETS, WALL_TILE_PRESETS, PAINT_COLORS, TILE_HEIGHTS } from '../data/finishes.js';
import { formatArea } from '../engine/units.js';

// The house: built from the traced wall model, walkable, and designable.
export default function Viewer3D() {
  const cvRef = useRef(null);
  const wrapRef = useRef(null);
  const sceneRef = useRef(null);
  const swatchRef = useRef(null);
  const rooms = useStore((s) => s.rooms);
  const materials = useStore((s) => s.materials);
  const trace = useStore((s) => s.trace);
  const unitSystem = useStore((s) => s.unitSystem);
  const [mode, setMode] = useState('orbit');
  const [here, setHere] = useState(null);
  const [pick, setPick] = useState(null);       // { roomId, surface }
  const [ceil, setCeil] = useState(false);
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);
  const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

  useEffect(() => {
    let alive = true;
    Promise.all([import('../three/house3d.js'), import('../three/finishTextures.js')]).then(([{ createHouseScene }, tex]) => {
      if (!alive || !cvRef.current) return;
      swatchRef.current = tex.finishSwatch;
      const sc = createHouseScene(cvRef.current, {
        onPick: (p) => setPick(p),
        onRoom: (name) => setHere(name),
        onMode: (m) => setMode(m),
      });
      sceneRef.current = sc;
      if (import.meta.env.DEV) { window.__house = sc; window.__store = useStore; } // test hooks (dev only)
      sc.update(buildHouseModel(useStore.getState()));
      const ro = new ResizeObserver(() => sc.resize());
      ro.observe(wrapRef.current);
      sc._ro = ro;
      setReady(true);
      force((n) => n + 1);
    });
    return () => { alive = false; sceneRef.current?._ro?.disconnect(); sceneRef.current?.dispose(); sceneRef.current = null; };
  }, []);

  useEffect(() => {
    sceneRef.current?.update(buildHouseModel(useStore.getState()));
  }, [rooms, materials, trace]);

  const model = buildHouseModel(useStore.getState());
  const empty = !model.rooms.length;
  const room = pick ? model.rooms.find((r) => r.id === pick.roomId) : null;
  const canDesign = rooms.length > 0; // design writes to takeoff rooms

  const walkIn = useCallback(() => { setPick(null); sceneRef.current?.walk(); if (!touch) setTimeout(() => sceneRef.current?.lock(), 30); }, [touch]);

  return (
    <div className="stage h3d" ref={wrapRef}>
      <canvas ref={cvRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />

      <div className="h3d-bar">
        <div className="h3d-seg">
          <button className={mode === 'orbit' ? 'on' : ''} onClick={() => sceneRef.current?.orbit()}>Dollhouse</button>
          <button className={mode === 'walk' ? 'on' : ''} disabled={empty} onClick={walkIn}>Walk through</button>
        </div>
        {mode === 'orbit' && (
          <label className="h3d-check"><input type="checkbox" checked={ceil} onChange={(e) => { setCeil(e.target.checked); sceneRef.current?.setCeilings(e.target.checked); }} /> Ceilings</label>
        )}
        {model.fromTrace && <span className="h3d-chip">Built from the traced model · {model.rooms.length} rooms · ceiling {model.H}′</span>}
      </div>

      {mode === 'walk' && (
        <>
          <div className="h3d-cross" />
          {here && <div className="h3d-here">{here}</div>}
          <div className="h3d-help">
            {touch ? 'Drag to look · joystick to walk · tap a floor or wall to change it'
              : 'Click to look around · W A S D to walk · Shift to run · click a floor or wall to change it · Esc to release'}
          </div>
          {touch && <Joystick onChange={(x, y) => sceneRef.current?.setJoystick(x, y)} />}
        </>
      )}
      {mode === 'orbit' && !empty && !pick && (
        <div className="h3d-help">Drag to orbit · scroll to zoom · right-drag to pan · click a floor or wall to design it</div>
      )}

      {empty && ready && (
        <div className="h3d-empty">
          <b>Nothing to build yet</b>
          Trace the plan (or draw rooms) and the house appears here — walls at true thickness, doors, ceiling height, finishes.
        </div>
      )}

      {room && (
        <div className="h3d-design" onPointerDown={(e) => e.stopPropagation()}>
          <div className="h3d-dh">
            <div>
              <div className="h3d-dn">{room.name}</div>
              <div className="h3d-dm">{formatArea(room.area, unitSystem)} · {room.type}</div>
            </div>
            <button className="icon-btn" onClick={() => setPick(null)} aria-label="Close">✕</button>
          </div>
          {!canDesign && <div className="note" style={{ marginTop: 0 }}>Send the traced rooms to the takeoff first — picks here are priced in the estimate.</div>}
          <div className="h3d-tabs">
            <button className={pick.surface === 'floor' ? 'on' : ''} onClick={() => setPick({ ...pick, surface: 'floor' })}>Floor</button>
            <button className={pick.surface === 'wall' ? 'on' : ''} onClick={() => setPick({ ...pick, surface: 'wall' })}>Walls</button>
          </div>
          {pick.surface === 'floor' ? (
            <>
              <div className="h3d-sub">Now: {room.floorName}{room.floorPriced ? ' · priced' : ' · not in estimate yet'}</div>
              <div className="h3d-grid">
                {FLOOR_PRESETS.map((p) => (
                  <Swatch key={p.id} preset={p} swatch={swatchRef.current} on={room.floorName === p.name} disabled={!canDesign}
                    onClick={() => useStore.getState().applyFinish(room.id, { floorPreset: p })} />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="h3d-sub">Paint</div>
              <div className="h3d-paints">
                {PAINT_COLORS.map((c) => (
                  <button key={c.id} title={c.name} className={'h3d-paint' + (room.paintId === c.id ? ' on' : '')} style={{ background: c.color }} disabled={!canDesign}
                    onClick={() => useStore.getState().applyFinish(room.id, { paint: c.id })} />
                ))}
              </div>
              <div className="h3d-sub">Wall tile {room.wallTileName ? `· ${room.wallTileName}` : '· none'}</div>
              <div className="h3d-grid">
                {WALL_TILE_PRESETS.map((p) => (
                  <Swatch key={p.id} preset={p} swatch={swatchRef.current} on={room.wallTileName === p.name} disabled={!canDesign}
                    onClick={() => useStore.getState().applyFinish(room.id, { wallTilePreset: p })} />
                ))}
              </div>
              <div className="h3d-sub">Tile height</div>
              <div className="h3d-heights">
                {TILE_HEIGHTS.map((h) => (
                  <button key={h.label} disabled={!canDesign || (!room.wallTile && h.v !== 0)}
                    className={(room.wallTile ? (room.wallTileHeight === h.v || (h.v === null && room.wallTileHeight === null)) : h.v === 0) ? 'on' : ''}
                    onClick={() => useStore.getState().applyFinish(room.id, { wallTileHeight: h.v })}>{h.label}</button>
                ))}
              </div>
            </>
          )}
          <div className="note">Every pick is added to Materials and priced in the Estimate.</div>
        </div>
      )}
    </div>
  );
}

function Swatch({ preset, swatch, on, disabled, onClick }) {
  const url = swatch ? swatch(preset) : null;
  return (
    <button className={'h3d-sw' + (on ? ' on' : '')} disabled={disabled} onClick={onClick} title={preset.name}>
      <span className="h3d-sw-img" style={url ? { backgroundImage: `url(${url})` } : { background: preset.color }} />
      <span className="h3d-sw-t">{preset.name}</span>
    </button>
  );
}

function Joystick({ onChange }) {
  const ref = useRef(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const id = useRef(null);
  const R = 46;
  const move = (e) => {
    const r = ref.current.getBoundingClientRect();
    let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(x, y); if (d > R) { x *= R / d; y *= R / d; }
    setKnob({ x, y }); onChange(x / R, y / R);
  };
  return (
    <div className="h3d-joy" ref={ref}
      onPointerDown={(e) => { e.stopPropagation(); id.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
      onPointerMove={(e) => { if (id.current === e.pointerId) move(e); }}
      onPointerUp={() => { id.current = null; setKnob({ x: 0, y: 0 }); onChange(0, 0); }}
      onPointerCancel={() => { id.current = null; setKnob({ x: 0, y: 0 }); onChange(0, 0); }}>
      <div className="h3d-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
