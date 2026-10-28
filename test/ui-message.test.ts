import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { buildMail, makePdf } from './mail-builder';

const UI = 'http://localhost:8787';
const API = 'http://127.0.0.1:8787/api/v2/domains';
const D = 'staging.test.example';
const cfg = parseConfig(env);

type Att = { filename?: string; contentType: string; bytes: Uint8Array };

async function put(inbox: string, opts: Partial<Parameters<typeof buildMail>[0]> = {}, domain = D) {
  const to = `${inbox}@${domain}`;
  const raw = buildMail({ to, ...opts });
  const out = await ingestEmail(
    { raw, rawSize: raw.length, envelopeTo: to, envelopeFrom: 'bounce@sender.example' },
    { db: env.DB, bucket: env.BUCKET },
    cfg,
    Date.now(),
  );
  if (out.status !== 'stored') throw new Error(`not stored: ${out.status}`);
  return out.id;
}

const pdf = async (label: string, filename: string): Promise<Att> => ({
  filename,
  contentType: 'application/pdf',
  bytes: await makePdf(label),
});

async function sha(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function stat(metric: string): Promise<number> {
  const r = await env.DB.prepare('SELECT SUM(count) AS n FROM daily_stats WHERE metric = ?')
    .bind(metric)
    .first<{ n: number | null }>();
  return r?.n ?? 0;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM daily_stats'),
  ]);
  const keys = (await env.BUCKET.list()).objects.map((o) => o.key);
  if (keys.length) await env.BUCKET.delete(keys);
});

describe('message page', () => {
  it('renders header, attachments and four tabs', async () => {
    const att = await pdf('invoice', 'invoice.pdf');
    const id = await put('alice', {
      subject: 'Hello',
      html: '<p>Click <a href="https://example.com/verify?x=1&amp;y=2">here</a></p>',
      text: 'Plain body',
      attachments: [att],
    });
    const res = await SELF.fetch(`${UI}/m/${D}/alice/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`alice@${D}`);
    expect(html).toContain('orders@sender.example');
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(html).toContain('invoice.pdf');
    const hash = await sha(att.bytes);
    expect(html).toContain(`title="${hash}"`);
    expect(html).toContain(hash.slice(0, 8));
    expect(html).toContain(`href="/m/${D}/alice/${id}/a/`);
    for (const tab of ['HTML', 'TEXT', 'JSON', 'LINKS']) expect(html).toContain(`data-tab="${tab.toLowerCase()}"`);
    expect(html).toContain('<pre');
    expect(html).toContain('Plain body');
    expect(html).toContain('href="https://example.com/verify?x=1&amp;y=2"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain(`value="/?domain=${D}"`);
  });

  it('iframe is sandboxed without allow-scripts', async () => {
    const id = await put('bob', { html: '<script>alert(1)</script><p>hi</p>' });
    const html = await (await SELF.fetch(`${UI}/m/${D}/bob/${id}`)).text();
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain('allow-scripts');
    const m = html.match(/srcdoc="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('&lt;script&gt;alert(1)');
    expect(html.replace(m![0], '')).not.toContain('<script>alert(1)');
  });

  it('JSON tab equals API detail', async () => {
    const id = await put('carol', { subject: 'Json', attachments: [await pdf('j', 'j.pdf')] });
    const html = await (await SELF.fetch(`${UI}/m/${D}/carol/${id}`)).text();
    const m = html.match(/<pre id="tab-json"[^>]*>([\s\S]*?)<\/pre>/);
    expect(m).not.toBeNull();
    const shown = JSON.parse(unescapeHtml(m![1]));
    const api = await (
      await SELF.fetch(`${API}/${D}/inboxes/carol/messages/${id}`, { headers: { Authorization: 'stage-token-a' } })
    ).json();
    expect(shown).toEqual(api);
  });

  it('UI download is byte-identical and binding-checked', async () => {
    const a = await pdf('mine', 'a.pdf');
    const idA = await put('dave', { attachments: [a] });
    const idB = await put('erin', { attachments: [await pdf('other', 'b.pdf')] });
    const page = await (await SELF.fetch(`${UI}/m/${D}/dave/${idA}`)).text();
    const attId = page.match(new RegExp(`/m/${D}/dave/${idA}/a/([^"]+)"`))![1];

    const ok = await SELF.fetch(`${UI}/m/${D}/dave/${idA}/a/${attId}`);
    expect(ok.status).toBe(200);
    expect(await sha(await ok.arrayBuffer())).toBe(await sha(a.bytes));

    expect((await SELF.fetch(`${UI}/m/${D}/erin/${idB}/a/${attId}`)).status).toBe(404);
  });

  it('shows incomplete warning', async () => {
    const id = await put('frank');
    await env.DB.prepare('UPDATE messages SET attachments_incomplete = 1, skipped_attachments = 2 WHERE id = ?')
      .bind(id)
      .run();
    const html = await (await SELF.fetch(`${UI}/m/${D}/frank/${id}`)).text();
    expect(html).toContain('Some attachments could not be stored');
    expect(html).toContain('2 PDFs were over the limit and not stored');
  });

  it('wrong domain or inbox is 404', async () => {
    const id = await put('gina');
    expect((await SELF.fetch(`${UI}/m/prod.test.example/gina/${id}`)).status).toBe(404);
    expect((await SELF.fetch(`${UI}/m/${D}/other/${id}`)).status).toBe(404);
    expect((await SELF.fetch(`${UI}/m/${D}/GINA/${id}`)).status).toBe(200);
  });

  it('accessed_ui bumps on view and download', async () => {
    const id = await put('hank', { attachments: [await pdf('h', 'h.pdf')] });
    expect(await stat('accessed_ui')).toBe(0);
    const page = await (await SELF.fetch(`${UI}/m/${D}/hank/${id}`)).text();
    expect(await stat('accessed_ui')).toBe(1);
    const attId = page.match(new RegExp(`/m/${D}/hank/${id}/a/([^"]+)"`))![1];
    await (await SELF.fetch(`${UI}/m/${D}/hank/${id}/a/${attId}`)).arrayBuffer();
    expect(await stat('accessed_ui')).toBe(2);
    await SELF.fetch(`${UI}/m/${D}/hank/${id}/a/nope`);
    await SELF.fetch(`${UI}/m/${D}/nobody/${id}`);
    expect(await stat('accessed_ui')).toBe(2);
  });
});
