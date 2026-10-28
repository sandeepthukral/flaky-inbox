import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { type IngestDeps, ingestEmail } from '../src/ingest/ingest';
import { buildMail, makePdf } from './mail-builder';

const NOW = 1_800_000_000_000;
const TO = 'alice@staging.test.example';
const cfg = parseConfig(env);
const deps: IngestDeps = { db: env.DB, bucket: env.BUCKET };

function input(raw: string, over: Partial<{ rawSize: number; envelopeTo: string }> = {}) {
  return {
    raw,
    rawSize: over.rawSize ?? raw.length,
    envelopeTo: over.envelopeTo ?? TO,
    envelopeFrom: 'bounce@sender.example',
  };
}

const pdfAtt = (filename: string, bytes: Uint8Array) => ({
  filename,
  contentType: 'application/pdf',
  bytes,
});

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function r2Keys(): Promise<string[]> {
  return (await env.BUCKET.list()).objects.map((o) => o.key);
}

async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return r?.n ?? 0;
}

async function emptyBucket() {
  const keys = await r2Keys();
  if (keys.length) await env.BUCKET.delete(keys);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM daily_stats'),
  ]);
  await emptyBucket();
});

describe('ingestEmail', () => {
  it('stores an Action-shaped invoice mail', async () => {
    const pdf = await makePdf('invoice-1');
    const padded = new Uint8Array(60_000);
    padded.set(pdf);
    padded.fill(0x20, pdf.length); // trailing whitespace after %%EOF keeps it a valid-looking PDF
    const raw = buildMail({
      to: TO,
      subject: 'Your invoice',
      attachments: [pdfAtt('factuur-310000032543.pdf', padded)],
    });
    const out = await ingestEmail(input(raw), deps, cfg, NOW);
    expect(out).toMatchObject({ status: 'stored', attachments: 1, incomplete: false });
    if (out.status !== 'stored') return;

    const att = await env.DB.prepare('SELECT * FROM attachments WHERE message_id = ?')
      .bind(out.id)
      .all<{ r2_key: string; sha256: string; size: number; filename: string }>();
    expect(att.results).toHaveLength(1);
    const obj = await env.BUCKET.get(att.results[0].r2_key);
    const stored = await obj!.arrayBuffer();
    expect(await sha256Hex(stored)).toBe(await sha256Hex(padded));
    expect(att.results[0].sha256).toBe(await sha256Hex(padded));
    expect(att.results[0].size).toBe(60_000);

    const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?')
      .bind(out.id)
      .first<{ received_at: number; expires_at: number }>();
    expect(m!.expires_at - m!.received_at).toBe(72 * 3_600_000);
    expect(await env.DB.prepare("SELECT count FROM daily_stats WHERE metric = 'incoming'").first()).toEqual({ count: 1 });
  });

  it('keeps two same-named PDFs distinct', async () => {
    const a = await makePdf('first');
    const b = await makePdf('second');
    const raw = buildMail({
      to: TO,
      attachments: [pdfAtt('invoice.pdf', a), pdfAtt('invoice.pdf', b)],
    });
    const out = await ingestEmail(input(raw), deps, cfg, NOW);
    expect(out).toMatchObject({ status: 'stored', attachments: 2 });
    const { results } = await env.DB.prepare('SELECT id, sha256 FROM attachments').all<{
      id: string;
      sha256: string;
    }>();
    expect(new Set(results.map((r) => r.id)).size).toBe(2);
    expect(new Set(results.map((r) => r.sha256)).size).toBe(2);
  });

  it('ignores non-PDF attachments', async () => {
    const raw = buildMail({
      to: TO,
      attachments: [
        { filename: 'pic.png', contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
        {
          filename: 'doc.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytes: new Uint8Array([0x50, 0x4b, 3, 4, 5]),
        },
      ],
    });
    const out = await ingestEmail(input(raw), deps, cfg, NOW);
    expect(out).toMatchObject({ status: 'stored', attachments: 0 });
    expect(await count('attachments')).toBe(0);
    const m = await env.DB.prepare('SELECT skipped_attachments FROM messages').first();
    expect(m).toEqual({ skipped_attachments: 0 });
  });

  it('skips PDFs over the count and size caps', async () => {
    const pdfs = [await makePdf('p1'), await makePdf('p2'), await makePdf('p3')];
    const raw = buildMail({ to: TO, attachments: pdfs.map((p, i) => pdfAtt(`p${i}.pdf`, p)) });

    await ingestEmail(input(raw), deps, { ...cfg, maxAttachments: 2 }, NOW);
    expect(await count('attachments')).toBe(2);
    expect(await env.DB.prepare('SELECT skipped_attachments AS s FROM messages').first()).toEqual({ s: 1 });

    await env.DB.batch([env.DB.prepare('DELETE FROM attachments'), env.DB.prepare('DELETE FROM messages')]);
    const big = new Uint8Array(2000);
    big.set(pdfs[0]);
    const one = buildMail({ to: TO, attachments: [pdfAtt('big.pdf', big)] });
    await ingestEmail(input(one), deps, { ...cfg, maxAttachmentBytes: 1000 }, NOW);
    expect(await count('attachments')).toBe(0);
    expect(await env.DB.prepare('SELECT skipped_attachments AS s FROM messages').first()).toEqual({ s: 1 });
  });

  it('rejects oversize without writing anything', async () => {
    const raw = buildMail({ to: TO, attachments: [pdfAtt('a.pdf', await makePdf('a'))] });
    const out = await ingestEmail(input(raw, { rawSize: cfg.maxMessageBytes + 1 }), deps, cfg, NOW);
    expect(out).toEqual({ status: 'rejected', reason: 'too_large' });
    expect(await count('messages')).toBe(0);
    expect(await count('attachments')).toBe(0);
    expect(await r2Keys()).toEqual([]);
    expect(
      await env.DB.prepare("SELECT domain, count FROM daily_stats WHERE metric = 'rejected'").all(),
    ).toMatchObject({ results: [{ domain: 'staging.test.example', count: 1 }] });
  });

  it('drops unknown domain', async () => {
    const raw = buildMail({ to: 'x@other.example' });
    const out = await ingestEmail(input(raw, { envelopeTo: 'x@other.example' }), deps, cfg, NOW);
    expect(out).toEqual({ status: 'rejected', reason: 'unknown_domain' });
    expect(await count('messages')).toBe(0);
    expect(
      await env.DB.prepare("SELECT domain, count FROM daily_stats WHERE metric = 'rejected'").all(),
    ).toMatchObject({ results: [{ domain: '_other', count: 1 }] });
  });

  it('R2 failure stores mail flagged incomplete', async () => {
    let puts = 0;
    const bucket: IngestDeps['bucket'] = {
      put: (async (...args: Parameters<R2Bucket['put']>) => {
        if (++puts === 2) throw new Error('R2 down');
        return env.BUCKET.put(...args);
      }) as R2Bucket['put'],
      delete: ((keys: string | string[]) => env.BUCKET.delete(keys)) as R2Bucket['delete'],
    };
    const raw = buildMail({
      to: TO,
      attachments: [pdfAtt('a.pdf', await makePdf('a')), pdfAtt('b.pdf', await makePdf('b'))],
    });
    const out = await ingestEmail(input(raw), { db: env.DB, bucket }, cfg, NOW);
    expect(out).toMatchObject({ status: 'stored', attachments: 0, incomplete: true });
    expect(await count('attachments')).toBe(0);
    expect(await env.DB.prepare('SELECT attachments_incomplete AS i FROM messages').first()).toEqual({ i: 1 });
    expect(await r2Keys()).toEqual([]);
  });

  it('D1 failure rolls back R2 and throws', async () => {
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return () => Promise.reject(new Error('D1 down'));
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const raw = buildMail({ to: TO, attachments: [pdfAtt('a.pdf', await makePdf('a'))] });
    await expect(ingestEmail(input(raw), { db, bucket: env.BUCKET }, cfg, NOW)).rejects.toThrow('D1 down');
    expect(await r2Keys()).toEqual([]);
    expect(await count('messages')).toBe(0);
  });

  it('lowercases recipient, keeps plus', async () => {
    const to = 'AutoUser+1@STAGING.TEST.EXAMPLE';
    await ingestEmail(input(buildMail({ to }), { envelopeTo: to }), deps, cfg, NOW);
    expect(await env.DB.prepare('SELECT inbox, domain FROM messages').first()).toEqual({
      inbox: 'autouser+1',
      domain: 'staging.test.example',
    });
  });

  it('files by envelope recipient', async () => {
    const raw = buildMail({
      to: 'real@staging.test.example',
      headerTo: 'someone-else@staging.test.example',
    });
    await ingestEmail(input(raw, { envelopeTo: 'real@staging.test.example' }), deps, cfg, NOW);
    expect(await env.DB.prepare('SELECT inbox FROM messages').first()).toEqual({ inbox: 'real' });
  });

  it('truncates bodies to maxBodyBytes on a character boundary', async () => {
    const html = `<p>${'é'.repeat(1_048_576)}</p>`; // 2 MB of UTF-8
    const raw = buildMail({ to: TO, html, htmlQuotedPrintable: true });
    const out = await ingestEmail(input(raw), deps, { ...cfg, maxMessageBytes: 10_000_000 }, NOW);
    expect(out.status).toBe('stored');
    const row = await env.DB.prepare('SELECT html_body FROM messages').first<{ html_body: string }>();
    expect(new TextEncoder().encode(row!.html_body).length).toBeLessThanOrEqual(1_048_576);
    expect(row!.html_body).not.toContain('�');
    expect(row!.html_body.length).toBeGreaterThan(500_000);
  });
});
