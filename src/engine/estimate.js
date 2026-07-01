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

import { polygonArea, polygonPerimeter } from './geometry.js';
import { analyzeCuts } from './cutEngine.js';

/**
 * Net area assigned to a material across rooms.
 * @param {import('./types.js').Material} material
 * @param {import('./types.js').Room[]} rooms
 * @returns {{ netSf: number, usedRooms: {name:string,sf:number}[] }}
 */
export function materialArea(material, rooms) {
  let netSf = 0;
  const usedRooms = [];
  for (const r of rooms) {
    if (!r.assigned?.includes(material.id)) continue;
    const sf = polygonArea(r.points);
    if (material.type === 'wall') {
      // wall coverage proxy: perimeter * wall height (default 8 ft)
      const per = polygonPerimeter(r.points);
      const h = r.wallHeight ?? 8;
      netSf += per * h;
      usedRooms.push({ name: r.name, sf: per * h });
    } else {
      netSf += sf;
      usedRooms.push({ name: r.name, sf });
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
export function estimateMaterial(material, rooms) {
  const { netSf, usedRooms } = materialArea(material, rooms);
  const tileSf = (material.tw / 12) * (material.th / 12) * (material.faceCoverage ?? 1);
  const wasteMul = 1 + (material.waste ?? 0) / 100;
  const grossSf = netSf * wasteMul;
  const wasteTiles = tileSf > 0 ? Math.ceil(grossSf / tileSf) : 0;

  // cut-engine accounting (only meaningful for floor tile in a real layout)
  let cutInfo = null, tiles = wasteTiles;
  // Unrounded square-footage basis for cut mode. Box pricing must derive boxes
  // from this raw value — NOT from the already-rounded `tiles` — otherwise the
  // safety margin gets rounded up to a whole tile and then rounded up again to a
  // whole box, over-ordering by up to one box.
  let cutsGrossSf = grossSf;
  const useCuts = material.costMode === 'cuts' && material.type !== 'wall';
  if (useCuts && rooms.some((r) => r.assigned?.includes(material.id))) {
    const assigned = rooms.filter((r) => r.assigned?.includes(material.id));
    const mode = material.optimizeWholeJob ? 'optimize' : 'practical';
    cutInfo = analyzeCuts(assigned, material, { mode });
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
    usedRooms, tileSf, wasteMul, cutInfo, costMode: useCuts ? 'cuts' : 'waste',
  };
}

/**
 * Whole-project estimate with labor and tax.
 * @param {import('./types.js').ProjectState} state
 * @returns {import('./types.js').ProjectEstimate}
 */
export function estimateProject(state) {
  const lines = state.materials.map((m) => estimateMaterial(m, state.rooms));
  const materialSubtotal = lines.reduce((s, l) => s + l.cost, 0);

  // labor: optional per-sf rate over total floor area
  const floorSf = state.rooms.reduce((s, r) => s + polygonArea(r.points), 0);
  const laborRate = state.laborRatePerSf ?? 0;
  const labor = floorSf * laborRate;

  const subtotal = materialSubtotal + labor;
  const tax = subtotal * (state.taxRate ?? 0) / 100;
  return { lines, materialSubtotal, floorSf, labor, laborRate, subtotal, tax, total: subtotal + tax };
}
