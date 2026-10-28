import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanup } from '../src/cleanup';
import { parseConfig } from '../src/config';
import { ingestEmail } from '../src/ingest/ingest';
import { buildMail, makePdf } from './mail-builder';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TO = 'alice@staging.test.example';
const cfg = parseConfig(env);

async function ingestWithPdf(now: number, label: string): Promise<string> {
  const pdf = await makePdf(label);
  const raw = buildMail({
    to: TO,
    attachments: [{ filename: `${label}.pdf`, contentType: 'application/pdf', bytes: pdf }],
  });
  const out = await ingestEmail(
    { raw, rawSize: raw.length, envelopeTo: TO, envelopeFrom: 'bounce@sender.example' },
    { db: env.DB, bucket: env.BUCKET },
    cfg,
    now,
  );
  if (out.status !== 'stored') throw new Error('ingest failed');
  return out.id;
}

async function r2Keys(): Promise<string[]> {
  return (await env.BUCKET.list()).objects.map((o) => o.key);
}

async function n(sql: string, ...params: string[]): Promise<number> {
  const r = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attachments'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM daily_stats'),
  ]);
  const keys = await r2Keys();
  if (keys.length) await env.BUCKET.delete(keys);
});

describe('runCleanup', () => {
  it('deletes expired mail with its R2 objects, keeps fresh mail', async () => {
    const now = Date.now();
    const oldId = await ingestWithPdf(now - 73 * HOUR, 'old');
    const freshId = await ingestWithPdf(now, 'fresh');
    expect(await r2Keys()).toHaveLength(2);

    const res = await runCleanup(env, cfg, now);

    expect(res.deleted).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM messages WHERE id = ?', oldId)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', oldId)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM messages WHERE id = ?', freshId)).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', freshId)).toBe(1);
    const keys = await r2Keys();
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`${freshId}/`)).toBe(true);
  });

  it('removes orphan R2 objects older than an hour, keeps recent ones', async () => {
    await env.BUCKET.put('orphan-id/x', 'data', { customMetadata: { messageId: 'orphan-id' } });

    const recent = await runCleanup(env, cfg, Date.now());
    expect(recent.orphans).toBe(0);
    expect(await r2Keys()).toEqual(['orphan-id/x']);

    const old = await runCleanup(env, cfg, Date.now() + 2 * HOUR);
    expect(old.orphans).toBe(1);
    expect(await r2Keys()).toEqual([]);
  });

  it('keeps old R2 objects whose message still has a row', async () => {
    const now = Date.now();
    await ingestWithPdf(now, 'live');
    const res = await runCleanup(env, cfg, now + 2 * HOUR);
    expect(res.orphans).toBe(0);
    expect(await r2Keys()).toHaveLength(1);
  });

  it('purges stats older than 90 days', async () => {
    const now = Date.UTC(2026, 9, 28, 12, 0);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_stats (day, domain, metric, count) VALUES (?, 'd', 'incoming', 1)").bind(day(now - 91 * DAY)),
      env.DB.prepare("INSERT INTO daily_stats (day, domain, metric, count) VALUES (?, 'd', 'incoming', 1)").bind(day(now - 10 * DAY)),
    ]);
    await runCleanup(env, cfg, now);
    const { results } = await env.DB.prepare('SELECT day FROM daily_stats').all<{ day: string }>();
    expect(results.map((r) => r.day)).toEqual([day(now - 10 * DAY)]);
  });

  it('rejects promptly and leaves D1 and R2 intact when the R2 delete throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = Date.now();
    const oldId = await ingestWithPdf(now - 73 * HOUR, 'old');
    const failing = {
      DB: env.DB,
      BUCKET: {
        delete: async () => {
          throw new Error('r2 down');
        },
        list: (opts?: R2ListOptions) => env.BUCKET.list(opts),
      } as unknown as R2Bucket,
    };

    await expect(runCleanup(failing, cfg, now)).rejects.toThrow('r2 down');

    expect(spy).toHaveBeenCalled();
    expect(await n('SELECT COUNT(*) AS n FROM messages WHERE id = ?', oldId)).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?', oldId)).toBe(1);
    expect(await r2Keys()).toHaveLength(1);
    spy.mockRestore();
  });

  it('stops instead of spinning when a batch removes no rows', async () => {
    const now = Date.now();
    const oldId = await ingestWithPdf(now - 73 * HOUR, 'old');
    let listCalls = 0;
    // D1 deletes silently affect 0 rows, so listExpiredIds keeps returning the same id.
    const stuck = {
      DB: {
        prepare: (sql: string) => {
          if (sql.includes('FROM messages WHERE expires_at')) listCalls++;
          return env.DB.prepare(sql);
        },
        batch: async (stmts: unknown[]) =>
          stmts.map(() => ({ results: [], success: true, meta: { changes: 0 } })),
      } as unknown as D1Database,
      BUCKET: env.BUCKET,
    };

    const res = await runCleanup(stuck, cfg, now);

    expect(res.deleted).toBe(0);
    expect(listCalls).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM messages WHERE id = ?', oldId)).toBe(1);
  });
});
