import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readsPlans, planModels, isModelProblem, DEFAULT_MODEL } from '../src/lib/planModels.js';

describe('planModels: which models may read plans', () => {
  it('accepts full-resolution models and rejects older ones', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-opus-4-7-20260301']) {
      expect(readsPlans(id), id).toBe(true);
    }
    for (const id of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-latest', 'claude-haiku-4-5', 'gpt-4o', '', undefined]) {
      expect(readsPlans(id), String(id)).toBe(false);
    }
  });

  it('builds the chain: configured (if capable), then the default', () => {
    expect(planModels(undefined)).toEqual({ chain: [DEFAULT_MODEL], ignored: null });
    expect(planModels(' ')).toEqual({ chain: [DEFAULT_MODEL], ignored: null });
    expect(planModels(DEFAULT_MODEL)).toEqual({ chain: [DEFAULT_MODEL], ignored: null });
    expect(planModels('claude-sonnet-5-5')).toEqual({ chain: ['claude-sonnet-5-5', DEFAULT_MODEL], ignored: null });
    expect(planModels('claude-sonnet-4-5')).toEqual({ chain: [DEFAULT_MODEL], ignored: 'claude-sonnet-4-5' });
  });

  it('tells model problems from request problems', () => {
    expect(isModelProblem({ status: 400, message: 'adaptive thinking is not supported on this model' })).toBe(true);
    expect(isModelProblem({ status: 400, message: 'effort: unsupported value' })).toBe(true);
    expect(isModelProblem({ status: 404, message: 'model: claude-x' })).toBe(true);
    expect(isModelProblem({ status: 400, message: 'Could not process image' })).toBe(false);
    expect(isModelProblem({ status: 429, message: 'rate limited for this model' })).toBe(false);
    expect(isModelProblem({ status: 500 })).toBe(false);
  });
});

// The route itself, with ANTHROPIC_MODEL set to different values.
const calls = [];
let queue = [];
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class BadRequestError extends APIError { constructor(msg) { super(400, msg); } }
  class NotFoundError extends APIError { constructor(msg) { super(404, msg); } }
  class APIConnectionTimeoutError extends Error {}
  const next = (kind, params) => {
    calls.push({ kind, model: params.model });
    const r = queue.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  class Anthropic {
    messages = { create: async (p) => next('plain', p) };
    beta = { messages: { create: async (p) => next('beta', p) } };
  }
  Object.assign(Anthropic, { APIError, BadRequestError, NotFoundError, APIConnectionTimeoutError });
  return { default: Anthropic };
});

const answer = { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rooms":[]}' }] };
const body = { imageBase64: 'aGVsbG8=', mediaType: 'image/png', imageWidth: 2000, imageHeight: 1500 };
async function route(model) {
  vi.resetModules();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  if (model) process.env.ANTHROPIC_MODEL = model; else delete process.env.ANTHROPIC_MODEL;
  const { default: handler } = await import('../api/detect-plan.js');
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const call = () => {
    const res = { code: 0, payload: null, status(c) { this.code = c; return this; }, json(j) { this.payload = j; return this; } };
    return handler({ method: 'POST', headers: {}, socket: {}, body }, res).then(() => res);
  };
  return { call, Anthropic };
}

describe('api/detect-plan model choice', () => {
  const env = process.env.ANTHROPIC_MODEL;
  beforeEach(() => { calls.length = 0; queue = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); if (env === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = env; });

  it('ignores an older ANTHROPIC_MODEL and uses the default', async () => {
    const { call } = await route('claude-sonnet-4-5');
    queue.push(answer);
    expect((await call()).code).toBe(200);
    expect(calls).toEqual([{ kind: 'beta', model: DEFAULT_MODEL }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-sonnet-4-5/));
  });

  it('falls back to the default when the configured model rejects the request', async () => {
    const { call, Anthropic } = await route('claude-sonnet-5');
    queue.push(new Anthropic.BadRequestError('adaptive thinking is not supported on this model'), answer);
    expect((await call()).code).toBe(200);
    expect(calls).toEqual([{ kind: 'plain', model: 'claude-sonnet-5' }, { kind: 'beta', model: DEFAULT_MODEL }]);
  });

  it('falls back when the configured model is unknown to the key', async () => {
    const { call, Anthropic } = await route('claude-opus-5');
    queue.push(new Anthropic.BadRequestError('fallbacks: unknown'), new Anthropic.NotFoundError('model: claude-opus-5'), answer);
    expect((await call()).code).toBe(200);
    expect(calls.map((c) => `${c.kind}:${c.model}`)).toEqual(['beta:claude-opus-5', 'plain:claude-opus-5', `beta:${DEFAULT_MODEL}`]);
  });

  it('does not switch models over an image problem', async () => {
    const { call, Anthropic } = await route(undefined);
    queue.push(new Anthropic.BadRequestError('fallbacks: unknown'), new Anthropic.BadRequestError('Could not process image'));
    const res = await call();
    expect(res.code).toBe(502);
    expect(calls).toHaveLength(2);
  });
});
