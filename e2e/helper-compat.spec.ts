import { expect, test } from '@playwright/test';
import { buildMail } from '../test/mail-builder';
import { deliverMail } from './deliver';
import { MailinatorClient } from './mailinator-client';

// The helper reads its key from the environment, exactly as in action/web.
process.env.MAILINATOR_API_KEY = 'stage-token-a';

const DOMAIN = 'staging.test.example';

async function send(request: Parameters<typeof deliverMail>[0], inbox: string, subject: string, html: string) {
  const to = `${inbox}@${DOMAIN}`;
  await deliverMail(request, buildMail({ to, subject, html }), 'orders@sender.example', to);
}

test('waitForLinkStartingWith resolves a verify link with &amp; decoded', async ({ request }) => {
  const inbox = `compat-${crypto.randomUUID()}`;
  await send(request, inbox, 'Verify', '<a href="https://gigya.test/verify?x=1&amp;y=2">Verify</a>');
  const client = new MailinatorClient(request, DOMAIN);
  const link = await client.waitForLinkStartingWith(inbox, 'https://gigya.test/verify', {
    timeout: 15_000,
  });
  expect(link).toBe('https://gigya.test/verify?x=1&y=2');
});

test('getMessages returns the newest first and getLinks reads each message', async ({ request }) => {
  const inbox = `compat-${crypto.randomUUID()}`;
  await send(request, inbox, 'older', '<a href="https://older.test/a">a</a>');
  await new Promise((r) => setTimeout(r, 2_100)); // seconds_ago has 1s resolution
  await send(request, inbox, 'newer', '<a href="https://newer.test/b">b</a>');
  const client = new MailinatorClient(request, DOMAIN);
  const msgs = await client.getMessages(inbox);
  expect(msgs.map((m) => m.subject)).toEqual(['newer', 'older']);
  expect(await client.getLinks(inbox, msgs[0].id)).toEqual(['https://newer.test/b']);
});
