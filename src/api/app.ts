import { Hono } from 'hono';
import { parseConfig } from '../config';
import { serveAttachment } from '../attachments';
import { getMessage, listAttachments, listMessages } from '../db/messages';
import { bumpStat, type Metric } from '../db/stats';
import type { Env } from '../env';
import { extractLinks } from '../links';
import { toAttachmentMeta, toInboxEntry, toMessageDetail } from '../shapes';
import { isTokenValid } from './auth';

const PATH_RE = /^\/api\/v2\/domains\/([^/]+)\/inboxes\/[^/]+(?:\/messages\/[^/]+(\/links|\/attachments(?:\/[^/]+)?)?)?\/?$/;
const MESSAGE_RE = /^\/api\/v2\/domains\/[^/]+\/inboxes\/[^/]+\/messages\//;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function createApiApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>().basePath('/api/v2');

  // Stats: awaited before returning so counts are settled when the response is seen.
  app.use('*', async (c, next) => {
    await next();
    const cfg = parseConfig(c.env);
    const now = Date.now();
    const path = c.req.path;
    const m = PATH_RE.exec(path);
    const domain = m ? safeDecode(m[1]).toLowerCase() : '_other';
    const statDomain = cfg.allowedDomains.includes(domain) ? domain : '_other';
    const status = c.res.status;
    const metrics: Metric[] = [];
    if (m) {
      const kind = m[2];
      const isMessage = MESSAGE_RE.test(path);
      if (!isMessage) metrics.push('api_inbox');
      else if (kind?.startsWith('/attachments')) metrics.push('api_attachment');
      else metrics.push('api_message');
      if (isMessage && status >= 200 && status < 300) metrics.push('accessed_api');
    }
    if (status >= 400) metrics.push('api_error');
    for (const metric of metrics) await bumpStat(c.env.DB, statDomain, metric, now);
  });

  app.use('/domains/:domain/*', async (c, next) => {
    const cfg = parseConfig(c.env);
    const domain = c.req.param('domain').toLowerCase();
    if (!cfg.allowedDomains.includes(domain)) return c.json({ error: 'Not found' }, 404);
    if (!(await isTokenValid(c.req.header('Authorization') ?? null, domain, cfg.apiTokens))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/domains/:domain/inboxes/:inbox', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const inbox = c.req.param('inbox').toLowerCase();
    const now = Date.now();
    const { rows } = await listMessages(c.env.DB, { domain, inbox, now, limit: 100, offset: 0 });
    return c.json({ domain, to: inbox, msgs: rows.map((r) => toInboxEntry(r, now)) });
  });

  app.get('/domains/:domain/inboxes/:inbox/messages/:id', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const inbox = c.req.param('inbox').toLowerCase();
    const now = Date.now();
    const row = await getMessage(c.env.DB, domain, inbox, c.req.param('id'), now);
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json(toMessageDetail(row, await listAttachments(c.env.DB, row.id), now));
  });

  app.get('/domains/:domain/inboxes/:inbox/messages/:id/links', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const inbox = c.req.param('inbox').toLowerCase();
    const row = await getMessage(c.env.DB, domain, inbox, c.req.param('id'), Date.now());
    if (!row) return c.json({ error: 'Not found' }, 404);
    return c.json({ links: extractLinks(row.html_body, row.text_body) });
  });

  app.get('/domains/:domain/inboxes/:inbox/messages/:id/attachments', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const inbox = c.req.param('inbox').toLowerCase();
    const row = await getMessage(c.env.DB, domain, inbox, c.req.param('id'), Date.now());
    if (!row) return c.json({ error: 'Not found' }, 404);
    const atts = await listAttachments(c.env.DB, row.id);
    return c.json({
      attachments: atts.map(toAttachmentMeta),
      attachmentsIncomplete: row.attachments_incomplete === 1,
    });
  });

  app.get('/domains/:domain/inboxes/:inbox/messages/:id/attachments/:attachmentId', (c) =>
    serveAttachment(c.env, {
      domain: c.req.param('domain').toLowerCase(),
      inbox: c.req.param('inbox').toLowerCase(),
      messageId: c.req.param('id'),
      attachmentId: c.req.param('attachmentId'),
      now: Date.now(),
    }),
  );

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    console.error('API error', err);
    return c.json({ error: 'Internal error' }, 500);
  });
  return app;
}
