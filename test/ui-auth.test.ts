import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { setAccessJwksOverrideForTest } from '../src/ui/access';
import worker from '../src/index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const accessEnv = { ...env, UI_AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'team.test', ACCESS_AUD: 'aud' };

afterEach(() => setAccessJwksOverrideForTest(null));

describe('UI auth', () => {
  it('serves the shell for a valid Access assertion', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' };
    setAccessJwksOverrideForTest(() => createLocalJWKSet({ keys: [jwk] }));
    const token = await new SignJWT({ email: 'qa@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setAudience('aud')
      .setIssuer('https://team.test')
      .setExpirationTime('5m')
      .sign(privateKey);
    const req = new Request('http://localhost:8787/', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    const res = await worker.fetch(req, accessEnv, ctx);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('flaky inbox');
    expect(body).toContain('qa@example.test');
  });

  it('403 responses carry the security headers', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/'), accessEnv, ctx);
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('refuses UI when team domain is whitespace only', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/'), { ...accessEnv, ACCESS_TEAM_DOMAIN: '  ' }, ctx);
    expect(res.status).toBe(403);
  });

  it('POST without Origin is 403 when UI_ORIGIN is unset', async () => {
    const res = await worker.fetch(
      new Request('http://localhost:8787/', { method: 'POST' }),
      { ...env, UI_ORIGIN: undefined } as unknown as typeof env,
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('refuses UI without assertion', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/'), accessEnv, ctx);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('flaky inbox');
  });

  it('refuses UI with a garbage assertion', async () => {
    const req = new Request('http://localhost:8787/', { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } });
    const res = await worker.fetch(req, accessEnv, ctx);
    expect(res.status).toBe(403);
  });

  it('refuses UI when access config missing', async () => {
    const res = await worker.fetch(
      new Request('http://localhost:8787/'),
      { ...accessEnv, ACCESS_TEAM_DOMAIN: undefined },
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it('dev mode serves the shell', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('flaky inbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('POST with foreign Origin is 403', async () => {
    const req = new Request('http://localhost:8787/', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it('POST without Origin is 403', async () => {
    const res = await worker.fetch(new Request('http://localhost:8787/', { method: 'POST' }), env, ctx);
    expect(res.status).toBe(403);
  });
});
