// ============================================================
// markedKeys.mjs — read an estimator's marked plan as an answer key.
//
// Artistic marks its takeoffs in Bluebeam: each tiled area is a measured
// polygon (its /Subj names the takeoff item — "Half Tiled Bathroom",
// "Vanity Floor", "Shower Floor", "Floor Deduction" …; its /Contents holds
// the measured "A = 41 sf"), fully tiled walls are measured polylines, and
// doors / fixtures are count marks. Those markups are the answer the trace
// is scored against (scripts/bench.mjs, sheets with "marked": true). The
// trace itself never sees them: pdfVectors.js leaves annotations out of
// the drawing.
// ============================================================
import { PDFDocument, PDFName, PDFArray, PDFNumber, PDFDict } from 'pdf-lib';

const num = (o) => (o instanceof PDFNumber ? o.asNumber() : Number(o?.toString?.()));
const text = (o) => (o && typeof o.decodeText === 'function' ? o.decodeText() : o ? String(o) : '');
const arr = (o) => (o instanceof PDFArray ? o.asArray() : []);
const ftIn = (s) => { const m = /(\d+)'-(\d+)"/.exec(s || ''); return m ? +m[1] + +m[2] / 12 : null; };

/**
 * @param {Uint8Array} bytes  the marked PDF
 * @returns {Promise<{ page: number, items: object[] }[]>} per page (1-based): every
 *   Polygon / PolyLine / Line markup — { type, subject, contents, sf, perimeter,
 *   length, fill, stroke, pts: [[x,y]…] in PDF points (unrotated user space) }
 */
export async function readMarkedKeys(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  return doc.getPages().map((page, i) => {
    const items = [];
    const annots = page.node.lookup(PDFName.of('Annots'));
    for (const ref of arr(annots)) {
      const a = ctx.lookup(ref);
      if (!(a instanceof PDFDict)) continue;
      const type = a.get(PDFName.of('Subtype'))?.toString().slice(1);
      if (!['Polygon', 'PolyLine', 'Line'].includes(type)) continue;
      const contents = text(a.lookup(PDFName.of('Contents'))).replace(/\r/g, ' | ');
      const m = /A = ([\d,.]+) sf|^([\d,.]+) sf/.exec(contents);
      const verts = arr(a.lookup(PDFName.of(type === 'Line' ? 'L' : 'Vertices'))).map(num);
      const L = /L = (\d+'-\d+")/.exec(contents);
      items.push({
        type,
        subject: text(a.lookup(PDFName.of('Subj'))),
        contents,
        sf: m ? +(m[1] || m[2]).replace(/,/g, '') : null,
        perimeter: L ? ftIn(L[1]) : null,
        length: type !== 'Polygon' ? ftIn(contents) : null,
        fill: arr(a.lookup(PDFName.of('IC'))).map(num),
        stroke: arr(a.lookup(PDFName.of('C'))).map(num),
        pts: Array.from({ length: Math.floor(verts.length / 2) }, (_, k) => [verts[2 * k], verts[2 * k + 1]]),
        ptToFt: num(a.lookup(PDFName.of('Measure'))?.lookup?.(PDFName.of('X'))?.lookup?.(0)?.lookup?.(PDFName.of('C'))) || null,
      });
    }
    // the scale the markups were calibrated to (feet per PDF point), from the area measurements
    const cal = items.filter((it) => it.type === 'Polygon' && it.sf != null && it.ptToFt).map((it) => it.ptToFt);
    return { page: i + 1, items, ptToFt: cal.length ? cal.sort((p, q) => p - q)[Math.floor(cal.length / 2)] : null };
  });
}

/** The marked floor areas: measured polygons with an area, not count marks or legend swatches. */
export const areaItems = (items) => items.filter((it) => it.type === 'Polygon' && it.sf != null && !/count/i.test(it.subject) && it.pts.length >= 3);
