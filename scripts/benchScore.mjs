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
export const inRoom = (p, r) => inPoly(p, r.poly) && !(r.holes || []).some((h) => inPoly(p, h));

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
    // room is the takeoff's own floor (to the door's centre)
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

/**
 * Score a trace against an estimator's marked areas (polygons in feet, the
 * trace's frame). An estimator draws one polygon over several rooms of one
 * finish, or several polygons in one room (the WC, the vanity, the shower
 * floor), so the unit scored is a region: marked areas and traced rooms that
 * overlap (over half of either, sampled on a 3" grid) joined into one. A
 * region is right when its traced floor equals its marked floor within
 * max(1 SF, 1%). A marked area no traced room covers is missing.
 */
export function scoreMarked(res, items, grid = 0.25) {
  const out = { answers: 0, right: 0, close: 0, merged: 0, missing: 0, split: 0, silent: 0, wrong: [], keySf: 0, gotSf: 0, regions: 0 };
  const boxes = res.rooms.map((r) => {
    const xs = r.poly.map((p) => p.x), ys = r.poly.map((p) => p.y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const roomAt = (p) => res.rooms.findIndex((r, i) => p.x >= boxes[i][0] && p.x <= boxes[i][2] && p.y >= boxes[i][1] && p.y <= boxes[i][3] && inRoom(p, r));
  const keys = items.filter((it) => !/deduct/i.test(it.subject));
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
    const n = ks.length, want = ks.reduce((a, it) => a + it.sf, 0);
    out.answers += n; out.keySf += want;
    const label = ks.map((it) => `${it.subject || 'area'} ${it.sf}`).join(' + ').slice(0, 90);
    if (!rs.length) { out.missing += n; out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: 'no traced room', flagged: false }); continue; }
    const got = rs.reduce((a, r) => a + r.area, 0);
    out.gotSf += got;
    if (rs.length > 1) out.split += n;
    const d = Math.abs(got - want), flagged = rs.some((r) => r.status !== 'ok');
    const names = rs.map((r) => r.name).join(' + ').slice(0, 60);
    if (d <= Math.max(1, 0.01 * want)) { out.right += n; out.close += n; continue; }
    if (d <= Math.max(3, 0.03 * want)) { out.close += n; out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: `${names}: ${got.toFixed(1)} SF (${(((got - want) / want) * 100).toFixed(1)}%)`, near: true, flagged }); continue; }
    if (got > want) out.merged += n;
    if (!flagged) out.silent += n;
    out.wrong.push({ name: label, sf: +want.toFixed(1), at: ks[0].at, why: `${names}: ${got.toFixed(0)} SF (${(((got - want) / want) * 100).toFixed(0)}%)`, flagged });
  }
  return out;
}

