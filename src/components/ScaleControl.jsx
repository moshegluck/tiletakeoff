import { useProject } from '../state/store.js';
import { ARCH_SCALES, SCALE_GROUPS, archFeetPerPaperInch } from '../engine/units.js';

// Scale control: pick an architectural preset (only meaningful once a PDF is
// loaded, so its pixels-per-paper-inch is known) or fall back to drawing the
// ruler along a known dimension.
export default function ScaleControl({ className = 'hud-sel', onRuler }) {
  const s = useProject();
  const hasPresets = s.planDpi > 0;
  const current = s.scale
    ? (s.archScale
        ? 'Scale ' + (ARCH_SCALES.find((a) => a.id === s.archScale)?.label || '')
        : 'Scale: custom (ruler)')
    : '⚠ Set scale…';
  const onChange = (e) => {
    const v = e.target.value;
    if (v === '__ruler') { s.setTool('ruler'); if (onRuler) onRuler(); return; }
    if (!v) return;
    const a = ARCH_SCALES.find((x) => x.id === v);
    const fpi = archFeetPerPaperInch(a);
    if (a && fpi && s.planDpi > 0) {
      s.setScale(fpi / s.planDpi);
      s.setArchScale(v);
      window.dispatchEvent(new CustomEvent('tt:toast', { detail: { msg: `Scale set · ${a.label}`, ok: true } }));
    }
  };
  return (
    <select className={className} value={s.archScale || ''} onChange={onChange}
      title={hasPresets ? 'Choose a drawing scale, or calibrate with the ruler' : 'Load a PDF for scale presets, or calibrate with the ruler'}>
      <option value="">{current}</option>
      <option value="__ruler">Custom — draw a line…</option>
      {hasPresets && SCALE_GROUPS.map(([g, label]) => (
        <optgroup key={g} label={label}>
          {ARCH_SCALES.filter((a) => a.group === g).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
