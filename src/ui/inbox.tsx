import { listMessages, type MessageSummary } from '../db/messages';
import type { Config } from '../config';
import { relativeAge } from '../time';
import { ICON_GLOBE, ICON_SEARCH } from './layout';
import { messageUrl } from './message';

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
const NEW_MS = 5 * 60_000;
const PREVIEW_CHARS = 140;
const AVATAR_COLOURS = 6;

export type InboxQuery = { domain: string; inbox: string; page: number; size: number };

export function parseInboxQuery(
  cfg: Config,
  q: { domain?: string; inbox?: string; page?: string; size?: string },
): InboxQuery {
  const domain = cfg.allowedDomains.includes((q.domain ?? '').toLowerCase())
    ? (q.domain ?? '').toLowerCase()
    : (cfg.allowedDomains[0] ?? '');
  const n = Math.floor(Number(q.page));
  const page = Number.isSafeInteger(n) && n >= 1 ? n : 1;
  const size = (PAGE_SIZES as readonly number[]).includes(Number(q.size)) ? Number(q.size) : DEFAULT_PAGE_SIZE;
  return { domain, inbox: (q.inbox ?? '').trim().toLowerCase(), page, size };
}

export function inboxUrl(q: InboxQuery, page = q.page): string {
  const p = new URLSearchParams({ domain: q.domain });
  if (q.inbox) p.set('inbox', q.inbox);
  if (q.size !== DEFAULT_PAGE_SIZE) p.set('size', String(q.size));
  if (page > 1) p.set('page', String(page));
  return `/?${p}`;
}

export async function loadInbox(db: D1Database, q: InboxQuery, now: number) {
  const { rows, total } = await listMessages(db, {
    domain: q.domain,
    inboxPrefix: q.inbox || undefined,
    now,
    limit: q.size,
    offset: (q.page - 1) * q.size,
  });
  return { rows, total, now };
}

// First, last and the neighbours of the current page; a gap of one page shows that page instead of "…".
export function pageWindow(current: number, pages: number): Array<number | '…'> {
  const keep = new Set([1, pages, current - 1, current, current + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (const p of sorted) {
    const prev = out.length ? (out[out.length - 1] as number) : 0;
    if (p - prev === 2) out.push(p - 1);
    else if (p - prev > 2) out.push('…');
    out.push(p);
  }
  return out;
}

export function initials(name: string | null, addr: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length) return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return addr ? addr[0].toUpperCase() : '?';
}

export function previewText(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
}

// Same sender, same colour.
function avatarColour(addr: string): number {
  let h = 0;
  for (const ch of addr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % AVATAR_COLOURS;
}

function ago(ms: number): string {
  const age = relativeAge(ms);
  return age === 'just now' ? age : `${age} ago`;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function RowsBody(props: { rows: MessageSummary[]; now: number }) {
  return (
    <tbody id="rows">
      {props.rows.length === 0 ? (
        <tr class="empty">
          <td colspan={6}>No mail here yet</td>
        </tr>
      ) : (
        props.rows.map((m) => {
          const href = messageUrl(m);
          const preview = previewText(m.text_head);
          return (
            <tr data-id={m.id} data-href={href} class="mail">
              <td class="check">
                <input type="checkbox" name="ids" value={m.id} aria-label="Select mail" />
              </td>
              <td class="to">
                <a href={href} class="inbox mono">
                  {m.inbox}
                </a>
                {props.now - m.received_at < NEW_MS ? <span class="newtag">NEW</span> : null}
              </td>
              <td>
                <a href={href} class="from">
                  <span class={`av av${avatarColour(m.from_addr)}`}>{initials(m.from_name, m.from_addr)}</span>
                  <span>
                    <span class="name">{m.from_name || m.from_addr}</span>
                    <span class="addr">{m.from_addr}</span>
                  </span>
                </a>
              </td>
              <td>
                <a href={href} class="subject">
                  {m.subject || '(no subject)'}
                  {preview ? <span class="preview"> — {preview}</span> : null}
                </a>
              </td>
              <td class="hide-sm">
                {m.attachment_count > 0 ? (
                  <span class="pill pdf">PDF · {m.attachment_count}</span>
                ) : (
                  <span class="zero">—</span>
                )}
              </td>
              <td class="age" title={utc(m.received_at)}>
                {ago(props.now - m.received_at)}
              </td>
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
  const { q, total } = props;
  const pages = Math.max(1, Math.ceil(total / q.size));
  const first = props.rows.length ? (q.page - 1) * q.size + 1 : 0;
  const last = props.rows.length ? first + props.rows.length - 1 : 0;
  return (
    <>
      <div class="head">
        <div>
          <h1>
            Inbox <span class="count">{total}</span>
          </h1>
          <p class="sub">Mail is kept for 3 days. Click a row to open it.</p>
        </div>
        <form method="get" action="/" class="toolbar" id="filter-form">
          {q.size !== DEFAULT_PAGE_SIZE ? <input type="hidden" name="size" value={String(q.size)} /> : null}
          <label class="field">
            {ICON_GLOBE}
            <select name="domain" id="domain" aria-label="Domain" data-autosubmit>
              {props.cfg.allowedDomains.map((d) => (
                <option value={d} selected={d === q.domain}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            {ICON_SEARCH}
            <input
              type="search"
              name="inbox"
              id="inbox-filter"
              value={q.inbox}
              placeholder="Inbox starts with…"
              aria-label="Inbox filter"
            />
          </label>
          <button type="submit" class="sr-only">
            Search
          </button>
          <span class="live" title="The list refreshes every 10 seconds">
            <span class="dot"></span>Live
          </span>
        </form>
      </div>
      <form method="post" action="/delete" id="delete-form">
        <input type="hidden" name="back" value={inboxUrl(q)} />
        <div class="selbar" id="selbar" hidden>
          <span id="selcount">0 selected</span>
          <button type="button" class="btn" id="clear-btn">
            Clear
          </button>
          <button type="submit" class="btn danger" id="delete-btn" disabled>
            Delete selected
          </button>
        </div>
        <div class="scroll">
        <table class="list">
          <thead>
            <tr>
              <th class="check">
                <input type="checkbox" id="select-all" aria-label="Select all" />
              </th>
              <th>To</th>
              <th>From</th>
              <th>Subject</th>
              <th class="hide-sm">Attachments</th>
              <th class="right">Received</th>
            </tr>
          </thead>
          <RowsBody rows={props.rows} now={props.now} />
        </table>
        </div>
      </form>
      <div class="foot">
        <form method="get" action="/" id="size-form">
          <input type="hidden" name="domain" value={q.domain} />
          {q.inbox ? <input type="hidden" name="inbox" value={q.inbox} /> : null}
          <label>
            Rows per page{' '}
            <select name="size" id="size" data-autosubmit>
              {PAGE_SIZES.map((s) => (
                <option value={String(s)} selected={s === q.size}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="sr-only">
            Apply
          </button>
        </form>
        <span>
          Showing {first}–{last} of {total}
        </span>
        <nav class="pager" aria-label="Pages">
          {q.page > 1 ? (
            <a href={inboxUrl(q, q.page - 1)} aria-label="Previous page">
              ‹
            </a>
          ) : (
            <span class="off">‹</span>
          )}
          {pageWindow(Math.min(q.page, pages), pages).map((p) =>
            p === '…' ? (
              <span class="gap">…</span>
            ) : p === q.page ? (
              <span class="cur" aria-current="page">
                {p}
              </span>
            ) : (
              <a href={inboxUrl(q, p)}>{p}</a>
            ),
          )}
          {q.page < pages ? (
            <a href={inboxUrl(q, q.page + 1)} aria-label="Next page">
              ›
            </a>
          ) : (
            <span class="off">›</span>
          )}
        </nav>
      </div>
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
