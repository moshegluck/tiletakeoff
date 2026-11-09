// ============================================================
// labelPrompt.js — what Claude is told when it labels a trace
// (`/api/detect-plan` mode 'labels', and scripts/ai-labels.mjs, so the
// benchmark asks exactly what the app asks). Claude answers per number;
// it never gives coordinates. src/engine/trace/labels.js builds the numbers
// and applies the answers.
// ============================================================

export const LABELS_SYSTEM = `You check a flooring takeoff that was rebuilt from an architectural floor plan's own line data.

The image is part of the floor plan with numbered marks drawn over it. Every mark comes from the drawing's lines; none is a guess:
- R1, R2, … (purple tag): a traced room, the tag at its centre.
- W1, W2, … (red line, red tag): a wall the trace built.
- G1, G2, … (green dashed line, green tag): a gap the walls leave. The trace has nothing across it, so the floor runs straight through.
- O1, O2, … (thick bar, tag above it): a gap the trace bridged — blue = door, orange = opening with no door, teal = window.

Answer for the numbers, using only what is drawn under them:
- W: "wall" — a real wall or partition; "not_wall" — anything else the trace took for one (stair treads or a stair's edge, a handrail, a counter, cabinets, a tub or shower edge, furniture, a dimension, break or grid line, hatch, a line of another drawing on the sheet).
- G: "separate" — something should close it: a door, a cased opening, a window, or the line where one room's floor ends and the next room's begins (jambs, a threshold, a header or dashed line drawn across, a different room on each side); "open" — the same floor carries on through it (an open plan with nothing drawn across, a hall continuing).
- O: "door", "opening", "window", or "solid" when the drawing has an unbroken wall there.
- R: the room's name as printed in that space; if none is printed, the most likely name from what is drawn (toilet / tub → BATH, rod / shelf → CLOSET). Type is one of: bath, closet, kitchen, laundry, bedroom, living, dining, hall, garage, outdoor, mech, room.

List every R. For W, G and O list only the numbers you can see clearly, and give a short "why" naming what the drawing shows. Never invent numbers and never give coordinates.`;

const TYPES = ['bath', 'closet', 'kitchen', 'laundry', 'bedroom', 'living', 'dining', 'hall', 'garage', 'outdoor', 'mech', 'room'];
const item = (labels) => ({
  type: 'object', additionalProperties: false, required: ['tag', 'is', 'why'],
  properties: { tag: { type: 'string' }, is: { type: 'string', enum: labels }, why: { type: 'string' } },
});

export const LABELS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rooms', 'walls', 'gaps', 'openings'],
  properties: {
    rooms: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['tag', 'name', 'type'],
        properties: { tag: { type: 'string' }, name: { type: 'string' }, type: { type: 'string', enum: TYPES } },
      },
    },
    walls: { type: 'array', items: item(['wall', 'not_wall']) },
    gaps: { type: 'array', items: item(['separate', 'open']) },
    openings: { type: 'array', items: item(['door', 'opening', 'window', 'solid']) },
  },
};

/** The list of numbers sent with the image (tag + what the trace says it is, px on the image). */
export function labelsText(W, H, tags) {
  const r = (v) => Math.round(v);
  return [
    `This image is ${W} × ${H} pixels.`,
    `Rooms (tag, traced name, centre px, SF): ${JSON.stringify(tags.rooms.map((x) => [x.tag, x.name || '', r(x.x), r(x.y), Math.round(x.area || 0)]))}`,
    `Walls (tag, middle px): ${JSON.stringify(tags.walls.map((x) => [x.tag, r(x.x), r(x.y)]))}`,
    `Gaps (tag, middle px, width ft): ${JSON.stringify(tags.gaps.map((x) => [x.tag, r(x.x), r(x.y), +(x.width || 0).toFixed(1)]))}`,
    `Bridged gaps (tag, as traced, middle px, width ft): ${JSON.stringify(tags.openings.map((x) => [x.tag, x.type, r(x.x), r(x.y), +(x.width || 0).toFixed(1)]))}`,
  ].join('\n');
}

/** Keep only answers about numbers that were asked, in the shapes the engine takes. */
export function cleanLabels(parsed, tags) {
  const has = (list) => new Set(list.map((x) => x.tag));
  const R = has(tags.rooms), W = has(tags.walls), G = has(tags.gaps), O = has(tags.openings);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const why = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const pick = (list, set, ok) => arr(list).filter((x) => x && set.has(String(x.tag)) && ok.includes(x.is)).map((x) => ({ tag: String(x.tag), is: x.is, why: why(x.why) }));
  return {
    rooms: arr(parsed?.rooms).filter((x) => x && R.has(String(x.tag))).map((x) => ({ tag: String(x.tag), name: String(x.name || '').replace(/\s+/g, ' ').trim().slice(0, 40), type: TYPES.includes(x.type) ? x.type : 'room' })),
    walls: pick(parsed?.walls, W, ['wall', 'not_wall']),
    gaps: pick(parsed?.gaps, G, ['separate', 'open']),
    openings: pick(parsed?.openings, O, ['door', 'opening', 'window', 'solid']),
  };
}
