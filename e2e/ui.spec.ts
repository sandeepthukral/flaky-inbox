import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildMail, makePdf } from '../test/mail-builder';
import { deliverMail } from './deliver';

const UI = 'http://localhost:8787';
const STAGING = 'staging.test.example';

async function send(request: APIRequestContext, inbox: string, subject: string) {
  const to = `${inbox}@${STAGING}`;
  await deliverMail(request, buildMail({ to, subject }), 'orders@sender.example', to);
}

const inboxPage = (prefix: string) => `${UI}/?domain=${STAGING}&inbox=${prefix}`;

test.describe('inbox', () => {
  test('auto-refresh keeps ticked boxes', async ({ page, request }) => {
    const prefix = `ui-${crypto.randomUUID().slice(0, 8)}`;
    await send(request, `${prefix}-a`, 'First');
    await page.goto(inboxPage(prefix));
    const rows = page.locator('#rows tr[data-id]');
    await expect(rows).toHaveCount(1);
    await rows.first().locator('input[name=ids]').check();
    await expect(page.locator('#delete-btn')).toBeEnabled();

    await send(request, `${prefix}-b`, 'Second');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    const first = page.locator('#rows tr', { hasText: 'First' });
    await expect(first.locator('input[name=ids]')).toBeChecked();
    const second = page.locator('#rows tr', { hasText: 'Second' });
    await expect(second.locator('input[name=ids]')).not.toBeChecked();
  });

  test('delete selected asks and removes', async ({ page, request }) => {
    const prefix = `ui-${crypto.randomUUID().slice(0, 8)}`;
    await send(request, `${prefix}-a`, 'One');
    await send(request, `${prefix}-b`, 'Two');
    await page.goto(inboxPage(prefix));
    const rows = page.locator('#rows tr[data-id]');
    await expect(rows).toHaveCount(2);

    await page.locator('#select-all').check();
    const messages: string[] = [];
    page.on('dialog', (dialog) => {
      messages.push(dialog.message());
      void dialog.accept();
    });
    await page.locator('#delete-btn').click();

    await expect(page.locator('#rows tr.empty')).toBeVisible();
    await expect(rows).toHaveCount(0);
    expect(messages).toEqual(['Delete 2 mails and their attachments?']);
  });
});

test.describe('message page', () => {
  test('tabs switch and LINKS lists the decoded link', async ({ page, request }) => {
    const inbox = `ui-${crypto.randomUUID().slice(0, 8)}`;
    const to = `${inbox}@${STAGING}`;
    await deliverMail(
      request,
      buildMail({
        to,
        subject: 'Tabs',
        text: 'Plain tab body',
        html: '<p>Click <a href="https://example.com/verify?x=1&amp;y=2">here</a></p>',
      }),
      'orders@sender.example',
      to,
    );
    await page.goto(inboxPage(inbox));
    await page.locator('#rows tr[data-id] a').first().click();

    await expect(page.locator('#tab-html')).toBeVisible();
    await expect(page.locator('#tab-text')).toBeHidden();
    await page.locator('button[data-tab=text]').click();
    await expect(page.locator('#tab-text')).toContainText('Plain tab body');
    await expect(page.locator('#tab-html')).toBeHidden();
    await page.locator('button[data-tab=json]').click();
    await expect(page.locator('#tab-json')).toContainText('"subject": "Tabs"');
    await page.locator('button[data-tab=links]').click();
    const link = page.locator('#tab-links a');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', 'https://example.com/verify?x=1&y=2');
  });

  test('download button saves a file with the right hash', async ({ page, request }) => {
    const inbox = `ui-${crypto.randomUUID().slice(0, 8)}`;
    const to = `${inbox}@${STAGING}`;
    const bytes = await makePdf(`e2e ${inbox}`);
    await deliverMail(
      request,
      buildMail({
        to,
        subject: 'Download',
        attachments: [{ filename: 'receipt.pdf', contentType: 'application/pdf', bytes }],
      }),
      'orders@sender.example',
      to,
    );
    await page.goto(inboxPage(inbox));
    await page.locator('#rows tr[data-id] a').first().click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('receipt.pdf');
    const saved = await readFile(await download.path());
    expect(createHash('sha256').update(saved).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
});
