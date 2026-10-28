// Mailinator v2 API shapes, checked against https://www.mailinator.com/docs/index.html (2026-10-28).
//
// Fetch Inbox: { domain: string, to: string, msgs: [{ subject, domain, from, id, to: string,
//   time: number (epoch ms), seconds_ago: number }] }
// Fetch Message: { fromfull, headers: {string: string}, subject, parts: [{ headers: {string: string},
//   body: string }], from, to, id: string, time: number (ms), seconds_ago: number }
// Fetch Message Links: { links: string[] }
// Fetch Attachments: { attachments: [{ filename, content-disposition, content-transfer-encoding,
//   content-type: string, attachment-id: number }] }
// The docs do not say whether text-body URLs or mailto: are in links; we follow spec section 6
// (html hrefs then text URLs, http/https only). The docs examples are malformed JSON, so types are
// inferred. Additions beyond Mailinator: `origTo` and `domain` on entries, `attachments` on detail
// (id, filename, contentType, size, sha256), `skippedAttachments`, `attachmentsIncomplete`.
import type { AttachmentRow, MessageRow, MessageSummary } from './db/messages';

export type InboxEntry = {
  id: string;
  domain: string;
  from: string;
  fromfull: string;
  subject: string;
  to: string;
  origTo: string;
  time: number;
  seconds_ago: number;
};

export type AttachmentMeta = {
  id: string;
  filename: string | null;
  contentType: string;
  size: number;
  sha256: string;
};

export type MessageDetail = Omit<InboxEntry, never> & {
  headers: Record<string, string>;
  parts: Array<{ headers: Record<string, string>; body: string }>;
  attachments: AttachmentMeta[];
  skippedAttachments: number;
  attachmentsIncomplete: boolean;
};

export function toInboxEntry(row: MessageSummary, now: number): InboxEntry {
  return {
    id: row.id,
    domain: row.domain,
    from: row.from_name ?? row.from_addr,
    fromfull: row.from_addr,
    subject: row.subject ?? '',
    to: row.inbox,
    origTo: row.to_addr,
    time: row.received_at,
    seconds_ago: Math.floor((now - row.received_at) / 1000),
  };
}

function parseHeaders(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as Record<string, string | string[]>;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    );
  } catch {
    return {};
  }
}

export function toAttachmentMeta(a: AttachmentRow): AttachmentMeta {
  return { id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, sha256: a.sha256 };
}

export function toMessageDetail(row: MessageRow, atts: AttachmentRow[], now: number): MessageDetail {
  const parts: MessageDetail['parts'] = [];
  if (row.text_body !== null) {
    parts.push({ headers: { 'content-type': 'text/plain; charset=utf-8' }, body: row.text_body });
  }
  if (row.html_body !== null) {
    parts.push({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: row.html_body });
  }
  return {
    ...toInboxEntry({ ...row, attachment_count: atts.length } as MessageSummary, now),
    headers: parseHeaders(row.headers_json),
    parts,
    attachments: atts.map(toAttachmentMeta),
    skippedAttachments: row.skipped_attachments,
    attachmentsIncomplete: row.attachments_incomplete === 1,
  };
}
