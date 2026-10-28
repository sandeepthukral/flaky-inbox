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

test.describe('inbox v2', () => {
  test('changing the domain loads that domain at once', async ({ page, request }) => {
    const inbox = `ui-${crypto.randomUUID().slice(0, 8)}`;
    const to = `${inbox}@prod.test.example`;
    await deliverMail(request, buildMail({ to, subject: 'Prod only' }), 'orders@sender.example', to);
    await page.goto(`${UI}/?domain=${STAGING}`);
    await page.locator('#domain').selectOption('prod.test.example');
    await expect(page).toHaveURL(/domain=prod\.test\.example/);
    await expect(page.locator('#rows tr', { hasText: 'Prod only' })).toHaveCount(1);
  });

  test('rows per page reloads with the new size', async ({ page }) => {
    await page.goto(`${UI}/?domain=${STAGING}`);
    await expect(page.locator('#size')).toHaveValue('25');
    await page.locator('#size').selectOption('100');
    await expect(page).toHaveURL(/size=100/);
    await expect(page.locator('#size')).toHaveValue('100');
  });

  test('typing in the filter applies it after a pause', async ({ page, request }) => {
    const prefix = `ui-${crypto.randomUUID().slice(0, 8)}`;
    await send(request, `${prefix}-a`, 'Filtered');
    await page.goto(`${UI}/?domain=${STAGING}`);
    await page.locator('#inbox-filter').fill(prefix);
    await expect(page).toHaveURL(new RegExp(`inbox=${prefix}`));
    await expect(page.locator('#rows tr[data-id]')).toHaveCount(1);
  });

  test('selection bar shows the count and Clear unticks', async ({ page, request }) => {
    const prefix = `ui-${crypto.randomUUID().slice(0, 8)}`;
    await send(request, `${prefix}-a`, 'Pick me');
    await page.goto(inboxPage(prefix));
    await expect(page.locator('#selbar')).toBeHidden();
    await page.locator('#rows tr[data-id] input[name=ids]').check();
    await expect(page.locator('#selbar')).toBeVisible();
    await expect(page.locator('#selcount')).toHaveText('1 selected');
    await page.locator('#clear-btn').click();
    await expect(page.locator('#selbar')).toBeHidden();
    await expect(page.locator('#rows tr[data-id] input[name=ids]')).not.toBeChecked();
  });

  test('clicking a row outside the links opens the mail', async ({ page, request }) => {
    const prefix = `ui-${crypto.randomUUID().slice(0, 8)}`;
    await send(request, `${prefix}-a`, 'Row click');
    await page.goto(inboxPage(prefix));
    await page.locator('#rows tr[data-id] td.age').click();
    await expect(page).toHaveURL(/\/m\//);
    await expect(page.locator('h1')).toHaveText('Row click');
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

test.describe('statistics page', () => {
  test('shows Stored >= 1 after delivering a mail', async ({ page, request }) => {
    await send(request, `ui-${crypto.randomUUID().slice(0, 8)}`, 'Stats');
    await page.goto(`${UI}/stats?domain=${STAGING}`);
    await expect(page.getByRole('columnheader', { name: 'Stored' })).toBeVisible();
    const stored = Number(await page.locator('#stats tbody tr[data-day] td').nth(1).innerText());
    expect(stored).toBeGreaterThanOrEqual(1);
  });
});
