// ============================================================
// units.js — measurement system: parse, format, convert.
// Internal canonical unit is FEET (decimal). Everything converts
// in/out of feet. This keeps geometry math in one consistent unit
// while letting the UI present imperial, metric, or architectural.
// ============================================================

export const UNIT_SYSTEMS = {
  imperial_ft_in: { id: 'imperial_ft_in', label: "Feet & inches (12' 6\")", kind: 'imperial' },
  imperial_decft: { id: 'imperial_decft', label: 'Decimal feet (12.5 ft)', kind: 'imperial' },
  imperial_in:    { id: 'imperial_in',    label: 'Inches (150 in)',        kind: 'imperial' },
  metric_m:       { id: 'metric_m',       label: 'Meters (3.81 m)',        kind: 'metric' },
  metric_cm:      { id: 'metric_cm',      label: 'Centimeters (381 cm)',   kind: 'metric' },
  metric_mm:      { id: 'metric_mm',      label: 'Millimeters (3810 mm)',  kind: 'metric' },
};

// Drawing scales, Bluebeam-style. `feetPerPaperInch` = real feet represented by
// one inch of paper (e.g. 1/4" = 1'-0" → 4). Metric entries use
// `metersPerPaperMm`. `group` drives the dropdown's optgroups.
export const SCALE_GROUPS = [
  ['arch', 'Architectural'],
  ['eng', 'Engineering'],
  ['metric', 'Metric'],
];

export const ARCH_SCALES = [
  // Architectural (paper fraction = 1 foot)
  { id: '1/32', label: '1/32" = 1\'-0"', group: 'arch', feetPerPaperInch: 32 },
  { id: '1/16', label: '1/16" = 1\'-0"', group: 'arch', feetPerPaperInch: 16 },
  { id: '3/32', label: '3/32" = 1\'-0"', group: 'arch', feetPerPaperInch: 32 / 3 },
  { id: '1/8',  label: '1/8" = 1\'-0"',  group: 'arch', feetPerPaperInch: 8 },
  { id: '3/16', label: '3/16" = 1\'-0"', group: 'arch', feetPerPaperInch: 16 / 3 },
  { id: '1/4',  label: '1/4" = 1\'-0"',  group: 'arch', feetPerPaperInch: 4 },
  { id: '3/8',  label: '3/8" = 1\'-0"',  group: 'arch', feetPerPaperInch: 8 / 3 },
  { id: '1/2',  label: '1/2" = 1\'-0"',  group: 'arch', feetPerPaperInch: 2 },
  { id: '3/4',  label: '3/4" = 1\'-0"',  group: 'arch', feetPerPaperInch: 4 / 3 },
  { id: '1',    label: '1" = 1\'-0"',    group: 'arch', feetPerPaperInch: 1 },
  { id: '1-1/2', label: '1 1/2" = 1\'-0"', group: 'arch', feetPerPaperInch: 2 / 3 },
  { id: '3',    label: '3" = 1\'-0"',    group: 'arch', feetPerPaperInch: 1 / 3 },
  // Engineering (1 inch = N feet)
  { id: 'e10',  label: '1" = 10\'',  group: 'eng', feetPerPaperInch: 10 },
  { id: 'e20',  label: '1" = 20\'',  group: 'eng', feetPerPaperInch: 20 },
  { id: 'e30',  label: '1" = 30\'',  group: 'eng', feetPerPaperInch: 30 },
  { id: 'e40',  label: '1" = 40\'',  group: 'eng', feetPerPaperInch: 40 },
  { id: 'e50',  label: '1" = 50\'',  group: 'eng', feetPerPaperInch: 50 },
  { id: 'e60',  label: '1" = 60\'',  group: 'eng', feetPerPaperInch: 60 },
  { id: 'e80',  label: '1" = 80\'',  group: 'eng', feetPerPaperInch: 80 },
  { id: 'e100', label: '1" = 100\'', group: 'eng', feetPerPaperInch: 100 },
  { id: 'e200', label: '1" = 200\'', group: 'eng', feetPerPaperInch: 200 },
  // Metric (real meters per paper mm)
  { id: '1:20',  label: '1:20',  group: 'metric', metersPerPaperMm: 0.02 },
  { id: '1:50',  label: '1:50',  group: 'metric', metersPerPaperMm: 0.05 },
  { id: '1:100', label: '1:100', group: 'metric', metersPerPaperMm: 0.1 },
  { id: '1:200', label: '1:200', group: 'metric', metersPerPaperMm: 0.2 },
  { id: '1:500', label: '1:500', group: 'metric', metersPerPaperMm: 0.5 },
];

// Real feet represented by one inch of paper, for either an imperial
// (feetPerPaperInch) or a metric (metersPerPaperMm) architectural scale.
// Used to turn a picked scale + the plan's pixels-per-paper-inch (DPI) into
// the app's canonical `scale` (feet per model-px).
export function archFeetPerPaperInch(a) {
  if (!a) return null;
  if (a.feetPerPaperInch != null) return a.feetPerPaperInch;
  if (a.metersPerPaperMm != null) return a.metersPerPaperMm * 25.4 * 3.280839895;
  return null;
}

const FT_PER = {
  ft: 1,
  in: 1 / 12,
  m: 3.280839895,
  cm: 0.03280839895,
  mm: 0.003280839895,
};

export const toFeet = (value, unit) => value * (FT_PER[unit] ?? 1);
export const fromFeet = (feet, unit) => feet / (FT_PER[unit] ?? 1);
export const sqFtToSqM = (sf) => sf * 0.09290304;

// ---- Imperial fraction helpers -------------------------------
// Round inches to the nearest 1/denom (default 16th).
function nearestFraction(inches, denom = 16) {
  const whole = Math.floor(inches);
  let frac = Math.round((inches - whole) * denom);
  let w = whole;
  if (frac === denom) { w += 1; frac = 0; }
  // reduce fraction
  let num = frac, den = denom;
  while (num && den && num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
  return { whole: w, num, den };
}

// Format decimal feet as 12'-6 1/2"
export function fmtFtIn(feet, { denom = 16, dashless = false } = {}) {
  const neg = feet < 0; let f = Math.abs(feet);
  let ft = Math.floor(f + 1e-9);
  const inchesTotal = (f - ft) * 12;
  let { whole, num, den } = nearestFraction(inchesTotal, denom);
  // carry: if inches rounded up to a full 12, roll into the next foot
  if (whole >= 12) { ft += Math.floor(whole / 12); whole = whole % 12; }
  const sep = dashless ? ' ' : '-';
  let s = `${ft}'`;
  if (whole || num) {
    s += sep + `${whole}`;
    if (num) s += ` ${num}/${den}`;
    s += '"';
  }
  return (neg ? '-' : '') + s;
}

// ---- Public format: feet -> display string for a unit system --
export function formatLength(feet, system, opts = {}) {
  switch (system) {
    case 'imperial_ft_in': return fmtFtIn(feet, opts);
    case 'imperial_decft': return `${round(feet, 3)} ft`;
    case 'imperial_in':    return `${round(feet * 12, 2)} in`;
    case 'metric_m':       return `${round(feet * 0.3048, 3)} m`;
    case 'metric_cm':      return `${round(feet * 30.48, 1)} cm`;
    case 'metric_mm':      return `${round(feet * 304.8, 0)} mm`;
    default:               return `${round(feet, 2)} ft`;
  }
}

export function formatArea(sqft, system) {
  if (UNIT_SYSTEMS[system]?.kind === 'metric')
    return `${round(sqFtToSqM(sqft), 2)} m²`;
  return `${round(sqft, 1)} sf`;
}

// ---- Parse a user-typed string back to feet -------------------
// Accepts: 12, 12.5, 12'6", 12' 6 1/2", 12ft, 150in, 3.8m, 381cm, 3810mm
export function parseLength(input, defaultSystem = 'imperial_ft_in') {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (s === '') return null;

  // metric explicit
  let m;
  if ((m = s.match(/^(-?[\d.]+)\s*mm$/))) return toFeet(+m[1], 'mm');
  if ((m = s.match(/^(-?[\d.]+)\s*cm$/))) return toFeet(+m[1], 'cm');
  if ((m = s.match(/^(-?[\d.]+)\s*m$/)))  return toFeet(+m[1], 'm');
  if ((m = s.match(/^(-?[\d.]+)\s*(?:in|")$/))) return toFeet(+m[1], 'in');
  if ((m = s.match(/^(-?[\d.]+)\s*(?:ft|')$/))) return +m[1];

  // feet-inches:  12'6  | 12' 6 1/2" | 12'-6" | 12-6 | 12 6
  // separator after feet may be any of: ' , - , whitespace (or a combination
  // like '- which is exactly what fmtFtIn emits), so they round-trip.
  const ftIn = s.match(/^(-?\d+)\s*['’]?\s*[-\s]?\s*(\d+)?\s*(?:(\d+)\/(\d+))?\s*"?$/);
  if (ftIn && (ftIn[2] != null || ftIn[3] != null)) {
    const ft = +ftIn[1];
    const inch = ftIn[2] ? +ftIn[2] : 0;
    const frac = ftIn[3] ? +ftIn[3] / +ftIn[4] : 0;
    const sign = ft < 0 ? -1 : 1;
    return ft + sign * (inch + frac) / 12;
  }

  // bare number -> interpret per system
  const num = parseFloat(s);
  if (!isNaN(num)) {
    switch (defaultSystem) {
      case 'imperial_in': return toFeet(num, 'in');
      case 'metric_m':    return toFeet(num, 'm');
      case 'metric_cm':   return toFeet(num, 'cm');
      case 'metric_mm':   return toFeet(num, 'mm');
      default:            return num; // feet
    }
  }
  return null;
}

export const round = (n, d = 2) => {
  const p = 10 ** d;
  return Math.round((n + Number.EPSILON) * p) / p;
};

// snap a feet value to a grid increment (in feet)
export const snap = (feet, inc) => (inc > 0 ? Math.round(feet / inc) * inc : feet);
