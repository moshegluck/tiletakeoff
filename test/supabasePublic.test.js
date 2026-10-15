import { describe, it, expect } from 'vitest';
import { resolveSupabase, SUPABASE_PROJECT } from '../src/lib/supabasePublic.js';

const ok = async () => ({ address: '1.2.3.4' });
const gone = async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
const flaky = async () => { const e = new Error('getaddrinfo EAI_AGAIN'); e.code = 'EAI_AGAIN'; throw e; };
const env = { url: 'https://deadproject.supabase.co', anonKey: 'k' };

describe('resolveSupabase', () => {
  it('uses the configured project when its host exists', async () => {
    expect(await resolveSupabase(env, ok)).toEqual({ ...env, source: 'env' });
  });
  it('falls back to the live project when the configured one no longer exists', async () => {
    const r = await resolveSupabase(env, gone);
    expect(r.source).toBe('fallback');
    expect(r.url).toBe(SUPABASE_PROJECT.url);
    expect(r.anonKey).toBe(SUPABASE_PROJECT.anonKey);
    expect(r.reason).toMatch(/deadproject\.supabase\.co no longer exists/);
  });
  it('keeps the configured project on a transient DNS error', async () => {
    expect((await resolveSupabase(env, flaky)).source).toBe('env');
  });
  it('stays local-only when nothing is configured', async () => {
    expect((await resolveSupabase({}, ok)).source).toBe('none');
    expect((await resolveSupabase({ url: env.url }, ok)).source).toBe('none');
  });
  it('falls back on a malformed URL', async () => {
    expect((await resolveSupabase({ url: 'not a url', anonKey: 'k' }, ok)).source).toBe('fallback');
  });
});
