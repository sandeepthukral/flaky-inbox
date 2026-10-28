import { expect, test, type APIRequestContext } from '@playwright/test';
import { buildMail } from '../test/mail-builder';
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
