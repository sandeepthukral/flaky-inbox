import PostalMime from 'postal-mime';
import type { Config } from '../config';
import { type AttachmentRow, insertMessage, type MessageRow } from '../db/messages';
import { bumpStat } from '../db/stats';
import { isAcceptedPdf } from './pdf';

export type IngestInput = {
  raw: ReadableStream | ArrayBuffer | string;
  rawSize: number;
  envelopeTo: string;
  envelopeFrom: string;
};
export type IngestDeps = { db: D1Database; bucket: Pick<R2Bucket, 'put' | 'delete'> };
export type IngestOutcome =
  | { status: 'stored'; id: string; attachments: number; incomplete: boolean }
  | { status: 'rejected'; reason: 'too_large' | 'unknown_domain' };

const OTHER_DOMAIN = '_other';

// Cut at maxBytes of UTF-8 without splitting a character.
function truncateUtf8(s: string | undefined, maxBytes: number): string | null {
  if (s === undefined) return null;
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Best effort: a failed cleanup is logged (the orphan sweep removes stray objects later).
async function cleanup(bucket: IngestDeps['bucket'], keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
  } catch (e) {
    console.error('R2 cleanup failed', e);
  }
}

export async function ingestEmail(
  input: IngestInput,
  deps: IngestDeps,
  cfg: Config,
  now: number,
): Promise<IngestOutcome> {
  const to = input.envelopeTo.toLowerCase();
  const at = to.lastIndexOf('@');
  const inbox = at >= 0 ? to.slice(0, at) : to;
  const domain = at >= 0 ? to.slice(at + 1) : '';
  const known = cfg.allowedDomains.includes(domain);

  if (input.rawSize > cfg.maxMessageBytes) {
    await bumpStat(deps.db, known ? domain : OTHER_DOMAIN, 'rejected', now);
    return { status: 'rejected', reason: 'too_large' };
  }
  if (!known) {
    await bumpStat(deps.db, OTHER_DOMAIN, 'rejected', now);
    return { status: 'rejected', reason: 'unknown_domain' };
  }

  const parsed = await PostalMime.parse(input.raw, { attachmentEncoding: 'arraybuffer' });
  const id = crypto.randomUUID();

  const headers: Record<string, string | string[]> = {};
  for (const h of parsed.headers) {
    const prev = headers[h.key];
    headers[h.key] = prev === undefined ? h.value : [...(Array.isArray(prev) ? prev : [prev]), h.value];
  }

  const candidates: Array<{ bytes: Uint8Array; filename: string | null; mimeType: string }> = [];
  for (const a of parsed.attachments) {
    if (a.disposition === 'inline' && a.contentId) continue;
    const bytes = new Uint8Array(a.content as ArrayBuffer);
    if (!isAcceptedPdf(bytes, a.mimeType, a.filename ?? undefined)) continue;
    candidates.push({ bytes, filename: a.filename, mimeType: a.mimeType });
  }
  const kept = candidates
    .filter((c) => c.bytes.length <= cfg.maxAttachmentBytes)
    .slice(0, cfg.maxAttachments);
  const skipped = candidates.length - kept.length;

  const attempted: string[] = []; // recorded before put(): a put that throws may still have landed
  const rows: AttachmentRow[] = [];
  let incomplete = false;
  try {
    for (const c of kept) {
      const attId = crypto.randomUUID();
      const key = `${id}/${attId}`;
      const sha256 = toHex(await crypto.subtle.digest('SHA-256', c.bytes));
      attempted.push(key);
      await deps.bucket.put(key, c.bytes, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { messageId: id },
      });
      rows.push({
        id: attId,
        message_id: id,
        filename: c.filename,
        content_type: 'application/pdf',
        size: c.bytes.length,
        sha256,
        r2_key: key,
      });
    }
  } catch (err) {
    console.error('R2 write failed; storing mail without attachments', err);
    await cleanup(deps.bucket, attempted);
    rows.length = 0;
    incomplete = true;
  }

  const from = parsed.from && !('group' in parsed.from && parsed.from.group) ? parsed.from : undefined;
  const msg: MessageRow = {
    id,
    domain,
    inbox,
    from_name: from?.name || null,
    from_addr: from?.address || input.envelopeFrom,
    to_addr: to,
    subject: parsed.subject ?? null,
    headers_json: JSON.stringify(headers),
    text_body: truncateUtf8(parsed.text, cfg.maxBodyBytes),
    html_body: truncateUtf8(parsed.html, cfg.maxBodyBytes),
    skipped_attachments: skipped,
    attachments_incomplete: incomplete ? 1 : 0,
    received_at: now,
    expires_at: now + cfg.retentionMs,
  };

  try {
    await insertMessage(deps.db, msg, rows);
  } catch (err) {
    await cleanup(deps.bucket, attempted);
    throw err;
  }
  await bumpStat(deps.db, domain, 'incoming', now);
  return { status: 'stored', id, attachments: rows.length, incomplete };
}
