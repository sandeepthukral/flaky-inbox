import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { initials, pageWindow, parseInboxQuery, previewText } from '../src/ui/inbox';
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

  it('paginates at 25 by default', async () => {
    const now = Date.now();
    for (let i = 0; i < 51; i++) await put(`p${i}`, {}, STAGING, now - i * 1000);
    const p1 = await (await SELF.fetch(`${UI}/?domain=${STAGING}`)).text();
    expect(rowIds(p1)).toHaveLength(25);
    expect(p1).toContain('Showing 1–25 of 51');
    expect(p1).toContain(`href="/?domain=${STAGING}&amp;page=2"`);
    expect(p1).toContain(`href="/?domain=${STAGING}&amp;page=3"`);
    const p3 = await (await SELF.fetch(`${UI}/?domain=${STAGING}&page=3`)).text();
    expect(rowIds(p3)).toHaveLength(1);
    expect(p3).toContain('Showing 51–51 of 51');
    expect(p3).toContain('aria-label="Previous page"');
  });

  it('size picks 50 or 100 per page and is kept in page links', async () => {
    const now = Date.now();
    for (let i = 0; i < 101; i++) await put(`s${i}`, {}, STAGING, now - i * 1000);
    const p50 = await (await SELF.fetch(`${UI}/?domain=${STAGING}&size=50`)).text();
    expect(rowIds(p50)).toHaveLength(50);
    expect(p50).toContain(`href="/?domain=${STAGING}&amp;size=50&amp;page=2"`);
    expect(p50).toMatch(/<option value="50" selected/);
    const p100 = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}&size=100`)).text();
    expect(rowIds(p100)).toHaveLength(100);
    const odd = await (await SELF.fetch(`${UI}/?domain=${STAGING}&size=7`)).text();
    expect(rowIds(odd)).toHaveLength(25);
  });

  it('delete form returns to the same size and page', async () => {
    await put('keep-size');
    const html = await (await SELF.fetch(`${UI}/?domain=${STAGING}&size=100`)).text();
    expect(html).toContain(`name="back" value="/?domain=${STAGING}&amp;size=100"`);
  });

  it('long inbox names carry the full name as a hover title', async () => {
    const long = `autouserwebtest-${'a'.repeat(36)}`;
    await put(long);
    const html = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}`)).text();
    expect(html).toContain(`class="inbox mono" title="${long}"`);
  });

  it('shows a text preview, sender initials and a NEW tag on fresh mail', async () => {
    const now = Date.now();
    await put('fresh', { fromName: 'Jane Doe', text: 'Hello   there\r\n  world' }, STAGING, now - 60_000);
    await put('older', { fromName: 'Old Sender' }, STAGING, now - 10 * 60_000);
    const html = await (await SELF.fetch(`${UI}/rows?domain=${STAGING}`)).text();
    expect(html).toContain('Hello there world');
    expect(html).toMatch(/class="av av\d"[^>]*>JD</);
    expect(html.match(/class="newtag"/g)).toHaveLength(1);
    expect(html).toContain('10 min ago');
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
    expect(html).toContain('PDF · 1');
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

describe('inbox helpers', () => {
  it('parseInboxQuery accepts only 25, 50 and 100 as size', () => {
    const q = (size?: string) => parseInboxQuery(cfg, { domain: STAGING, size }).size;
    expect(q()).toBe(25);
    expect(q('50')).toBe(50);
    expect(q('100')).toBe(100);
    for (const bad of ['0', '10', '1000', 'abc', '-25', '50.5']) expect(q(bad)).toBe(25);
  });

  it('pageWindow shows first, last and the neighbours of the current page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
    expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, '…', 10]);
    expect(pageWindow(4, 10)).toEqual([1, 2, 3, 4, 5, '…', 10]);
    expect(pageWindow(10, 10)).toEqual([1, '…', 9, 10]);
  });

  it('initials take the first letters of up to two words, else the address', () => {
    expect(initials('Jane Doe', 'x@y.z')).toBe('JD');
    expect(initials('Action', 'x@y.z')).toBe('A');
    expect(initials('  sandeep singh thukral ', 'x@y.z')).toBe('SS');
    expect(initials(null, 'orders@sender.example')).toBe('O');
    expect(initials('', '')).toBe('?');
  });

  it('previewText collapses whitespace and cuts at 140 characters', () => {
    expect(previewText(null)).toBe('');
    expect(previewText('  a \n\t b  ')).toBe('a b');
    expect(previewText('x'.repeat(200))).toHaveLength(140);
  });
});
