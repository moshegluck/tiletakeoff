// ============================================================
// tileCatalog.js — library of common tile/plank sizes.
// Sizes in inches. Grouped by family. Extend freely.
// ============================================================

export const TILE_CATALOG = [
  {
    group: 'Square (in)',
    items: [
      { id: 'sq_2',   label: '2 × 2',   tw: 2,  th: 2 },
      { id: 'sq_3',   label: '3 × 3',   tw: 3,  th: 3 },
      { id: 'sq_4',   label: '4 × 4',   tw: 4,  th: 4 },
      { id: 'sq_6',   label: '6 × 6',   tw: 6,  th: 6 },
      { id: 'sq_8',   label: '8 × 8',   tw: 8,  th: 8 },
      { id: 'sq_12',  label: '12 × 12', tw: 12, th: 12 },
      { id: 'sq_16',  label: '16 × 16', tw: 16, th: 16 },
      { id: 'sq_18',  label: '18 × 18', tw: 18, th: 18 },
      { id: 'sq_24',  label: '24 × 24', tw: 24, th: 24 },
      { id: 'sq_32',  label: '32 × 32', tw: 32, th: 32 },
      { id: 'sq_36',  label: '36 × 36', tw: 36, th: 36 },
    ],
  },
  {
    group: 'Rectangle / Subway (in)',
    items: [
      { id: 'rc_2x4',   label: '2 × 4',   tw: 2,  th: 4 },
      { id: 'rc_3x6',   label: '3 × 6',   tw: 3,  th: 6 },
      { id: 'rc_4x8',   label: '4 × 8',   tw: 4,  th: 8 },
      { id: 'rc_4x12',  label: '4 × 12',  tw: 4,  th: 12 },
      { id: 'rc_6x12',  label: '6 × 12',  tw: 6,  th: 12 },
      { id: 'rc_8x12',  label: '8 × 12',  tw: 8,  th: 12 },
      { id: 'rc_12x24', label: '12 × 24', tw: 12, th: 24 },
      { id: 'rc_16x32', label: '16 × 32', tw: 16, th: 32 },
      { id: 'rc_18x36', label: '18 × 36', tw: 18, th: 36 },
    ],
  },
  {
    group: 'Plank / Wood-look (in)',
    items: [
      { id: 'pk_6x24',  label: '6 × 24',  tw: 6, th: 24 },
      { id: 'pk_6x36',  label: '6 × 36',  tw: 6, th: 36 },
      { id: 'pk_8x36',  label: '8 × 36',  tw: 8, th: 36 },
      { id: 'pk_8x48',  label: '8 × 48',  tw: 8, th: 48 },
      { id: 'pk_9x48',  label: '9 × 48',  tw: 9, th: 48 },
    ],
  },
  {
    group: 'Mosaic (sheet, in)',
    items: [
      { id: 'mo_12',    label: '12 × 12 sheet', tw: 12, th: 12 },
      { id: 'mo_pen',   label: 'Penny round 12 sheet', tw: 12, th: 12 },
      { id: 'mo_hex',   label: 'Hex 12 sheet',  tw: 12, th: 12 },
    ],
  },
  {
    group: 'Metric (mm → in)',
    items: [
      { id: 'm_300',  label: '300 × 300 mm', tw: 11.81, th: 11.81 },
      { id: 'm_600',  label: '600 × 600 mm', tw: 23.62, th: 23.62 },
      { id: 'm_600x1200', label: '600 × 1200 mm', tw: 23.62, th: 47.24 },
      { id: 'm_800',  label: '800 × 800 mm', tw: 31.5,  th: 31.5 },
    ],
  },
];

// flat lookup
export const TILE_FLAT = TILE_CATALOG.flatMap((g) => g.items);

export const GROUT_JOINTS = [
  { id: 'j_0',     label: 'Rectified 1/16"', in: 0.0625 },
  { id: 'j_18',    label: '1/8"',  in: 0.125 },
  { id: 'j_316',   label: '3/16"', in: 0.1875 },
  { id: 'j_14',    label: '1/4"',  in: 0.25 },
  { id: 'j_38',    label: '3/8"',  in: 0.375 },
];

// Suggested waste % by pattern (industry rules of thumb)
export const WASTE_BY_PATTERN = {
  grid: 10, brick_50: 10, brick_33: 12,
  diagonal: 15, herringbone: 15, basketweave: 15,
};
