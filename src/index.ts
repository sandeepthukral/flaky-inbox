import { parseConfig } from './config';
import type { Env } from './env';

const notImplemented = () => new Response('Not Implemented', { status: 501 });

export default {
  async email(_message: ForwardableEmailMessage, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Stub until the mail handler task.
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const cfg = parseConfig(env);
    const host = new URL(req.url).host;
    if (host === cfg.apiHost) return notImplemented(); // API app: later task
    if (host === cfg.uiHost) return notImplemented(); // UI app: later task
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Stub until the cleanup task.
  },
};
