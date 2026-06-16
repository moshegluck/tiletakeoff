import React, { useRef, useEffect } from 'react';
import { useStore } from '../state/store.js';

// Lazy-loads the Three.js scene so the 2D core stays light.
export default function Viewer3D() {
  const cvRef = useRef(null);
  const wrapRef = useRef(null);
  const sceneRef = useRef(null);
  const rooms = useStore((s) => s.rooms);
  const materials = useStore((s) => s.materials);

  useEffect(() => {
    let alive = true;
    import('../three/scene3d.js').then(({ createScene }) => {
      if (!alive || !cvRef.current) return;
      const proj = { rooms: useStore.getState().rooms, materials: useStore.getState().materials };
      sceneRef.current = createScene(cvRef.current, proj);
      const ro = new ResizeObserver(() => sceneRef.current?.resize());
      ro.observe(wrapRef.current);
      sceneRef.current._ro = ro;
    });
    return () => { alive = false; sceneRef.current?._ro?.disconnect(); sceneRef.current?.dispose(); };
  }, []);

  useEffect(() => {
    sceneRef.current?.update({ rooms, materials });
  }, [rooms, materials]);

  return (
    <div className="stage" ref={wrapRef}>
      <canvas ref={cvRef} style={{ width: '100%', height: '100%' }} />
      <div className="hud">
        <span className="chip">drag rotate · wheel zoom · right-drag pan</span>
      </div>
    </div>
  );
}
