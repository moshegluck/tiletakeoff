import { describe, it, expect } from 'vitest';
import { findingsToFlags } from '../src/lib/aiReview.js';

describe('AI check findings → flags on the plan', () => {
  const img = {
    k: 2, x0: 100, y0: 50,
    tags: {
      rooms: [{ tag: 'R1', id: 'r7', name: 'GYM' }, { tag: 'R2', id: 'r8', name: 'BATH' }],
      openings: [{ tag: 'O1', id: 'o3', type: 'door' }],
    },
  };
  it('puts each finding where the AI pointed, in feet, tied to its room / opening', () => {
    const scale = 1 / 36;   // ft per plan px
    const out = findingsToFlags({ findings: [{ kind: 'missed_door', room: 'R2', opening: 'O1', x: 200, y: 100, note: 'door drawn here', confidence: 0.8 }], roomsOk: ['R1', 'R9'] }, img, scale);
    expect(out.flags).toHaveLength(1);
    const f = out.flags[0];
    expect(f).toMatchObject({ severity: 'warn', kind: 'ai_missed_door', roomId: 'r8', openingId: 'o3', ai: true });
    // image px 200 → plan px 100 + 100 = 200 → 200 / 36 ft
    expect(f.at.x).toBeCloseTo(200 / 36, 9);
    expect(f.at.y).toBeCloseTo(100 / 36, 9);
    expect(f.msg).toMatch(/^AI check — missed doorway \(BATH · door O1\): door drawn here$/);
    expect(out.okIds).toEqual(['r7']);
  });
});
