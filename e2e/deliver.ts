import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

// Wrangler/Miniflare's local email trigger (Miniflare CorePaths.EMAIL).
const EMAIL_ENDPOINT = 'http://127.0.0.1:8787/cdn-cgi/local/email';

export type Delivery = { status: number; body: string };

/** Deliver raw MIME through the local email handler and return the endpoint's answer. */
export async function deliverRaw(
  request: APIRequestContext,
  raw: string,
  from: string,
  to: string,
): Promise<Delivery> {
  const response = await request.post(EMAIL_ENDPOINT, {
    params: { from, to },
    data: Buffer.from(raw, 'utf8'),
    headers: { 'Content-Type': 'message/rfc822' },
  });
  return { status: response.status(), body: await response.text() };
}

export async function deliverMail(
  request: APIRequestContext,
  raw: string,
  from: string,
  to: string,
): Promise<void> {
  const result = await deliverRaw(request, raw, from, to);
  expect(result.status, `local email delivery failed: ${result.body}`).toBe(200);
}
