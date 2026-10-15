import { describe, it, expect, vi, beforeEach } from 'vitest';

// The production failure: SUPABASE_URL names a deleted project, the browser
// signs in to the live one. The route must verify with the live project.
const created = [];
vi.mock('@supabase/supabase-js', () => ({
  createClient: (url) => {
    created.push(url);
    return { auth: { getUser: async () => (url.includes('deadproject')
      ? { data: null, error: new Error('fetch failed') }
      : { data: { user: { id: 'u1' } }, error: null }) } };
  },
}));
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rooms":[]}' }] }) };
    beta = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rooms":[]}' }] }) } };
  }
  Anthropic.BadRequestError = class extends Error {};
  Anthropic.APIConnectionTimeoutError = class extends Error {};
  return { default: Anthropic };
});

process.env.ANTHROPIC_API_KEY = 'k';
process.env.SUPABASE_URL = 'https://deadproject.supabase.co';
process.env.SUPABASE_ANON_KEY = 'old-anon';
const { default: handler } = await import('../api/detect-plan.js');
const { SUPABASE_PROJECT } = await import('../src/lib/supabasePublic.js');

const jwt = (iss) => ['e30', Buffer.from(JSON.stringify({ iss, sub: 'u1' })).toString('base64url'), 'sig'].join('.');
const body = { imageBase64: 'aGVsbG8=', mediaType: 'image/png', imageWidth: 100, imageHeight: 100 };
async function call(token) {
  const res = { code: 0, payload: null, status(c) { this.code = c; return this; }, json(j) { this.payload = j; return this; } };
  await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, socket: {}, body }, res);
  return res;
}
beforeEach(() => { created.length = 0; });

describe('api/detect-plan sign-in check', () => {
  it('accepts a session from the live project although env names a dead one', async () => {
    const res = await call(jwt(`${SUPABASE_PROJECT.url}/auth/v1`));
    expect(res.code).toBe(200);
    expect(created).toEqual([SUPABASE_PROJECT.url]);
  });
  it('asks for sign-in with no token', async () => {
    const res = await call(null);
    expect(res.code).toBe(401);
    expect(res.payload.error).toMatch(/Sign in/);
  });
  it('refuses a token from a project that is not ours, without calling it', async () => {
    const res = await call(jwt('https://evil.example/auth/v1'));
    expect(res.code).toBe(401);
    expect(created).toEqual([]);
  });
});
