import { listMessages, type MessageSummary } from '../db/messages';
import type { Config } from '../config';
import { relativeAge } from '../time';

export const PAGE_SIZE = 50;

export type InboxQuery = { domain: string; inbox: string; page: number };

export function parseInboxQuery(
  cfg: Config,
  q: { domain?: string; inbox?: string; page?: string },
): InboxQuery {
  const domain = cfg.allowedDomains.includes((q.domain ?? '').toLowerCase())
    ? (q.domain ?? '').toLowerCase()
    : (cfg.allowedDomains[0] ?? '');
  const n = Math.floor(Number(q.page));
  const page = Number.isSafeInteger(n) && n >= 1 ? n : 1;
  return { domain, inbox: (q.inbox ?? '').trim().toLowerCase(), page };
}

export function inboxUrl(q: InboxQuery, page = q.page): string {
  const p = new URLSearchParams({ domain: q.domain });
  if (q.inbox) p.set('inbox', q.inbox);
  if (page > 1) p.set('page', String(page));
  return `/?${p}`;
}

export async function loadInbox(db: D1Database, q: InboxQuery, now: number) {
  const { rows, total } = await listMessages(db, {
    domain: q.domain,
    inboxPrefix: q.inbox || undefined,
    now,
    limit: PAGE_SIZE,
    offset: (q.page - 1) * PAGE_SIZE,
  });
  return { rows, total, now };
}

function Cell(props: { href: string; title?: string; children?: unknown }) {
  return (
    <td title={props.title}>
      <a href={props.href}>{props.children as string}</a>
    </td>
  );
}

export function RowsBody(props: { rows: MessageSummary[]; now: number }) {
  return (
    <tbody id="rows">
      {props.rows.length === 0 ? (
        <tr class="empty">
          <td colspan={6}>No mail</td>
        </tr>
      ) : (
        props.rows.map((m) => {
          const href = `/m/${encodeURIComponent(m.domain)}/${encodeURIComponent(m.inbox)}/${encodeURIComponent(m.id)}`;
          return (
            <tr data-id={m.id}>
              <td class="check">
                <input type="checkbox" name="ids" value={m.id} aria-label="Select mail" />
              </td>
              <Cell href={href}>{m.inbox}</Cell>
              <Cell href={href}>{m.from_name ?? m.from_addr}</Cell>
              <Cell href={href}>{m.subject || '(no subject)'}</Cell>
              <Cell href={href}>{m.attachment_count > 0 ? String(m.attachment_count) : ''}</Cell>
              <Cell href={href} title={new Date(m.received_at).toISOString()}>
                {relativeAge(props.now - m.received_at)}
              </Cell>
            </tr>
          );
        })
      )}
    </tbody>
  );
}

export function InboxView(props: {
  cfg: Config;
  q: InboxQuery;
  rows: MessageSummary[];
  total: number;
  now: number;
}) {
  const { q } = props;
  const pages = Math.max(1, Math.ceil(props.total / PAGE_SIZE));
  return (
    <>
      <form method="get" action="/" class="filter">
        <select name="domain" id="domain" aria-label="Domain">
          {props.cfg.allowedDomains.map((d) => (
            <option value={d} selected={d === q.domain}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="search"
          name="inbox"
          value={q.inbox}
          placeholder="Inbox starts with..."
          aria-label="Inbox filter"
        />
        <button type="submit">Search</button>
      </form>
      <form method="post" action="/delete" id="delete-form">
        <input type="hidden" name="back" value={inboxUrl(q)} />
        <p>
          <button type="submit" id="delete-btn" disabled>
            Delete selected
          </button>
        </p>
        <table>
          <thead>
            <tr>
              <th class="check">
                <input type="checkbox" id="select-all" aria-label="Select all" />
              </th>
              <th>To</th>
              <th>From</th>
              <th>Subject</th>
              <th>PDFs</th>
              <th>Received</th>
            </tr>
          </thead>
          <RowsBody rows={props.rows} now={props.now} />
        </table>
      </form>
      <p class="pager">
        {q.page > 1 ? <a href={inboxUrl(q, q.page - 1)}>Previous</a> : null} Page {q.page} of {pages}{' '}
        ({props.total} mails) {q.page < pages ? <a href={inboxUrl(q, q.page + 1)}>Next</a> : null}
      </p>
    </>
  );
}

// Only same-site relative paths; anything else (absolute, protocol-relative, backslash tricks) -> "/".
export function safeBack(back: unknown): string {
  if (typeof back !== 'string') return '/';
  if (!back.startsWith('/') || back.startsWith('//') || back.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(back)) return '/';
  return back;
}
