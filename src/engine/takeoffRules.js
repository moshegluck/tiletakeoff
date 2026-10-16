// ============================================================
// takeoffRules.js — Artistic Tile Installation's takeoff rules (Moshe's
// estimating practice), the arithmetic every number goes through:
//
//   floor  = room − shower footprints − 10 SF per tub
//   walls  = perimeter × tiled height
//            − 14 SF per door in a fully tiled wall (2 LF × 7'),
//              8 SF at 4'-0" (2 LF × 4'); a wide opening (double door,
//              cased opening) comes off at its own width × that height
//            − 10 SF per tub
//            windows are never deducted (they get a cut charge)
//   every quantity rounds UP to whole SF — short tile stops a crew
//
// Each result carries the arithmetic as text, so a number can be traced
// back to the plan in seconds. Pure; no DOM.
// ============================================================

import { roomArea, roomWallLf } from './geometry.js';

export const STD_DOOR_LF = 2;     // a standard door comes off as 2 LF …
export const DOOR_HEAD = 7;       // … × 7' (= 14 SF), or × the tile height below that
export const WIDE_OPENING = 4;    // wider than this (or a double door): its own width
export const TUB_SF = 10;

/** Round up to whole SF (floating noise never adds a foot). */
export const roundUp = (x) => Math.max(0, Math.ceil(x - 1e-6));
const n1 = (x) => String(+x.toFixed(2));

/**
 * A room's tubs, showers and (for rooms with no traced doors) door count.
 * @param {object} r room
 * @returns {{ tubs: number, showers: {w:number, d:number}[], doors: number }}
 */
export function roomFixtures(r) {
  const f = r.fixtures || {};
  const showers = (Array.isArray(f.showers) ? f.showers : [])
    .filter((s) => s && +s.w > 0 && +s.d > 0).map((s) => ({ w: +s.w, d: +s.d }));
  return { tubs: Math.max(0, Math.floor(+f.tubs || 0)), showers, doors: Math.max(0, Math.floor(+f.doors || 0)) };
}

/**
 * Parse Moshe's shower notation: "5x2.75", "SH 5x2.75, 4x3", "5'-0\" x 2'-9\"".
 * @returns {{w:number,d:number}[]}
 */
export function parseShowers(text) {
  const out = [];
  const ft = (s) => {
    const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(?:['’]\s*-?\s*(\d+(?:\.\d+)?)?\s*["”]?)?$/);
    if (!m) return NaN;
    return +m[1] + (m[2] ? +m[2] / 12 : 0);
  };
  for (const part of String(text || '').replace(/\bsh\b/gi, '').split(/[,;]+/)) {
    const [a, b] = part.split(/\s*[x×*]\s*/i);
    const w = ft(a), d = ft(b);
    if (w > 0 && d > 0) out.push({ w, d });
  }
  return out;
}

/** "5x2.75, 4x3" — the notation back. */
export const showersText = (showers) => showers.map((s) => `${n1(s.w)}x${n1(s.d)}`).join(', ');

/**
 * Floor takeoff of a room (or its field, when design zones take part of it).
 * @param {object} r room
 * @param {number} [area] the area the floor tile covers (defaults to the room)
 */
export function floorTakeoff(r, area = roomArea(r)) {
  const fx = roomFixtures(r);
  const shower = fx.showers.reduce((a, s) => a + s.w * s.d, 0);
  const tub = fx.tubs * TUB_SF;
  const net = Math.max(0, area - shower - tub);
  const parts = [`${n1(area)}`];
  for (const s of fx.showers) parts.push(`− ${n1(s.w * s.d)} (shower ${n1(s.w)}x${n1(s.d)})`);
  if (fx.tubs) parts.push(`− ${tub} (tub${fx.tubs > 1 ? ` ×${fx.tubs}` : ''})`);
  const sf = roundUp(net);
  return {
    area, shower, tub, net, sf,
    showers: fx.showers.map((s) => ({ ...s, sf: roundUp(s.w * s.d) })),
    text: parts.length > 1 ? `${parts.join(' ')} = ${n1(net)} → ${sf} SF` : `${n1(area)} → ${sf} SF`,
  };
}

/**
 * Wall takeoff of a room at a tiled height.
 * @param {object} r room (traced rooms carry wallLf net of their doorways and the openings)
 * @param {number} height tiled height, ft (the ceiling when fully tiled)
 */
export function wallTakeoff(r, height) {
  const fx = roomFixtures(r);
  const traced = Number.isFinite(r.wallLf);
  const ways = traced ? (r.openings || []).filter((o) => o.type !== 'window') : [];
  const windows = traced ? (r.openings || []).filter((o) => o.type === 'window') : [];
  // the whole perimeter: a traced room's wall LF has its doorways taken out — put them back
  const lf = roomWallLf(r) + ways.reduce((a, o) => a + (o.width || 0), 0);
  const h = Math.max(0, height);
  const hd = Math.min(h, DOOR_HEAD);
  const doors = ways.length
    ? ways.map((o) => {
      const wide = o.type === 'double_door' || (o.width || 0) > WIDE_OPENING;
      return { width: o.width || 0, wide, sf: (wide ? o.width : STD_DOOR_LF) * hd };
    })
    : Array.from({ length: fx.doors }, () => ({ width: STD_DOOR_LF, wide: false, sf: STD_DOOR_LF * hd }));
  const tub = fx.tubs * TUB_SF;
  const gross = lf * h;
  const net = Math.max(0, gross - doors.reduce((a, d) => a + d.sf, 0) - tub);
  const sf = roundUp(net);
  const ded = [
    ...doors.map((d) => `− ${n1(d.sf)} (${d.wide ? `${n1(d.width)}' opening` : 'door'})`),
    ...(fx.tubs ? [`− ${tub} (tub${fx.tubs > 1 ? ` ×${fx.tubs}` : ''})`] : []),
  ];
  return {
    lf, height: h, gross, doors, tub, windows: windows.length, net, sf,
    full: h >= (r.wallHeight ?? 8) - 1e-6,
    text: `${n1(lf)} LF × ${n1(h)}' = ${n1(gross)}${ded.length ? ' ' + ded.join(' ') : ''} = ${n1(net)} → ${sf} SF`
      + (windows.length ? ` · ${windows.length} window cut${windows.length > 1 ? 's' : ''} (not deducted)` : ''),
  };
}

/** The tiled height of a room's wall tile: its design pick, else the full wall (ceiling). */
export function wallTileHeight(r) {
  const th = r.finish?.wallTileHeight;
  return th == null ? (r.wallHeight ?? 8) : th;
}
