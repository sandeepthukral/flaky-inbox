import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('host dispatch', () => {
  it('404s an unknown host', async () => {
    const res = await SELF.fetch('http://evil.example/api/v2/domains/x/inboxes/y');
    expect(res.status).toBe(404);
  });

  it('routes the API host to the API app (JSON 404 for unknown path)', async () => {
    const res = await SELF.fetch('http://127.0.0.1:8787/api/v2/domains');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('routes the UI host to the UI app', async () => {
    const res = await SELF.fetch('http://localhost:8787/');
    expect(res.status).toBe(200);
  });
});
