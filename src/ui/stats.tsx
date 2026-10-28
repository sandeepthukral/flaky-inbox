import type { Config } from '../config';
import { METRICS, readStats, type Metric } from '../db/stats';
import { ICON_GLOBE } from './layout';

type StatRows = Awaited<ReturnType<typeof readStats>>;

// Column order: Stored, Rejected, read by API, read in UI, then the API calls.
const COLUMNS: Array<{ metric: Metric; label: string; group: 'in' | 'read' | 'api'; first?: boolean }> = [
  { metric: 'incoming', label: 'Stored', group: 'in', first: true },
  { metric: 'rejected', label: 'Rejected', group: 'in' },
  { metric: 'accessed_api', label: 'API', group: 'read', first: true },
  { metric: 'accessed_ui', label: 'UI', group: 'read' },
  { metric: 'api_inbox', label: 'Inbox', group: 'api', first: true },
  { metric: 'api_message', label: 'Message', group: 'api' },
  { metric: 'api_attachment', label: 'Attachment', group: 'api' },
  { metric: 'api_error', label: 'Errors', group: 'api' },
];

const fmt = (n: number) => n.toLocaleString('en');

// Anything that is not an allowed domain falls back to "all".
export function parseStatsDomain(cfg: Config, raw: string | undefined): string {
  const d = (raw ?? '').trim().toLowerCase();
  return cfg.allowedDomains.includes(d) ? d : 'all';
}

export function loadStats(db: D1Database, cfg: Config, domain: string, now: number) {
  return readStats(db, { domain, now, days: cfg.statsRetentionDays });
}

export function sumStats(rows: StatRows): Record<Metric, number> {
  const total = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
  for (const r of rows) for (const m of METRICS) total[m] += r[m];
  return total;
}

function weekday(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

function Cell(props: { col: (typeof COLUMNS)[number]; value: number; max?: number; total?: boolean }) {
  const { col, value } = props;
  const cls = [
    'num',
    `c-${col.group}`,
    col.first ? 'gap' : '',
    value === 0 && !props.total ? 'zero' : '',
    col.metric === 'api_error' && value > 0 ? 'err' : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (props.max !== undefined) {
    const width = props.max > 0 ? Math.max(2, Math.round((56 * value) / props.max)) : 2;
    return (
      <td class={cls}>
        <div class="barcell">
          <div class="minibar" style={`width:${width}px`}></div>
          {fmt(value)}
        </div>
      </td>
    );
  }
  return <td class={cls}>{fmt(value)}</td>;
}

function Kpi(props: { id: string; kind: string; icon: string; label: string; value: number; hint: string; bad?: boolean }) {
  return (
    <div class={`kpi ${props.kind}${props.bad ? ' bad' : ''}`} id={`kpi-${props.id}`}>
      <div class="icon">{props.icon}</div>
      <div class="label">{props.label}</div>
      <div class="value">{fmt(props.value)}</div>
      <div class="hint">{props.hint}</div>
    </div>
  );
}

export function StatsView(props: { cfg: Config; domain: string; rows: StatRows }) {
  const t = sumStats(props.rows);
  const read = t.accessed_api + t.accessed_ui;
  const calls = t.api_inbox + t.api_message + t.api_attachment;
  // Every API call counts in its own column; errors are counted on top, so the share is errors / calls.
  const errorShare = calls
    ? `${Math.min(100, Math.round((100 * t.api_error) / calls))}% of API calls`
    : 'no API calls';
  const maxStored = Math.max(0, ...props.rows.map((r) => r.incoming));
  return (
    <>
      <div class="head">
        <div>
          <h1>Statistics</h1>
          <p class="sub">Per day, last {props.cfg.statsRetentionDays} days (UTC).</p>
        </div>
        <form method="get" action="/stats" class="toolbar">
          <label class="field">
            {ICON_GLOBE}
            <select name="domain" id="domain" aria-label="Domain" data-autosubmit>
              <option value="all" selected={props.domain === 'all'}>
                All domains
              </option>
              {props.cfg.allowedDomains.map((d) => (
                <option value={d} selected={d === props.domain}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="sr-only">
            Show
          </button>
        </form>
      </div>
      <div class="cards">
        <Kpi id="received" kind="k-in" icon="↓" label="Emails received" value={t.incoming} hint={`${fmt(t.rejected)} rejected`} />
        <Kpi
          id="read"
          kind="k-read"
          icon="✓"
          label="Emails read"
          value={read}
          hint={`${fmt(t.accessed_api)} by API · ${fmt(t.accessed_ui)} in UI`}
        />
        <Kpi id="calls" kind="k-api" icon="⚡" label="API calls" value={calls} hint="inbox, message, attachment" />
        <Kpi id="errors" kind="k-err" icon="!" label="API errors" value={t.api_error} hint={errorShare} bad={t.api_error > 0} />
      </div>
      <div class="scroll">
      <table id="stats" class="list">
        <thead>
          <tr>
            <th rowspan={2}>Date</th>
            <th colspan={2} class="group gap">
              <span class="grp g-in">Emails incoming</span>
            </th>
            <th colspan={2} class="group gap">
              <span class="grp g-read">Emails read</span>
            </th>
            <th colspan={4} class="group gap">
              <span class="grp g-api">API calls</span>
            </th>
          </tr>
          <tr>
            {COLUMNS.map((c) => (
              <th class={c.first ? 'n gap' : 'n'}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr class="empty">
              <td colspan={9}>No statistics yet</td>
            </tr>
          ) : (
            <>
              {props.rows.map((r) => (
                <tr data-day={r.day}>
                  <td class="day mono">
                    {r.day}
                    <small>{weekday(r.day)}</small>
                  </td>
                  {COLUMNS.map((c) => (
                    <Cell col={c} value={r[c.metric]} max={c.metric === 'incoming' ? maxStored : undefined} />
                  ))}
                </tr>
              ))}
              <tr class="total" data-total>
                <td>Total</td>
                {COLUMNS.map((c) => (
                  <Cell col={c} value={t[c.metric]} total />
                ))}
              </tr>
            </>
          )}
        </tbody>
      </table>
      </div>
    </>
  );
}
