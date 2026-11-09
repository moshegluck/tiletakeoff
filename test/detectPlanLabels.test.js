import { describe, it, expect, vi } from 'vitest';

// mode 'labels': Claude answers per number; the route keeps only answers
// about the numbers it was sent
const sent = [];
vi.mock('@anthropic-ai/sdk', () => {
  const answer = { rooms: [{ tag: 'R1', name: 'BATH', type: 'bath' }], walls: [{ tag: 'W1', is: 'not_wall', why: 'stair edge' }], gaps: [{ tag: 'G9', is: 'separate', why: 'made up' }], openings: [] };
  const create = async (p) => { sent.push(p); return { stop_reason: 'end_turn', model: p.model, content: [{ type: 'text', text: JSON.stringify(answer) }] }; };
  class Anthropic { messages = { create }; beta = { messages: { create } }; }
  Anthropic.BadRequestError = class extends Error {};
  Anthropic.APIConnectionTimeoutError = class extends Error {};
  return { default: Anthropic };
});

process.env.ANTHROPIC_API_KEY = 'k';
delete process.env.SUPABASE_URL;
const { default: handler } = await import('../api/detect-plan.js');

async function call(body) {
  const res = { code: 0, payload: null, status(c) { this.code = c; return this; }, json(j) { this.payload = j; return this; } };
  await handler({ method: 'POST', headers: {}, socket: { remoteAddress: '1.2.3.4' }, body }, res);
  return res;
}
const tags = { rooms: [{ tag: 'R1', name: '', x: 10, y: 10, area: 40 }], walls: [{ tag: 'W1', x: 5, y: 5 }], gaps: [{ tag: 'G1', x: 7, y: 7, width: 3 }], openings: [] };

describe('api/detect-plan labels mode', () => {
  it('asks with the labels prompt and returns only the asked tags', async () => {
    const res = await call({ mode: 'labels', imageBase64: 'aGVsbG8=', mediaType: 'image/jpeg', imageWidth: 400, imageHeight: 300, tags });
    expect(res.code).toBe(200);
    expect(res.payload.rooms).toEqual([{ tag: 'R1', name: 'BATH', type: 'bath' }]);
    expect(res.payload.walls).toEqual([{ tag: 'W1', is: 'not_wall', why: 'stair edge' }]);
    expect(res.payload.gaps).toEqual([]);
    const p = sent.at(-1);
    expect(p.system).toMatch(/never give coordinates/);
    expect(p.messages[0].content[1].text).toContain('["W1",5,5]');
  });
  it('refuses a call with no numbers', async () => {
    const res = await call({ mode: 'labels', imageBase64: 'aGVsbG8=', imageWidth: 400, imageHeight: 300, tags: {} });
    expect(res.code).toBe(400);
  });
});
