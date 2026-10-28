import { getAttachmentForMessage } from './db/messages';
import type { Env } from './env';
import { contentDisposition } from './filename';

type Params = { domain: string; inbox: string; messageId: string; attachmentId: string; now: number };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stream one attachment, only if message, inbox, domain and expiry all match, and the stored bytes are intact. */
export async function serveAttachment(env: Pick<Env, 'DB' | 'BUCKET'>, p: Params): Promise<Response> {
  const row = await getAttachmentForMessage(env.DB, p.domain, p.inbox, p.messageId, p.attachmentId, p.now);
  if (!row) return json({ error: 'Not found' }, 404);
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) {
    console.error('Attachment object missing in R2', { attachmentId: row.id, key: row.r2_key });
    return json({ error: 'Attachment unavailable' }, 500);
  }
  if (obj.size !== row.size) {
    await obj.body.cancel();
    console.error('Attachment size mismatch', { attachmentId: row.id, expected: row.size, actual: obj.size });
    return json({ error: 'Attachment unavailable' }, 500);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': row.content_type,
      'Content-Length': String(row.size),
      'Content-Disposition': contentDisposition(row.filename),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
