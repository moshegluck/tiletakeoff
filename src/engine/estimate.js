// ============================================================
// estimate.js — turn rooms + materials into orderable quantities
// and costs. Pure functions; consumes canonical-feet geometry.
//
// Two costing modes per material:
//   'waste'   — classic area × (1+waste%) → tiles. Fast, conservative.
//   'cuts'    — uses the cut engine: full tiles + only the NEW tiles
//               actually broken for cuts after offcut reuse, then adds
//               a small safety waste on top. More accurate, less padding.
// ============================================================

import { roomArea } from './geometry.js';
import { analyzeCuts } from './cutEngine.js';
import { roomRegions } from './zones.js';
import { roomPattern, wasteFor } from './patterns.js';
import { floorTakeoff, wallParts, wallTileHeight, roundUp } from './takeoffRules.js';

/**
 * Net area a material covers across rooms. A floor material assigned to a
 * room covers that room's FIELD (room minus its border bands and inlays);
 * a floor material picked on a design zone covers that zone.
 * @param {import('./types.js').Material} material
 * @param {import('./types.js').Room[]} rooms
 * @returns {{ netSf: number, usedRooms: {name:string,sf:number,lf?:number,pattern?:string}[] }}
 */
export function materialArea(material, rooms, materials = null) {
  let netSf = 0;
  const usedRooms = [];
  const isWall = (id) => (materials ? materials.find((m) => m.id === id)?.type === 'wall' : id === material.id);
  for (const r of rooms) {
    if (material.type === 'wall') {
      if (!r.assigned?.includes(material.id)) continue;
      // perimeter × tiled height − 14 SF a door (8 at 4'), − 10 a tub, windows
      // not deducted, rounded up (takeoffRules.js); the height is the design
      // pick (wainscot / shower) else the full wall. A second wall tile in a
      // bath is the shower / tub walls' — each covers its own part
      const w = wallParts(r, r.assigned.filter(isWall), wallTileHeight(r)).find((x) => x.materialId === material.id);
      if (!w) continue;
      netSf += w.sf;
      usedRooms.push({ name: w.part === 'all' ? r.name : `${r.name} · ${w.label.toLowerCase()}`, sf: w.sf, text: w.text });
      continue;
    }
    // floor: the room's field (outline minus holes, bands and inlays) and
    // any design zones picked in this material
    const onField = r.assigned?.includes(material.id);
    const onZone = (r.zones || []).some((z) => z.materialId === material.id);
    if (!onField && !onZone) continue;
    const reg = roomRegions(r);
    if (onField) {
      // the field less shower footprints and 10 SF a tub, rounded up
      const f = floorTakeoff(r, reg.fieldArea);
      netSf += f.sf;
      usedRooms.push({ name: r.name, sf: f.sf, pattern: roomPattern(r, material), text: f.text });
    }
    for (const b of reg.bands) {
      if (b.zone.materialId !== material.id) continue;
      netSf += roundUp(b.area);
      usedRooms.push({ name: `${r.name} · ${b.zone.name}`, sf: roundUp(b.area), lf: b.lf, pattern: 'border' });
    }
    for (const z of reg.inlays) {
      if (z.zone.materialId !== material.id) continue;
      netSf += roundUp(z.area);
      usedRooms.push({ name: `${r.name} · ${z.zone.name}`, sf: roundUp(z.area), pattern: z.zone.layout?.pattern || material.pattern || 'grid' });
    }
  }
  return { netSf, usedRooms };
}

/**
 * Estimate one material against its assigned rooms.
 * @param {import('./types.js').Material} material
 * @param {import('./types.js').Room[]} rooms
 * @returns {import('./types.js').EstimateLine}
 */
export function estimateMaterial(material, rooms, materials = null) {
  const { netSf, usedRooms } = materialArea(material, rooms, materials);
  const tileSf = (material.tw / 12) * (material.th / 12) * (material.faceCoverage ?? 1);
  // waste follows the pattern each room lays this tile in
  const grossSf = usedRooms.reduce((a, u) => a + u.sf * (1 + wasteFor(material, u.pattern) / 100), 0);
  const wasteMul = netSf > 0 ? grossSf / netSf : 1 + (material.waste ?? 0) / 100;
  const wastePct = (wasteMul - 1) * 100;
  const wasteTiles = tileSf > 0 ? Math.ceil(grossSf / tileSf) : 0;

  // cut-engine accounting (only meaningful for floor tile in a real layout)
  let cutInfo = null, tiles = wasteTiles;
  // Unrounded square-footage basis for cut mode. Box pricing must derive boxes
  // from this raw value — NOT from the already-rounded `tiles` — otherwise the
  // safety margin gets rounded up to a whole tile and then rounded up again to a
  // whole box, over-ordering by up to one box.
  let cutsGrossSf = grossSf;
  const useCuts = material.costMode === 'cuts' && material.type !== 'wall';
  if (useCuts && usedRooms.length) {
    const mode = material.optimizeWholeJob ? 'optimize' : 'practical';
    // rooms using this material on their field OR on a design zone
    const using = rooms.filter((r) => r.assigned?.includes(material.id) ||
      (r.zones || []).some((z) => z.materialId === material.id));
    cutInfo = analyzeCuts(using, material, { mode });
    // add a safety margin on the *broken* tiles only (breakage on site)
    const safety = 1 + (material.cutSafetyPct ?? 5) / 100;
    const rawTiles = cutInfo.totalTiles * safety;
    tiles = Math.ceil(rawTiles);           // whole tiles to buy / show
    cutsGrossSf = rawTiles * tileSf;        // unrounded sf for box math
  }

  let qty, unit, unitCost;
  if (material.priceUnit === 'tile') { qty = tiles; unit = 'tile'; unitCost = material.price; }
  else if (material.priceUnit === 'box') {
    const sfPerBox = material.sfPerBox ?? 1;
    const sfNeeded = useCuts ? cutsGrossSf : grossSf;
    qty = Math.ceil(sfNeeded / sfPerBox); unit = 'box'; unitCost = material.price;
  } else {
    qty = useCuts ? tiles * tileSf : grossSf; unit = 'sf'; unitCost = material.price;
  }

  const cost = qty * unitCost;
  return {
    material, netSf, grossSf, tiles, wasteTiles, qty, unit, unitCost, cost,
    usedRooms, tileSf, wasteMul, wastePct, cutInfo, costMode: useCuts ? 'cuts' : 'waste',
  };
}

/**
 * Whole-project estimate with labor and tax.
 * @param {import('./types.js').ProjectState} state
 * @returns {import('./types.js').ProjectEstimate}
 */
export function estimateProject(state) {
  const lines = state.materials.map((m) => estimateMaterial(m, state.rooms, state.materials));
  const materialSubtotal = lines.reduce((s, l) => s + l.cost, 0);

  // labor: optional per-sf rate over total floor area
  const floorSf = state.rooms.reduce((s, r) => s + roomArea(r), 0);
  const laborRate = state.laborRatePerSf ?? 0;
  const labor = floorSf * laborRate;

  const subtotal = materialSubtotal + labor;
  const tax = subtotal * (state.taxRate ?? 0) / 100;
  return { lines, materialSubtotal, floorSf, labor, laborRate, subtotal, tax, total: subtotal + tax };
}
