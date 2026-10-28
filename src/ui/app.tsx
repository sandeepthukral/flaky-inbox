import { Hono } from 'hono';
import { parseConfig } from '../config';
import type { Env } from '../env';
import { accessJwks, verifyAccessJwt } from './access';
import { serveAttachment } from '../attachments';
import { deleteMessages, getMessage, listAttachments } from '../db/messages';
import { bumpStat } from '../db/stats';
import { InboxView, loadInbox, parseInboxQuery, RowsBody, safeBack } from './inbox';
import { Layout } from './layout';
import { MessageView } from './message';
import { loadStats, parseStatsDomain, StatsView } from './stats';

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src * data:; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; frame-ancestors 'none'";

export function createUiApp(): Hono<{ Bindings: Env; Variables: { user: string } }> {
  const app = new Hono<{ Bindings: Env; Variables: { user: string } }>();

  // Security headers on every response, including 403s.
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    // same-origin, not no-referrer: browsers send `Origin: null` on same-site form POSTs under
    // no-referrer, which the Origin check below would reject.
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cache-Control', 'private, no-store');
  });

  // Fail closed: no valid Access assertion, no page.
  app.use('*', async (c, next) => {
    const cfg = parseConfig(c.env);
    if (cfg.uiAuthMode === 'dev') {
      c.set('user', 'dev@local');
      return next();
    }
    if (!cfg.accessTeamDomain || !cfg.accessAud) return c.body('Forbidden', 403);
    const user = await verifyAccessJwt(c.req.header('Cf-Access-Jwt-Assertion') ?? null, {
      aud: cfg.accessAud,
      issuer: `https://${cfg.accessTeamDomain}`,
      jwks: accessJwks(cfg.accessTeamDomain),
    });
    if (!user) return c.body('Forbidden', 403);
    c.set('user', user.email);
    return next();
  });

  // Cross-site request protection for anything that changes state.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const { uiOrigin } = parseConfig(c.env);
      if (!uiOrigin || c.req.header('Origin') !== uiOrigin) return c.body('Forbidden', 403);
    }
    return next();
  });

  app.get('/', async (c) => {
    const cfg = parseConfig(c.env);
    const q = parseInboxQuery(cfg, c.req.query());
    const data = await loadInbox(c.env.DB, q, Date.now());
    return c.html(
      <Layout title="Inbox" user={c.get('user')} active="inbox">
        <InboxView cfg={cfg} q={q} rows={data.rows} total={data.total} now={data.now} />
      </Layout>,
    );
  });

  app.get('/rows', async (c) => {
    const q = parseInboxQuery(parseConfig(c.env), c.req.query());
    const data = await loadInbox(c.env.DB, q, Date.now());
    return c.html(<RowsBody rows={data.rows} now={data.now} />);
  });

  app.get('/stats', async (c) => {
    const cfg = parseConfig(c.env);
    const domain = parseStatsDomain(cfg, c.req.query('domain'));
    const rows = await loadStats(c.env.DB, cfg, domain, Date.now());
    return c.html(
      <Layout title="Statistics" user={c.get('user')} active="stats">
        <StatsView cfg={cfg} domain={domain} rows={rows} />
      </Layout>,
    );
  });

  app.get('/m/:domain/:inbox/:id', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const inbox = c.req.param('inbox').toLowerCase();
    const now = Date.now();
    const row = await getMessage(c.env.DB, domain, inbox, c.req.param('id'), now);
    if (!row) {
      return c.html(
        <Layout title="Not found" user={c.get('user')} active="message">
          <p>Message not found. It may have expired or been deleted.</p>
          <p>
            <a href="/">Back to inbox</a>
          </p>
        </Layout>,
        404,
      );
    }
    const atts = await listAttachments(c.env.DB, row.id);
    await bumpStat(c.env.DB, domain, 'accessed_ui', now);
    return c.html(
      <Layout title={row.subject || 'Message'} user={c.get('user')} active="message">
        <MessageView row={row} atts={atts} now={now} />
      </Layout>,
    );
  });

  app.get('/m/:domain/:inbox/:id/a/:attachmentId', async (c) => {
    const domain = c.req.param('domain').toLowerCase();
    const now = Date.now();
    const res = await serveAttachment(c.env, {
      domain,
      inbox: c.req.param('inbox').toLowerCase(),
      messageId: c.req.param('id'),
      attachmentId: c.req.param('attachmentId'),
      now,
    });
    if (res.status === 200) await bumpStat(c.env.DB, domain, 'accessed_ui', now);
    return res;
  });

  app.post('/delete', async (c) => {
    const form = await c.req.formData();
    const ids = [...new Set(form.getAll('ids').filter((v): v is string => typeof v === 'string' && v !== ''))];
    if (ids.length > 0) await deleteMessages(c.env, ids);
    return c.redirect(safeBack(form.get('back')), 303);
  });

  return app;
}
