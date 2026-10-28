import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { buildMail, makePdf } from '../test/mail-builder';
import { deliverMail, deliverRaw } from './deliver';

const API = 'http://127.0.0.1:8787/api/v2';
const STAGING = 'staging.test.example';
const PROD = 'prod.test.example';
const TOKEN = 'stage-token-a';

const sha256 = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const newInbox = () => `e2e-${crypto.randomUUID()}`;
const inboxUrl = (inbox: string, domain = STAGING) => `${API}/domains/${domain}/inboxes/${inbox}`;
const auth = (token = TOKEN) => ({ headers: { Authorization: token } });

async function send(
  request: APIRequestContext,
  inbox: string,
  opts: Partial<Parameters<typeof buildMail>[0]> = {},
  domain = STAGING,
) {
  const to = `${inbox}@${domain}`;
  await deliverMail(request, buildMail({ to, ...opts }), 'orders@sender.example', to);
}

async function listMsgs(request: APIRequestContext, inbox: string, domain = STAGING, token = TOKEN) {
  const res = await request.get(inboxUrl(inbox, domain), auth(token));
  expect(res.status()).toBe(200);
  return (await res.json()) as { msgs: Array<{ id: string; subject: string; seconds_ago: number }> };
}

async function detail(request: APIRequestContext, inbox: string, id: string) {
  const res = await request.get(`${inboxUrl(inbox)}/messages/${id}`, auth());
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    attachments: Array<{ id: string; filename: string | null; sha256: string; size: number }>;
  };
}

test('PDF attachment: list, detail and download match by SHA-256', async ({ request }) => {
  const inbox = newInbox();
  const pdf = await makePdf('round-trip');
  await send(request, inbox, {
    subject: 'with pdf',
    attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', bytes: pdf }],
  });
  const { msgs } = await listMsgs(request, inbox);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].subject).toBe('with pdf');
  const d = await detail(request, inbox, msgs[0].id);
  expect(d.attachments).toHaveLength(1);
  expect(d.attachments[0].filename).toBe('invoice.pdf');
  expect(d.attachments[0].sha256).toBe(sha256(pdf));
  const dl = await request.get(
    `${inboxUrl(inbox)}/messages/${msgs[0].id}/attachments/${d.attachments[0].id}`,
    auth(),
  );
  expect(dl.status()).toBe(200);
  expect(sha256(await dl.body())).toBe(sha256(pdf));
});

test('two mails with different PDFs are isolated; cross-message ids return 404', async ({
  request,
}) => {
  const inbox = newInbox();
  const pdfA = await makePdf('mail-a');
  const pdfB = await makePdf('mail-b');
  await send(request, inbox, {
    subject: 'A',
    attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', bytes: pdfA }],
  });
  await send(request, inbox, {
    subject: 'B',
    attachments: [{ filename: 'b.pdf', contentType: 'application/pdf', bytes: pdfB }],
  });
  const { msgs } = await listMsgs(request, inbox);
  expect(msgs).toHaveLength(2);
  const idA = msgs.find((m) => m.subject === 'A')!.id;
  const idB = msgs.find((m) => m.subject === 'B')!.id;
  const dA = await detail(request, inbox, idA);
  const dB = await detail(request, inbox, idB);
  const dlA = await request.get(`${inboxUrl(inbox)}/messages/${idA}/attachments/${dA.attachments[0].id}`, auth());
  const dlB = await request.get(`${inboxUrl(inbox)}/messages/${idB}/attachments/${dB.attachments[0].id}`, auth());
  expect(sha256(await dlA.body())).toBe(sha256(pdfA));
  expect(sha256(await dlB.body())).toBe(sha256(pdfB));
  const cross = await request.get(
    `${inboxUrl(inbox)}/messages/${idB}/attachments/${dA.attachments[0].id}`,
    auth(),
  );
  expect(cross.status()).toBe(404);
});

test('wrong domain or inbox returns 404', async ({ request }) => {
  const inbox = newInbox();
  const pdf = await makePdf('scoping');
  await send(request, inbox, {
    attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', bytes: pdf }],
  });
  const { msgs } = await listMsgs(request, inbox);
  const id = msgs[0].id;
  const att = (await detail(request, inbox, id)).attachments[0].id;

  const otherInbox = `${inboxUrl(newInbox())}/messages/${id}`;
  expect((await request.get(otherInbox, auth())).status()).toBe(404);
  expect((await request.get(`${otherInbox}/attachments/${att}`, auth())).status()).toBe(404);
  expect((await request.get(`${otherInbox}/links`, auth())).status()).toBe(404);

  // Unknown domain is 404 before any token check.
  const unknown = await request.get(inboxUrl(inbox, 'nope.test.example'), auth());
  expect(unknown.status()).toBe(404);
  // Known domain, message exists only under the other domain: prod token, prod domain, 404.
  const prod = await request.get(`${inboxUrl(inbox, PROD)}/messages/${id}`, auth('prod-token'));
  expect(prod.status()).toBe(404);
});

test('duplicate filenames are both stored, distinct and downloadable', async ({ request }) => {
  const inbox = newInbox();
  const one = await makePdf('dup-one');
  const two = await makePdf('dup-two');
  await send(request, inbox, {
    attachments: [
      { filename: 'invoice.pdf', contentType: 'application/pdf', bytes: one },
      { filename: 'invoice.pdf', contentType: 'application/pdf', bytes: two },
    ],
  });
  const { msgs } = await listMsgs(request, inbox);
  const d = await detail(request, inbox, msgs[0].id);
  expect(d.attachments).toHaveLength(2);
  expect(new Set(d.attachments.map((a) => a.id)).size).toBe(2);
  const hashes: string[] = [];
  for (const a of d.attachments) {
    const dl = await request.get(`${inboxUrl(inbox)}/messages/${msgs[0].id}/attachments/${a.id}`, auth());
    expect(dl.status()).toBe(200);
    hashes.push(sha256(await dl.body()));
  }
  expect(hashes.sort()).toEqual([sha256(one), sha256(two)].sort());
});

test.describe('authentication', () => {
  test('missing, wrong and Bearer-prefixed tokens return 401', async ({ request }) => {
    const url = inboxUrl(newInbox());
    expect((await request.get(url)).status()).toBe(401);
    expect((await request.get(url, auth('wrong'))).status()).toBe(401);
    expect((await request.get(url, auth(`Bearer ${TOKEN}`))).status()).toBe(401);
  });

  test('a staging token on the production domain returns 401, and the reverse', async ({
    request,
  }) => {
    const inbox = newInbox();
    expect((await request.get(inboxUrl(inbox, PROD), auth(TOKEN))).status()).toBe(401);
    expect((await request.get(inboxUrl(inbox, STAGING), auth('prod-token'))).status()).toBe(401);
  });

  test('both staging tokens and the production token work on their own domain', async ({
    request,
  }) => {
    const inbox = newInbox();
    expect((await request.get(inboxUrl(inbox, STAGING), auth('stage-token-a'))).status()).toBe(200);
    expect((await request.get(inboxUrl(inbox, STAGING), auth('stage-token-b'))).status()).toBe(200);
    expect((await request.get(inboxUrl(inbox, PROD), auth('prod-token'))).status()).toBe(200);
  });
});

test('links come from HTML and text bodies with &amp; decoded', async ({ request }) => {
  const inbox = newInbox();
  const other = newInbox();
  await send(request, inbox, {
    html: '<a href="https://html.test/verify?a=1&amp;b=2">go</a>',
    text: 'Or open https://text.test/path?c=3 now',
  });
  await send(request, other, { html: '<a href="https://other.test/x">x</a>', text: 'nothing' });
  const { msgs } = await listMsgs(request, inbox);
  const res = await request.get(`${inboxUrl(inbox)}/messages/${msgs[0].id}/links`, auth());
  expect(res.status()).toBe(200);
  const { links } = (await res.json()) as { links: string[] };
  expect(links).toContain('https://html.test/verify?a=1&b=2');
  expect(links).toContain('https://text.test/path?c=3');
  expect(links.join(' ')).not.toContain('other.test');
  expect(links.join(' ')).not.toContain('&amp;');
});

test('an empty inbox returns 200 with msgs: []', async ({ request }) => {
  const res = await request.get(inboxUrl(newInbox()), auth());
  expect(res.status()).toBe(200);
  expect((await res.json()).msgs).toEqual([]);
});

test('non-PDF attachments are ignored', async ({ request }) => {
  const inbox = newInbox();
  await send(request, inbox, {
    attachments: [
      { filename: 'notes.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hello') },
      { filename: 'pic.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2]) },
    ],
  });
  const { msgs } = await listMsgs(request, inbox);
  expect(msgs).toHaveLength(1);
  expect((await detail(request, inbox, msgs[0].id)).attachments).toEqual([]);
});

test('an oversize mail is rejected and nothing is stored', async ({ request }) => {
  const inbox = newInbox();
  const to = `${inbox}@${STAGING}`;
  // Server runs with MAX_MESSAGE_BYTES=200000 (see playwright.config.ts).
  const big = buildMail({ to, text: 'x'.repeat(250_000) });
  const result = await deliverRaw(request, big, 'orders@sender.example', to);
  // Local endpoint answers 400 with the setReject reason when the worker rejects.
  expect(result.status).toBe(400);
  expect(result.body).toContain('Worker rejected email with the following reason: Message too large');
  expect((await listMsgs(request, inbox)).msgs).toEqual([]);
});
