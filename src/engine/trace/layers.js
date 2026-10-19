// ============================================================
// layers.js — what a CAD layer holds, from its name.
//
// AutoCAD / Revit PDFs keep the drawing's layers ("A-WALL", "A-DOOR",
// "T - DIMS INTERIOR", "A - FURNITURE", …). When a sheet has them, the
// architect has already said which lines are walls — far better evidence
// than guessing from geometry, where a dimension line, a beam overhead or
// a title-block box can pass for a wall face. Pure; no DOM.
// ============================================================

/**
 * door / window: the architect's door or window drawing; opening: a layer
 * holding both (A - DOORS_WINDOWS)
 * @typedef {'wall'|'door'|'window'|'opening'|'roomLabel'|'ignore'|'other'} LayerKind
 */

// letters in any script: a drafter in Moscow or Montreal names layers in their language
const norm = (name) => ` ${String(name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

// checked in this order: a demolition wall is not a wall; "WALL LEGEND" text is not a wall
/** @type {[LayerKind, RegExp][]} */
const RULES = [
  // being removed, or not on this floor: never a wall
  ['ignore', /\b(demo|demol\w*|remove\w*|exist\w* to be removed)\b/],
  ['ignore', /\b(above|abv|ovhd|overhead|hidden|beam\w*|joist\w*|header|lintel|soffit|roof\w*|ceil\w*|clg|rcp)\b/],
  // room-name text: "T - ROOM LABEL", "A-AREA-IDEN" (AIA), "A-ANNO-RMNM", "ROOM TAGS"
  ['roomLabel', /\b(room|rm|space)\b.*\b(labels?|names?|tags?|iden\w*|text|txt)\b|\b(area ?iden\w*|area ?names?|rmnm|rm ?names?)\b/],
  // tags and labels are text, not the door / window drawn in the wall
  // (a wall-type layer holds the tags and patterns that name each wall's type)
  ['ignore', /\b(labels?|tags?|text|txt|symbols?|symb|notes?)\b|\bwall ?types?\b/],
  ['opening', /\b(doors?|drs?)\b.*(\w*windows?|glaz\w*)|(\w*windows?|glaz\w*)\b.*\bdoors?\b|\bopenings?\b/],
  ['door', /\b(\w*doors?|dr|drs|doorswings?)\b/],
  ['window', /\b(glaz\w*|\w*windows?|wind|wndw|win|sash\w*|storefront|curtain ?wall)\b/],
  // the same words in the drafter's language (Russian, French, German, Spanish, Italian, Polish)
  ['ignore', / (размер\p{L}*|текст\p{L}*|мебел\p{L}*|штрих\p{L}*|cot(e|es|ation|ations|a|as)|quote|bema(ß|ss)ung\p{L}*|wymiar\p{L}*|textes?|mobilier|mob|m(ö|oe)bel|muebles?|mobili|hachures?|schraffur\p{L}*) /u],
  ['door', / (двер\p{L}*|portes?|portas?|puertas?|t(ü|ue)r(en)?) /u],
  ['window', / (окн\p{L}*|окон\p{L}*|fen|fen(ê|e)tres?|fenster|ventanas?|finestr\p{L}*|janelas?) /u],
  ['ignore', /\b(dim\w*|text|txt|anno\w*|notes?|keynotes?|titles?|tblk|t ?block|frame|border|shbd|sheet|logo|revis\w*|leaders?|multileaders?|labels?|tags?|symbols?|symb|section|sect|elev\w*|details?|grid\w*|hatch\w*|pat|patt\w*|poch\w*|viewports?|vports?|defpoints|furn\w*|fix|fixt\w*|equip\w*|case|casework|built ?ins?|millwork|cabinet\w*|appl\w*|plumb\w*|plmb|elec\w*|wiring|lighting|light\w*|mech\w*|hvac|struc\w*|cols|columns?|stairs?|strs|flor|hral|deck\w*|rail\w*|site|topo\w*|landsc\w*|areas?|scope)\b/],
  // casework, fixtures and what's drawn on or under the floor, in plain words ("Counter", "A-KITCHEN",
  // "A-FXTR-PLUM", "A-Closet Shelves", "ADA - FLOOR SPACE", "INSULATION", "FOOTINGS"), and the sheet's
  // text, title block and seal ("DTEXT", "PRESNOTE", "TITLEBLOCK", "SIGN-SEAL", "A-North Arrow")
  ['ignore', /\b(counters?|countertops?|kitchens?|ktcn|vanit(y|ies)|fxtr\w*|fixtures?|shel(f|ves|ving)|ada|insul\w*|footings?|ftgs?|concrete|rebar|clng|junk|hid|\w*text\w*|\w*tex|\w*notes?|titleblock|seal|signatures?|north ?arrow)\b/],
  ['wall', /\b(\w*walls?|wall\w*|partitions?|prtn|ptn|foundation ?walls?|fdn ?walls?)\b/],
  ['wall', / (стен\p{L}*|murs?|muros?|w(a|ä)nde?|waende|ścian\p{L}*) /u],
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

/** A door, window or door-and-window layer: linework that marks a gap in a wall. */
export const isOpeningLayer = (k) => k === 'door' || k === 'window' || k === 'opening';

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
 * and on layers we can't name (a wall drawn on an odd layer still counts,
 * except on the default layer "0");
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
    // CAD's default layer "0" holds dimension ticks, break lines, block
    // insides — once the sheet names its wall layers, never its walls
    return k === 'wall' || (k === 'other' && !isDefaultLayer(l.layer));
  });
}

/** AutoCAD's default layer. */
export const isDefaultLayer = (name) => /^\s*0\s*$/.test(String(name ?? ''));

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
