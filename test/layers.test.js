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

  it('a wall-type layer holds the tags naming each wall\'s type, not walls (Carlton Rd, Bais Rochel)', () => {
    // Carlton's "A-WALL TYPE" diamonds paired into 10" walls
    expect(['A-WALL TYPE', 'A-WALLTYPE', 'A-Wall_Type', 'WALL TYPES'].map(classifyLayer)).toEqual(['ignore', 'ignore', 'ignore', 'ignore']);
    expect(['A-Wall', 'A-WALL-FULL', 'A-WALL-TYP1'].map(classifyLayer)).toEqual(['wall', 'wall', 'wall']);
  });

  it('reads layer names in the drafter\'s language and in AIA shorthand (Saddle River, Promenade)', () => {
    // Saddle River's dimensions are on "Размеры" (Russian: dimensions); paired with a wall face they made a 20" wall
    expect(['Размеры', 'Cotation', 'A-FIX.', 'A-SHBD', 'logo', 'A-N-MOB-MOB-TAB-CHA'].map(classifyLayer)).toEqual(['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore']);
    expect(['A-N-ENV-MUR-02', 'Стены'].map(classifyLayer)).toEqual(['wall', 'wall']);
    expect(['A-D-ELE-FEN', 'A-N-INT-FEN'].map(classifyLayer)).toEqual(['window', 'window']);
    expect(classifyLayer('Portes')).toBe('door');
    // Promenade: casework, columns, floor patterns, railings and the out-of-scope outline are no walls
    expect(['A-101|Q-CASE', 'A-101|A-COLS', 'ID-FLOOR PAT-OUTLINE', 'A-101|A-FLOR-HRAL', 'NOT IN SCOPE'].map(classifyLayer)).toEqual(['ignore', 'ignore', 'ignore', 'ignore', 'ignore']);
    // …and names that only look alike keep their meaning
    expect(['A-WALL', 'S-WALL', 'STAIRCASE WALL', 'A-101|A-GENM', '04', 'FIXED GLASS'].map(classifyLayer)).toEqual(['wall', 'wall', 'wall', 'other', 'other', 'other']);
  });

  it('on a sheet that names its wall layers, layer "0" (ticks, break lines) gives no walls', () => {
    const ln = (layer) => ({ a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, layer });
    const lines = [...Array(40)].map(() => ln('A-Wall')).concat([ln('0'), ln('A - FOUNDATION'), ln('A-Door')]);
    expect(wallCandidates(lines).map((l) => l.layer).filter((n) => n !== 'A-Wall')).toEqual(['A - FOUNDATION']);
    // a sheet without wall layers keeps everything, layer 0 included
    expect(wallCandidates([ln('0'), ln('A-Door')]).length).toBe(2);
  });
});
