import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { buildMail, makePdf } from './mail-builder';

const UI = 'http://localhost:8787';
const STAGING = 'staging.test.example';
const PROD = 'prod.test.example';
const cfg = parseConfig(env);
const deps = { db: env.DB, bucket: env.BUCKET };

async function put(
  inbox: string,
  opts: Partial<Parameters<typeof buildMail>[0]> = {},
  domain = STAGING,
  at = Date.now(),
): Promise<string> {
  const to = `${inbox}@${domain}`;
  const raw = buildMail({ to, ...opts });
  const out = await ingestEmail(
    { raw, rawSize: raw.length, envelopeTo: to, envelopeFrom: 'bounce@sender.example' },
    deps,
    cfg,
    at,
  );
  if (out.status !== 'stored') throw new Error(`not stored: ${out.status}`);
  return out.id;
}

const rowIds = (html: string) => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map((m) => m[1]);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
  ]);
  const keys = (await env.BUCKET.list()).objects.map((o) => o.key);
  if (keys.length) await env.BUCKET.delete(keys);
});

describe('inbox page', () => {
  it("shows only the selected domain's mail, newest first", async () => {
    const now = Date.now();
    const older = await put('alice', { subject: 'Older' }, STAGING, now - 60_000);
    const newer = await put('bob', { subject: 'Newer' }, STAGING, now - 1_000);
    const other = await put('carol', { subject: 'Prod mail' }, PROD, now);

    const res = await SELF.fetch(`${UI}/?domain=${STAGING}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(rowIds(html)).toEqual([newer, older]);
    expect(html).not.toContain(other);

    const prod = await (await SELF.fetch(`${UI}/?domain=${PROD}`)).text();
    expect(rowIds(prod)).toEqual([other]);
    expect(prod).toContain(`href="/m/${PROD}/carol/${other}"`);
  });

  it('defaults to the first allowed domain when domain is missing or unknown', async () => {
    const id = await put('alice');
    for (const q of ['', '?domain=nope.example']) {
      const html = await (await SELF.fetch(`${UI}/${q}`)).text();
      expect(rowIds(html)).toEqual([id]);
    }
  });

  it('prefix filter matches inbox start', async () => {
    const hit = await put('order-1');
    const hit2 = await put('order-2');
    await put('other-order');
    const html = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}&inbox=order`)).text();
    expect(new Set(rowIds(html))).toEqual(new Set([hit, hit2]));
  });

  it('paginates at 50', async () => {
    const now = Date.now();
    for (let i = 0; i < 51; i++) await put(`p${i}`, {}, STAGING, now - i * 1000);
    const p1 = await (await SELF.fetch(`${UI}/?domain=${STAGING}`)).text();
    expect(rowIds(p1)).toHaveLength(50);
    expect(p1).toContain('page=2');
    const p2 = await (await SELF.fetch(`${UI}/?domain=${STAGING}&page=2`)).text();
    expect(rowIds(p2)).toHaveLength(1);
    expect(p2).toContain('Previous');
  });

  it('clamps absurd page values to page 1', async () => {
    await put('clamp');
    for (const bad of ['Infinity', '1e999', '-5', 'abc', '99999999999999999999']) {
      const res = await SELF.fetch(`${UI}/?domain=${STAGING}&page=${bad}`);
      expect(res.status).toBe(200);
      expect(rowIds(await res.text()).length).toBe(1);
    }
  });

  it('hides expired mail', async () => {
    await put('old', {}, STAGING, Date.now() - 100 * 3_600_000);
    const fresh = await put('fresh');
    const html = await (await SELF.fetch(`${UI}/?domain=${STAGING}`)).text();
    expect(rowIds(html)).toEqual([fresh]);
  });

  it('mail with no subject shows (no subject)', async () => {
    await put('quiet', { subject: '' });
    const html = await (await SELF.fetch(`${UI}/?domain=${STAGING}`)).text();
    expect(html).toContain('(no subject)');
  });

  it('escapes mail-controlled text', async () => {
    await put('x', { subject: '<img src=x onerror=alert(1)>', fromName: 'Eve <script>' });
    const html = await (await SELF.fetch(`${UI}/?domain=${STAGING}`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('shows the PDF count', async () => {
    const pdf = await makePdf('one');
    await put('docs', { attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf }] });
    const html = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}`)).text();
    expect(html).toMatch(/<td[^>]*><a[^>]*>1<\/a><\/td>/);
  });
});

describe('POST /delete', () => {
  const post = (body: URLSearchParams) =>
    SELF.fetch(`${UI}/delete`, {
      method: 'POST',
      headers: { Origin: UI, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });

  it('removes mail and R2 objects', async () => {
    const pdf = await makePdf('gone');
    const id = await put('del', { attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', bytes: pdf }] });
    const keep = await put('keep');
    expect((await env.BUCKET.list()).objects).toHaveLength(1);

    const res = await post(new URLSearchParams([['ids', id], ['ids', 'no-such-id'], ['back', `/?domain=${STAGING}`]]));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`/?domain=${STAGING}`);

    const html = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}`)).text();
    expect(rowIds(html)).toEqual([keep]);
    expect((await env.BUCKET.list()).objects).toHaveLength(0);
  });

  it('ignores off-site back', async () => {
    for (const back of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const res = await post(new URLSearchParams([['back', back]]));
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/');
    }
  });

  it('empty selection deletes nothing and redirects', async () => {
    const id = await put('safe');
    const res = await post(new URLSearchParams());
    expect(res.status).toBe(303);
    expect(rowIds(await (await SELF.fetch(`${UI}/rows?domain=${STAGING}`)).text())).toEqual([id]);
  });

  it('403 without the matching Origin', async () => {
    const id = await put('safe');
    const res = await SELF.fetch(`${UI}/delete`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['ids', id]]),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });
});
