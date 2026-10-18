// ============================================================
// dimScale.js — the scale a sheet is really drawn at, measured off its own
// dimension strings.
//
// A scale note can be wrong (copied from another sheet) and a sheet can be
// plotted at no standard scale at all (fit to the paper). Its dimension
// strings can't be: each states a length, and its dimension line spans it
// between the two extension lines that cross it on either side of the
// text. Every dimension votes value / span; the plan's dimensions agree.
// ============================================================

/** A dimension string's length in feet (8'-6", 12'-6 1/2", SHX's 8'-8 "12" = 8'-8 1/2"), or null. */
export function dimFeet(str) {
  const s = String(str || '').replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").trim();
  const m = /^(\d{1,3})\s*'\s*-?\s*(\d{1,2})?(?:\s+(\d+)\/(\d+)|\s*"(\d)(\d{1,2})")?\s*"?$/.exec(s);
  if (!m) return null;
  let inch = +(m[2] || 0);
  if (m[3]) inch += +m[3] / +m[4];
  if (m[5]) inch += +m[5] / +m[6];
  if (inch >= 12) return null;
  return +m[1] + inch / 12;
}

/**
 * Votes from the sheet's dimension strings for its feet per paper inch.
 * @param {{str,x,y,h?,rot?}[]} texts   px (rendered image)
 * @param {{a,b}[]} lines               px
 * @param {number} pxPerInch            render px per paper inch (144 at 2×)
 * @returns {{ fpi: number, votes: number, of: number, agree: number } | null}
 *   fpi the sheet's dimensions agree on, how many voted for it (within 1%),
 *   how many dimensions were measured in all
 */
export function dimensionScale(texts, lines, pxPerInch) {
  const dims = texts.map((t) => ({ t, v: dimFeet(t.str) })).filter((d) => d.v && d.v >= 2);
  if (!dims.length) return null;
  // lines by axis, for the dimension lines (along the text) and extension lines (across it)
  const along = [[], []];   // 0: horizontal, 1: vertical
  for (const l of lines) {
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, L = Math.hypot(dx, dy);
    if (L < 4) continue;
    if (Math.abs(dy) < 0.01 * L) along[0].push({ c: (l.a.y + l.b.y) / 2, s0: Math.min(l.a.x, l.b.x), s1: Math.max(l.a.x, l.b.x) });
    else if (Math.abs(dx) < 0.01 * L) along[1].push({ c: (l.a.x + l.b.x) / 2, s0: Math.min(l.a.y, l.b.y), s1: Math.max(l.a.y, l.b.y) });
  }
  const votes = [];
  for (const { t, v } of dims) {
    const ax = (t.rot || 0) >= 45 && (t.rot || 0) < 135 ? 1 : 0;   // text up the sheet → vertical dimension
    const tc = ax ? t.x : t.y, ts = ax ? t.y : t.x, h = t.h || 10;
    // the dimension line: along the text, just beside it, running under its middle
    let dl = null;
    for (const l of along[ax]) {
      const off = Math.abs(l.c - tc);
      if (off > 2 * h || ts < l.s0 || ts > l.s1) continue;
      if (!dl || off < dl.off) dl = { ...l, off };
    }
    if (!dl) continue;
    // its ends: the extension lines crossing it nearest the text on each side
    let lo = -Infinity, hi = Infinity;
    for (const e of along[1 - ax]) {
      if (e.s0 > dl.c + 1 || e.s1 < dl.c - 1) continue;      // doesn't cross the dimension line
      if (e.c < ts - 0.5 && e.c > lo) lo = e.c;
      if (e.c > ts + 0.5 && e.c < hi) hi = e.c;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    const span = hi - lo;
    if (span < 2 * h) continue;
    votes.push((v / span) * pxPerInch);
  }
  if (!votes.length) return null;
  let best = null;
  for (const f of votes) {
    const agree = votes.filter((g) => Math.abs(g / f - 1) <= 0.01);
    if (!best || agree.length > best.votes) best = { fpi: agree.reduce((a, g) => a + g, 0) / agree.length, votes: agree.length };
  }
  return { fpi: best.fpi, votes: best.votes, of: votes.length, agree: best.votes / votes.length };
}

/** Door tags ("3'0" X 6'8"", "2'-8" x 6'-8"") with the leaf width they state (ft). */
export function doorTags(texts) {
  const out = [];
  for (const t of texts) {
    const s = String(t.str || '').replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").trim();
    const m = /^(\d)\s*'\s*-?\s*(\d{1,2})\s*"?\s*[xX×]\s*([5-9])\s*'\s*-?\s*(\d{1,2})?\s*"?$/.exec(s);
    if (!m || +m[2] >= 12) continue;
    const w = +m[1] + +m[2] / 12;
    if (w >= 1.5 && w <= 4) out.push({ x: t.x, y: t.y, w, str: t.str });
  }
  return out;
}

/**
 * The scale a sheet's doors say it's drawn at: each door tag stands in the
 * swing of the door it names (its leaf width), and the swing's radius on
 * paper IS that leaf. Every tag in a swing votes width / radius; the votes
 * that agree (within 4% of their median) are the sheet's feet per inch.
 * @param {{x,y,w}[]} tags   px (rendered image)
 * @param {{c,r,p0,p3}[]} arcs  door swings, px
 * @param {number} pxPerInch
 * @returns {{ fpi: number, votes: number, of: number } | null}
 */
export function doorTagScale(tags, arcs, pxPerInch) {
  const cr = (p, q) => p.x * q.y - p.y * q.x;
  const votes = [];
  for (const t of tags) {
    let best = null, bd = Infinity;
    for (const a of arcs) {
      const vt = { x: t.x - a.c.x, y: t.y - a.c.y };
      const d = Math.hypot(vt.x, vt.y) / a.r;
      if (d > 1.6) continue;
      // inside the swing's sector, within its radius, is where a door's tag sits
      const v0 = { x: a.p0.x - a.c.x, y: a.p0.y - a.c.y }, v3 = { x: a.p3.x - a.c.x, y: a.p3.y - a.c.y };
      const s = Math.sign(cr(v0, v3));
      const inSector = Math.sign(cr(v0, vt)) === s && Math.sign(cr(vt, v3)) === s && d <= 1.1;
      const score = d + (inSector ? 0 : 1);
      if (score < bd) { bd = score; best = a; }
    }
    if (best && bd <= 1.6) votes.push(t.w / (best.r / pxPerInch));
  }
  if (!votes.length) return null;
  const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const m = med(votes);
  const agree = votes.filter((v) => Math.abs(v / m - 1) <= 0.04);
  return { fpi: med(agree), votes: agree.length, of: votes.length };
}
