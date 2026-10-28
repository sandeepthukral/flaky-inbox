import type { Config } from '../config';
import { readStats } from '../db/stats';

type StatRows = Awaited<ReturnType<typeof readStats>>;

// Anything that is not an allowed domain falls back to "all".
export function parseStatsDomain(cfg: Config, raw: string | undefined): string {
  const d = (raw ?? '').trim().toLowerCase();
  return cfg.allowedDomains.includes(d) ? d : 'all';
}

export function loadStats(db: D1Database, cfg: Config, domain: string, now: number) {
  return readStats(db, { domain, now, days: cfg.statsRetentionDays });
}

export function StatsView(props: { cfg: Config; domain: string; rows: StatRows }) {
  return (
    <>
      <form method="get" action="/stats" class="filter">
        <select name="domain" id="domain" aria-label="Domain">
          <option value="all" selected={props.domain === 'all'}>
            All
          </option>
          {props.cfg.allowedDomains.map((d) => (
            <option value={d} selected={d === props.domain}>
              {d}
            </option>
          ))}
        </select>
        <button type="submit">Show</button>
      </form>
      <table id="stats">
        <thead>
          <tr>
            <th rowspan={2}>Date</th>
            <th colspan={2}>Emails incoming</th>
            <th colspan={2}>Emails accessed</th>
            <th colspan={4}>API calls</th>
          </tr>
          <tr>
            <th>Stored</th>
            <th>Rejected</th>
            <th>API</th>
            <th>UI</th>
            <th>Inbox</th>
            <th>Message</th>
            <th>Attachment</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr class="empty">
              <td colspan={9}>No statistics yet</td>
            </tr>
          ) : (
            props.rows.map((r) => (
              <tr data-day={r.day}>
                <td>{r.day}</td>
                <td>{r.incoming}</td>
                <td>{r.rejected}</td>
                <td>{r.accessed_api}</td>
                <td>{r.accessed_ui}</td>
                <td>{r.api_inbox}</td>
                <td>{r.api_message}</td>
                <td>{r.api_attachment}</td>
                <td>{r.api_error}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
