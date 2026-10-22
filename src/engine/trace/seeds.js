// ============================================================
// seeds.js — rooms the sheet tells apart where the traced walls don't.
//
// A room the plan names — or a point a reading of the plan puts in a room
// (`input.seeds`: the AI pass, a click) — is a seed: it stands in a room of
// its own. Two seeds in one closed space mean the trace joined two rooms:
// they part at the narrowest gap the walls leave between them (a doorway is
// narrower than the rooms it joins). A seed in no closed space means its
// walls leak: it is shut in at the gaps it leaks through. Each gap closed
// becomes an opening across it, flagged where it is: nothing drawn there
// says so. Where no gap parts two seeds (an open plan) nothing closes; the
// space stays one room, flagged as before.
// Pure; no DOM. Units: feet.
// ============================================================
import { gapMap } from './leaks.js';

const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

// rooms entered through a door, floored on their own: they part from any
// room they share a space with, across a doorway's width. The open rooms of
// a plan (kitchen, dining, living, hall) part from each other only across a
// narrow gap — a cased opening — and never two halls (a hall, a stair hall
// and a foyer named in one open space are one floor). A name of no known
// kind (a desk, a unit's number, a note) parts only from a doored room.
const DOORED = new Set(['bath', 'closet', 'laundry', 'mech', 'bedroom', 'garage', 'outdoor', 'nofloor']);
const OPEN = new Set(['kitchen', 'dining', 'living', 'hall']);
// a reading's room types in the trace's own
const SEED_TYPE = {
  bathroom: 'bath', wc: 'bath', shower: 'bath', vanity: 'bath', closet: 'closet', pantry: 'closet', storage: 'closet',
  laundry: 'laundry', mechanical: 'mech', bedroom: 'bedroom', garage: 'garage', porch: 'outdoor',
  living: 'living', office: 'living', dining: 'dining', kitchen: 'kitchen', hall: 'hall', foyer: 'hall', stair: 'hall',
};

/** a reading's room type in the trace's own */
export const seedType = (t) => SEED_TYPE[t] || 'room';

/**
 * The seeds of a trace: its room names (each cluster of names standing
 * together, from analyzeGraph's `spots`) and the given seeds, one per room
 * — a given seed naming a room the sheet names too, in the same space, is
 * that name's seed.
 * @param {{ x, y, name, type, roomId: string|null, typed?: boolean }[]} spots
 * @param {{ x, y, name?: string, type?: string }[]} given
 * @param {(p:{x,y}) => string|null} roomAt
 */
export function roomSeeds(spots, given = [], roomAt = () => null) {
  const out = spots.map((s) => ({ ...s, src: 'label' }));
  for (const g of given) {
    if (!Number.isFinite(g?.x) || !Number.isFinite(g?.y)) continue;
    const roomId = roomAt(g);
    const k = key(g.name);
    const same = out.find((s) => s.roomId === roomId && (Math.hypot(s.x - g.x, s.y - g.y) < 3
      || (k && (key(s.name).includes(k) || (key(s.name) && k.includes(key(s.name)))))));
    if (same) continue;
    out.push({ x: g.x, y: g.y, name: g.name || 'room', type: seedType(g.type), roomId, typed: true, src: 'seed' });
  }
  return out;
}

/**
 * The gaps to close so each seed stands in a room of its own.
 * @param {{ nodes: {x,y}[], edges: {u,v,kind?,t?}[] }} g  the wall graph
 * @param {{ x, y, name, type, roomId: string|null, typed?: boolean }[]} seeds
 * @param {{ maxOpening?: number, maxDoor?: number, maxCased?: number, apart?: number, maxPairs?: number, anyPair?: boolean }} [opt]
 * @returns {{ at:{x,y}, to:{x,y}, gap: number, t: number, why: 'split'|'leak', names: string[] }[]}
 */
export function seedGaps(g, seeds, { maxOpening = 16, maxDoor = 8, maxCased = 6.5, apart = 6, maxPairs = 80, anyPair = false } = {}) {
  const used = new Set(g.edges.flatMap((e) => [e.u, e.v]));
  const nodes = [...used].map((n) => g.nodes[n]);
  if (!nodes.length || !seeds.length) return [];
  const edges = g.edges.map((e) => ({ a: g.nodes[e.u], b: g.nodes[e.v] }));
  const m = gapMap(edges, nodes, { maxGap: maxOpening });
  // a gap's thickness: the wall it opens from
  const thick = (p) => {
    let t = 0;
    for (const e of g.edges) {
      if (e.kind === 'opening') continue;
      const a = g.nodes[e.u], b = g.nodes[e.v];
      if (Math.hypot(a.x - p.x, a.y - p.y) < 1e-6 || Math.hypot(b.x - p.x, b.y - p.y) < 1e-6) t = Math.max(t, e.t || 0);
    }
    return t || 4.5 / 12;
  };
  const out = [];
  const take = (gaps, why, names) => {
    m.hold(gaps);
    for (const gp of gaps) {
      if (out.some((o) => Math.hypot(o.at.x - gp.at.x, o.at.y - gp.at.y) < 1e-6 && Math.hypot(o.to.x - gp.to.x, o.to.y - gp.to.y) < 1e-6)) continue;
      out.push({ at: { ...gp.at }, to: { ...gp.to }, gap: gp.gap, t: thick(gp.at), why, names });
    }
  };
  // two seeds in one room: part them
  const byRoom = new Map();
  for (const s of seeds) if (s.roomId) { if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []); byRoom.get(s.roomId).push(s); }
  let pairs = 0;
  for (const ss of byRoom.values()) {
    for (let i = 0; i < ss.length; i++) {
      for (let j = i + 1; j < ss.length; j++) {
        const a = ss[i], b = ss[j];
        const doored = DOORED.has(a.type) || DOORED.has(b.type);
        const open = OPEN.has(a.type) && OPEN.has(b.type) && a.type !== b.type;
        if (!anyPair && !doored && !open) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < apart || ++pairs > maxPairs) continue;
        // a door's width (a garage's door is wider); a cased opening's
        const widest = a.type === 'garage' || b.type === 'garage' ? maxOpening : doored || anyPair ? maxDoor : maxCased;
        const gaps = m.split(a, b, { widest });
        if (!gaps) continue;
        // …and parts no two names that stand in one floor (two halls: the
        // gap is a passage along the hall, not the room's own doorway)
        const halls = ss.filter((s) => s.type === 'hall');
        const together = halls.flatMap((h, x) => halls.slice(x + 1).filter((k) => m.joined(h, k)).map((k) => [h, k]));
        m.hold(gaps);
        const parts = together.some(([h, k]) => !m.joined(h, k));
        m.release(gaps);
        if (!parts) take(gaps, 'split', [a.name, b.name]);
      }
    }
  }
  // a seed in no room: shut it in
  for (const s of seeds) {
    if (s.roomId || !s.typed) continue;
    const lk = m.leak(s);
    if (lk) take(lk.gaps, 'leak', [s.name]);
  }
  return out;
}
