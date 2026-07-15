// ============================================================
// types.js — central JSDoc type definitions for the engine layer.
//
// These are documentation + editor/`tsc --noEmit` enforcement only;
// they emit no runtime code. Importing this file is unnecessary — the
// typedefs are global once the file is part of the checked project
// (see jsconfig.json `checkJs`). Engine functions reference them with
// `@param {Room}` etc. The goal: catch the class of bug where a missing
// `material.tw` silently becomes NaN and corrupts an estimate.
// ============================================================

/**
 * A 2D point in canonical feet (plan space, +x right, +y down).
 * @typedef {{ x: number, y: number }} Point
 */

/**
 * Tile layout settings for a room's floor field.
 * @typedef {Object} LayoutSpec
 * @property {PatternId} pattern
 * @property {number} [angleDeg]   rotation in degrees (grid/brick)
 * @property {Point}  [origin]     layout origin offset in feet
 */

/**
 * Pattern identifiers understood by the layout engine.
 * @typedef {'grid'|'brick_50'|'brick_33'|'herringbone'|'diagonal'|'basketweave'} PatternId
 */

/**
 * A room/space. Geometry is a closed polygon in feet (rectangles are
 * just 4-vertex polygons). `assigned` holds material ids applied here.
 * @typedef {Object} Room
 * @property {string} id
 * @property {string} name
 * @property {string} [color]
 * @property {Point[]} points          polygon vertices in feet
 * @property {string[]} assigned       material ids applied to this room
 * @property {number} [wallHeight]     ft, for wall-tile coverage proxy
 * @property {LayoutSpec} [layout]
 */

/**
 * Material costing mode.
 * @typedef {'waste'|'cuts'} CostMode
 * @typedef {'sf'|'tile'|'box'} PriceUnit
 * @typedef {'floor'|'wall'} MaterialType
 */

/**
 * A tile/material line. Sizes `tw`/`th` are in INCHES; `grout` in inches.
 * @typedef {Object} Material
 * @property {string} id
 * @property {string} name
 * @property {MaterialType} type
 * @property {string} [color]
 * @property {number} tw               tile width, inches
 * @property {number} th               tile height, inches
 * @property {number} [grout]          joint width, inches
 * @property {PatternId} [pattern]
 * @property {number} [waste]          waste percent (waste mode)
 * @property {number} price
 * @property {PriceUnit} priceUnit
 * @property {number} [sfPerBox]
 * @property {number} [faceCoverage]   fraction of nominal covered (mosaics)
 * @property {CostMode} [costMode]
 * @property {boolean} [optimizeWholeJob]
 * @property {number} [cutSafetyPct]
 * @property {boolean} [grainLocked]   true = directional (planks/wood-look)
 */

/**
 * Measurement markup type + the markup record.
 * @typedef {'length'|'area'|'rect'|'ellipse'|'count'|'arrow'|'text'} MarkupType
 * @typedef {Object} Markup
 * @property {string} id
 * @property {MarkupType} type
 * @property {Point[]} points
 * @property {string} [name]
 * @property {string} [color]
 * @property {number} [unitCost]
 * @property {string} [note]
 */

/**
 * One placed tile from the layout engine (center, size, rotation).
 * @typedef {Object} TileQuad
 * @property {number} cx
 * @property {number} cy
 * @property {number} w
 * @property {number} h
 * @property {number} rot   radians
 */

/**
 * Cut-engine assignment record (drives the cut sheet).
 * @typedef {Object} CutAssignment
 * @property {string} piece
 * @property {string} room
 * @property {number} w
 * @property {number} h
 * @property {'offcut'|'new tile'} source
 * @property {string} from
 * @property {{w:number,h:number,id:string}[]} produces
 */

/**
 * Result of analyzeCuts for one material.
 * @typedef {Object} CutResult
 * @property {string} material
 * @property {PatternId} pattern
 * @property {boolean} grainLocked
 * @property {number} fullTiles
 * @property {number} cutPieces
 * @property {number} newTilesBrokenForCuts
 * @property {number} reusedOffcuts
 * @property {number} tilesSavedByReuse
 * @property {number} scrapPieces
 * @property {number} totalTiles
 * @property {number} naiveTotal
 * @property {number} pctSaved
 * @property {'practical'|'optimize'} mode
 * @property {CutAssignment[]} assignments
 * @property {?string} note
 */

/**
 * A single estimate line for one material.
 * @typedef {Object} EstimateLine
 * @property {Material} material
 * @property {number} netSf
 * @property {number} grossSf
 * @property {number} tiles
 * @property {number} [wasteTiles]
 * @property {number} qty
 * @property {string} unit
 * @property {number} unitCost
 * @property {number} cost
 * @property {?CutResult} cutInfo
 * @property {CostMode} costMode
 * @property {{name:string,sf:number}[]} [usedRooms]
 * @property {number} [tileSf]
 * @property {number} [wasteMul]
 */

/**
 * Whole-project estimate rollup.
 * @typedef {Object} ProjectEstimate
 * @property {EstimateLine[]} lines
 * @property {number} materialSubtotal
 * @property {number} floorSf
 * @property {number} labor
 * @property {number} laborRate
 * @property {number} subtotal
 * @property {number} tax
 * @property {number} total
 */

/**
 * The minimal project state the engine functions read.
 * @typedef {Object} ProjectState
 * @property {string} [name]
 * @property {string} [unitSystem]
 * @property {?number} [scale]
 * @property {Room[]} rooms
 * @property {Material[]} materials
 * @property {Markup[]} [markups]
 * @property {number} [taxRate]
 * @property {number} [laborRatePerSf]
 */

export {}; // keep this a module
