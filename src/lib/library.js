// ============================================================
// library.js — the tile library: everything you can lay in a room, as one
// list of items.
//   catalog  finish presets (named products with colour and price) and the
//            standard sizes
//   mine     tiles you saved: in your account when signed in, else on this
//            device
//   project  the materials already in this takeoff
// An item carries how it is laid (pattern, angle, grout), so applying it to
// a room sets the room's pattern too (store.applyTile).
// ============================================================

import { nanoid } from 'nanoid';
import { FLOOR_PRESETS, WALL_TILE_PRESETS } from '../data/finishes.js';
import { TILE_CATALOG, WASTE_BY_PATTERN } from '../data/tileCatalog.js';
import { cloudEnabled } from './supabase.js';
import { getUser, listTiles, addTile, updateTile, deleteTile } from './cloud.js';

/**
 * @typedef {Object} LibItem
 * @property {string} key        stable id: cat:…, size:…, mine:…, dev:…, mat:…
 * @property {'catalog'|'size'|'mine'|'device'|'project'} source
 * @property {string} name
 * @property {'floor'|'wall'} kind
 * @property {number} tw         inches
 * @property {number} th         inches
 * @property {number} grout      inches
 * @property {string} pattern    engine/layouts.js PATTERNS id
 * @property {number} angleDeg
 * @property {string} color
 * @property {string} [style]    3D finish style
 * @property {number} price
 * @property {'sf'|'tile'|'box'} priceUnit
 * @property {number} [sfPerBox]
 * @property {number} [waste]
 * @property {string} [vendor]
 * @property {string} [sku]
 * @property {string} [presetId]
 * @property {string} [materialId] project materials only
 * @property {string} [rowId]      saved tiles only
 */

const FLOOR_COLOR = '#d9d3c7', WALL_COLOR = '#e9eef2';

/** Built-in finishes and standard sizes. @returns {LibItem[]} */
export function catalogItems() {
  const preset = (p, kind) => ({
    key: `cat:${p.id}`, source: 'catalog', name: p.name, kind,
    tw: p.tw, th: p.th, grout: p.grout ?? 0.125, pattern: p.pattern || 'grid', angleDeg: 0,
    color: p.color, style: p.style, price: p.price ?? 0, priceUnit: 'sf', sfPerBox: 15,
    waste: WASTE_BY_PATTERN[p.pattern] ?? 10, presetId: p.id,
  });
  const sizes = [];
  for (const g of TILE_CATALOG) {
    const plank = /plank/i.test(g.group), mosaic = /mosaic/i.test(g.group);
    for (const t of g.items) {
      const pattern = plank ? 'brick_33' : 'grid';
      sizes.push({
        key: `size:${t.id}`, source: 'size', name: `${t.label}${mosaic ? '' : ' tile'}`.replace(/\s+/g, ' '), kind: 'floor',
        tw: t.tw, th: t.th, grout: plank ? 0 : mosaic ? 0.0625 : 0.125, pattern, angleDeg: 0,
        color: plank ? '#c49a6c' : FLOOR_COLOR, style: plank ? 'wood' : /hex/i.test(t.id) ? 'hex' : 'stone',
        price: 0, priceUnit: 'sf', sfPerBox: 15, waste: WASTE_BY_PATTERN[pattern] ?? 10, group: g.group,
      });
    }
  }
  return [...FLOOR_PRESETS.map((p) => preset(p, 'floor')), ...WALL_TILE_PRESETS.map((p) => preset(p, 'wall')), ...sizes];
}

/** A project material as a library item. @returns {LibItem} */
export function materialItem(m) {
  return {
    key: `mat:${m.id}`, source: 'project', name: m.name, kind: m.type === 'wall' ? 'wall' : 'floor',
    tw: m.tw, th: m.th, grout: m.grout ?? 0.125, pattern: m.pattern || 'grid', angleDeg: 0,
    color: m.color || (m.type === 'wall' ? WALL_COLOR : FLOOR_COLOR), style: m.finishStyle, price: m.price ?? 0,
    priceUnit: m.priceUnit || 'sf', sfPerBox: m.sfPerBox, waste: m.waste, vendor: m.vendor, sku: m.sku,
    presetId: m.presetId, materialId: m.id,
  };
}

/** The material fields an item sets. */
export function materialFields(it) {
  const kind = it.kind === 'wall' ? 'wall' : 'floor';
  return {
    name: it.name, type: kind, color: it.color || (kind === 'wall' ? WALL_COLOR : FLOOR_COLOR),
    tw: +it.tw || 12, th: +it.th || 12, grout: Number.isFinite(+it.grout) ? +it.grout : 0.125,
    pattern: it.pattern || 'grid', waste: Number.isFinite(+it.waste) ? +it.waste : (WASTE_BY_PATTERN[it.pattern] ?? 10),
    price: +it.price || 0, priceUnit: it.priceUnit || 'sf', sfPerBox: +it.sfPerBox || 15,
    ...(it.style ? { finishStyle: it.style } : {}), ...(it.presetId ? { presetId: it.presetId } : {}),
    ...(it.vendor ? { vendor: it.vendor } : {}), ...(it.sku ? { sku: it.sku } : {}),
  };
}

// ---- saved tiles ("My tiles") ----
const rowToItem = (r) => ({
  key: `mine:${r.id}`, source: 'mine', rowId: r.id, name: r.name, kind: r.kind === 'wall' ? 'wall' : 'floor',
  tw: +r.tw_in || 12, th: +r.th_in || 12, grout: r.grout_in != null ? +r.grout_in : 0.125,
  pattern: r.pattern || 'grid', angleDeg: +r.angle_deg || 0, color: r.color || FLOOR_COLOR, style: r.finish_style || undefined,
  price: r.price != null ? +r.price : 0, priceUnit: r.price_unit || 'sf', sfPerBox: r.sf_per_box != null ? +r.sf_per_box : undefined,
  waste: r.waste_pct != null ? +r.waste_pct : undefined, vendor: r.vendor || undefined, sku: r.sku || undefined,
});
const itemToRow = (it) => ({
  name: it.name, tw_in: it.tw, th_in: it.th, grout_in: it.grout, kind: it.kind, pattern: it.pattern, angle_deg: it.angleDeg || 0,
  color: it.color, finish_style: it.style, price: it.price, price_unit: it.priceUnit, sf_per_box: it.sfPerBox,
  waste_pct: it.waste, vendor: it.vendor, sku: it.sku,
});

const DEVICE_KEY = 'tt.library.v1';
function readDevice() {
  try { const a = JSON.parse(localStorage.getItem(DEVICE_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function writeDevice(items) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(items)); } catch (_) { throw new Error('This device has no room to save more tiles.'); }
}

async function signedIn() {
  if (!cloudEnabled) return false;
  try { return !!(await getUser()); } catch (_) { return false; }
}

/**
 * Saved tiles: your account's (when signed in) and this device's.
 * @returns {Promise<{ items: LibItem[], cloud: boolean }>}
 */
export async function listMine() {
  const device = readDevice().map((it) => ({ ...it, source: 'device' }));
  if (!(await signedIn())) return { items: device, cloud: false };
  const rows = await listTiles();
  return { items: [...rows.map(rowToItem), ...device], cloud: true };
}

/**
 * Save a tile to "My tiles" (account when signed in, else this device).
 * Updates it in place when it is already a saved tile.
 * @param {LibItem} item
 * @returns {Promise<LibItem>}
 */
export async function saveMine(item) {
  const clean = { ...item, source: undefined, key: undefined, materialId: undefined, rowId: undefined };
  if (item.source === 'device') {
    const all = readDevice().map((x) => (x.key === item.key ? { ...x, ...clean, key: x.key } : x));
    writeDevice(all);
    return { ...item };
  }
  if (await signedIn()) {
    const row = item.source === 'mine' && item.rowId ? await updateTile(item.rowId, itemToRow(item)) : await addTile(itemToRow(clean));
    return rowToItem(row);
  }
  const saved = { ...clean, key: `dev:${nanoid(10)}`, source: 'device' };
  writeDevice([saved, ...readDevice()]);
  return saved;
}

/** @param {LibItem} item */
export async function deleteMine(item) {
  if (item.source === 'device') { writeDevice(readDevice().filter((x) => x.key !== item.key)); return; }
  if (item.source === 'mine' && item.rowId) await deleteTile(item.rowId);
}
