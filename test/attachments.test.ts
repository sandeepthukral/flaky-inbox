import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { buildMail, makePdf } from './mail-builder';

const cfg = parseConfig(env);
const BASE = 'http://127.0.0.1:8787/api/v2/domains';
const D = 'staging.test.example';
const AUTH = { Authorization: 'stage-token-a' };

type Att = { filename?: string; contentType: string; bytes: Uint8Array };
const pdfAtt = (bytes: Uint8Array, filename?: string): Att => ({ filename, contentType: 'application/pdf', bytes });

async function put(to: string, attachments: Att[], now = Date.now()) {
  const raw = buildMail({ to, attachments });
  const out = await ingestEmail(
    { raw, rawSize: raw.length, envelopeTo: to, envelopeFrom: 'b@sender.example' },
    { db: env.DB, bucket: env.BUCKET },
    cfg,
    now,
  );
  if (out.status !== 'stored') throw new Error('not stored');
  return out.id;
}

const get = (path: string, headers: Record<string, string> = AUTH) => SELF.fetch(`${BASE}/${path}`, { headers });

type Meta = { id: string; filename: string | null; contentType: string; size: number; sha256: string };
async function list(inbox: string, id: string): Promise<{ attachments: Meta[]; attachmentsIncomplete: boolean }> {
  return (await get(`${D}/inboxes/${inbox}/messages/${id}/attachments`)).json();
}

async function sha(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function stat(metric: string): Promise<number> {
  const r = await env.DB.prepare('SELECT SUM(count) AS n FROM daily_stats WHERE domain = ? AND metric = ?')
    .bind(D, metric)
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

describe('attachment download', () => {
  it('download is byte-identical', async () => {
    const pdf = await makePdf('invoice one');
    const id = await put(`bob@${D}`, [pdfAtt(pdf, 'invoice.pdf')]);
    const [meta] = (await list('bob', id)).attachments;
    expect(meta.sha256).toBe(await sha(pdf));
    const res = await get(`${D}/inboxes/bob/messages/${id}/attachments/${meta.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(pdf.length));
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await sha(await res.arrayBuffer())).toBe(await sha(pdf));
  });

  it('two mails, each URL returns only its own file', async () => {
    const pa = await makePdf('mail A');
    const pb = await makePdf('mail B');
    const a = await put(`bob@${D}`, [pdfAtt(pa, 'a.pdf')]);
    const b = await put(`bob@${D}`, [pdfAtt(pb, 'b.pdf')]);
    const [ma] = (await list('bob', a)).attachments;
    const [mb] = (await list('bob', b)).attachments;
    const ra = await get(`${D}/inboxes/bob/messages/${a}/attachments/${ma.id}`);
    const rb = await get(`${D}/inboxes/bob/messages/${b}/attachments/${mb.id}`);
    expect(await sha(await ra.arrayBuffer())).toBe(await sha(pa));
    expect(await sha(await rb.arrayBuffer())).toBe(await sha(pb));
    expect(await sha(pa)).not.toBe(await sha(pb));
  });

  it("A's attachment id under B's message URL is 404", async () => {
    const a = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')]);
    const b = await put(`bob@${D}`, [pdfAtt(await makePdf('B'), 'b.pdf')]);
    const [ma] = (await list('bob', a)).attachments;
    const res = await get(`${D}/inboxes/bob/messages/${b}/attachments/${ma.id}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toBe('application/pdf');
  });

  it('right ids under wrong inbox or wrong domain are 404', async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')]);
    const [m] = (await list('bob', id)).attachments;
    expect((await get(`${D}/inboxes/alice/messages/${id}/attachments/${m.id}`)).status).toBe(404);
    expect((await get(`${D}/inboxes/alice/messages/${id}/attachments`)).status).toBe(404);
    const prod = { Authorization: 'prod-token' };
    expect((await get(`prod.test.example/inboxes/bob/messages/${id}/attachments/${m.id}`, prod)).status).toBe(404);
    expect((await get(`prod.test.example/inboxes/bob/messages/${id}/attachments`, prod)).status).toBe(404);
  });

  it('two invoice.pdf in one mail are both downloadable and differ', async () => {
    const p1 = await makePdf('first');
    const p2 = await makePdf('second');
    const id = await put(`bob@${D}`, [pdfAtt(p1, 'invoice.pdf'), pdfAtt(p2, 'invoice.pdf')]);
    const { attachments } = await list('bob', id);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a) => a.filename)).toEqual(['invoice.pdf', 'invoice.pdf']);
    const hashes = new Set<string>();
    for (const a of attachments) {
      const res = await get(`${D}/inboxes/bob/messages/${id}/attachments/${a.id}`);
      expect(res.status).toBe(200);
      const h = await sha(await res.arrayBuffer());
      expect(h).toBe(a.sha256);
      hashes.add(h);
    }
    expect(hashes).toEqual(new Set([await sha(p1), await sha(p2)]));
  });

  it('listing shows attachmentsIncomplete for a flagged message', async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')]);
    expect((await list('bob', id)).attachmentsIncomplete).toBe(false);
    await env.DB.prepare('UPDATE messages SET attachments_incomplete = 1 WHERE id = ?').bind(id).run();
    const body = await list('bob', id);
    expect(body.attachmentsIncomplete).toBe(true);
    expect(body.attachments).toHaveLength(1);
  });

  it('size mismatch returns 500', async () => {
    const pdf = await makePdf('A');
    const id = await put(`bob@${D}`, [pdfAtt(pdf, 'a.pdf')]);
    const row = await env.DB.prepare('SELECT id, r2_key FROM attachments WHERE message_id = ?')
      .bind(id)
      .first<{ id: string; r2_key: string }>();
    await env.BUCKET.put(row!.r2_key, new Uint8Array([1, 2, 3]));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get(`${D}/inboxes/bob/messages/${id}/attachments/${row!.id}`);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-type')).not.toBe('application/pdf');
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('missing R2 object returns 500', async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')]);
    const row = await env.DB.prepare('SELECT id, r2_key FROM attachments WHERE message_id = ?')
      .bind(id)
      .first<{ id: string; r2_key: string }>();
    await env.BUCKET.delete(row!.r2_key);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get(`${D}/inboxes/bob/messages/${id}/attachments/${row!.id}`);
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("expired message's attachment is 404", async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')], Date.now() - 73 * 3_600_000);
    const row = await env.DB.prepare('SELECT id FROM attachments WHERE message_id = ?').bind(id).first<{ id: string }>();
    expect((await get(`${D}/inboxes/bob/messages/${id}/attachments/${row!.id}`)).status).toBe(404);
    expect((await get(`${D}/inboxes/bob/messages/${id}/attachments`)).status).toBe(404);
  });

  it('awkward filename gives safe header', async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'placeholder.pdf'), pdfAtt(await makePdf('B'))]);
    // A raw CR/LF cannot survive MIME header parsing, so set the hostile name on the stored row directly.
    await env.DB.prepare('UPDATE attachments SET filename = ? WHERE message_id = ? AND filename = ?')
      .bind('../x"\r\n€.pdf', id, 'placeholder.pdf')
      .run();
    const { attachments } = await list('bob', id);
    expect(attachments).toHaveLength(2);
    const h1 = (await get(`${D}/inboxes/bob/messages/${id}/attachments/${attachments[0].id}`)).headers.get('content-disposition')!;
    expect(h1).not.toMatch(/[\r\n]/);
    expect(h1).not.toContain('/');
    expect(h1).toContain("filename*=UTF-8''");
    const h2 = (await get(`${D}/inboxes/bob/messages/${id}/attachments/${attachments[1].id}`)).headers.get('content-disposition')!;
    expect(h2).toContain('attachment.pdf');
  });

  it('accessed_api and api_attachment stats bump on download', async () => {
    const id = await put(`bob@${D}`, [pdfAtt(await makePdf('A'), 'a.pdf')]);
    const [m] = (await list('bob', id)).attachments;
    expect(await stat('api_attachment')).toBe(1);
    expect(await stat('accessed_api')).toBe(1);
    await (await get(`${D}/inboxes/bob/messages/${id}/attachments/${m.id}`)).arrayBuffer();
    expect(await stat('api_attachment')).toBe(2);
    expect(await stat('accessed_api')).toBe(2);
    await get(`${D}/inboxes/bob/messages/${id}/attachments/nope`);
    expect(await stat('api_attachment')).toBe(3);
    expect(await stat('accessed_api')).toBe(2);
    expect(await stat('api_error')).toBe(1);
  });
});
