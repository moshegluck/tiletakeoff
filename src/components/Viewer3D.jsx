import { useRef, useEffect } from 'react';
import { useStore } from '../state/store.js';

// Lazy-loads the Three.js scene so the 2D core stays light.
export default function Viewer3D() {
  const cvRef = useRef(null);
  const wrapRef = useRef(null);
  const sceneRef = useRef(null);
  const rooms = useStore((s) => s.rooms);
  const materials = useStore((s) => s.materials);
  const planImage = useStore((s) => s.planImage);
  const planWidth = useStore((s) => s.planWidth);
  const planHeight = useStore((s) => s.planHeight);
  const scale = useStore((s) => s.scale);

  const proj = () => {
    const st = useStore.getState();
    return { rooms: st.rooms, materials: st.materials, planImage: st.planImage, planWidth: st.planWidth, planHeight: st.planHeight, scale: st.scale };
  };

  useEffect(() => {
    let alive = true;
    import('../three/scene3d.js').then(({ createScene }) => {
      if (!alive || !cvRef.current) return;
      sceneRef.current = createScene(cvRef.current, proj());
      const ro = new ResizeObserver(() => sceneRef.current?.resize());
      ro.observe(wrapRef.current);
      sceneRef.current._ro = ro;
    });
    return () => { alive = false; sceneRef.current?._ro?.disconnect(); sceneRef.current?.dispose(); };
  }, []);

  useEffect(() => {
    sceneRef.current?.update(proj());
  }, [rooms, materials, planImage, planWidth, planHeight, scale]);

  const empty = !rooms.length;
  return (
    <div className="stage" ref={wrapRef}>
      <canvas ref={cvRef} style={{ width: '100%', height: '100%' }} />
      <div className="hud">
        <span className="chip">drag rotate · wheel zoom · right-drag pan</span>
        {empty && <span className="chip warn">{planImage ? 'plan preview — draw rooms for walls & tile' : 'draw rooms or load a plan to build the model'}</span>}
      </div>
    </div>
  );
}
