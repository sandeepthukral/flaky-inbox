import { Hono } from 'hono';
import { parseConfig } from '../config';
import type { Env } from '../env';
import { accessJwks, verifyAccessJwt } from './access';
import { Layout } from './layout';

const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src * data:; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; frame-ancestors 'none'";

export function createUiApp(): Hono<{ Bindings: Env; Variables: { user: string } }> {
  const app = new Hono<{ Bindings: Env; Variables: { user: string } }>();

  // Security headers on every response, including 403s.
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
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

  app.get('/', (c) =>
    c.html(
      <Layout title="Inbox" user={c.get('user')} active="inbox">
        <p>Inbox coming soon.</p>
      </Layout>,
    ),
  );

  return app;
}
