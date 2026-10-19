import { describe, it, expect } from 'vitest';
import { wallParts, baseTakeoff, roomAccents } from '../src/engine/takeoffRules.js';
import { quantityList } from '../src/lib/quantityList.js';
import { buildProposal, tileLines, ARTISTIC_RATES } from '../src/lib/proposal.js';
import { summarize, roomMarks, markContext } from '../src/lib/markedPdf.js';
import { estimateProject } from '../src/engine/estimate.js';

// The surfaces Moshe's skills price and order on their own lines: the
// shower floors' tile, accent walls (tub / vanity BW: 30% waste, their run
// off the rest of the walls), tiled base (LF × its height, the room's waste
// + 10 points, NA until its tile is picked) and pattern labor (Willow
// Tree's checkerboard foyer: 162 SF @ $8.75 on one line).
const sq = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const room = (name, pts, extra = {}) => ({ id: name, name, points: pts, assigned: [], ...extra });
const mat = (id, type, name, tw, th, extra = {}) => ({ id, type, name, tw, th, grout: 0.125, pattern: 'grid', waste: 10, price: 0, priceUnit: 'sf', sfPerBox: 15, ...extra });

const MATS = [
  mat('F', 'floor', '24X48 Floor', 24, 48), mat('W', 'wall', '12X24 Wall', 12, 24), mat('ACC', 'wall', '16X48 Deco', 16, 48),
  mat('PEB', 'floor', 'Pebbles 254', 12, 12), mat('HB', 'floor', '12X24 Herringbone', 12, 24, { pattern: 'herringbone' }),
];
// a 10x5 tub bath, 9' fully tiled, one door; the tub's back wall (5 LF) in a deco tile
const TUB = room('TUB BATHROOM', sq(0, 0, 10, 5), {
  assigned: ['F', 'W'], wallHeight: 9, fixtures: { doors: 1, tubs: 1 },
  finish: { accents: [{ id: 'a1', label: 'Tub BW', lf: 5, materialId: 'ACC' }] },
});
// a 9.25x5 shower bath, its shower floor in pebbles
const SHOWER = room('GUEST SHOWER BATHROOM', sq(20, 0, 9.25, 5), {
  assigned: ['F', 'W'], wallHeight: 10, fixtures: { doors: 1, showers: [{ w: 5, d: 2.75 }] }, finish: { showerFloorMaterialId: 'PEB' },
});
// a 20x6 hallway: 24X48 floor, a 6" base in the same tile, two doors
const HALL = room('HALLWAY', sq(40, 0, 20, 6), { assigned: ['F'], fixtures: { doors: 2 }, finish: { base: { heightIn: 6, materialId: 'F' } } });
// a 12x13.5 foyer in a herringbone
const FOYER = room('FOYER', sq(70, 0, 12, 13.5), { assigned: ['HB'] });
const st = { name: 'Job', unitSystem: 'imperial_ft_in', materials: MATS, pdfPage: 1, scale: 1 / 36, rooms: [TUB, SHOWER, HALL, FOYER], markups: [], pageData: {} };

const qLines = (q, name) => {
  const i = q.rows.findIndex((r) => r.type === 'sub' && r.text.startsWith(name));
  const out = [];
  for (let k = i + 1; k < q.rows.length && q.rows[k].type === 'line'; k++) out.push(q.rows[k]);
  return out;
};

describe('accent walls (tub BW, vanity BW): their run in their own tile', () => {
  it('the tub BW is its LF × the tiled height; the rest of the walls carries the doors and the tub', () => {
    const parts = wallParts(TUB, ['W'], 9);
    expect(parts).toEqual([
      expect.objectContaining({ materialId: 'ACC', part: 'accent', label: 'Tub BW', sf: 45 }),
      expect.objectContaining({ materialId: 'W', part: 'rest', label: 'Rest of walls', sf: 246 - 45 }),
    ]);
    expect(parts[1].text).toBe("(30 − 5) LF × 9' = 225 − 14 (door) − 10 (tub) = 201 → 201 SF");
    // no accent: as before, one tile on the whole wall
    expect(wallParts({ ...TUB, finish: {} }, ['W'], 9)).toEqual([expect.objectContaining({ part: 'all', sf: 246 })]);
  });

  it('an accent tile with no other wall tile still takes off its own run', () => {
    expect(wallParts({ ...TUB, assigned: ['F'] }, [], 9)).toEqual([expect.objectContaining({ part: 'accent', sf: 45 })]);
    expect(roomAccents({ finish: { accents: [{ lf: 0, materialId: 'ACC' }, { lf: 4 }] } })).toEqual([expect.objectContaining({ lf: 4, materialId: null })]);
  });

  it('orders at 30% waste, prices at its size tier with TUB BW on the line, and counts once in the estimate', () => {
    const q = quantityList(st);
    const lines = qLines(q, 'TUB BATHROOM');
    expect(lines.map((l) => `${l.loc} | ${l.item} | ${l.count} | ${l.waste}`)).toEqual([
      'Floor | 24X48 FLOOR TILE | 40 | 0.25',
      'Wall — Tub BW | 16X48 WALL TILE | 45 | 0.3',
      'Rest of Walls | 12X24 WALL TILE | 201 | 0.25',
    ]);
    const p = buildProposal(st);
    const pl = qLines(p, 'TUB BATHROOM');
    expect(pl.map((l) => `${l.desc} | ${l.qty} | ${l.item} | ${l.rate}`)).toContain('Install large wall tile 16X48 - TUB BW | 45 | Large wall tile | 8.75');
    expect(pl.map((l) => `${l.desc} | ${l.qty}`)).toContain('Wall Tile Install 12X24 - REST OF WALLS | 201');
    const e = estimateProject(st);
    expect(e.lines.find((l) => l.material.id === 'ACC').netSf).toBe(45);
    expect(e.lines.find((l) => l.material.id === 'W').netSf).toBe(201 + 271);
  });

  it('the room header carries it as Moshe writes it, and the marked plan sums its walls once', () => {
    const mk = roomMarks(TUB, markContext(st, st.rooms));
    expect(mk.header).toBe("TUB BATHROOM (10x5 tub tubaccentw5lf) 9' ceiling - fully tiled");
    expect(mk.wallSf).toBe(45 + 201);
  });
});

describe('the shower floors\' tile', () => {
  it('names the quantity list line (15% waste) and the proposal\'s shower floor; the estimate orders its SF', () => {
    const q = quantityList(st);
    expect(qLines(q, 'GUEST SHOWER').find((l) => l.loc.startsWith('Shower Floor'))).toMatchObject({ item: '12X12 PEBBLES', count: 14, waste: 0.15 });
    const p = buildProposal(st);
    expect(qLines(p, 'GUEST SHOWER').find((l) => l.item === 'Shower Fl').desc).toBe('Install standard shower floor with Pebbles 254 (14sf) 12X12');
    expect(estimateProject(st).lines.find((l) => l.material.id === 'PEB').netSf).toBe(14);
  });
});

describe('tiled base: its own line, never folded into the floor', () => {
  it('LF = the walls less 2 LF a door; SF = LF × the base height', () => {
    const b = baseTakeoff(HALL);
    expect(b).toMatchObject({ lf: 52 - 4, heightIn: 6, sf: 24, materialId: 'F' });
    expect(b.text).toBe('52 − 4 (doors ×2) = 48 LF × 6" = 24 SF');
    // a traced room's wall LF is net of its doorways already
    expect(baseTakeoff({ ...HALL, wallLf: 49.5, openings: [{ width: 2.5, type: 'door' }] }).lf).toBe(49.5);
    expect(baseTakeoff({ ...HALL, finish: {} })).toBe(null);
  });

  it('orders at the room\'s waste for that tile + 10 points, outside the floor and wall totals; NA until picked', () => {
    const q = quantityList(st);
    const base = qLines(q, 'HALLWAY').find((l) => l.loc.startsWith('Base'));
    expect(base).toMatchObject({ loc: 'Base — 6" tiled base (48 LF)', item: '24X48 FLOOR TILE', unit: 'SF', count: 24, waste: 0.32 });
    expect(q.baseSf).toBe(24);
    expect(q.floorSf).toBe(40 + 33 + 120 + 162);
    const na = quantityList({ ...st, rooms: [{ ...HALL, finish: { base: { heightIn: 4, materialId: null } } }] });
    expect(qLines(na, 'HALLWAY').find((l) => l.loc.startsWith('Base'))).toMatchObject({ item: 'NA', count: 16, waste: 0.2 });
  });

  it('the proposal lists it per LF with no rate until Moshe sets one (never a guess), and flags it', () => {
    const p = buildProposal(st);
    const base = qLines(p, 'HALLWAY').find((l) => l.item === 'Base');
    expect(base).toMatchObject({ desc: '6" Tiled base per Ln Ft - 24X48 TILE', qty: 48, rate: null });
    expect(p.flags).toContain('HALLWAY: tiled base has no rate on the card — set it');
    expect(buildProposal(st, { ...ARTISTIC_RATES, base: 6.5 }).rows.find((l) => l.item === 'Base').rate).toBe(6.5);
    expect(summarize(st).pages[0].rooms.find((r) => r.name === 'HALLWAY').lines).toContainEqual(expect.objectContaining({ label: 'Tiled base 6"', qty: 48, unit: 'LF' }));
  });
});

describe('pattern labor (checkerboard, herringbone…)', () => {
  it('a floor laid in a special layout is priced as pattern labor on one line, not by its size tier', () => {
    const p = buildProposal(st);
    expect(qLines(p, 'FOYER').map((l) => `${l.desc} | ${l.qty} | ${l.item} | ${l.rate}`)).toEqual(['Herringbone style labor for floor 12X24 | 162 | Pattern Fl | 8.75']);
    // a straight lay keeps its tier
    expect(tileLines('floor', MATS[4], 100, '', ARTISTIC_RATES, 'grid')[0]).toMatchObject({ item: 'Rectified', rate: 7.75 });
    // x-large still takes its upcharge
    expect(tileLines('floor', mat('X', 'floor', '48X48', 48, 48), 100, '', ARTISTIC_RATES, 'basketweave').map((l) => l.item)).toEqual(['Pattern Fl', 'Upcharge X Large']);
  });
});
