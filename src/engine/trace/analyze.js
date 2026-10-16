// ============================================================
// analyze.js — turn the traced graph into a takeoff.
//
// Rooms are faces of the wall graph. Each room's floor polygon is the
// centerline loop pulled in by half of each wall's thickness (doors:
// to the centre of the opening by default, where the threshold sits).
// Wall linear footage walks that same loop, net of openings, plus the
// "in and out" of any partition that dead-ends inside the room.
// Everything that doesn't add up becomes a located flag.
// ============================================================

import {
  sub, dot, cross, dist, norm, perp, signedArea, polyPerimeter, pointInPoly, interiorPoint, mid, lerp,
} from './vec.js';
import { traceFaces, stripSpurs, splitPinches, fmtIn } from './graph.js';
// (dist, signedArea etc. come from vec.js above)

const IN = 1 / 12;

/** @type {[string, RegExp][]} */
export const ROOM_TYPES = [
  ['bath', /\b(bath|bathroom|bth|wc|w\.c\.?|powder|pwdr|toilet|lav|lavatory|ensuite|en-suite|shower|restroom|half bath|1\/2 bath)\b/i],
  ['closet', /\b(closet|clos|clo|cl|wic|w\.i\.c\.?|walk-?in|linen|lin|pantry|pan|storage|stor|wardrobe)\b/i],
  ['kitchen', /\b(kitchen|kit|kitch|kitchenette)\b/i],
  ['laundry', /\b(laundry|laund|utility|util|mud\s*room|mudroom|w\/d)\b/i],
  ['bedroom', /\b(bedroom|bed\s*rm|bdrm|br|master|guest|nursery|bed|suite)\b/i],
  ['living', /\b(living|family|great\s*room|den|lounge|rec|recreation|media|playroom|study|office|library|sunroom|bonus)\b/i],
  ['dining', /\b(dining|din|breakfast|nook)\b/i],
  ['hall', /\b(hall|hallway|corridor|corr|foyer|entry|vestibule|vest|gallery|landing|stair|stairs|stairway)\b/i],
  ['garage', /\b(garage|gar|carport)\b/i],
  ['outdoor', /\b(porch|deck|patio|balcony|terrace|veranda)\b/i],
  ['mech', /\b(mech|mechanical|boiler|elec|electrical|furnace|hvac|wh|water heater)\b/i],
];

const DIM_RE = /^\s*\d+\s*['’]\s*-?\s*\d*\s*(\d+\/\d+)?\s*["”]?\s*$|^\s*\d+(\.\d+)?\s*["”]\s*$|^\s*\d+\s*['’]\s*$/;
const AREA_RE = /\b\d+(\.\d+)?\s*(sf|sq\.?\s*ft|s\.f\.)\b/i;
const NOISE_RE = /^(up|dn|down|n|ref|dw|w|d|ov|mw|ac|hb|fd|ht|typ|sim|eq|clg|ceil|ceiling|tile|wood|vinyl|carpet|lvt|lvp|hwd|cpt|ct|vct|new|exist|existing|demo)$/i;

export function roomTypeOf(name) {
  if (!name) return 'room';
  for (const [t, re] of ROOM_TYPES) if (re.test(name)) return t;
  return 'room';
}

function isLabel(str) {
  const s = (str || '').trim();
  if (s.length < 2 || !/[a-z].*[a-z]/i.test(s)) return false;
  if (DIM_RE.test(s) || AREA_RE.test(s) || NOISE_RE.test(s)) return false;
  if (/=|scale/i.test(s)) return false;
  return true;
}

/** Offset a face loop toward its left face (the room). dists[k] per half-edge. */
export function offsetLoop(loop, nodes, distOf) {
  const L = loop.map((h) => {
    const p = nodes[h.from], q = nodes[h.to];
    const u = norm(sub(q, p)), n = perp(u), d = distOf(h);
    return { h, p, q, u, n, d, P: { x: p.x + n.x * d, y: p.y + n.y * d }, Q: { x: q.x + n.x * d, y: q.y + n.y * d } };
  });
  const k = L.length;
  const s = new Array(k), e = new Array(k);
  for (let i = 0; i < k; i++) {
    const A = L[(i - 1 + k) % k], B = L[i];
    const c = cross(A.u, B.u);
    // Nearly-straight joins (real PDFs are full of 0.01° wobble) and reversals
    // can't be intersected safely — the meeting point flies off to infinity.
    // Step across at the shared corner instead.
    const straightish = Math.abs(c) < 0.035 && dot(A.u, B.u) > 0;
    let X = null;
    if (!straightish && Math.abs(c) > 1e-9) {
      const t = cross(sub(B.P, A.P), B.u) / c;
      X = { x: A.P.x + A.u.x * t, y: A.P.y + A.u.y * t };
      const corner = A.q;
      if (dist(X, corner) > 3 * Math.max(A.d, B.d) + 0.5) X = null; // runaway miter
    }
    if (X) { e[(i - 1 + k) % k] = X; s[i] = X; }
    else { e[(i - 1 + k) % k] = A.Q; s[i] = B.P; }
  }
  const poly = [];
  const segLen = [];
  let inverted = 0;
  for (let i = 0; i < k; i++) {
    const v = sub(e[i], s[i]);
    const ok = dot(v, L[i].u) >= -1e-6;
    if (!ok) inverted++;
    segLen.push(ok ? Math.hypot(v.x, v.y) : 0);
    for (const p of [s[i], e[i]]) {
      const last = poly[poly.length - 1];
      if (!last || dist(last, p) > 1e-6) poly.push({ x: p.x, y: p.y });
    }
  }
  if (poly.length > 1 && dist(poly[0], poly[poly.length - 1]) < 1e-6) poly.pop();
  return { poly, segLen, edges: L.map((x) => x.h.e), inverted };
}

/**
 * Analyze a pruned graph into rooms, openings, flags.
 * @param {{nodes, edges}} g
 * @param {object} ctx { texts, arcs, schedule, options }
 */
export function analyzeGraph(g, ctx = {}) {
  const { texts = [], arcs = [], schedule = null } = ctx;
  const opt = { floorAtDoor: 'center', ...ctx.options };
  const flags = [];
  let fid = 0;
  const flag = (severity, kind, at, msg, extra = {}) => flags.push({ id: `f${++fid}`, severity, kind, at: at ? { x: at.x, y: at.y } : null, msg, ...extra });

  const { faces, half } = traceFaces(g);
  const nodes = g.nodes;

  // face per half-edge
  const faceOfHalf = new Map();
  for (const f of faces) for (const h of f.half) faceOfHalf.set(h.id, f);

  // components (for holes)
  const compOf = new Map();
  {
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const e of g.edges) { for (const n of [e.u, e.v]) if (!parent.has(n)) parent.set(n, n); }
    for (const e of g.edges) { const a = find(e.u), b = find(e.v); if (a !== b) parent.set(a, b); }
    for (const n of parent.keys()) compOf.set(n, find(n));
  }

  // classify faces
  const interior = [], outer = [];
  for (const f of faces) {
    if (!f.closed) {
      const h = f.half[0];
      flag('error', 'unclosed', nodes[h.from], 'Trace could not close a loop here');
      continue;
    }
    const { loop, spurs } = stripSpurs(f.half);
    f.loop = loop; f.spurs = spurs;
    f.poly = loop.map((h) => nodes[h.from]);
    f.comp = loop.length ? compOf.get(loop[0].from) : (f.half.length ? compOf.get(f.half[0].from) : null);
    if (f.area > 1e-6 && loop.length >= 3) interior.push(f);
    else outer.push(f);
  }

  // holes: an outer boundary of one component sitting inside an interior face of another
  for (const o of outer) {
    if (!o.loop || o.loop.length < 3) continue;
    const probe = o.poly[0];
    let host = null;
    for (const f of interior) {
      if (f.comp === o.comp) continue;
      if (!pointInPoly(probe, f.poly)) continue;
      if (!host || f.area < host.area) host = f;
    }
    if (host) { (host.holes ||= []).push(o); o.hostOf = host; }
  }

  // ---- sheet border / frame: a loop whose only job is to enclose the building ----
  if (!ctx._frameChecked) {
    // A sheet border runs around the edge of the PAGE. Only linework that spans
    // the page (≥ 85% both ways) and holds no rooms of its own is treated as a
    // frame — a big room with a detached core inside it is still a room.
    const frameComps = new Set();
    const sheet = ctx.sheet;
    const cbb = new Map();
    for (const e of g.edges) {
      const k = compOf.get(e.u);
      if (!cbb.has(k)) cbb.set(k, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      const b = cbb.get(k);
      for (const n of [nodes[e.u], nodes[e.v]]) { b.x0 = Math.min(b.x0, n.x); b.y0 = Math.min(b.y0, n.y); b.x1 = Math.max(b.x1, n.x); b.y1 = Math.max(b.y1, n.y); }
    }
    const roomsIn = new Map(); // comp -> { own big rooms (not containing other plans), containers }
    for (const f of interior) {
      if (!roomsIn.has(f.comp)) roomsIn.set(f.comp, { own: 0, containers: 0 });
      const c = roomsIn.get(f.comp);
      const contains = (f.holes || []).some((o) => interior.some((x) => x.comp === o.comp && x.area >= 20));
      if (contains) c.containers++; else if (f.area >= 20) c.own++;
    }
    const spansSheet = (b) => sheet && (b.x1 - b.x0) >= 0.85 * (sheet.x1 - sheet.x0) && (b.y1 - b.y0) >= 0.85 * (sheet.y1 - sheet.y0);
    for (const [k, b] of cbb) {
      const c = roomsIn.get(k) || { own: 0, containers: 0 };
      if (c.own === 0 && spansSheet(b)) frameComps.add(k);
    }
    // Roomless linework well away from the building (title block, details,
    // schedules) isn't part of it. Anything overlapping the building stays —
    // a leaking wall there must be flagged, never dropped.
    const roomComps = new Set([...roomsIn].filter(([k, c]) => (c.own > 0 || c.containers > 0) && !frameComps.has(k)).map(([k]) => k));
    if (roomComps.size) {
      const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const k of roomComps) { const b = cbb.get(k); if (!b) continue; bb.x0 = Math.min(bb.x0, b.x0); bb.y0 = Math.min(bb.y0, b.y0); bb.x1 = Math.max(bb.x1, b.x1); bb.y1 = Math.max(bb.y1, b.y1); }
      for (const [k, b] of cbb) {
        if (roomComps.has(k) || frameComps.has(k)) continue;
        const far = b.x1 < bb.x0 - 6 || b.x0 > bb.x1 + 6 || b.y1 < bb.y0 - 6 || b.y0 > bb.y1 + 6;
        if (far) frameComps.add(k);
      }
    }
    if (frameComps.size) {
      const g2 = { nodes: g.nodes, edges: g.edges.filter((e) => !frameComps.has(compOf.get(e.u))).map((e, i) => ({ ...e, id: i })) };
      const res = analyzeGraph(g2, { ...ctx, _frameChecked: true });
      res.flags.push({ id: 'f_frame', severity: 'info', kind: 'frame', at: null, msg: `${frameComps.size} piece(s) of non-building linework ignored (sheet border, title block, details)` });
      res.ignoredEdges = g.edges.length - g2.edges.length;
      return res;
    }
  }

  // ---- labels → faces ----
  // only text over the building counts — schedules, notes and title blocks sit outside it
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const f of interior) for (const p of f.poly) { bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y); bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y); }
  const overBuilding = (t) => t.x >= bb.x0 - 1 && t.x <= bb.x1 + 1 && t.y >= bb.y0 - 1 && t.y <= bb.y1 + 1;
  const labelItems = texts.filter((t) => isLabel(t.str) && overBuilding(t));
  const faceAt = (p) => {
    let best = null;
    for (const f of interior) {
      if (!pointInPoly(p, f.poly)) continue;
      if (f.holes && f.holes.some((hh) => pointInPoly(p, hh.poly))) continue;
      if (!best || f.area < best.area) best = f;
    }
    return best;
  };
  for (const t of labelItems) {
    const f = faceAt(t);
    if (f) (f.labels ||= []).push(t);
    else if (roomTypeOf(t.str) !== 'room') {
      // a room name with no closed room around it = the walls leak
      flag('error', 'room_not_closed', t, `"${t.str.trim()}" is not inside a closed room — its walls don't close (gap, missing wall, or an opening the trace couldn't bridge)`);
    }
  }

  // ---- rooms ----
  const distFor = (h) => {
    const e = h.e;
    if (e.kind === 'opening') return opt.floorAtDoor === 'face' ? (e.t || 0) / 2 : 0;
    return (e.t || 0) / 2;
  };
  const rooms = [];
  const voids = [];
  const roomOfFace = new Map();
  let rIdx = 0;
  for (const f of interior) {
    // A face boundary can visit a corner twice. Sort the sub-loops out:
    //   positive loops  → the room outline (two = a true pinch between rooms)
    //   negative loops  → a walled box tied to the room by a wall (a hole)
    //   2-edge loops    → a wall walked out and back (both faces count)
    const ringLoops = [], holeLoops = [], extraSpurs = [];
    for (const l of splitPinches(f.loop)) {
      const a = l.length >= 3 ? signedArea(l.map((h) => nodes[h.from])) : 0;
      if (a > 1e-6) ringLoops.push({ l, a });
      else if (a < -1e-6) holeLoops.push(l);
      else for (const h of l) if (!extraSpurs.includes(h.e)) extraSpurs.push(h.e);
    }
    ringLoops.sort((p, q) => q.a - p.a);
    if (ringLoops.length > 1) flag('warn', 'pinch', nodes[ringLoops[1].l[0].from], 'Two spaces touch at a single corner here — check whether they should be one room or two');
    if (!ringLoops.length) continue;
    const parts = ringLoops.map((r) => offsetLoop(r.l, nodes, distFor));
    const holes = (f.holes || []).map((o) => offsetLoop(o.loop, nodes, distFor)).concat(holeLoops.map((l) => offsetLoop(l, nodes, distFor)));
    const holeCenterArea = holeLoops.reduce((s, l) => s + Math.abs(signedArea(l.map((h) => nodes[h.from]))), 0);
    let area = parts.reduce((s, p) => s + signedArea(p.poly), 0) + holes.reduce((s, p) => s + signedArea(p.poly), 0);
    const centerArea = f.area - (f.holes || []).reduce((s, o) => s + Math.abs(o.area), 0) - holeCenterArea;
    const perim = parts.reduce((s, p) => s + polyPerimeter(p.poly), 0);
    const inverted = parts.reduce((s, p) => s + p.inverted, 0) + holes.reduce((s, p) => s + p.inverted, 0);

    // thin / tiny faces are wall cavities, chases, pocket-door slots
    const hyd = centerArea > 0 ? (2 * centerArea) / polyPerimeter(f.poly) : 0;
    if (centerArea < 3 || hyd < 0.9 || area <= 0.5) {
      voids.push({ poly: f.poly, area: Math.max(0, area), centerArea });
      continue;
    }
    let fellBack = false;
    if (area > centerArea + 1e-6 || inverted > 0) {
      flag('warn', 'offset', interiorPoint(f.poly), 'Room outline needed a fallback around a very short wall — check the corners here');
      if (area > centerArea || area <= 0) { area = centerArea; fellBack = true; }
    }

    // wall linear footage along the finished face, net of openings
    let wallLf = 0, openingLf = 0;
    const edgeLfs = [];
    for (const p of parts.concat(holes)) {
      p.edges.forEach((e, i) => {
        const l = p.segLen[i];
        if (e.kind === 'opening') openingLf += l; else wallLf += l;
        edgeLfs.push({ e, l });
      });
    }
    // spurs: a partition that dead-ends inside the room has two faces + an end cap
    const spurList = [];
    let spurLf = 0;
    const spurEdges = [...f.spurs, ...extraSpurs.filter((e) => !f.spurs.includes(e))].filter((e) => e.kind !== 'opening');
    if (spurEdges.length) {
      // group spur edges into chains attached at a boundary node (room outline or a hole)
      const onLoop = new Set([...f.loop.map((h) => h.from), ...(f.holes || []).flatMap((o) => o.loop.map((h) => h.from))]);
      const byNode = new Map();
      for (const e of spurEdges) for (const n of [e.u, e.v]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(e); }
      const used = new Set();
      for (const e of spurEdges) {
        if (used.has(e)) continue;
        // BFS the chain
        const chain = []; const q = [e]; used.add(e);
        while (q.length) {
          const x = q.pop(); chain.push(x);
          for (const n of [x.u, x.v]) for (const y of byNode.get(n) || []) if (!used.has(y)) { used.add(y); q.push(y); }
        }
        const total = chain.reduce((s, x) => s + dist(nodes[x.u], nodes[x.v]), 0);
        const ends = chain.flatMap((x) => [x.u, x.v]);
        const attaches = [...new Set(ends.filter((n) => onLoop.has(n)))];
        const attach = attaches[0];
        const frees = [...new Set(ends.filter((n) => ends.filter((m) => m === n).length === 1 && !onLoop.has(n)))];
        const tc = chain.reduce((s, x) => s + x.t * dist(nodes[x.u], nodes[x.v]), 0) / (total || 1);
        // both faces, minus the part buried in each host wall, minus the strip of
        // host face it covers, plus an end cap at each free end:
        //   2·L − Σ hostT − |attach|·t + |free|·t
        let hostSum = 0;
        for (const n of attaches) hostSum += Math.max(0, ...g.edges.filter((x) => (x.u === n || x.v === n) && !chain.includes(x)).map((x) => x.t));
        const lf = Math.max(0, 2 * total - hostSum - attaches.length * tc + frees.length * tc);
        spurLf += lf;
        const freeEnd = frees[0];
        spurList.push({ lf, length: total, t: chain[0].t, a: attach != null ? { ...nodes[attach] } : { ...nodes[chain[0].u] }, b: freeEnd != null ? { ...nodes[freeEnd] } : { ...nodes[chain[0].v] }, edges: chain.map((x) => x.id) });
      }
    }

    const id = `r${++rIdx}`;
    const room = {
      id, faceId: f.id,
      poly: fellBack ? ringLoops[0].l.map((h) => ({ ...nodes[h.from] })) : parts[0].poly,
      extraPolys: parts.slice(1).map((p) => p.poly),
      holes: fellBack ? (f.holes || []).map((o) => o.poly).concat(holeLoops.map((l) => l.map((h) => ({ ...nodes[h.from] })))) : holes.map((h) => h.poly),
      centerPoly: ringLoops[0].l.map((h) => nodes[h.from]),
      area, centerArea, perimeter: perim,
      wallLf: wallLf + spurLf, wallLfLoop: wallLf, openingLf, spurLf, spurs: spurList,
      edgeIds: [...new Set(edgeLfs.map((x) => x.e.id))],
      labels: (f.labels || []).map((t) => t.str.trim()),
      center: interiorPoint(parts[0].poly.length >= 3 ? parts[0].poly : f.poly),
      openings: [],
      flags: [],
    };
    // name from labels nearest the centre, in reading order
    const lbls = (f.labels || []).slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const nameParts = [];
    for (const t of lbls) {
      const s = t.str.trim();
      if (!nameParts.some((x) => x.toLowerCase() === s.toLowerCase())) nameParts.push(s);
    }
    // keep labels that sit together (within ~4 ft of the first room-type label)
    const typedL = lbls.filter((t) => roomTypeOf(t.str) !== 'room');
    const anchor = (typedL.length ? typedL : lbls).slice().sort((a, b) => dist(a, room.center) - dist(b, room.center))[0];
    const near = anchor ? lbls.filter((t) => dist(t, anchor) < 4.5) : [];
    room.name = near.length ? [...new Set(near.map((t) => t.str.trim()))].join(' ') : null;
    // the room's type comes from its own anchor label, not a neighbour's stray tag
    room.type = anchor && roomTypeOf(anchor.str) !== 'room' ? roomTypeOf(anchor.str) : roomTypeOf(room.name || '');
    // two different room names far apart in one face → merged rooms
    const typed = lbls.filter((t) => roomTypeOf(t.str) !== 'room');
    const far = typed.filter((t) => anchor && dist(t, anchor) >= 6 && roomTypeOf(t.str) !== roomTypeOf(anchor.str));
    if (far.length) {
      const names = [anchor.str.trim(), ...new Set(far.map((t) => t.str.trim()))];
      flag('warn', 'merged_rooms', far[0], `${names.join(' + ')} share one enclosed space — no wall or opening was found between them. Split it if they're separate takeoff areas.`, { roomId: id });
    }
    rooms.push(room);
    roomOfFace.set(f.id, room);
  }

  if (!rooms.length && !ctx._quiet) {
    flag('error', 'no_rooms', null, 'No closed rooms were found — check the scale and the trace area, or the drawing may be too faint / not a floor plan');
  }

  // default names
  const typeCount = {};
  for (const r of rooms) {
    if (!r.name) { typeCount.room = (typeCount.room || 0) + 1; r.name = `Space ${typeCount.room}`; }
  }

  // ---- edges: exterior, openings and their rooms ----
  const sideFaces = new Map(); // edge id -> [face left of u→v, face left of v→u]
  for (const h of half) {
    const f = faceOfHalf.get(h.id);
    if (!sideFaces.has(h.e.id)) sideFaces.set(h.e.id, [null, null]);
    sideFaces.get(h.e.id)[h.from === h.e.u ? 0 : 1] = f;
  }
  const roomOf = (f) => (f ? roomOfFace.get(f.id) || null : null);
  const isOuter = (f) => !f || f.area <= 1e-6;

  const walls = [];
  const openings = [];
  for (const e of g.edges) {
    const [fa, fb] = sideFaces.get(e.id) || [null, null];
    const a = nodes[e.u], b = nodes[e.v];
    const exterior = (isOuter(fa) && !(fa && fa.hostOf)) || (isOuter(fb) && !(fb && fb.hostOf));
    if (e.kind === 'opening') {
      const o = e.opening || {};
      const ra = roomOf(fa), rb = roomOf(fb);
      const op = {
        id: `o${e.id}`, edgeId: e.id, a: { ...a }, b: { ...b }, t: e.t, width: o.width ?? dist(a, b), openingType: o.openingType || 'opening',
        conf: o.conf ?? 0.6, arcs: o.arcs || [], exterior, rooms: [ra?.id || null, rb?.id || null], jambs: o.jambs,
      };
      openings.push(op);
      for (const r of [ra, rb]) if (r) r.openings.push({ id: op.id, width: op.width, type: op.openingType, to: (r === ra ? rb : ra)?.name || (exterior ? 'Exterior' : null) });
    } else {
      walls.push({ id: `w${e.id}`, edgeId: e.id, a: { ...a }, b: { ...b }, t: e.t, conf: e.conf, src: e.src, exterior, length: dist(a, b) });
    }
  }

  // ---- dangling ends ----
  const deg = new Map();
  for (const e of g.edges) { deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); }
  const halfInto = new Map();
  for (const h of half) halfInto.set(`${h.e.id}:${h.to}`, h);
  const edgeAt = new Map();
  for (const e of g.edges) { if (!edgeAt.has(e.u)) edgeAt.set(e.u, e); if (!edgeAt.has(e.v)) edgeAt.set(e.v, e); }
  for (const [n, d] of deg) {
    if (d !== 1) continue;
    const e = edgeAt.get(n);
    const h = halfInto.get(`${e.id}:${n}`);
    const f = h ? faceOfHalf.get(h.id) : null;
    const room = roomOf(f);
    if (room) flag('info', 'spur', nodes[n], `Free-standing wall end in ${room.name} (partition / pony wall) — both faces counted in wall LF`, { roomId: room.id });
    else flag('error', 'open_end', nodes[n], 'Wall ends without connecting to anything — the trace is open here (missing wall, unbridged door, or unclear drawing)');
  }

  // 4-way crossings: the trace crosses itself
  for (const [n, d] of deg) {
    if (d < 4) continue;
    const inc = g.edges.filter((x) => x.u === n || x.v === n);
    flag('info', 'crossing', nodes[n], `${inc.length} walls meet at one point — confirm this junction`);
  }

  // ---- door / opening sanity in context ----
  checkOpenings(openings, rooms, schedule, flag, arcs.length > 0);

  // ---- door-swing scale calibration ----
  const calibration = calibrateFromDoors(arcs);
  if (calibration.verdict === 'off') {
    flag('error', 'scale', null, calibration.msg);
  }

  // attach flags to rooms
  for (const fl of flags) {
    if (fl.roomId) continue;
    if (!fl.at) continue;
    const r = rooms.find((rr) => pointInPoly(fl.at, rr.centerPoly));
    if (r) fl.roomId = r.id;
  }
  for (const fl of flags) if (fl.roomId) rooms.find((r) => r.id === fl.roomId)?.flags.push(fl.id);
  for (const r of rooms) {
    const sev = r.flags.map((id) => flags.find((f) => f.id === id)?.severity);
    r.status = sev.includes('error') ? 'error' : sev.includes('warn') ? 'review' : 'ok';
  }

  return { rooms, voids, walls, openings, flags, calibration, faces: faces.length };
}

// ---------------------------------------------------------------------------

const STD_LEAF = [1.5, 1 + 8 / 12, 1 + 10 / 12, 2, 2 + 2 / 12, 2 + 4 / 12, 2 + 6 / 12, 2 + 8 / 12, 2 + 10 / 12, 3, 3.5];

function checkOpenings(openings, rooms, schedule, flag, swingsReadable) {
  if (!swingsReadable && openings.length) flag('info', 'no_swings', null, 'Door swings could not be read on this sheet — door widths come from the wall gaps');
  const byId = new Map(rooms.map((r) => [r.id, r]));
  for (const o of openings) {
    const at = mid(o.a, o.b);
    const rs = o.rooms.map((id) => (id ? byId.get(id) : null));
    const types = rs.map((r) => (r ? r.type : o.exterior ? 'exterior' : 'room'));
    const names = rs.map((r) => (r ? r.name : o.exterior ? 'exterior' : '?'));
    const w = o.width;
    const label = `${fmtIn(w)} ${o.openingType === 'opening' ? 'opening' : o.openingType === 'double_door' ? 'double door' : 'door'} between ${names.join(' and ')}`;
    const isDouble = o.openingType === 'double_door';
    if (w < 1.5) { flag('warn', 'door_width', at, `${label} is too narrow for a door — probably a gap in the drawing`); continue; }
    if (types.includes('bath') && w > 3.25 && !isDouble) {
      flag('warn', 'door_width', at, `${label} is wide for a bathroom door — check the plan / door schedule`);
    } else if (types.includes('closet') && w > 8.5) {
      flag('warn', 'door_width', at, `${label} is wider than a closet bifold/bypass — confirm`);
    } else if (types.includes('bedroom') && !types.includes('exterior') && !types.includes('closet') && !types.includes('bath') && w > 4 && !isDouble) {
      flag('warn', 'door_width', at, `${label} is wide for a single room entry — door or cased opening? confirm`);
    } else if (!types.includes('exterior') && w > 8 && o.arcs.length === 0) {
      flag('info', 'inferred_opening', at, `${label}: wide cased opening inferred — confirm it's open and not a missing wall`);
    }
    if (swingsReadable && o.openingType === 'opening' && w <= 4 && !types.includes('closet')) {
      flag('info', 'no_swing', at, `${label}: no door swing found (pocket / bifold / cased?) — width taken from the wall gap`);
    }
    if (schedule && schedule.widths?.length && o.arcs.length) {
      const leaf = isDouble ? w / 2 : w;
      const ok = schedule.widths.some((sw) => Math.abs(sw - leaf) <= 1.5 * IN || Math.abs(sw - w) <= 1.5 * IN);
      if (!ok) flag('warn', 'door_schedule', at, `${label} doesn't match any door-schedule width (${schedule.widths.map(fmtIn).join(', ')})`);
    }
  }
}

export function calibrateFromDoors(arcs) {
  const radii = arcs.map((a) => a.r).filter((r) => r > 0.3 && r < 12);
  if (radii.length < 2) return { verdict: 'unknown', doors: radii.length, msg: 'Not enough door swings to cross-check the scale' };
  const near = (r) => STD_LEAF.reduce((b, s) => (Math.abs(s - r) < Math.abs(b - r) ? s : b), STD_LEAF[0]);
  const score = (f) => radii.filter((r) => Math.abs(near(r * f) - r * f) <= 1.25 * IN).length;
  const factors = [1, 0.5, 2, 0.25, 4, 0.75, 4 / 3, 1.5, 2 / 3, 3, 1 / 3];
  const s1 = score(1);
  let best = 1, bs = s1;
  for (const f of factors) { const s = score(f); if (s > bs + 1) { best = f; bs = s; } }
  const devs = radii.map((r) => Math.abs(near(r) - r) * 12);
  const medDev = devs.sort((a, b) => a - b)[Math.floor(devs.length / 2)];
  if (best !== 1 && bs >= Math.max(2, radii.length * 0.6)) {
    return { verdict: 'off', factor: best, doors: radii.length, msg: `Scale looks wrong: ${radii.length} door swings measure ${radii.slice(0, 4).map(fmtIn).join(', ')}… — they'd be standard doors if the scale were ×${+best.toFixed(3)}. Re-check the scale.` };
  }
  if (s1 >= Math.max(2, radii.length * 0.6)) {
    return { verdict: 'confirmed', doors: radii.length, matched: s1, medianDevIn: +medDev.toFixed(2), msg: `Scale confirmed by ${s1} of ${radii.length} door swings (median ${medDev.toFixed(1)}" from a standard door)` };
  }
  return { verdict: 'unclear', doors: radii.length, matched: s1, medianDevIn: +medDev.toFixed(2), msg: `Only ${s1} of ${radii.length} door swings match standard sizes — scale unverified` };
}

/** Parse a drawing-scale note like 1/4" = 1'-0" from sheet text. Returns an ARCH_SCALES id or null. */
export function parseScaleNote(texts) {
  const joined = texts.map((t) => t.str).join(' ');
  const counts = new Map();
  const re = /(\d+\s*-?\s*\d*\/?\d*)\s*["”]\s*=\s*1\s*['’]\s*-?\s*0?\s*["”]?/g;
  let m;
  while ((m = re.exec(joined))) {
    const raw = m[1].replace(/\s+/g, ' ').trim();
    let val = null;
    const mixed = raw.match(/^(\d+)[ -](\d+)\/(\d+)$/);
    const frac = raw.match(/^(\d+)\/(\d+)$/);
    if (mixed) val = +mixed[1] + +mixed[2] / +mixed[3];
    else if (frac) val = +frac[1] / +frac[2];
    else if (/^\d+$/.test(raw)) val = +raw;
    if (!val) continue;
    const key = +val.toFixed(5);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const eng = /1\s*["”]\s*=\s*(\d+)\s*['’]/g;
  while ((m = eng.exec(joined))) {
    const key = `e${m[1]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return null;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (typeof best === 'string') return best;
  const map = { 0.03125: '1/32', 0.0625: '1/16', 0.09375: '3/32', 0.125: '1/8', 0.1875: '3/16', 0.25: '1/4', 0.375: '3/8', 0.5: '1/2', 0.75: '3/4', 1: '1', 1.5: '1-1/2', 3: '3' };
  return map[best] || null;
}

/** Collect door sizes like 2'-8" x 6'-8" from schedule / tag text. */
export function parseDoorSchedule(texts) {
  const joined = texts.map((t) => t.str).join(' ');
  const re = /(\d)\s*['’]\s*-?\s*(\d{1,2})\s*["”]?\s*[xX×]\s*(\d)\s*['’]\s*-?\s*(\d{1,2})\s*["”]?/g;
  const widths = new Map(), heights = new Map();
  let m;
  while ((m = re.exec(joined))) {
    const w = +m[1] + +m[2] / 12, h = +m[3] + +m[4] / 12;
    if (w < 1 || w > 10 || h < 5 || h > 10) continue;
    widths.set(+w.toFixed(4), (widths.get(+w.toFixed(4)) || 0) + 1);
    heights.set(+h.toFixed(4), (heights.get(+h.toFixed(4)) || 0) + 1);
  }
  if (!widths.size) return null;
  const doorHeight = [...heights.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { widths: [...widths.keys()].sort((a, b) => a - b), doorHeight };
}

export { lerp };
