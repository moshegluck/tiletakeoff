import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stand-in for the Anthropic SDK: records every request and replays queued
// results, so the route's request shape and response cleaning are tested
// without a key or network.
const calls = [];
let queue = [];
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class BadRequestError extends APIError { constructor(msg) { super(400, msg); } }
  class APIConnectionTimeoutError extends Error {}
  const next = (kind, params) => {
    calls.push({ kind, params });
    const r = queue.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  class Anthropic {
    constructor(opts) { this.opts = opts; }
    messages = { create: async (p) => next('plain', p) };
    beta = { messages: { create: async (p) => next('beta', p) } };
  }
  Anthropic.APIError = APIError;
  Anthropic.BadRequestError = BadRequestError;
  Anthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
  return { default: Anthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key';
const { default: handler } = await import('../api/detect-plan.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;

function call(body) {
  const res = { code: 0, payload: null, status(c) { this.code = c; return this; }, json(j) { this.payload = j; return this; } };
  return handler({ method: 'POST', headers: {}, socket: {}, body }, res).then(() => res);
}
const answer = (rooms) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ rooms }) }] });
const body = { imageBase64: 'aGVsbG8=', mediaType: 'image/jpeg', imageWidth: 2000, imageHeight: 1500, feetPerPixel: 0.02 };

beforeEach(() => { calls.length = 0; queue = []; });

describe('api/detect-plan', () => {
  it('asks Claude Opus 5.5 for pixel outlines with fallbacks, effort and a schema', async () => {
    queue.push(answer([{ name: 'KITCHEN', x: 100, y: 50, w: 400, h: 300, outline: [], dim_text: "12'x10'", dim_w_ft: 12, dim_h_ft: 10, confidence: 0.9 }]));
    const res = await call(body);
    expect(res.code).toBe(200);
    const { kind, params } = calls[0];
    expect(kind).toBe('beta');
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config.effort).toBe('high');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.messages[0].content[1].text).toMatch(/2000 × 1500 pixels/);
    expect(res.payload.rooms[0]).toMatchObject({ name: 'KITCHEN', x: 100, y: 50, w: 400, h: 300, dimWFt: 12, dimHFt: 10 });
    expect(res.payload.imageWidth).toBe(2000);
  });

  it('retries without fallbacks if the API rejects that request shape', async () => {
    queue.push(new Anthropic.BadRequestError('fallbacks: unknown field'), answer([]));
    const res = await call(body);
    expect(res.code).toBe(200);
    expect(calls.map((c) => c.kind)).toEqual(['beta', 'plain']);
    expect(calls[1].params.fallbacks).toBeUndefined();
    expect(calls[1].params.betas).toBeUndefined();
  });

  it('clamps rooms to the image and drops unusable ones', async () => {
    queue.push(answer([
      { name: 'A', x: -20, y: 10, w: 300, h: 200, outline: [{ x: -5, y: 10 }, { x: 'bad', y: 1 }], dim_text: '', dim_w_ft: -3, dim_h_ft: 5000, confidence: 7 },
      { name: 'B', x: 10, y: 10, w: NaN, h: 20, outline: [], dim_text: '', dim_w_ft: 0, dim_h_ft: 0, confidence: 0.5 },
      { name: 'C', x: 1990, y: 10, w: 400, h: 200, outline: [], dim_text: '', dim_w_ft: 0, dim_h_ft: 0, confidence: 0.5 },
    ]));
    const res = await call(body);
    const rooms = res.payload.rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms[0]).toMatchObject({ x: 0, w: 280, dimWFt: 0, dimHFt: 0, confidence: 1 });
    expect(rooms[0].outline).toEqual([{ x: 0, y: 10 }]);
    expect(rooms[1]).toMatchObject({ x: 1990, w: 10 });
  });

  it('rejects requests without image dimensions or with oversized images', async () => {
    expect((await call({ ...body, imageWidth: undefined })).code).toBe(400);
    expect((await call({ ...body, imageWidth: 4000 })).code).toBe(400);
    expect((await call({ ...body, imageBase64: 'x'.repeat(4_200_001) })).code).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('reports a refusal as an empty result with a warning', async () => {
    queue.push({ stop_reason: 'refusal', content: [] });
    const res = await call(body);
    expect(res.payload.rooms).toEqual([]);
    expect(res.payload.warning).toMatch(/declined/);
  });

  it('review mode: shows Claude the traced model and keeps only findings on real tags', async () => {
    const review = { findings: [
      { kind: 'window_as_door', room: 'R1', opening: 'O2', x: 400, y: -30, note: 'O2 is a casement window (R3553 CAS), not a door', confidence: 0.9 },
      { kind: 'false_wall', room: 'R9', opening: 'O7', x: 50, y: 60, note: 'stair break line', confidence: 0.8 },
      { kind: 'made_up', room: 'R1', opening: '', x: 1, y: 1, note: 'x', confidence: 1 },
      { kind: 'outline_off', room: 'R2', opening: '', x: 10, y: 10, note: 'unsure', confidence: 0.1 },
    ], rooms_ok: ['R2', 'R5'] };
    queue.push({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(review) }] });
    const res = await call({
      mode: 'review', imageBase64: 'aGVsbG8=', mediaType: 'image/jpeg', imageWidth: 1800, imageHeight: 1200, pxPerFt: 36,
      rooms: [{ tag: 'R1', name: 'SPACE 1', x: 300, y: 200, areaSf: 36.6, wallLf: 16.4 }, { tag: 'R2', name: 'GYM', x: 900, y: 600, areaSf: 142.6, wallLf: 39.8 }],
      openings: [{ tag: 'O1', type: 'door', x: 100, y: 100, widthFt: 2.5 }, { tag: 'O2', type: 'opening', x: 400, y: 10, widthFt: 6.6 }],
    });
    expect(res.code).toBe(200);
    const { params } = calls[0];
    expect(params.system).toMatch(/never supplies|Never invent/i);
    expect(params.output_config.format.schema.properties.findings).toBeTruthy();
    expect(params.messages[0].content[1].text).toMatch(/R1.*SPACE 1/);
    expect(params.messages[0].content[1].text).toMatch(/O2.*opening/);
    expect(res.payload.findings).toEqual([
      { kind: 'window_as_door', room: 'R1', opening: 'O2', x: 400, y: 0, note: 'O2 is a casement window (R3553 CAS), not a door', confidence: 0.9 },
      { kind: 'false_wall', room: '', opening: '', x: 50, y: 60, note: 'stair break line', confidence: 0.8 },
    ]);
    expect(res.payload.roomsOk).toEqual(['R2']);
  });
});
