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
    // (the reading says what kind of room a name of no known kind is: "ROOM #3" is a bath)
    if (same) { if (same.type === 'room' && seedType(g.type) !== 'room') same.type = seedType(g.type); continue; }
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
export function seedGaps(g, seeds, { maxOpening = 16, maxDoor = 8, maxCased = 6.5, apart = 6, maxPairs = 80, anyPair = false, sideGap = 1.25, leakGap = 1.25 } = {}) {
  const used = new Set(g.edges.flatMap((e) => [e.u, e.v]));
  const nodes = [...used].map((n) => g.nodes[n]);
  if (!nodes.length || !seeds.length) return [];
  const edges = g.edges.map((e) => ({ a: g.nodes[e.u], b: g.nodes[e.v] }));
  const m = gapMap(edges, nodes, { maxGap: maxOpening, sideGap });
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
        // (any two names part across a leak narrower than any doorway: a
        // wall that stops inches short of the one it meets is no passage)
        const leakOnly = !anyPair && !doored && !open;
        if (leakOnly && (a.type === 'hall' && b.type === 'hall')) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < apart || ++pairs > maxPairs) continue;
        // a door's width (a garage's door is wider); a cased opening's
        const widest = leakOnly ? leakGap : a.type === 'garage' || b.type === 'garage' ? maxOpening : doored || anyPair ? maxDoor : maxCased;
        // (a doorway: a jog in a wall an inch or two across parts no rooms)
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

/**
 * Doorways the trace left open into a small space: a gap a door's width
 * across (the door is the ruler: no passage between two floors is narrower
 * than a door, an open plan's openings are wider), closing off a space of
 * its own on one side — a vanity alcove, a closet, a toilet room — inside
 * one traced room. A door swing drawn at the gap, its radius the gap's
 * width, lets the gap be as wide as the door.
 * @param {{ nodes: {x,y}[], edges: {u,v,kind?,t?}[] }} g  the wall graph
 * @param {{ id, poly: {x,y}[] }[]} rooms
 * @param {{ c:{x,y}, r:number }[]} arcs
 * @param {{ x, y, type, roomId }[]} spots  the sheet's names (two halls are one floor however narrow the way between)
 * @param {{ minNeck?: number, maxNeck?: number, maxDoor?: number, minPart?: number, maxPart?: number }} [opt]
 * @returns {{ at:{x,y}, to:{x,y}, gap: number, t: number, why: 'neck', names: string[], sf: number }[]}
 */
export function neckGaps(g, rooms, arcs = [], spots = [], { minNeck = 1.6, maxNeck = 3.25, maxDoor = 4, minPart = 12, maxPart = 200 } = {}) {
  const used = new Set(g.edges.flatMap((e) => [e.u, e.v]));
  const nodes = [...used].map((n) => g.nodes[n]);
  if (!nodes.length || !rooms.length) return [];
  const edges = g.edges.map((e) => ({ a: g.nodes[e.u], b: g.nodes[e.v] }));
  // (a doorway at a corner: the space past it is bounded by the wall it
  // meets, so it opens out less than the gap is wide)
  const m = gapMap(edges, nodes, { maxGap: maxDoor + 1, past: 0.6 });
  const inPoly = (p, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  };
  // a wall's thickness where the gap meets it: the clear width between the
  // faces is what a door fills (the centrelines are half a wall further apart)
  const segD = (p, a, b) => { const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1e-9; const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2)); return Math.hypot(a.x + t * vx - p.x, a.y + t * vy - p.y); };
  const tAt = (p) => {
    let best = null, bd = 0.05;
    for (const e of g.edges) { const d = segD(p, g.nodes[e.u], g.nodes[e.v]); if (d < bd) { bd = d; best = e; } }
    return best?.t || 4.5 / 12;
  };
  const swing = (gp, clear) => arcs.some((a) => Math.abs(a.r - clear) < 0.15 * clear
    && Math.min(Math.hypot(a.c.x - gp.at.x, a.c.y - gp.at.y), Math.hypot(a.c.x - gp.to.x, a.c.y - gp.to.y)) < 0.6);
  const out = [];
  for (const gp of m.gaps) {
    if (gp.gap < minNeck) continue;
    const clear = gp.gap - (tAt(gp.at) + tAt(gp.to)) / 2;
    if (clear < minNeck || clear > maxDoor || (clear > maxNeck && !swing(gp, clear))) continue;
    const mid = { x: (gp.at.x + gp.to.x) / 2, y: (gp.at.y + gp.to.y) / 2 };
    const nx = -(gp.to.y - gp.at.y) / gp.gap, ny = (gp.to.x - gp.at.x) / gp.gap;
    const p = { x: mid.x + nx * 0.6, y: mid.y + ny * 0.6 }, q = { x: mid.x - nx * 0.6, y: mid.y - ny * 0.6 };
    const room = rooms.find((r) => inPoly(p, r.poly) && inPoly(q, r.poly));
    if (!room || room.area < 2 * minPart) continue;
    m.hold([gp]);
    const sm = m.smallSide(p, q, Math.min(maxPart, room.area - minPart) + 1);
    let halls = false;
    if (sm) {
      const inner = sm.side === 'p' ? p : q;
      const hs = spots.filter((s) => s.roomId === room.id && s.type === 'hall');
      const k = hs.filter((s) => m.joined(s, inner)).length;
      halls = k > 0 && k < hs.length;
    }
    m.release([gp]);
    if (halls) continue;
    if (!sm || sm.sf < minPart || sm.sf > maxPart || sm.sf > room.area - minPart) continue;
    if (out.some((o) => Math.hypot(o.at.x - gp.to.x, o.at.y - gp.to.y) < 0.3 && Math.hypot(o.to.x - gp.at.x, o.to.y - gp.at.y) < 0.3)) continue;
    out.push({ at: { ...gp.at }, to: { ...gp.to }, gap: gp.gap, t: 4.5 / 12, why: 'neck', names: [room.name || 'room'], sf: sm.sf });
  }
  return out;
}
