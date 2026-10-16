import { describe, it, expect } from 'vitest';
import { classifyLayer, wallCandidates, isOpeningLayer } from '../src/engine/trace/layers.js';

describe('CAD layer names', () => {
  it('tells walls, doors, windows and door-and-window layers apart', () => {
    const k = (n) => classifyLayer(n);
    expect(['A-Wall', 'A-WALL-EXST', 'NEWWALLS', 'I-WALL', 'PARTITION'].map(k)).toEqual(['wall', 'wall', 'wall', 'wall', 'wall']);
    expect(['A-Door', 'A-DOOR-FRAM', 'I-DOOR'].map(k)).toEqual(['door', 'door', 'door']);
    expect(['A-Glaz', 'A-GLAZ-SILL', 'NEWWINDOWS', 'WINDOWS', 'A-WIND'].map(k)).toEqual(['window', 'window', 'window', 'window', 'window']);
    expect(['A - DOORS_WINDOWS GRAY', 'A-OPENINGS'].map(k)).toEqual(['opening', 'opening']);
    expect(['door', 'window', 'opening'].every(isOpeningLayer)).toBe(true);
  });

  it('door and window tags, labels and text are text, not the door drawn in the wall', () => {
    expect(['T - DOOR LABEL', 'T - WINDOW LABEL', 'Door Tags', 'A-ANNO-TEXT'].map(classifyLayer)).toEqual(['ignore', 'ignore', 'ignore', 'ignore']);
    expect(classifyLayer('T - ROOM LABEL')).toBe('roomLabel');
  });

  it('demolition, overhead and drafting layers are never walls', () => {
    expect(['A-WALL-DEMO', 'A - DEMOLISH', 'A - ABOVE', 'A-WALL-PATT', 'T - DIMS INTERIOR CD'].map(classifyLayer)).toEqual(['ignore', 'ignore', 'ignore', 'ignore', 'ignore']);
  });

  it('on a sheet that names its wall layers, layer "0" (ticks, break lines) gives no walls', () => {
    const ln = (layer) => ({ a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer });
    const lines = [...Array(40)].map(() => ln('A-Wall')).concat([ln('0'), ln('A - FOUNDATION'), ln('A-Door')]);
    expect(wallCandidates(lines).map((l) => l.layer).filter((n) => n !== 'A-Wall')).toEqual(['A - FOUNDATION']);
    // a sheet without wall layers keeps everything, layer 0 included
    expect(wallCandidates([ln('0'), ln('A-Door')]).length).toBe(2);
  });
});
