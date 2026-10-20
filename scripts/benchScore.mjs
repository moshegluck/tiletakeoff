// ============================================================
// benchScore.mjs — how scripts/bench.mjs scores a trace against its answers
// (printed room tags, hand-audited rooms, an estimator's marked areas).
// ============================================================
export const inPoly = (p, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};
// (a room's name tag may stand on its stair: a stair run taken off the floor is still the room's)
export const inRoom = (p, r) => inPoly(p, r.poly) && !(r.holes || []).some((h) => !(r.stairHoles || []).includes(h) && inPoly(p, h));

/** Score one traced sheet against its answers. */
export function score(res, answers) {
  const out = { answers: answers.length, right: 0, close: 0, merged: 0, missing: 0, silent: 0, wrong: [] };
  const byRoom = new Map();
  for (const a of answers) {
    const r = res.rooms.find((rm) => inRoom(a.at, rm));
    if (!r) { out.missing++; out.wrong.push({ ...a, why: 'no room' }); continue; }
    if (!byRoom.has(r)) byRoom.set(r, []);
    byRoom.get(r).push(a);
  }
  for (const [r, as] of byRoom) {
    const want = as.reduce((s, a) => s + a.sf, 0);
    // a printed tag measures to the wall faces across doorways; a hand-audited
    // room is the takeoff's own floor
    const got = as[0].src === 'printed' ? (r.areaFaces ?? r.area) : r.area;
    const d = Math.abs(got - want);
    const zones = as.length > 1 && r.printedParts && r.areaCheck === 'match';
    if (as.length > 1 && !zones) {
      out.merged += as.length;
      for (const a of as) out.wrong.push({ ...a, why: `merged into ${r.name} (${r.area.toFixed(0)} SF)`, flagged: r.status !== 'ok' });
      if (r.status === 'ok') out.silent += as.length;
      continue;
    }
    const n = as.length;
    if (d <= Math.max(1, 0.01 * want)) { out.right += n; out.close += n; continue; }
    if (d <= Math.max(3, 0.03 * want)) { out.close += n; out.wrong.push(...as.map((a) => ({ ...a, why: `${got.toFixed(1)} SF (${(((got - want) / want) * 100).toFixed(1)}%)`, flagged: r.status !== 'ok', near: true }))); continue; }
    const flagged = r.status !== 'ok';
    if (!flagged) out.silent += n;
    out.wrong.push(...as.map((a) => ({ ...a, why: `${r.name}: ${got.toFixed(0)} SF (${(((got - want) / want) * 100).toFixed(0)}%)`, flagged })));
  }
  return out;
}

/** The area (sampled) that marked polygons cover more than once. */
function overlapOf(ks, grid) {
  if (ks.length < 2) return 0;
  const xs = ks.flatMap((it) => it.poly.map((p) => p.x)), ys = ks.flatMap((it) => it.poly.map((p) => p.y));
  let extra = 0;
  for (let x = Math.min(...xs) + grid / 2; x < Math.max(...xs); x += grid) {
    for (let y = Math.min(...ys) + grid / 2; y < Math.max(...ys); y += grid) {
      const n = ks.reduce((c, it) => c + (inPoly({ x, y }, it.poly) ? 1 : 0), 0);
      if (n > 1) extra += (n - 1) * grid * grid;
    }
  }
  return extra;
}

/** Index drawn lines (feet) in a coarse grid; near(p, dir) = a line runs by p, along dir. */
export function lineIndex(lines, cellSize = 2) {
  const cells = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const l of lines) {
    const x0 = Math.floor(Math.min(l.a.x, l.b.x) / cellSize), x1 = Math.floor(Math.max(l.a.x, l.b.x) / cellSize);
    const y0 = Math.floor(Math.min(l.a.y, l.b.y) / cellSize), y1 = Math.floor(Math.max(l.a.y, l.b.y) / cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = key(i, j); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(l); }
  }
  return {
    near(p, dir, tol = 0.4, maxDeg = 25) {
      const i = Math.floor(p.x / cellSize), j = Math.floor(p.y / cellSize);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        for (const l of cells.get(key(i + di, j + dj)) || []) {
          const vx = l.b.x - l.a.x, vy = l.b.y - l.a.y, L2 = vx * vx + vy * vy;
          if (L2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((p.x - l.a.x) * vx + (p.y - l.a.y) * vy) / L2));
          if (Math.hypot(l.a.x + t * vx - p.x, l.a.y + t * vy - p.y) > tol) continue;
          const cos = Math.abs(vx * dir.x + vy * dir.y) / Math.sqrt(L2);
          if (cos >= Math.cos((maxDeg * Math.PI) / 180)) return true;
        }
      }
      return false;
    },
  };
}

/**
 * Where a region's traced floor runs on past its marked areas, is the marked
 * edge drawn there? An estimator who tiles part of an open room (an entry pad
 * inside the door, the kitchen end of a kitchen / family room) stops the tile
 * in open floor, with nothing drawn along the edge: that is scope, not a
 * trace error. Where a drawn line runs along the edge the trace went through
 * it. Returns the marked edge (ft) the trace runs past, and how much of it has
 * nothing drawn along it.
 */
export function openEdge(ks, rs, lines, step = 0.25) {
  let past = 0, open = 0;
  const inAny = (p, polys) => polys.some((poly) => inPoly(p, poly));
  const roomPolys = rs.map((r) => r.poly), keyPolys = ks.map((k) => k.poly);
  for (const k of ks) {
    const P = k.poly;
    const sgn = Math.sign(P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p.x * q.y - q.x * p.y; }, 0)) || 1;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1e-6) continue;
      const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const out = { x: dir.y * sgn, y: -dir.x * sgn };   // outward normal
      for (let s = step / 2; s < L; s += step) {
        const p = { x: a.x + dir.x * s, y: a.y + dir.y * s };
        const q = { x: p.x + out.x * 0.6, y: p.y + out.y * 0.6 };
        if (!inAny(q, roomPolys) || inAny(q, keyPolys)) continue;
        past += step;
        if (!lines.near(p, dir)) open += step;
      }
    }
  }
  return { past, open };
}

/**
 * Score a trace against an estimator's marked areas (polygons in feet, the
 * trace's frame). An estimator draws one polygon over several rooms of one
 * finish, or several polygons in one room (the WC, the vanity, the shower
 * floor), so the unit scored is a region: marked areas and traced rooms that
 * overlap (over half of either, sampled on a 3" grid) joined into one. A
 * region is right when its traced floor equals its marked floor within
 * max(1 SF, 1%). Marked areas drawn over each other count once. A marked
 * area no traced room covers is missing; one under 5 SF isn't scored.
 *
 * With the sheet's drawn lines (`lines`, ft), a region whose traced floor
 * runs on past the marked area mostly across open floor (nothing drawn along
 * the marked edge: `openEdge`) is `scope` — part of a room tiled, the
 * estimator's choice, not something the walls can tell. `geo` scores the
 * rest: the regions the drawing itself bounds.
 */
export function scoreMarked(res, items, grid = 0.25, lines = null) {
  const out = { answers: 0, right: 0, close: 0, merged: 0, missing: 0, split: 0, silent: 0, wrong: [], keySf: 0, gotSf: 0, regions: 0 };
  out.scope = 0; out.geo = { answers: 0, right: 0, close: 0, silent: 0 };
  // every region, right or wrong: what was marked, what was traced, the traced rooms' perimeter
  // (an error / perimeter is the edge offset that would explain it)
  out.all = [];
  const idx = lines ? lineIndex(lines) : null;
  const boxes = res.rooms.map((r) => {
    const xs = r.poly.map((p) => p.x), ys = r.poly.map((p) => p.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const roomAt = (p) => res.rooms.findIndex((r, i) => p.x >= boxes[i][0] && p.x <= boxes[i][2] && p.y >= boxes[i][1] && p.y <= boxes[i][3] && inRoom(p, r));
  // (a sliver under 5 SF — a curb, a niche, a stray click — is no room's floor)
  const keys = items.filter((it) => !/deduct/i.test(it.subject) && it.sf >= 5);
  // overlap[k] = Map(room index → sampled area of key k inside it)
  const cell = grid * grid;
  const overlap = keys.map((it) => {
    const xs = it.poly.map((p) => p.x), ys = it.poly.map((p) => p.y);
    const m = new Map();
    let n = 0;
    for (let x = Math.min(...xs) + grid / 2; x < Math.max(...xs); x += grid) {
      for (let y = Math.min(...ys) + grid / 2; y < Math.max(...ys); y += grid) {
        const p = { x, y };
        if (!inPoly(p, it.poly)) continue;
        n++;
        const r = roomAt(p);
        if (r >= 0) m.set(r, (m.get(r) || 0) + cell);
      }
    }
    it.at = { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
    it.sampled = n * cell;
    return m;
  });
  // union-find over keys (k) and rooms (R + i)
  const R = keys.length, parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const join = (a, b) => { for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x); parent.set(find(a), find(b)); };
  keys.forEach((it, k) => {
    if (!parent.has(k)) parent.set(k, k);
    for (const [r, a] of overlap[k]) if (a > 0.5 * it.sampled || a > 0.5 * res.rooms[r].area) join(k, R + r);
  });
  const groups = new Map();
  for (const x of parent.keys()) { const g = find(x); if (!groups.has(g)) groups.set(g, { keys: [], rooms: [] }); (x < R ? groups.get(g).keys : groups.get(g).rooms).push(x < R ? keys[x] : res.rooms[x - R]); }
  for (const { keys: ks, rooms: rs } of groups.values()) {
    if (!ks.length) continue;
    out.regions++;
    // marked areas drawn over each other (a shower floor over the room's
    // floor) cover the floor once: their sum less the sampled overlap
    const n = ks.length, want = ks.reduce((a, it) => a + it.sf, 0) - overlapOf(ks, grid);
    out.answers += n; out.keySf += want;
    const label = ks.map((it) => `${it.subject || 'area'} ${it.sf}`).join(' + ').slice(0, 90);
    const geo = (k) => { out.geo.answers += n; if (k === 'right') out.geo.right += n; if (k === 'right' || k === 'close') out.geo.close += n; if (k === 'silent') out.geo.silent += n; };
    if (!rs.length) { out.missing += n; geo('wrong'); out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: 'no traced room', flagged: false }); continue; }
    // a floor that stops at the wall line across each doorway: a marked area
    // drawn through a door between two of its rooms takes in the doorway too
    const inRegion = new Set(rs.map((r) => r.id));
    const strips = res.options?.floorAtDoor === 'face'
      ? (res.openings || []).filter((o) => o.openingType !== 'window' && o.rooms?.every((id) => id && inRegion.has(id))).reduce((a, o) => a + (o.width || 0) * (o.t || 0), 0)
      : 0;
    const got = rs.reduce((a, r) => a + r.area, 0) + strips;
    out.gotSf += got;
    const perim = rs.reduce((a, r) => a + r.poly.reduce((s, p, i) => s + Math.hypot(r.poly[(i + 1) % r.poly.length].x - p.x, r.poly[(i + 1) % r.poly.length].y - p.y), 0), 0);
    out.all.push({ n, want: +want.toFixed(2), got: +got.toFixed(2), gotFaces: +rs.reduce((a, r) => a + (r.areaFaces ?? r.area), 0).toFixed(2), perim: +perim.toFixed(2), rooms: rs.length, names: rs.map((r) => r.name).join(' + ').slice(0, 60), flagged: rs.some((r) => r.status !== 'ok'), at: ks[0].at, subj: ks.map((k) => k.subject).join(' + ').slice(0, 60) });
    if (rs.length > 1) out.split += n;
    const d = Math.abs(got - want), flagged = rs.some((r) => r.status !== 'ok');
    const names = rs.map((r) => r.name).join(' + ').slice(0, 60);
    if (d <= Math.max(1, 0.01 * want)) { out.right += n; out.close += n; geo('right'); continue; }
    if (d <= Math.max(3, 0.03 * want)) { geo('close'); out.close += n; out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: `${names}: ${got.toFixed(1)} SF (${(((got - want) / want) * 100).toFixed(1)}%)`, near: true, flagged }); continue; }
    if (got > want) out.merged += n;
    if (!flagged) out.silent += n;
    // scope: the trace runs on past the marked edge across open floor
    let scope = false;
    if (idx && got > want) { const e = openEdge(ks, rs, idx); scope = e.open >= Math.max(1.5, 0.5 * e.past); }
    if (scope) out.scope += n; else geo(flagged ? 'wrong' : 'silent');
    out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: `${names}: ${got.toFixed(0)} SF (${(((got - want) / want) * 100).toFixed(0)}%)`, flagged, scope });
  }
  return out;
}

