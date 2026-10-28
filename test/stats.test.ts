import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bumpStat, purgeOldStats, readStats } from '../src/db/stats';
import { relativeAge, utcDay } from '../src/time';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 12, 0);

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM daily_stats').run();
});

describe('bumpStat', () => {
  it('increments per day/domain/metric', async () => {
    await bumpStat(env.DB, 'staging.test.example', 'incoming', NOW);
    await bumpStat(env.DB, 'staging.test.example', 'incoming', NOW);
    await bumpStat(env.DB, 'staging.test.example', 'rejected', NOW);
    await bumpStat(env.DB, 'prod.test.example', 'incoming', NOW);
    await bumpStat(env.DB, 'staging.test.example', 'incoming', NOW - DAY);
    const { results } = await env.DB.prepare(
      'SELECT day, domain, metric, count FROM daily_stats ORDER BY day, domain, metric',
    ).all();
    expect(results).toEqual([
      { day: '2026-10-27', domain: 'staging.test.example', metric: 'incoming', count: 1 },
      { day: '2026-10-28', domain: 'prod.test.example', metric: 'incoming', count: 1 },
      { day: '2026-10-28', domain: 'staging.test.example', metric: 'incoming', count: 2 },
      { day: '2026-10-28', domain: 'staging.test.example', metric: 'rejected', count: 1 },
    ]);
  });

  it('bumpStat swallows errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = {
      prepare() {
        throw new Error('boom');
      },
    } as unknown as D1Database;
    await expect(bumpStat(bad, 'd', 'incoming', NOW)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('readStats', () => {
  it("sums across domains for 'all'", async () => {
    await bumpStat(env.DB, 'staging.test.example', 'incoming', NOW);
    await bumpStat(env.DB, 'prod.test.example', 'incoming', NOW);
    await bumpStat(env.DB, 'prod.test.example', 'api_error', NOW);
    await bumpStat(env.DB, 'prod.test.example', 'incoming', NOW - DAY);
    const all = await readStats(env.DB, { domain: 'all', now: NOW, days: 7 });
    expect(all.map((r) => r.day)).toEqual(['2026-10-28', '2026-10-27']);
    expect(all[0]).toEqual({
      day: '2026-10-28',
      incoming: 2,
      rejected: 0,
      accessed_api: 0,
      accessed_ui: 0,
      api_inbox: 0,
      api_message: 0,
      api_attachment: 0,
      api_error: 1,
    });
    const one = await readStats(env.DB, { domain: 'staging.test.example', now: NOW, days: 7 });
    expect(one).toHaveLength(1);
    expect(one[0].incoming).toBe(1);
  });

  it('limits to the requested number of days', async () => {
    await bumpStat(env.DB, 'd', 'incoming', NOW);
    await bumpStat(env.DB, 'd', 'incoming', NOW - 5 * DAY);
    const r = await readStats(env.DB, { domain: 'all', now: NOW, days: 2 });
    expect(r.map((x) => x.day)).toEqual(['2026-10-28']);
  });
});

describe('purgeOldStats', () => {
  it('deletes days older than the retention window', async () => {
    await bumpStat(env.DB, 'd', 'incoming', NOW);
    await bumpStat(env.DB, 'd', 'incoming', NOW - 10 * DAY);
    await purgeOldStats(env.DB, NOW, 5);
    const r = await readStats(env.DB, { domain: 'all', now: NOW, days: 365 });
    expect(r.map((x) => x.day)).toEqual(['2026-10-28']);
  });
});

describe('time', () => {
  it('utcDay uses UTC', () => {
    expect(utcDay(Date.UTC(2026, 9, 27, 23, 30))).toBe('2026-10-27');
  });

  it('relativeAge formats', () => {
    expect(relativeAge(30_000)).toBe('just now');
    expect(relativeAge(5 * 60_000)).toBe('5 min');
    expect(relativeAge(3 * 3_600_000)).toBe('3 hours');
    expect(relativeAge(2 * DAY)).toBe('2 days');
  });
});
