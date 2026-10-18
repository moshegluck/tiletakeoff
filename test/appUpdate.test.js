import { describe, it, expect } from 'vitest';
import { isStaleBuild, reloadForUpdate, takeUpdateNote } from '../src/lib/appUpdate.js';

// A tab loaded before a deploy asks for code files the deploy removed;
// opening a plan then failed on iPhone ("Importing a module script failed").
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

describe('a page from an older deploy', () => {
  it('knows a missing code file by how each browser words it', () => {
    expect(isStaleBuild(new TypeError('Importing a module script failed.'))).toBe(true);   // Safari
    expect(isStaleBuild(new TypeError('Failed to fetch dynamically imported module: https://x/assets/pdf-Db1oDYcV.js'))).toBe(true);   // Chrome
    expect(isStaleBuild(new TypeError('error loading dynamically imported module'))).toBe(true);   // Firefox
    expect(isStaleBuild(new Error('Unable to preload CSS for /assets/index.css'))).toBe(true);
    expect(isStaleBuild(new Error('That image could not be read.'))).toBe(false);
    expect(isStaleBuild(null)).toBe(false);
  });

  it('reloads once onto the new version, leaves a note, and never loops', () => {
    const store = memStore();
    let reloads = 0;
    const loc = { reload: () => { reloads++; } };
    expect(reloadForUpdate('updated', store, loc)).toBe(true);
    expect(reloads).toBe(1);
    // the same failure again right after the reload: the file is really gone — no second reload
    expect(reloadForUpdate('updated', store, loc)).toBe(false);
    expect(reloads).toBe(1);
    expect(takeUpdateNote(store)).toBe('updated');
    expect(takeUpdateNote(store)).toBe(null);
    // no storage to remember it by: no reload at all
    expect(reloadForUpdate('x', null, loc)).toBe(false);
    const broken = { getItem: () => { throw new Error('blocked'); } };
    expect(reloadForUpdate('x', broken, loc)).toBe(false);
    expect(reloads).toBe(1);
  });
});
