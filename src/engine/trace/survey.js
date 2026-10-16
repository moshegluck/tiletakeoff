// ============================================================
// survey.js — what the trace read off the sheet, in words: the drawing's
// conventions (which pen draws walls, what was set aside as dimensions,
// furniture, hidden lines), its wall types, its doors and windows, what
// kind of building it is, and how the result checks against the sheet's own
// numbers. Shown in the Trace panel so the estimator can see what the
// engine believed before trusting a single number. Pure.
// ============================================================

const IN = 1 / 12;
const fmtIn = (ft) => `${+(ft * 12).toFixed(1)}"`;

/**
 * @param {object} input  the runTrace input (feet)
 * @param {object} res    the chosen reading's result
 */
export function describeSheet(input, res) {
  const st = res.stats || {};
  const texts = input.texts || [];
  const arcs = input.arcs || [];
  const notes = [];
  const words = texts.map((t) => String(t.str || '').toUpperCase());
  const has = (re) => words.some((w) => re.test(w));

  // ---- the building ----
  const units = new Set(words.filter((w) => /\bUNIT\s+[A-Z0-9]/.test(w)).map((w) => w.match(/\bUNIT\s+([A-Z0-9-]+)/)[1])).size;
  const commercial = words.filter((w) => /\b(OFFICE|LOUNGE|FITNESS|STORAGE|LOBBY|RETAIL|MEETING|CORRIDOR|ELEC|MECH)/.test(w)).length;
  const building = units >= 2 ? (commercial >= 4 ? 'multifamily with amenity / commercial space' : 'multifamily')
    : commercial >= 6 ? 'commercial' : 'residential';
  const existing = st.thickBodies > 0 || has(/\bEXISTING\b/);
  notes.push(`Building: ${building}${units >= 2 ? ` (${units} unit types named)` : ''}${existing ? ', existing structure with new work' : ''}.`);
  if (has(/\bDEMOLISHED\b|\bDEMO\b/) && has(/\bNEW CONSTRUCTION\b|\bNEW\b/)) notes.push('Phase legend on the sheet: existing / demolished / new construction.');

  // ---- how it's drawn ----
  if (input.layered) notes.push('CAD layers name the walls, doors, windows and room labels — walls come from the wall layers only.');
  if (st.heavyW > 0) notes.push(`Drawn with pen weights: walls from the heavy pen; hairline pairs (furniture, fixtures, casework) are not walls.`);
  if (st.annotationLines) notes.push(`${st.annotationLines} line(s) in an annotation colour (dimension strings, grids, tags) set aside.`);
  if (st.dashedLines) notes.push(`${st.dashedLines} dashed line(s) (hidden, overhead or demolished) — never a wall on their own${st.thickBodies ? ', only the hidden outer face of a thick wall' : ''}.`);
  if (st.hatchLines) notes.push(`${st.hatchLines} evenly spaced line(s) read as hatch / tile / stair treads.`);

  // ---- wall types ----
  const types = (st.peaks || []).filter((t) => t >= 2.5).slice(0, 5).map((t) => `${t}"`);
  if (types.length) notes.push(`Wall thicknesses on the sheet: ${types.join(', ')}${st.thickBodies ? `; ${st.thickBodies} piece(s) of thick masonry (16"–36")` : ''}.`);

  // ---- doors & windows ----
  const poly = arcs.filter((a) => a.src === 'polyline').length;
  if (arcs.length) notes.push(`${arcs.length} door swing(s)${poly ? ` (${poly} drawn as straight pieces)` : ''}; ${res.totals?.doors ?? 0} door(s) placed${res.totals?.windows ? `, ${res.totals.windows} window(s)` : ''}.`);
  if (res.calibration?.msg) notes.push(res.calibration.msg);

  // ---- the plan checks the trace ----
  const v = res.verify;
  if (v?.tags) {
    notes.push(`Plan check: ${v.matched} of ${v.tags} printed room areas agree with the trace${v.off ? `; ${v.off} don't (flagged with both numbers)` : ''}${v.unplaced ? `; ${v.unplaced} tag(s) in no traced room` : ''}.`);
  } else {
    notes.push('No printed room areas on this sheet to check against — check the rooms against the drawing.');
  }

  // ---- which reading ----
  const rd = (res.readings || []);
  const won = rd.find((r) => r.chosen);
  if (rd.length > 1 && won) {
    notes.push(won.id === 'default'
      ? `Also tried: ${rd.filter((r) => !r.chosen).map((r) => r.label).join('; ')} — the drawing as read agreed best with the sheet.`
      : `Read as: ${won.label} — it agreed with the sheet better than the default reading.`);
  }
  return { building, existing, units, notes };
}

export { IN, fmtIn };
