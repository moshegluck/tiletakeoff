import { describe, it, expect } from 'vitest';
import { PDFDocument, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath, rectangle, fill, stroke, setFillingRgbColor, setLineWidth } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageVectors } from '../src/lib/pdfVectors.js';

// Revit fills a wall's cut by clipping to the wall's outline and filling a
// rectangle through it: on a 45° wall the rectangle's edges are nowhere on the
// sheet (the nursing facility, 03-15-24 — they paired into walls across rooms).
async function clippedFill() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.pushOperators(
    pushGraphicsState(),
    // a 45° wall strip, its faces 8 pt apart along x, from y = 100 to y = 200
    moveTo(96, 100), lineTo(196, 200), lineTo(204, 200), lineTo(104, 100), closePath(), clip(), endPath(),
    setFillingRgbColor(0.75, 0.75, 0.75), rectangle(90, 90, 120, 120), fill(),
    popGraphicsState(),
    // drawn after the restore: the clip is gone
    setLineWidth(1), moveTo(20, 20), lineTo(380, 20), stroke(),
    // a stroke under a clip shows only inside it
    pushGraphicsState(), rectangle(250, 250, 50, 50), clip(), endPath(),
    moveTo(200, 275), lineTo(350, 275), stroke(),
    popGraphicsState(),
  );
  return doc.save();
}

describe('clipping paths: only what shows is drawing', () => {
  it("a fill clipped to a wall's outline gives the outline, not the rectangle; a stroke is cut to its clip", async () => {
    const pdf = await pdfjs.getDocument({ data: (await clippedFill()).slice(), disableFontFace: true, verbosity: 0 }).promise;
    const ev = await extractPageVectors(await pdf.getPage(1), 1, pdfjs.OPS);
    const len = (l) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    const fills = ev.lines.filter((l) => l.filled);
    // no edge of the rectangle (x or y = 90 / 210) survives
    expect(fills.some((l) => [l.a.x, l.b.x].every((x) => Math.abs(x - 90) < 0.5 || Math.abs(x - 210) < 0.5))).toBe(false);
    expect(fills.some((l) => [l.a.y, l.b.y].every((y) => Math.abs(y - 310) < 0.5 || Math.abs(y - 190) < 0.5))).toBe(false);
    // the wall's two 45° faces do, each about 141 pt long
    const diag = fills.filter((l) => Math.abs(Math.abs(l.b.x - l.a.x) - Math.abs(l.b.y - l.a.y)) < 0.5 && len(l) > 100);
    expect(diag.length).toBe(2);
    // the line drawn after the restore is whole; the clipped one runs 250 → 300 only
    expect(ev.lines.some((l) => !l.filled && len(l) > 359)).toBe(true);
    const cut = ev.lines.filter((l) => !l.filled && Math.abs(l.a.y - 125) < 0.5);
    expect(cut.length).toBe(1);
    expect(Math.min(cut[0].a.x, cut[0].b.x)).toBeCloseTo(250, 1);
    expect(Math.max(cut[0].a.x, cut[0].b.x)).toBeCloseTo(300, 1);
  });
});
