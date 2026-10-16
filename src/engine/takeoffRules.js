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
export const TUB_RUN_LF = 10;     // a standard 5x2.5 tub's wall run: back + both ends

/** Round up to whole SF (floating noise never adds a foot). */
export const roundUp = (x) => Math.max(0, Math.ceil(x - 1e-6));
const n1 = (x) => String(+x.toFixed(2));

const count = (v) => Math.max(0, Math.floor(+v || 0));

/**
 * A room's fixtures: tubs, showers, (for rooms with no traced doors) door
 * count, niches (1 per tub and per shower unless set), shower seats, and
 * windows as W x H when given (the cut is priced with its size, and its
 * perimeter is the window's miter).
 * @param {object} r room
 * @returns {{ tubs:number, showers:{w:number,d:number}[], doors:number, niches:number, nichesSet:boolean, seats:number, windows:{w:number,h:number}[] }}
 */
export function roomFixtures(r) {
  const f = r.fixtures || {};
  const showers = (Array.isArray(f.showers) ? f.showers : [])
    .filter((s) => s && +s.w > 0 && +s.d > 0).map((s) => ({ w: +s.w, d: +s.d }));
  const windows = (Array.isArray(f.windows) ? f.windows : [])
    .filter((s) => s && +s.w > 0 && +s.h > 0).map((s) => ({ w: +s.w, h: +s.h }));
  const tubs = count(f.tubs);
  const nichesSet = f.niches != null && f.niches !== '';
  return {
    tubs, showers, doors: count(f.doors), windows, seats: count(f.seats),
    niches: nichesSet ? count(f.niches) : tubs + showers.length, nichesSet,
  };
}

/**
 * The windows in a room's walls: the sizes given on the room (W x H), else
 * the windows the trace found (width only).
 * @returns {{ w:number, h:number|null }[]}
 */
export function roomWindows(r) {
  const fx = roomFixtures(r);
  if (fx.windows.length) return fx.windows;
  return (r.openings || []).filter((o) => o.type === 'window').map((o) => ({ w: o.width || 0, h: null }));
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

/** Windows as Moshe notes them, W x H: "5.75x6.25, 6x7.25". */
export const parseWindows = (text) => parseShowers(text).map((s) => ({ w: s.w, h: s.d }));
export const windowsText = (wins) => wins.map((s) => `${n1(s.w)}x${s.h ? n1(s.h) : '?'}`).join(', ');

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
  const windows = roomWindows(r);
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

/**
 * The wall run a room's showers and tubs take (the "wet walls"): a shower's
 * back wall and both depths (W + 2·D — the entry side is glass), 10 LF a tub.
 */
export function wetRun(r) {
  const fx = roomFixtures(r);
  const lf = fx.showers.reduce((a, s) => a + s.w + 2 * s.d, 0) + fx.tubs * TUB_RUN_LF;
  const parts = [...fx.showers.map((s) => `${n1(s.w)} + 2×${n1(s.d)}`), ...(fx.tubs ? [`${fx.tubs * TUB_RUN_LF} (tub${fx.tubs > 1 ? ` ×${fx.tubs}` : ''})`] : [])];
  return { lf, text: parts.join(' + '), shower: fx.showers.length > 0, tub: fx.tubs > 0 };
}

/**
 * The wall tile lines of a room (Willow Tree #41765). One wall tile covers
 * the whole wall. A second wall tile in a room with a shower or tub is the
 * shower / tub walls' tile (`finish.wetWallMaterialId`, else the second one
 * picked): it covers the wet run × the tiled height; the rest of the walls
 * carry the doors and the 10 SF tub deduction. Each line carries its
 * arithmetic. More wall tiles than that each list the whole wall, marked
 * `overlap` — nothing says how they share it.
 * @param {object} r room
 * @param {string[]} wallIds the room's wall tile materials, in the order picked
 * @param {number} [height] tiled height
 * @returns {{ materialId:string, part:'all'|'wet'|'rest', label:string, sf:number, text:string, overlap?:boolean }[]}
 */
export function wallParts(r, wallIds, height = wallTileHeight(r)) {
  const ids = [...new Set((wallIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const whole = wallTakeoff(r, height);
  const wet = wetRun(r);
  if (ids.length !== 2 || !(wet.lf > 0)) {
    return ids.map((id) => ({ materialId: id, part: 'all', label: 'Walls', sf: whole.sf, text: whole.text, overlap: ids.length > 1 }));
  }
  const wetId = ids.includes(r.finish?.wetWallMaterialId) ? r.finish.wetWallMaterialId : ids[1];
  const restId = ids.find((id) => id !== wetId);
  const h = whole.height;
  const wetLf = Math.min(wet.lf, whole.lf);
  const wetGross = wetLf * h;
  const restLf = whole.lf - wetLf;
  const restGross = restLf * h;
  const ded = whole.doors.reduce((a, d) => a + d.sf, 0) + whole.tub;
  const restNet = Math.max(0, restGross - ded);
  const dedText = [
    ...whole.doors.map((d) => `− ${n1(d.sf)} (${d.wide ? `${n1(d.width)}' opening` : 'door'})`),
    ...(whole.tub ? [`− ${whole.tub} (tub)`] : []),
  ];
  const label = wet.shower && wet.tub ? 'Shower & tub walls' : wet.shower ? 'Shower walls' : 'Tub walls';
  return [
    { materialId: wetId, part: 'wet', label, sf: roundUp(wetGross), text: `${wet.text} = ${n1(wetLf)} LF × ${n1(h)}' = ${n1(wetGross)} → ${roundUp(wetGross)} SF` },
    {
      materialId: restId, part: 'rest', label: 'Rest of walls', sf: roundUp(restNet),
      text: `(${n1(whole.lf)} − ${n1(wetLf)}) LF × ${n1(h)}' = ${n1(restGross)}${dedText.length ? ' ' + dedText.join(' ') : ''} = ${n1(restNet)} → ${roundUp(restNet)} SF`,
    },
  ];
}

