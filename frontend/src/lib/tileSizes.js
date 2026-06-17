// Comprehensive standard tile size library (US nominal sizes, inches).
// Used as quick-pick presets in the catalog.
export const TILE_SIZE_GROUPS = [
  {
    category: "Mosaic & Penny",
    sizes: [
      [0.375, 0.375], [0.625, 0.625], [1, 1], [1, 2], [2, 2], [2, 4], [1, 3], [3, 3],
    ],
  },
  {
    category: "Wall / Subway",
    sizes: [
      [2, 6], [2, 8], [3, 6], [3, 9], [3, 12], [4, 4], [4, 8], [4, 12], [4, 16],
      [4.25, 4.25], [5, 5], [6, 6],
    ],
  },
  {
    category: "Floor Square",
    sizes: [
      [6, 6], [8, 8], [10, 10], [12, 12], [13, 13], [16, 16], [18, 18], [20, 20],
      [24, 24], [32, 32], [36, 36], [48, 48],
    ],
  },
  {
    category: "Rectangle / Plank",
    sizes: [
      [6, 24], [6, 36], [6, 48], [7, 48], [8, 36], [8, 40], [8, 48], [9, 48], [9, 60],
      [12, 24], [12, 36], [12, 48], [16, 32], [18, 36], [24, 48],
    ],
  },
  {
    category: "Wood-Look Plank",
    sizes: [
      [4, 24], [4, 36], [6, 24], [6, 36], [6, 48], [8, 48], [9, 60], [7.5, 47],
    ],
  },
  {
    category: "Large Format / Slab",
    sizes: [
      [24, 48], [32, 64], [40, 40], [48, 48], [48, 96], [60, 120],
    ],
  },
  {
    category: "Hexagon & Specialty",
    sizes: [
      [4, 4], [6, 6], [8, 8], [8, 10], [10, 12], [11, 13], [12, 14],
    ],
  },
];

export const fmtSize = (w, h) => `${w}×${h} in`;
