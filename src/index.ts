import { createApiApp } from './api/app';
import { runCleanup } from './cleanup';
import { parseConfig } from './config';
import type { Env } from './env';
import { ingestEmail } from './ingest/ingest';
import { createUiApp } from './ui/app';

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    const outcome = await ingestEmail(
      {
        raw: message.raw,
        rawSize: message.rawSize,
        envelopeTo: message.to,
        envelopeFrom: message.from,
      },
      { db: env.DB, bucket: env.BUCKET },
      parseConfig(env),
      Date.now(),
    );
    if (outcome.status === 'rejected' && outcome.reason === 'too_large') {
      message.setReject('Message too large');
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = parseConfig(env);
    const host = new URL(req.url).host;
    if (host === cfg.apiHost) return createApiApp().fetch(req, env, ctx);
    if (host === cfg.uiHost) return createUiApp().fetch(req, env, ctx);
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCleanup(env, parseConfig(env), Date.now()));
  },
};
