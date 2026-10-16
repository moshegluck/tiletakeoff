// ============================================================
// patterns.js — how a tile is laid in each room.
//
// A material carries its pattern (the way that tile is usually laid). A
// room uses its tile's pattern unless the room says otherwise
// (room.layout.pattern), so changing the tile's pattern changes every room
// that hasn't been set its own. Waste follows the pattern each room actually
// uses. Pure; no DOM.
// ============================================================

import { PATTERNS } from './layouts.js';
import { WASTE_BY_PATTERN } from '../data/tileCatalog.js';

export const patternLabel = (id) => PATTERNS.find((p) => p.id === id)?.label || 'Straight (grid)';

/**
 * The pattern a room lays a material in.
 * @param {{layout?: {pattern?: string}} | null} room
 * @param {{pattern?: string} | null} material
 */
export function roomPattern(room, material) {
  return room?.layout?.pattern || material?.pattern || 'grid';
}

/**
 * Waste % for laying a material in a pattern: the material's own waste for
 * its own pattern (the estimator may have tuned it), else the rule of thumb
 * for the pattern used.
 * @param {{waste?: number, pattern?: string, type?: string}} material
 * @param {string} [pattern]
 */
export function wasteFor(material, pattern) {
  const base = material.waste ?? 0;
  if (!pattern || material.type === 'wall' || pattern === 'border' || pattern === (material.pattern || 'grid')) return base;
  return WASTE_BY_PATTERN[pattern] ?? base;
}

/**
 * Projects saved before rooms inherited their tile's pattern gave every room
 * an explicit straight grid, which silently overrode the tile's pattern.
 * Drop that default (straight, unrotated, at the origin) so the room follows
 * its tile again. Rooms with a real choice (another pattern, an angle or a
 * moved origin) keep it.
 * @param {any[]} rooms
 */
export function migrateRoomLayouts(rooms) {
  return (rooms || []).map((r) => {
    const l = r.layout;
    if (!l || l.pattern !== 'grid' || (l.angleDeg || 0) !== 0 || (l.origin && (l.origin.x || l.origin.y))) return r;
    const { pattern: _p, ...rest } = l;
    return { ...r, layout: rest };
  });
}
