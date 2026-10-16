// ============================================================
// finishes.js — the design library used by the 3D walkthrough.
// Floor and wall-tile presets map 1:1 to estimating materials (size,
// grout, pattern, price), so picking a finish in 3D updates the takeoff.
// `style` tells the renderer how to draw it.
// ============================================================

export const FLOOR_PRESETS = [
  { id: 'oak-plank', name: 'White oak plank 7×48', style: 'wood', color: '#c49a6c', tw: 7, th: 48, grout: 0, pattern: 'brick_33', price: 6.5 },
  { id: 'walnut-plank', name: 'Walnut plank 8×72', style: 'wood', color: '#6e4a32', tw: 8, th: 72, grout: 0, pattern: 'brick_33', price: 9.75 },
  { id: 'herring-oak', name: 'Herringbone oak 4×24', style: 'wood', color: '#b8895a', tw: 4, th: 24, grout: 0, pattern: 'herringbone', price: 11 },
  { id: 'marble-2424', name: 'Carrara marble 24×24', style: 'marble', color: '#ecebe7', tw: 24, th: 24, grout: 0.0625, pattern: 'grid', price: 14 },
  { id: 'porc-gray-1224', name: 'Gray porcelain 12×24', style: 'stone', color: '#a7a6a2', tw: 12, th: 24, grout: 0.125, pattern: 'brick_33', price: 4.75 },
  { id: 'porc-white-2448', name: 'Matte white porcelain 24×48', style: 'stone', color: '#e4e1db', tw: 24, th: 48, grout: 0.0625, pattern: 'grid', price: 7.25 },
  { id: 'slate-1818', name: 'Charcoal slate 18×18', style: 'slate', color: '#4b4f53', tw: 18, th: 18, grout: 0.25, pattern: 'grid', price: 6 },
  { id: 'terracotta-1212', name: 'Terracotta 12×12', style: 'terracotta', color: '#b5653f', tw: 12, th: 12, grout: 0.375, pattern: 'grid', price: 5.5 },
  { id: 'hex-mosaic', name: 'White hex mosaic 2"', style: 'hex', color: '#f1f0ec', tw: 2, th: 2, grout: 0.0625, pattern: 'grid', price: 12, faceCoverage: 1 },
  { id: 'checker-1212', name: 'Black & white checker 12×12', style: 'checker', color: '#e9e7e1', tw: 12, th: 12, grout: 0.0625, pattern: 'grid', price: 5 },
  { id: 'concrete', name: 'Polished concrete look 24×24', style: 'concrete', color: '#b3b0aa', tw: 24, th: 24, grout: 0.0625, pattern: 'grid', price: 5.25 },
];

export const WALL_TILE_PRESETS = [
  { id: 'subway-white', name: 'White subway 3×6', style: 'gloss', color: '#f4f3ef', tw: 6, th: 3, grout: 0.0625, pattern: 'brick_50', price: 4.5 },
  { id: 'subway-sage', name: 'Sage zellige 4×4', style: 'zellige', color: '#8fa58f', tw: 4, th: 4, grout: 0.0625, pattern: 'grid', price: 16 },
  { id: 'marble-1224-wall', name: 'Marble 12×24', style: 'marble', color: '#ebe9e4', tw: 24, th: 12, grout: 0.0625, pattern: 'brick_50', price: 13 },
  { id: 'porc-gray-wall', name: 'Gray porcelain 12×24', style: 'stone', color: '#b2b0ab', tw: 24, th: 12, grout: 0.0625, pattern: 'grid', price: 4.75 },
  { id: 'navy-3x12', name: 'Navy gloss 3×12', style: 'gloss', color: '#2d3f5c', tw: 12, th: 3, grout: 0.0625, pattern: 'brick_50', price: 8 },
];

export const PAINT_COLORS = [
  { id: 'white', name: 'Chantilly white', color: '#f2efe8' },
  { id: 'greige', name: 'Agreeable greige', color: '#d6cfc3' },
  { id: 'gray', name: 'Repose gray', color: '#c4c2bb' },
  { id: 'sage', name: 'Soft sage', color: '#b9c3ad' },
  { id: 'blue', name: 'Hale navy', color: '#3f4d61' },
  { id: 'clay', name: 'Warm clay', color: '#c9a088' },
  { id: 'charcoal', name: 'Iron ore', color: '#43413f' },
  { id: 'sky', name: 'Breath of sky', color: '#c7d6df' },
];

export const TILE_HEIGHTS = [
  { v: 0, label: 'None' }, { v: 3.5, label: 'Wainscot 3½′' }, { v: 4, label: '4′' }, { v: 7, label: 'Shower 7′' }, { v: null, label: 'Full height' },
];

/** Sensible default finish per room type (before anything is picked). */
export function defaultFinishFor(type) {
  // wall tile is never a default: it only appears once it's chosen, so the 3D
  // never shows tile the takeoff isn't pricing
  if (type === 'bath') return { floor: 'hex-mosaic', paint: 'white' };
  if (type === 'kitchen' || type === 'laundry' || type === 'mech') return { floor: 'porc-gray-1224', paint: 'white' };
  if (type === 'hall') return { floor: 'oak-plank', paint: 'greige' };
  if (type === 'garage') return { floor: 'concrete', paint: 'gray' };
  return { floor: 'oak-plank', paint: type === 'bedroom' ? 'sky' : 'greige' };
}

export const allPresets = () => [...FLOOR_PRESETS, ...WALL_TILE_PRESETS];
export const presetById = (id) => allPresets().find((p) => p.id === id) || null;
export const paintById = (id) => PAINT_COLORS.find((p) => p.id === id) || (typeof id === 'string' && id.startsWith('#') ? { id, name: id, color: id } : PAINT_COLORS[0]);
