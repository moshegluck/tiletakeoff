// ============================================================
// markups.js — measurement markups (Bluebeam-style).
// A markup is a measurement placed on the plan with an optional
// unit cost. Types:
//   length  — polyline, measured in linear feet
//   area    — polygon, measured in square feet
//   rect    — rectangle, measured in square feet (w×h shown too)
//   count   — point markers, measured as a count
// Geometry stored in canonical feet (same as rooms). Cost = value ×
// unitCost. The markups list summarizes by type and by subject (name).
// ============================================================

import { polygonArea, polygonPerimeter } from './geometry.js';

export const MARKUP_TYPES = {
  length: { id: 'length', label: 'Length', unit: 'lf', icon: 'M3 12h18' },
  area:   { id: 'area',   label: 'Area',   unit: 'sf', icon: 'M4 4h16v16H4z' },
  rect:   { id: 'rect',   label: 'Rectangle area', unit: 'sf', icon: 'M4 6h16v12H4z' },
  count:  { id: 'count',  label: 'Count',  unit: 'ea', icon: 'M12 5v14M5 12h14' },
};

// measured value in the markup's native unit
/**
 * Measured value in the markup's native unit (lf/sf/ea).
 * @param {import('./types.js').Markup} mk
 * @returns {number}
 */
export function markupValue(mk) {
  switch (mk.type) {
    case 'length': return polylineLength(mk.points);
    case 'area':   return mk.points?.length >= 3 ? polygonArea(mk.points) : 0;
    case 'rect': {
      if (!mk.points || mk.points.length < 2) return 0;
      const [a, b] = mk.points;
      return Math.abs(b.x - a.x) * Math.abs(b.y - a.y);
    }
    case 'count':  return mk.points?.length || 0;
    default: return 0;
  }
}

export function markupDims(mk) {
  if (mk.type === 'rect' && mk.points?.length >= 2) {
    const [a, b] = mk.points;
    return { w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  return null;
}

function polylineLength(pts) {
  if (!pts || pts.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

export function markupUnit(mk) { return MARKUP_TYPES[mk.type]?.unit || ''; }

export function markupCost(mk) {
  return markupValue(mk) * (mk.unitCost || 0);
}

// summarize markups for the list: subtotal by type + grand total cost
/**
 * Group markups by type and total their cost.
 * @param {import('./types.js').Markup[]} markups
 */
export function summarizeMarkups(markups) {
  const byType = {};
  let totalCost = 0;
  for (const mk of markups) {
    const t = mk.type;
    if (!byType[t]) byType[t] = { type: t, unit: markupUnit(mk), value: 0, cost: 0, count: 0 };
    byType[t].value += markupValue(mk);
    byType[t].cost += markupCost(mk);
    byType[t].count += 1;
    totalCost += markupCost(mk);
  }
  return { byType: Object.values(byType), totalCost };
}
