import type { Env } from '../env';

export type MessageRow = {
  id: string;
  domain: string;
  inbox: string;
  from_name: string | null;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  headers_json: string | null;
  text_body: string | null;
  html_body: string | null;
  skipped_attachments: number;
  attachments_incomplete: number;
  received_at: number;
  expires_at: number;
};

export type AttachmentRow = {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string;
  size: number;
  sha256: string;
  r2_key: string;
};

export type MessageSummary = Pick<
  MessageRow,
  'id' | 'domain' | 'inbox' | 'from_name' | 'from_addr' | 'to_addr' | 'subject' | 'received_at' | 'expires_at'
> & { attachment_count: number; text_head: string | null };

// D1 allows at most 100 bound parameters per statement.
const ID_CHUNK = 50;
const R2_DELETE_CHUNK = 1000;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function insertMessage(
  db: D1Database,
  msg: MessageRow,
  atts: AttachmentRow[],
): Promise<void> {
  const stmts = [
    db
      .prepare(
        `INSERT INTO messages (id, domain, inbox, from_name, from_addr, to_addr, subject, headers_json,
           text_body, html_body, skipped_attachments, attachments_incomplete, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        msg.id,
        msg.domain,
        msg.inbox,
        msg.from_name,
        msg.from_addr,
        msg.to_addr,
        msg.subject,
        msg.headers_json,
        msg.text_body,
        msg.html_body,
        msg.skipped_attachments,
        msg.attachments_incomplete,
        msg.received_at,
        msg.expires_at,
      ),
    ...atts.map((a) =>
      db
        .prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, sha256, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(a.id, a.message_id, a.filename, a.content_type, a.size, a.sha256, a.r2_key),
    ),
  ];
  await db.batch(stmts);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listMessages(
  db: D1Database,
  q: {
    domain: string;
    inbox?: string;
    inboxPrefix?: string;
    now: number;
    limit: number;
    offset: number;
  },
): Promise<{ rows: MessageSummary[]; total: number }> {
  let where = 'm.domain = ? AND m.expires_at > ?';
  const params: Array<string | number> = [q.domain, q.now];
  if (q.inbox !== undefined) {
    where += ' AND m.inbox = ?';
    params.push(q.inbox);
  }
  if (q.inboxPrefix !== undefined) {
    where += " AND m.inbox LIKE ? || '%' ESCAPE '\\'";
    params.push(escapeLike(q.inboxPrefix));
  }
  const rowsStmt = db
    .prepare(
      `SELECT m.id, m.domain, m.inbox, m.from_name, m.from_addr, m.to_addr, m.subject,
         m.received_at, m.expires_at, substr(m.text_body, 1, 400) AS text_head,
         (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
       FROM messages m WHERE ${where}
       ORDER BY m.received_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, q.limit, q.offset);
  const countStmt = db
    .prepare(`SELECT COUNT(*) AS total FROM messages m WHERE ${where}`)
    .bind(...params);
  const [rows, count] = await db.batch([rowsStmt, countStmt]);
  return {
    rows: rows.results as MessageSummary[],
    total: (count.results[0] as { total: number }).total,
  };
}

export async function getMessage(
  db: D1Database,
  domain: string,
  inbox: string,
  id: string,
  now: number,
): Promise<MessageRow | null> {
  return db
    .prepare('SELECT * FROM messages WHERE id = ? AND domain = ? AND inbox = ? AND expires_at > ?')
    .bind(id, domain, inbox, now)
    .first<MessageRow>();
}

export async function listAttachments(db: D1Database, messageId: string): Promise<AttachmentRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid')
    .bind(messageId)
    .all<AttachmentRow>();
  return results;
}

export async function getAttachmentForMessage(
  db: D1Database,
  domain: string,
  inbox: string,
  messageId: string,
  attachmentId: string,
  now: number,
): Promise<AttachmentRow | null> {
  return db
    .prepare(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND a.message_id = ? AND m.domain = ? AND m.inbox = ? AND m.expires_at > ?`,
    )
    .bind(attachmentId, messageId, domain, inbox, now)
    .first<AttachmentRow>();
}

export async function deleteMessages(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  ids: string[],
): Promise<number> {
  let deleted = 0;
  for (const group of chunks(ids, ID_CHUNK)) {
    const marks = group.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT r2_key FROM attachments WHERE message_id IN (${marks})`,
    )
      .bind(...group)
      .all<{ r2_key: string }>();
    // R2 objects first, then attachment rows, then message rows.
    for (const keys of chunks(
      results.map((r) => r.r2_key),
      R2_DELETE_CHUNK,
    )) {
      await env.BUCKET.delete(keys);
    }
    const [, msgs] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${marks})`).bind(...group),
      env.DB.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...group),
    ]);
    deleted += msgs.meta.changes;
  }
  return deleted;
}

export async function listExpiredIds(db: D1Database, now: number, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM messages WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?')
    .bind(now, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
