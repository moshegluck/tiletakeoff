import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors } from '../src/lib/pdfVectors.js';
import { readMarkedKeys, areaItems } from '../scripts/markedKeys.mjs';
import { scoreMarked } from '../scripts/benchScore.mjs';

// An estimator's marked plan: the architect's drawing, AutoCAD's invisible
// "AutoCAD SHX Text" annotations carrying its words, and Bluebeam area
// polygons on top (the takeoff — the answer key, never the drawing).
async function markedPlan() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawLine({ start: { x: 50, y: 50 }, end: { x: 350, y: 50 }, thickness: 2 });
  const ctx = doc.context;
  const ap = ctx.register(ctx.stream('0 0 1 RG 3 w 100 100 m 300 100 l 300 200 l 100 200 l h S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300] }));
  const poly = ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', Rect: [100, 100, 300, 200], Vertices: [100, 100, 300, 100, 300, 200, 100, 200],
    Contents: PDFString.of('A = 41 sf'), Subj: PDFString.of('Half Tiled Bathroom'), IC: [1, 1, 0.5], C: [0, 0, 1],
    Measure: { Type: 'Measure', Subtype: 'RL', X: [{ Type: 'NumberFormat', C: 0.0740741 }] }, AP: { N: ap },
  });
  const count = ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Rect: [10, 10, 20, 20], Vertices: [10, 10, 20, 10, 20, 20], Contents: PDFString.of('1'), Subj: PDFString.of('Count Measurement') });
  const shx = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [150, 140, 250, 160], Contents: PDFString.of('BATHROOM'), T: PDFString.of('AutoCAD SHX Text') });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(poly), ctx.register(count), ctx.register(shx)]));
  return doc.save();
}

describe('marked plans (an estimator\'s takeoff on the architect\'s drawing)', () => {
  it('the trace reads the drawing and the SHX words, never the markups', async () => {
    const bytes = await markedPlan();
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 }).promise;
    const ev = await extractPageVectors(await pdf.getPage(1), 2, pdfjs.OPS);
    // the drawn line is there (y = 300 - 50 at 2x = 500 px); the markup's square (y 200..400 px) is not
    expect(ev.lines.some((l) => Math.abs(l.a.y - 500) < 2 && Math.abs(l.b.y - 500) < 2)).toBe(true);
    expect(ev.lines.some((l) => l.a.y > 190 && l.a.y < 410 && l.b.y > 190 && l.b.y < 410)).toBe(false);
    const t = ev.texts.find((x) => x.str === 'BATHROOM');
    expect(t).toBeTruthy();
    expect(t.x).toBeCloseTo(400, 0);
    expect(t.y).toBeCloseTo(300, 0);
  });

  it("reads the markups as answers: the item, its measured area, its outline, the calibration", async () => {
    const [p] = await readMarkedKeys(await markedPlan());
    const areas = areaItems(p.items);
    expect(areas.length).toBe(1);   // the count mark isn't a floor area
    expect(areas[0]).toMatchObject({ subject: 'Half Tiled Bathroom', sf: 41, fill: [1, 1, 0.5] });
    expect(areas[0].pts.length).toBe(4);
    expect(p.ptToFt).toBeCloseTo(0.0740741, 6);
  });

  it('scores regions: one marked area over two traced rooms, two marked areas in one room', () => {
    const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const room = (id, poly, area, status = 'ok') => ({ id, name: id, poly, area, status });
    const res = { rooms: [room('A', sq(0, 0, 10, 10), 100), room('B', sq(10, 0, 20, 10), 100), room('C', sq(0, 20, 10, 30), 100)] };
    const items = [
      { subject: 'Foyer', sf: 200, poly: sq(0, 0, 20, 10) },             // spans A and B: right
      { subject: 'Half Tiled Bathroom', sf: 60, poly: sq(0, 20, 6, 30) }, // C holds both: 60 + 30 = 90 vs 100
      { subject: 'Vanity Floor', sf: 30, poly: sq(6, 20, 9, 30) },
      { subject: 'Floor Deduction', sf: 10, poly: sq(0, 20, 1, 30) },    // not a floor area of its own
    ];
    const s = scoreMarked(res, items);
    expect(s.regions).toBe(2);
    expect(s.right).toBe(1);
    expect(s.silent).toBe(2);   // C is 11% off and carries no flag
  });

  it('floors stop at the wall line across a doorway; a marked area drawn through the door takes in the doorway', () => {
    const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    // a bath (A) and its closet (B) behind a 5" wall with a 3' door; the estimator marked both as one
    const t = 5 / 12;
    const res = {
      options: { floorAtDoor: 'face' },
      rooms: [{ id: 'A', name: 'BATH', poly: sq(0, 0, 8, 10), area: 80, status: 'ok' }, { id: 'B', name: 'CL', poly: sq(8 + t, 0, 12, 10), area: 10 * (4 - t), status: 'ok' }],
      openings: [{ openingType: 'door', rooms: ['A', 'B'], width: 3, t }],
    };
    const s = scoreMarked(res, [{ subject: 'Bath', sf: 80 + 10 * (4 - t) + 3 * t, poly: sq(0, 0, 12, 10) }]);
    expect(s.right).toBe(1);
    // floors to the door's centre already hold the doorway: nothing is added
    const centre = scoreMarked({ ...res, options: { floorAtDoor: 'center' } }, [{ subject: 'Bath', sf: 80 + 10 * (4 - t), poly: sq(0, 0, 12, 10) }]);
    expect(centre.right).toBe(1);
  });

  it("a shower floor drawn over the room's floor counts once (Saddle River's mikvah pools)", () => {
    const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const res = { rooms: [{ id: 'A', name: 'MIKVAH', poly: sq(0, 0, 16, 24), area: 384, status: 'ok' }] };
    const items = [
      { subject: 'Mikvah | Dressing Room', sf: 384, poly: sq(0, 0, 16, 24) },
      { subject: 'Shower Floor', sf: 120, poly: sq(0, 0, 10, 12) },   // the pool, inside the room's polygon
    ];
    const s = scoreMarked(res, items);
    expect(s.regions).toBe(1);
    expect(s.right).toBe(2);
    expect(s.keySf).toBeCloseTo(384, 0);
  });
});
