import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const accessEnv = { ...env, UI_AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'team.test', ACCESS_AUD: 'aud' };

describe('UI auth', () => {
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
