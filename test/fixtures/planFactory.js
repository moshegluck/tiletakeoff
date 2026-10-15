// ============================================================
// planFactory.js — synthesize realistic architectural linework.
//
// Walls are unioned on a 1/4" grid and the BOUNDARY of the union is
// emitted as face lines — exactly how a CAD plan draws walls: outer
// faces run to the outer corner, inner faces stop at the inner corner,
// door gaps get jamb lines. Then we dirty it up like real PDFs:
// doubled traces, drafting gaps, overshoots, floor hatch, furniture.
// ============================================================

const RES = 48; // cells per foot (1/4")
const OFF = 2;  // ft of margin so exterior faces at negative coords aren't clipped

export function wallsToLines(walls, doors, W, H) {
  const nx = Math.round((W + 2 * OFF) * RES), ny = Math.round((H + 2 * OFF) * RES);
  const g = new Uint8Array(nx * ny);
  const fill = (x0, y0, x1, y1, v) => {
    const i0 = Math.max(0, Math.round((Math.min(x0, x1) + OFF) * RES)), i1 = Math.min(nx, Math.round((Math.max(x0, x1) + OFF) * RES));
    const j0 = Math.max(0, Math.round((Math.min(y0, y1) + OFF) * RES)), j1 = Math.min(ny, Math.round((Math.max(y0, y1) + OFF) * RES));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) g[j * nx + i] = v;
  };
  for (const w of walls) {
    const h = w.t / 2;
    if (w.y1 === w.y2) fill(Math.min(w.x1, w.x2) - (w.capA ?? h), w.y1 - h, Math.max(w.x1, w.x2) + (w.capB ?? h), w.y1 + h, 1);
    else fill(w.x1 - h, Math.min(w.y1, w.y2) - (w.capA ?? h), w.x1 + h, Math.max(w.y1, w.y2) + (w.capB ?? h), 1);
  }
  for (const d of doors) {
    const h = d.t / 2 + 0.01;
    if (d.axis === 'h') fill(d.s, d.c - h, d.s + d.w, d.c + h, 0);
    else fill(d.c - h, d.s, d.c + h, d.s + d.w, 0);
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : g[j * nx + i]);
  const lines = [];
  // horizontal boundary edges
  for (let j = 0; j <= ny; j++) {
    let start = null;
    for (let i = 0; i <= nx; i++) {
      const edge = i < nx && at(i, j) !== at(i, j - 1);
      if (edge && start === null) start = i;
      if (!edge && start !== null) {
        lines.push({ a: { x: start / RES - OFF, y: j / RES - OFF }, b: { x: i / RES - OFF, y: j / RES - OFF } });
        start = null;
      }
    }
  }
  for (let i = 0; i <= nx; i++) {
    let start = null;
    for (let j = 0; j <= ny; j++) {
      const edge = j < ny && at(i, j) !== at(i - 1, j);
      if (edge && start === null) start = j;
      if (!edge && start !== null) {
        lines.push({ a: { x: i / RES - OFF, y: start / RES - OFF }, b: { x: i / RES - OFF, y: j / RES - OFF } });
        start = null;
      }
    }
  }
  return lines;
}

const EXT = 8 / 12, INT = 4.5 / 12;

/** A 40' × 28' house with seven rooms and deliberate trouble spots. */
export function buildHousePlan({ messy = true } = {}) {
  const W = 40, H = 28;
  const walls = [
    // exterior (centerlines)
    { x1: 0, y1: 0, x2: 40, y2: 0, t: EXT }, { x1: 0, y1: 28, x2: 40, y2: 28, t: EXT },
    { x1: 0, y1: 0, x2: 0, y2: 28, t: EXT }, { x1: 40, y1: 0, x2: 40, y2: 28, t: EXT },
    // interior
    { x1: 0, y1: 16, x2: 40, y2: 16, t: INT },
    { x1: 12, y1: 0, x2: 12, y2: 16, t: INT },   // kitchen | living
    { x1: 24, y1: 0, x2: 24, y2: 16, t: INT },   // living | bedroom
    { x1: 12, y1: 16, x2: 12, y2: 28, t: INT },  // bath | hall
    { x1: 16, y1: 16, x2: 16, y2: 28, t: INT },  // hall | master
    { x1: 32, y1: 16, x2: 32, y2: 28, t: INT },  // master | wic
    // pony wall dead-ending inside the bath (the "in and out")
    { x1: 6, y1: 23, x2: 6, y2: 28, t: INT, capA: INT / 2, capB: 0 },
  ];
  const doors = [
    { axis: 'v', c: 12, s: 4, w: 8, t: INT, kind: 'cased' },             // kitchen ↔ living 8' cased
    { axis: 'v', c: 24, s: 11, w: 2 + 8 / 12, t: INT, hinge: 'start', swing: +1 }, // living ↔ bedroom
    { axis: 'h', c: 16, s: 13, w: 2.5, t: INT, hinge: 'start', swing: +1 },        // living ↔ hall
    { axis: 'v', c: 12, s: 18, w: 2.5, t: INT, hinge: 'start', swing: -1 },        // hall ↔ bath
    { axis: 'v', c: 16, s: 22, w: 2 + 8 / 12, t: INT, hinge: 'start', swing: +1 }, // hall ↔ master
    { axis: 'v', c: 32, s: 20, w: 4, t: INT, kind: 'bifold' },          // master ↔ wic
    { axis: 'h', c: 0, s: 16, w: 3, t: EXT, hinge: 'start', swing: +1 },           // front door (living)
    { axis: 'h', c: 16, s: 3, w: 5, t: INT, kind: 'cased' },            // BAD: 5' opening kitchen ↔ bath
  ];
  let lines = wallsToLines(walls, doors, W, H);
  const arcs = [];
  for (const d of doors) {
    if (!d.hinge) continue;
    const face = d.c + (d.t / 2) * d.swing;           // room-side face
    if (d.axis === 'h') {
      const hinge = { x: d.s, y: face };
      arcs.push(quarterArc(hinge, { x: d.w, y: 0 }, { x: 0, y: d.w * d.swing }));
      lines.push({ a: hinge, b: { x: hinge.x, y: hinge.y + d.w * d.swing } }); // leaf
    } else {
      const hinge = { x: face, y: d.s };
      arcs.push(quarterArc(hinge, { x: 0, y: d.w }, { x: d.w * d.swing, y: 0 }));
      lines.push({ a: hinge, b: { x: hinge.x + d.w * d.swing, y: hinge.y } });
    }
  }
  // a 12" column in the living room, drawn as a closed square
  lines.push(...rect(18, 7, 1, 1));
  // furniture: a bed in the master (single thin lines, 5'×6'8")
  lines.push(...rect(21, 20, 5, 6.67));
  // kitchen counter run (24" deep) + sink bowl
  lines.push({ a: { x: 0.34, y: 2.33 }, b: { x: 9, y: 2.33 } });
  lines.push(...rect(4, 0.8, 2, 1.3));

  const texts = [
    { str: 'KITCHEN', x: 6, y: 9 }, { str: 'LIVING', x: 19, y: 11 }, { str: 'BEDROOM', x: 32, y: 8 },
    { str: 'BATH', x: 3, y: 21 }, { str: 'HALL', x: 14, y: 25 }, { str: 'MASTER', x: 24, y: 18 }, { str: 'BEDROOM', x: 24, y: 18.8 },
    { str: 'W.I.C.', x: 36, y: 22 },
    { str: "11'-6\"", x: 6, y: 10 }, { str: "12'-0\"", x: 18, y: 12 },
    { str: 'FLOOR PLAN', x: 4, y: 30 }, { str: "SCALE: 1/4\" = 1'-0\"", x: 4, y: 31 },
    { str: "2'-8\" x 6'-8\"", x: 25, y: 12 }, { str: "2'-6\" x 6'-8\"", x: 13, y: 19 }, { str: "3'-0\" x 6'-8\"", x: 17, y: 1.5 },
  ];

  if (messy) {
    // floor hatch: 12" tile grid in the bath (evenly spaced → must be rejected)
    for (let x = 1; x < 11.5; x += 1) lines.push({ a: { x, y: 16.3 }, b: { x, y: 27.6 } });
    for (let y = 17; y < 27.5; y += 1) lines.push({ a: { x: 0.4, y }, b: { x: 11.8, y } });
    // doubled trace: every 7th line drawn twice, 0.2" off
    const dup = lines.filter((_, i) => i % 7 === 0).map((l) => ({ a: { x: l.a.x + 0.016, y: l.a.y + 0.016 }, b: { x: l.b.x + 0.016, y: l.b.y + 0.016 } }));
    lines.push(...dup);
    // drafting gap: break the bedroom's inner east face with a 1/2" gap
    lines = breakLine(lines, (l) => Math.abs(l.a.x - (40 - EXT / 2)) < 1e-6 && l.a.y < 8 && l.b.y > 8, 8, 0.04);
    // overshoot: kitchen north inner face extends 3" past the corner
    lines.push({ a: { x: -0.5, y: EXT / 2 }, b: { x: 0.34, y: EXT / 2 } });
  }

  return { W, H, lines, arcs, texts, walls, doors };
}

function rect(x, y, w, h) {
  return [
    { a: { x, y }, b: { x: x + w, y } }, { a: { x: x + w, y }, b: { x: x + w, y: y + h } },
    { a: { x: x + w, y: y + h }, b: { x, y: y + h } }, { a: { x, y: y + h }, b: { x, y } },
  ];
}

const K = 0.5522847498;
function quarterArc(c, v0, v1) {
  // arc from c+v0 to c+v1 (perpendicular radius vectors), as one cubic
  const p0 = { x: c.x + v0.x, y: c.y + v0.y }, p3 = { x: c.x + v1.x, y: c.y + v1.y };
  const p1 = { x: p0.x + v1.x * K, y: p0.y + v1.y * K };
  const p2 = { x: p3.x + v0.x * K, y: p3.y + v0.y * K };
  return { pieces: [{ p0, p1, p2, p3 }], c, r: Math.hypot(v0.x, v0.y) };
}

function breakLine(lines, pred, at, gap) {
  const out = [];
  for (const l of lines) {
    if (!pred(l)) { out.push(l); continue; }
    out.push({ a: l.a, b: { x: l.a.x, y: at - gap / 2 } });
    out.push({ a: { x: l.a.x, y: at + gap / 2 }, b: l.b });
  }
  return out;
}
