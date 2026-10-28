import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AttachmentRow,
  deleteMessages,
  getAttachmentForMessage,
  getMessage,
  insertMessage,
  listAttachments,
  listExpiredIds,
  listMessages,
  type MessageRow,
} from '../src/db/messages';

const NOW = 1_800_000_000_000;

function msg(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'm1',
    domain: 'staging.test.example',
    inbox: 'alice',
    from_name: 'Bob',
    from_addr: 'bob@example.com',
    to_addr: 'alice@staging.test.example',
    subject: 'Hello',
    headers_json: null,
    text_body: 'hi',
    html_body: null,
    skipped_attachments: 0,
    attachments_incomplete: 0,
    received_at: NOW - 1000,
    expires_at: NOW + 100_000,
    ...over,
  };
}

function att(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'a1',
    message_id: 'm1',
    filename: 'f.txt',
    content_type: 'text/plain',
    size: 3,
    sha256: 'abc',
    r2_key: 'm1/a1',
    ...over,
  };
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM attachments'), env.DB.prepare('DELETE FROM messages')]);
});

describe('getMessage', () => {
  it('returns null for wrong domain, wrong inbox, or expired', async () => {
    await insertMessage(env.DB, msg(), []);
    expect(await getMessage(env.DB, 'staging.test.example', 'alice', 'm1', NOW)).toEqual(msg());
    expect(await getMessage(env.DB, 'prod.test.example', 'alice', 'm1', NOW)).toBeNull();
    expect(await getMessage(env.DB, 'staging.test.example', 'bob', 'm1', NOW)).toBeNull();
    expect(await getMessage(env.DB, 'staging.test.example', 'alice', 'm1', NOW + 100_000)).toBeNull();
  });
});

describe('listMessages', () => {
  it('hides expired and orders newest first', async () => {
    await insertMessage(env.DB, msg({ id: 'old', received_at: NOW - 5000 }), []);
    await insertMessage(env.DB, msg({ id: 'new', received_at: NOW - 1000 }), [
      att({ id: 'na', message_id: 'new', r2_key: 'new/na' }),
    ]);
    await insertMessage(env.DB, msg({ id: 'gone', received_at: NOW - 100, expires_at: NOW - 1 }), []);
    const { rows, total } = await listMessages(env.DB, {
      domain: 'staging.test.example',
      inbox: 'alice',
      now: NOW,
      limit: 10,
      offset: 0,
    });
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows[0].attachment_count).toBe(1);
    expect(rows[1].attachment_count).toBe(0);
    expect(total).toBe(2);
  });

  it('inboxPrefix treats % and _ literally', async () => {
    await insertMessage(env.DB, msg({ id: 'x1', inbox: 'a_b' }), []);
    await insertMessage(env.DB, msg({ id: 'x2', inbox: 'axb' }), []);
    const q = { domain: 'staging.test.example', now: NOW, limit: 10, offset: 0 };
    const r = await listMessages(env.DB, { ...q, inboxPrefix: 'a_' });
    expect(r.rows.map((m) => m.inbox)).toEqual(['a_b']);
    expect(r.total).toBe(1);
    const p = await listMessages(env.DB, { ...q, inboxPrefix: '%' });
    expect(p.rows).toEqual([]);
  });

  it('applies limit and offset while total counts all', async () => {
    for (let i = 0; i < 3; i++) {
      await insertMessage(env.DB, msg({ id: `p${i}`, received_at: NOW - i * 10 }), []);
    }
    const r = await listMessages(env.DB, {
      domain: 'staging.test.example',
      now: NOW,
      limit: 1,
      offset: 1,
    });
    expect(r.rows.map((m) => m.id)).toEqual(['p1']);
    expect(r.total).toBe(3);
  });
});

describe('attachments', () => {
  async function seed() {
    await insertMessage(env.DB, msg({ id: 'A', inbox: 'alice' }), [
      att({ id: 'attA2', message_id: 'A', r2_key: 'A/2' }),
      att({ id: 'attA1', message_id: 'A', r2_key: 'A/1' }),
    ]);
    await insertMessage(env.DB, msg({ id: 'B', inbox: 'bob', expires_at: NOW + 50 }), [
      att({ id: 'attB', message_id: 'B', r2_key: 'B/1' }),
    ]);
  }

  it('listAttachments returns insertion order', async () => {
    await seed();
    expect((await listAttachments(env.DB, 'A')).map((a) => a.id)).toEqual(['attA2', 'attA1']);
  });

  it('getAttachmentForMessage enforces message, domain, inbox and expiry', async () => {
    await seed();
    const d = 'staging.test.example';
    expect((await getAttachmentForMessage(env.DB, d, 'alice', 'A', 'attA1', NOW))?.r2_key).toBe('A/1');
    expect(await getAttachmentForMessage(env.DB, d, 'bob', 'B', 'attA1', NOW)).toBeNull();
    expect(await getAttachmentForMessage(env.DB, d, 'alice', 'B', 'attA1', NOW)).toBeNull();
    expect(await getAttachmentForMessage(env.DB, 'prod.test.example', 'alice', 'A', 'attA1', NOW)).toBeNull();
    expect(await getAttachmentForMessage(env.DB, d, 'alice', 'A', 'attA1', NOW + 99_999)).not.toBeNull();
    expect(await getAttachmentForMessage(env.DB, d, 'alice', 'A', 'attA1', NOW + 100_000)).toBeNull();
    expect(await getAttachmentForMessage(env.DB, d, 'bob', 'B', 'attB', NOW + 50)).toBeNull();
  });
});

describe('expiry and deletion', () => {
  it('listExpiredIds returns only expired ids up to limit', async () => {
    await insertMessage(env.DB, msg({ id: 'e1', expires_at: NOW - 2 }), []);
    await insertMessage(env.DB, msg({ id: 'e2', expires_at: NOW - 1 }), []);
    await insertMessage(env.DB, msg({ id: 'live' }), []);
    expect(await listExpiredIds(env.DB, NOW, 10)).toEqual(['e1', 'e2']);
    expect(await listExpiredIds(env.DB, NOW, 1)).toEqual(['e1']);
  });

  it('deleteMessages removes R2 objects, attachments and message', async () => {
    await env.BUCKET.put('m1/a1', 'abc');
    await env.BUCKET.put('keep/k', 'keep');
    await insertMessage(env.DB, msg(), [att()]);
    await insertMessage(env.DB, msg({ id: 'keep' }), [
      att({ id: 'ka', message_id: 'keep', r2_key: 'keep/k' }),
    ]);
    const n = await deleteMessages(env, ['m1']);
    expect(n).toBe(1);
    expect(await env.BUCKET.head('m1/a1')).toBeNull();
    expect(await env.BUCKET.head('keep/k')).not.toBeNull();
    const a = await env.DB.prepare('SELECT id FROM attachments').all();
    const m = await env.DB.prepare('SELECT id FROM messages').all();
    expect(a.results.map((r) => r.id)).toEqual(['ka']);
    expect(m.results.map((r) => r.id)).toEqual(['keep']);
  });

  it('deleteMessages with no ids is a no-op', async () => {
    expect(await deleteMessages(env, [])).toBe(0);
  });
});
