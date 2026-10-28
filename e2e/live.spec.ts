import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

// Live acceptance against the deployed service (docs/acceptance.md). Skipped unless all three are set.
// Run on its own: the helper reads its base URL when first imported, so this file sets it before the
// dynamic import below and must not share a worker with a spec that imported the helper earlier.
//   LIVE_API_BASE=https://mail-api.flaky-tests.uk/api/v2 LIVE_DOMAIN=ecom-staging.flaky-tests.uk \
//   MAILINATOR_API_KEY=<token> LIVE_INBOX=accept-... LIVE_LINK_PREFIX=https://... [LIVE_EXPECT_PDF=1] \
//   pnpm e2e live.spec.ts
const { LIVE_API_BASE, LIVE_DOMAIN, MAILINATOR_API_KEY, LIVE_INBOX, LIVE_LINK_PREFIX, LIVE_EXPECT_PDF } =
  process.env;
const enabled = Boolean(LIVE_API_BASE && LIVE_DOMAIN && MAILINATOR_API_KEY);

test.describe('live service', () => {
  test.skip(!enabled, 'set LIVE_API_BASE, LIVE_DOMAIN and MAILINATOR_API_KEY to run against the live service');

  async function client(request: Parameters<Parameters<typeof test>[2]>[0]['request']) {
    process.env.MAILINATOR_API_BASE_URL = LIVE_API_BASE;
    const { MailinatorClient } = await import('./mailinator-client');
    return new MailinatorClient(request, LIVE_DOMAIN);
  }

  test('inbox has mail with the helper fields', async ({ request }) => {
    expect(LIVE_INBOX, 'LIVE_INBOX is required').toBeTruthy();
    const messages = await (await client(request)).getMessages(LIVE_INBOX!);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const m of messages) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.subject).toBe('string');
      expect(typeof m.from).toBe('string');
      expect(typeof m.to).toBe('string');
      expect(typeof m.seconds_ago).toBe('number');
    }
  });

  test('a link with the given prefix is found', async ({ request }) => {
    expect(LIVE_INBOX, 'LIVE_INBOX is required').toBeTruthy();
    expect(LIVE_LINK_PREFIX, 'LIVE_LINK_PREFIX is required').toBeTruthy();
    const link = await (await client(request)).waitForLinkStartingWith(LIVE_INBOX!, LIVE_LINK_PREFIX!, {
      timeout: 30_000,
    });
    expect(link.startsWith(LIVE_LINK_PREFIX!)).toBe(true);
  });

  test('PDF attachment downloads with the listed sha256', async ({ request }) => {
    test.skip(LIVE_EXPECT_PDF !== '1', 'set LIVE_EXPECT_PDF=1 to check the PDF');
    expect(LIVE_INBOX, 'LIVE_INBOX is required').toBeTruthy();
    const messages = await (await client(request)).getMessages(LIVE_INBOX!);
    const headers = { Authorization: MAILINATOR_API_KEY! };
    const base = `${LIVE_API_BASE}/domains/${LIVE_DOMAIN}/inboxes/${LIVE_INBOX}/messages`;

    let checked = false;
    for (const m of messages) {
      const list = await request.get(`${base}/${m.id}/attachments`, { headers });
      expect(list.ok()).toBe(true);
      const { attachments } = (await list.json()) as {
        attachments: Array<{ id: string; contentType: string; sha256: string }>;
      };
      const pdf = attachments.find((a) => a.contentType === 'application/pdf');
      if (!pdf) continue;
      const download = await request.get(`${base}/${m.id}/attachments/${pdf.id}`, { headers });
      expect(download.ok()).toBe(true);
      const bytes = await download.body();
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pdf.sha256);
      checked = true;
      break;
    }
    expect(checked, 'no PDF attachment found in the inbox').toBe(true);
  });
});
