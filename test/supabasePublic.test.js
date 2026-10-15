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

import { tokenIssuerOrigin, projectForToken } from '../src/lib/supabasePublic.js';
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

describe('session routing by token issuer', () => {
  const live = jwt({ iss: `${SUPABASE_PROJECT.url}/auth/v1`, sub: 'u1' });
  const dead = { url: 'https://deadproject.supabase.co', anonKey: 'old' };
  it('reads the issuer origin', () => {
    expect(tokenIssuerOrigin(live)).toBe(SUPABASE_PROJECT.url);
    expect(tokenIssuerOrigin('garbage')).toBeNull();
  });
  it('routes a live-project token to the live project even when env names a dead one', () => {
    expect(projectForToken(live, dead)).toEqual({ url: SUPABASE_PROJECT.url, anonKey: SUPABASE_PROJECT.anonKey });
  });
  it('routes a configured-project token to the configured project', () => {
    expect(projectForToken(jwt({ iss: 'https://deadproject.supabase.co/auth/v1' }), dead)).toEqual(dead);
  });
  it('refuses tokens from anyone else', () => {
    expect(projectForToken(jwt({ iss: 'https://evil.example/auth/v1' }), dead)).toBeNull();
    expect(projectForToken('not.a.jwt', dead)).toBeNull();
  });
});
