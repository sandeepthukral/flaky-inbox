import { utcDay } from '../time';

export type Metric =
  | 'incoming'
  | 'rejected'
  | 'accessed_api'
  | 'accessed_ui'
  | 'api_inbox'
  | 'api_message'
  | 'api_attachment'
  | 'api_error';

export const METRICS: Metric[] = [
  'incoming',
  'rejected',
  'accessed_api',
  'accessed_ui',
  'api_inbox',
  'api_message',
  'api_attachment',
  'api_error',
];

const DAY_MS = 86_400_000;

export async function bumpStat(
  db: D1Database,
  domain: string,
  metric: Metric,
  now: number,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO daily_stats (day, domain, metric, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, domain, metric) DO UPDATE SET count = count + 1`,
      )
      .bind(utcDay(now), domain, metric)
      .run();
  } catch (err) {
    console.error('bumpStat failed', err);
  }
}

export async function readStats(
  db: D1Database,
  q: { domain: string | 'all'; now: number; days: number },
): Promise<Array<{ day: string } & Record<Metric, number>>> {
  const since = utcDay(q.now - (q.days - 1) * DAY_MS);
  const all = q.domain === 'all';
  const sql = `SELECT day, metric, SUM(count) AS count FROM daily_stats
    WHERE day >= ?${all ? '' : ' AND domain = ?'} GROUP BY day, metric ORDER BY day DESC`;
  const stmt = db.prepare(sql);
  const { results } = await (all ? stmt.bind(since) : stmt.bind(since, q.domain)).all<{
    day: string;
    metric: Metric;
    count: number;
  }>();
  const byDay = new Map<string, { day: string } & Record<Metric, number>>();
  for (const r of results) {
    let row = byDay.get(r.day);
    if (!row) {
      row = { day: r.day, ...(Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>) };
      byDay.set(r.day, row);
    }
    if (METRICS.includes(r.metric)) row[r.metric] = r.count;
  }
  return [...byDay.values()];
}

export async function purgeOldStats(db: D1Database, now: number, days: number): Promise<void> {
  await db
    .prepare('DELETE FROM daily_stats WHERE day < ?')
    .bind(utcDay(now - days * DAY_MS))
    .run();
}
