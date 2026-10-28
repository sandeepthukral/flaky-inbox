import type { AttachmentRow, MessageRow } from '../db/messages';
import { extractLinks } from '../links';
import { toMessageDetail } from '../shapes';

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const messageUrl = (m: { domain: string; inbox: string; id: string }) =>
  `/m/${encodeURIComponent(m.domain)}/${encodeURIComponent(m.inbox)}/${encodeURIComponent(m.id)}`;

export function MessageView(props: { row: MessageRow; atts: AttachmentRow[]; now: number }) {
  const { row, atts } = props;
  const base = messageUrl(row);
  const links = extractLinks(row.html_body, row.text_body);
  const detail = JSON.stringify(toMessageDetail(row, atts, props.now), null, 2);
  const tabs: Array<'html' | 'text' | 'json' | 'links'> = [
    ...(row.html_body !== null ? (['html'] as const) : []),
    'text',
    'json',
    'links',
  ];
  const active = tabs[0];
  return (
    <>
      <form method="post" action="/delete" id="delete-message-form" class="msghead">
        <input type="hidden" name="ids" value={row.id} />
        <input type="hidden" name="back" value={`/?domain=${row.domain}`} />
        <a class="back" href={`/?domain=${encodeURIComponent(row.domain)}`}>
          ‹ Back to inbox
        </a>
        <button type="submit" class="btn danger">
          Delete
        </button>
      </form>
      <div class="card">
        <h1>{row.subject || '(no subject)'}</h1>
        <dl class="meta">
          <dt>To</dt>
          <dd>{row.to_addr}</dd>
          <dt>From</dt>
          <dd>{row.from_addr}</dd>
          <dt>Received</dt>
          <dd>{utc(row.received_at)}</dd>
          <dt>Expires</dt>
          <dd>{utc(row.expires_at)}</dd>
        </dl>
      </div>
      <div class="card" id="attachments">
        <h2>Attachments</h2>
        {row.attachments_incomplete === 1 ? (
          <div class="warn">Some attachments could not be stored</div>
        ) : null}
        {row.skipped_attachments > 0 ? (
          <div class="warn">
            {row.skipped_attachments} {row.skipped_attachments === 1 ? 'PDF was' : 'PDFs were'} over the
            limit and not stored
          </div>
        ) : null}
        {atts.length === 0 ? (
          <p class="zero">None</p>
        ) : (
          <table class="atts">
            <tbody>
              {atts.map((a) => (
                <tr>
                  <td>{a.filename ?? '(unnamed)'}</td>
                  <td>{humanSize(a.size)}</td>
                  <td title={a.sha256}>
                    <code>{a.sha256.slice(0, 8)}</code>
                  </td>
                  <td>
                    <a href={`${base}/a/${encodeURIComponent(a.id)}`} class="btn">
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div class="msgtabs" id="tabs">
        {tabs.map((t) => (
          <button type="button" data-tab={t} class={t === active ? 'active' : ''}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      <div class="panel">
        {row.html_body !== null ? (
          <div id="tab-html" hidden={active !== 'html'}>
            <iframe
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcdoc={`<base target="_blank">${row.html_body}`}
             title="HTML body"></iframe>
          </div>
        ) : null}
        <pre id="tab-text" hidden={active !== 'text'}>
          {row.text_body ?? ''}
        </pre>
        <pre id="tab-json" hidden={active !== 'json'}>
          {detail}
        </pre>
        <div id="tab-links" hidden={active !== 'links'}>
          {links.length === 0 ? (
            <p>No links</p>
          ) : (
            <ul>
              {links.map((l) => (
                <li>
                  <a href={l} rel="noreferrer noopener" target="_blank">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
