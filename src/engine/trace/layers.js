// ============================================================
// layers.js — what a CAD layer holds, from its name.
//
// AutoCAD / Revit PDFs keep the drawing's layers ("A-WALL", "A-DOOR",
// "T - DIMS INTERIOR", "A - FURNITURE", …). When a sheet has them, the
// architect has already said which lines are walls — far better evidence
// than guessing from geometry, where a dimension line, a beam overhead or
// a title-block box can pass for a wall face. Pure; no DOM.
// ============================================================

/** @typedef {'wall'|'opening'|'roomLabel'|'ignore'|'other'} LayerKind */

const norm = (name) => ` ${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

// checked in this order: a demolition wall is not a wall; "WALL LEGEND" text is not a wall
/** @type {[LayerKind, RegExp][]} */
const RULES = [
  // being removed, or not on this floor: never a wall
  ['ignore', /\b(demo|demol\w*|remove\w*|exist\w* to be removed)\b/],
  ['ignore', /\b(above|abv|ovhd|overhead|hidden|beam\w*|joist\w*|header|lintel|soffit|roof\w*|ceil\w*|clg|rcp)\b/],
  // room-name text: "T - ROOM LABEL", "A-AREA-IDEN" (AIA), "A-ANNO-RMNM", "ROOM TAGS"
  ['roomLabel', /\b(room|rm|space)\b.*\b(labels?|names?|tags?|iden\w*|text|txt)\b|\b(area ?iden\w*|area ?names?|rmnm|rm ?names?)\b/],
  ['opening', /\b(doors?|dr|drs|glaz\w*|windows?|wind|wndw|win|openings?|storefront|curtain ?wall)\b/],
  ['ignore', /\b(dim\w*|text|txt|anno\w*|notes?|keynotes?|titles?|tblk|t ?block|frame|border|sheet|revis\w*|leaders?|multileaders?|labels?|tags?|symbols?|symb|section|sect|elev\w*|details?|grid\w*|hatch\w*|patt\w*|poch\w*|viewports?|vports?|defpoints|furn\w*|fixt\w*|equip\w*|casework|built ?ins?|millwork|cabinet\w*|appl\w*|plumb\w*|plmb|elec\w*|wiring|lighting|light\w*|mech\w*|hvac|struc\w*|stairs?|strs|deck\w*|rail\w*|site|topo\w*|landsc\w*|areas?)\b/],
  ['wall', /\b(walls?|wall\w*|partitions?|prtn|ptn|foundation ?walls?|fdn ?walls?)\b/],
];

/**
 * @param {string|null|undefined} name  CAD layer name
 * @returns {LayerKind}
 */
export function classifyLayer(name) {
  if (name == null || name === '') return 'other';
  const n = norm(name);
  for (const [kind, re] of RULES) if (re.test(n)) return kind;
  return 'other';
}

/**
 * Does this sheet's layering name its walls? Only then are layers trusted to
 * leave lines out: a sheet drawn all on layer "0" keeps every line.
 * @param {{ layer?: string|null }[]} lines
 * @returns {boolean}
 */
export function hasWallLayers(lines) {
  let wall = 0;
  for (const l of lines) if (l.layer != null && classifyLayer(l.layer) === 'wall') wall++;
  return wall >= 40;
}

/**
 * The lines that can be wall faces: on a layered sheet, those on wall layers
 * and on layers we can't name (a wall drawn on an odd layer still counts);
 * never dimensions, text, furniture, doors / windows, things overhead or
 * demolished walls. A sheet without wall layers keeps everything.
 * @template {{ layer?: string|null }} L
 * @param {L[]} lines
 * @returns {L[]}
 */
export function wallCandidates(lines) {
  if (!hasWallLayers(lines)) return lines;
  return lines.filter((l) => {
    const k = classifyLayer(l.layer);
    return k === 'wall' || k === 'other';
  });
}

/**
 * Sheet text that can name a room: never the title block, dimensions, detail
 * callouts or sections. When the sheet has a room-label layer, only its text
 * names rooms (notes and leaders inside a room don't).
 * @template {{ layer?: string|null }} T
 * @param {T[]} texts
 * @returns {T[]}
 */
export function labelCandidates(texts) {
  const layered = texts.some((t) => t.layer != null);
  if (!layered) return texts;
  if (texts.some((t) => classifyLayer(t.layer) === 'roomLabel')) {
    return texts.filter((t) => classifyLayer(t.layer) === 'roomLabel');
  }
  return texts.filter((t) => !/\b(titles?|tblk|t ?block|frame|border|sheet|revis\w*|dim\w*|section|sect|elev\w*|details?|keynotes?|symbols?|wiring)\b/.test(norm(t.layer)));
}
