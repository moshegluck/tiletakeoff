// ============================================================
// sheetScale.js — which scale the floor plan on a sheet is drawn at.
//
// A sheet carries many scale notes: the plan's, and one under every detail,
// section and enlarged plan beside it (often more of those than of the
// plan). The plan's own note sits with the plan's title ("BASEMENT PLAN",
// "FIRST FLOOR PLAN", "FLOOR FINISH PLAN"), so that's the one taken.
// Notes are read text by text (a view's number bubble next to its note is
// not part of it), including AutoCAD's SHX text, which flattens a stacked
// fraction: SCALE:  "=1'-0"14"=1'-0"  is 1/4" = 1'-0".
// ============================================================

/** Paper inches per foot for each architectural scale id, and back. */
const ARCH = { '1/32': 1 / 32, '1/16': 1 / 16, '3/32': 3 / 32, '1/8': 1 / 8, '3/16': 3 / 16, '1/4': 1 / 4, '3/8': 3 / 8, '1/2': 1 / 2, '3/4': 3 / 4, '1': 1, '1-1/2': 1.5, '3': 3 };
const ID_OF = new Map(Object.entries(ARCH).map(([id, v]) => [+v.toFixed(5), id]));

const norm = (s) => String(s || '').replace(/[″”“]/g, '"').replace(/[′’‘]/g, "'").replace(/\s+/g, ' ').trim();

/** A flattened stacked fraction's digits ("14", "316") as a value: 1/4, 3/16. */
function stacked(digits) {
  for (let k = 1; k < digits.length; k++) {
    const n = +digits.slice(0, k), d = +digits.slice(k);
    if (d >= 2 && d <= 64 && (d & (d - 1)) === 0 && n > 0 && n < d) return n / d;
  }
  return null;
}

/** The architectural scale a note states (an ARCH id), or an engineering one ("e20"), or null. */
export function readScale(str) {
  const s = norm(str);
  // SHX writes the line with the stacked fraction left out ("SCALE: 1 "=1'-0"")
  // and then again with the fraction's digits in its place, sometimes after
  // the rest of the line ("…3,600 SF14"=1'-0"")
  let m = /(\d*)\s*"\s*=\s*1'\s*-?\s*0?"/.exec(s);
  if (m) {
    const rest = s.slice(m.index + m[0].length);
    const f = /(?:^|[^\d/])(\d{2,3})\s*"\s*=\s*1'/.exec(rest);
    const frac = f ? stacked(f[1]) : null;
    const v = (m[1] ? +m[1] : 0) + (frac || 0);
    if (frac != null && ID_OF.has(+v.toFixed(5))) return ID_OF.get(+v.toFixed(5));
  }
  m = /(?:^|[^\d/])(\d+(?:[ -]\d+\/\d+|\/\d+)?)\s*"\s*[=\-–—]\s*1\s*'\s*-?\s*0?\s*"?/.exec(s);
  if (m) {
    const raw = m[1];
    const mixed = /^(\d+)[ -](\d+)\/(\d+)$/.exec(raw), frac = /^(\d+)\/(\d+)$/.exec(raw);
    const v = mixed ? +mixed[1] + +mixed[2] / +mixed[3] : frac ? +frac[1] / +frac[2] : +raw;
    if (ID_OF.has(+v.toFixed(5))) return ID_OF.get(+v.toFixed(5));
  }
  m = /1\s*"\s*=\s*(\d+)\s*'/.exec(s);
  if (m && +m[1] >= 10) return `e${m[1]}`;
  return null;
}

/**
 * Every scale note on the sheet, with where it is.
 * @param {{str:string,x:number,y:number,h?:number}[]} texts
 * @returns {{ id: string, x: number, y: number, h: number, str: string }[]}
 */
export function scaleNotes(texts) {
  const out = [];
  texts.forEach((t, i) => {
    let id = readScale(t.str);
    let str = t.str;
    // "SCALE:" alone: its value is the next text along its line
    if (!id && /^\s*scale\s*:?\s*$/i.test(t.str)) {
      const h = t.h || 10;
      let best = -1, bd = Infinity;
      for (let j = 0; j < texts.length; j++) {
        const u = texts[j];
        if (j === i || Math.abs(u.y - t.y) > h * 0.6 || u.x <= t.x) continue;
        const d = u.x - t.x;
        if (d < h * 12 && d < bd && readScale(u.str)) { best = j; bd = d; }
      }
      if (best >= 0) { id = readScale(texts[best].str); str = `${t.str} ${texts[best].str}`; }
    }
    if (id) out.push({ id, x: t.x, y: t.y, h: t.h || 10, str: norm(str) });
  });
  return out;
}

/**
 * The titles of the plan views on the sheet: "BASEMENT PLAN", "FIRST FLOOR
 * PLAN", "FLOOR FINISH PLAN" — not a note that mentions a plan ("SEE
 * FOUNDATION PLAN FOR SIZE"), nor a detail or section of one.
 */
export function planTitles(texts) {
  return texts.filter((t) => {
    const s = norm(t.str).toUpperCase();
    if (!/\bPLAN\b/.test(s) || s.length > 45) return false;
    if (/\b(SEE|REFER|FOR|DETAIL|SECTION|ELEVATION|NOTE|KEY|SITE|ROOF|REFLECTED|CEILING|RCP|DEMO(LITION)?|ELECTRICAL|PLUMBING|MECHANICAL|FRAMING|STRUCTURAL|ENLARGED)\b/.test(s)) return false;
    return /^[A-Z0-9 &.,'/\-–—#()]+$/.test(s);
  });
}

/**
 * The floor plan's scale. The note nearest the plan's title wins (the
 * largest title when there are several, a title-block repeat being smaller);
 * else the note most of the sheet's notes agree on.
 * @returns {{ id: string, how: 'title'|'common', title?: string, notes: number } | null}
 */
export function planScale(texts) {
  const notes = scaleNotes(texts);
  if (!notes.length) return null;
  const titles = planTitles(texts).sort((a, b) => (b.h || 0) - (a.h || 0));
  for (const ti of titles) {
    const h = ti.h || 10;
    let best = null, bd = Infinity;
    for (const n of notes) {
      const d = Math.hypot(n.x - ti.x, n.y - ti.y);
      if (d < bd) { bd = d; best = n; }
    }
    // a view's scale is printed with its title: under it or beside it
    if (best && bd <= Math.max(h * 14, 400)) return { id: best.id, how: 'title', title: norm(ti.str), notes: notes.length };
  }
  const count = new Map();
  for (const n of notes) count.set(n.id, (count.get(n.id) || 0) + 1);
  const [id] = [...count].sort((a, b) => b[1] - a[1])[0];
  return { id, how: 'common', notes: notes.length };
}
