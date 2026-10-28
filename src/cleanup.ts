import type { Config } from './config';
import { deleteMessages, listExpiredIds } from './db/messages';
import { purgeOldStats } from './db/stats';
import type { Env } from './env';

const BATCH = 100;
const ORPHAN_MIN_AGE_MS = 3_600_000;
// D1 allows at most 100 bound parameters per statement.
const ID_CHUNK = 50;

async function existingIds(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const group = ids.slice(i, i + ID_CHUNK);
    const marks = group.map(() => '?').join(',');
    const { results } = await db
      .prepare(`SELECT id FROM messages WHERE id IN (${marks})`)
      .bind(...group)
      .all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

async function sweepOrphans(env: Pick<Env, 'DB' | 'BUCKET'>, now: number): Promise<number> {
  const cutoff = now - ORPHAN_MIN_AGE_MS;
  let orphans = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ cursor });
    const old = page.objects
      .filter((o) => o.uploaded.getTime() < cutoff)
      .map((o) => ({ key: o.key, messageId: o.key.split('/')[0] }));
    if (old.length > 0) {
      const live = await existingIds(env.DB, [...new Set(old.map((o) => o.messageId))]);
      const dead = old.filter((o) => !live.has(o.messageId)).map((o) => o.key);
      if (dead.length > 0) {
        await env.BUCKET.delete(dead);
        orphans += dead.length;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return orphans;
}

// Errors propagate (after logging) so a failing batch is not retried in a loop;
// the next hourly run picks up where this one stopped.
export async function runCleanup(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  cfg: Config,
  now: number,
): Promise<{ deleted: number; orphans: number }> {
  try {
    let deleted = 0;
    for (;;) {
      const ids = await listExpiredIds(env.DB, now, BATCH);
      if (ids.length === 0) break;
      const removed = await deleteMessages(env, ids);
      deleted += removed;
      if (removed === 0) break; // nothing was removed; avoid spinning on the same ids
    }
    const orphans = await sweepOrphans(env, now);
    await purgeOldStats(env.DB, now, cfg.statsRetentionDays);
    return { deleted, orphans };
  } catch (err) {
    console.error('cleanup failed', err);
    throw err;
  }
}
