import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { buildMail } from './mail-builder';

const cfg = parseConfig(env);
const BASE = 'http://127.0.0.1:8787/api/v2/domains';
const D = 'staging.test.example';
const AUTH = { Authorization: 'stage-token-a' };

async function put(to: string, opts: Partial<Parameters<typeof buildMail>[0]> = {}, now = Date.now()) {
  const raw = buildMail({ to, ...opts });
  const out = await ingestEmail(
    { raw, rawSize: raw.length, envelopeTo: to, envelopeFrom: 'b@sender.example' },
    { db: env.DB, bucket: env.BUCKET },
    cfg,
    now,
  );
  if (out.status !== 'stored') throw new Error('not stored');
  return out.id;
}

const get = (path: string, headers: Record<string, string> = AUTH) =>
  SELF.fetch(`${BASE}/${path}`, { headers });

async function stat(domain: string, metric: string): Promise<number> {
  const r = await env.DB.prepare('SELECT SUM(count) AS n FROM daily_stats WHERE domain = ? AND metric = ?')
    .bind(domain, metric)
    .first<{ n: number | null }>();
  return r?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM daily_stats'),
  ]);
});

describe('inbox list', () => {
  it('lists newest first with helper fields', async () => {
    const older = await put(`bob@${D}`, { subject: 'old', fromName: 'Action.com' }, Date.now() - 10_000);
    const newer = await put(`bob@${D}`, { subject: 'new' }, Date.now() - 2_000);
    const res = await get(`${D}/inboxes/bob`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: string; to: string; msgs: Record<string, unknown>[] };
    expect(body.domain).toBe(D);
    expect(body.to).toBe('bob');
    expect(body.msgs.map((m) => m.id)).toEqual([newer, older]);
    const m = body.msgs[1];
    expect(m).toMatchObject({ subject: 'old', to: 'bob', from: 'Action.com', fromfull: 'orders@sender.example', origTo: `bob@${D}` });
    for (const x of body.msgs) {
      expect(typeof x.id).toBe('string');
      expect(typeof x.subject).toBe('string');
      expect(typeof x.seconds_ago).toBe('number');
    }
    expect(m.seconds_ago as number).toBeGreaterThanOrEqual(10);
  });

  it('empty inbox is 200 with msgs []', async () => {
    const res = await get(`${D}/inboxes/nobody`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: D, to: 'nobody', msgs: [] });
  });

  it('finds inbox case-insensitively, with %2B and literal +', async () => {
    const id = await put(`autouser+1@${D}`);
    for (const p of ['AutoUser%2B1', 'AutoUser+1']) {
      const body = (await (await get(`${D}/inboxes/${p}`)).json()) as { msgs: { id: string }[] };
      expect(body.msgs.map((m) => m.id)).toEqual([id]);
    }
  });

  it('expired message is hidden', async () => {
    const id = await put(`bob@${D}`, {}, Date.now() - 73 * 3_600_000);
    expect(((await (await get(`${D}/inboxes/bob`)).json()) as { msgs: unknown[] }).msgs).toEqual([]);
    expect((await get(`${D}/inboxes/bob/messages/${id}`)).status).toBe(404);
    expect((await get(`${D}/inboxes/bob/messages/${id}/links`)).status).toBe(404);
  });

  it('mail with no subject and no html lists and has detail', async () => {
    const raw = 'From: a@sender.example\r\nTo: bob@staging.test.example\r\n\r\nhello\r\n';
    const out = await ingestEmail(
      { raw, rawSize: raw.length, envelopeTo: `bob@${D}`, envelopeFrom: 'a@sender.example' },
      { db: env.DB, bucket: env.BUCKET },
      cfg,
      Date.now(),
    );
    if (out.status !== 'stored') throw new Error('x');
    const list = (await (await get(`${D}/inboxes/bob`)).json()) as { msgs: { subject: string }[] };
    expect(list.msgs[0].subject).toBe('');
    const detail = await get(`${D}/inboxes/bob/messages/${out.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { parts: unknown[]; attachments: unknown[] };
    expect(body.parts.length).toBeGreaterThan(0);
    expect(body.attachments).toEqual([]);
    expect(((await (await get(`${D}/inboxes/bob/messages/${out.id}/links`)).json()) as { links: string[] }).links).toEqual([]);
  });
});

describe('auth and domains', () => {
  it('401 on missing, wrong, Bearer, and cross-domain token, with api_error stat', async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: 'nope' }, { Authorization: 'Bearer stage-token-a' }, { Authorization: 'prod-token' }]) {
      const res = await get(`${D}/inboxes/bob`, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect(await stat(D, 'api_error')).toBe(4);
    expect(await stat(D, 'api_inbox')).toBe(4);
  });

  it('second token works', async () => {
    expect((await get(`${D}/inboxes/bob`, { Authorization: 'stage-token-b' })).status).toBe(200);
  });

  it('404 on domain not in ALLOWED_DOMAINS', async () => {
    const res = await get('evil.test.example/inboxes/bob', { Authorization: 'stage-token-a' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(await stat('_other', 'api_error')).toBe(1);
  });
});

describe('message detail and links', () => {
  it('links come from the right message', async () => {
    const a = await put(`bob@${D}`, { html: '<a href="https://a.test/x">a</a>', text: 'a' });
    const b = await put(`bob@${D}`, { html: '<a href="https://b.test/y">b</a>', text: 'b' });
    const la = (await (await get(`${D}/inboxes/bob/messages/${a}/links`)).json()) as { links: string[] };
    const lb = (await (await get(`${D}/inboxes/bob/messages/${b}/links`)).json()) as { links: string[] };
    expect(la.links).toEqual(['https://a.test/x']);
    expect(lb.links).toEqual(['https://b.test/y']);
  });

  it('quoted-printable verification link is byte-exact', async () => {
    const url = `https://gigya.test/verify?token=${'Ab3_-'.repeat(40)}&lang=nl`;
    expect(url.length).toBeGreaterThan(200);
    const id = await put(`bob@${D}`, { html: `<a href="${url.replace('&', '&amp;')}">verify</a>`, htmlQuotedPrintable: true });
    const body = (await (await get(`${D}/inboxes/bob/messages/${id}/links`)).json()) as { links: string[] };
    expect(body.links).toEqual([url]);
  });

  it('detail has Mailinator shape', async () => {
    const id = await put(`bob@${D}`, { subject: 'Hi', fromName: 'Action.com' });
    const d = (await (await get(`${D}/inboxes/bob/messages/${id}`)).json()) as Record<string, any>;
    expect(d).toMatchObject({ id, subject: 'Hi', from: 'Action.com', to: 'bob' });
    expect(d.headers.subject).toBe('Hi');
    expect(d.parts[0]).toHaveProperty('headers');
    expect(d.parts[0]).toHaveProperty('body');
    expect(typeof d.time).toBe('number');
  });

  it('message under wrong inbox or domain is 404', async () => {
    const id = await put(`bob@${D}`);
    expect((await get(`${D}/inboxes/alice/messages/${id}`)).status).toBe(404);
    expect((await get(`${D}/inboxes/alice/messages/${id}/links`)).status).toBe(404);
    const res = await get(`prod.test.example/inboxes/bob/messages/${id}`, { Authorization: 'prod-token' });
    expect(res.status).toBe(404);
  });
});

describe('stats', () => {
  it('list bumps api_inbox, links bumps api_message and accessed_api', async () => {
    const id = await put(`bob@${D}`);
    await get(`${D}/inboxes/bob`);
    expect(await stat(D, 'api_inbox')).toBe(1);
    expect(await stat(D, 'accessed_api')).toBe(0);
    await get(`${D}/inboxes/bob/messages/${id}/links`);
    expect(await stat(D, 'api_message')).toBe(1);
    expect(await stat(D, 'accessed_api')).toBe(1);
  });
});
