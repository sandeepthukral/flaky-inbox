import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { utcDay } from '../src/time';

const UI = 'http://localhost:8787';
const STAGING = 'staging.test.example';
const PROD = 'prod.test.example';
const DAY_MS = 86_400_000;

const today = utcDay(Date.now());
const yesterday = utcDay(Date.now() - DAY_MS);

async function seed(rows: Array<[string, string, string, number]>) {
  await env.DB.batch(
    rows.map(([day, domain, metric, count]) =>
      env.DB.prepare('INSERT INTO daily_stats (day, domain, metric, count) VALUES (?, ?, ?, ?)').bind(
        day,
        domain,
        metric,
        count,
      ),
    ),
  );
}

// Data cells of the body row for a day, in column order.
function rowCells(html: string, day: string): number[] {
  const row = html.match(new RegExp(`<tr[^>]*data-day="${day}"[^>]*>(.*?)</tr>`, 's'));
  if (!row) throw new Error(`no row for ${day}`);
  return [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].slice(1).map((m) => Number(m[1]));
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM daily_stats').run();
  await seed([
    [today, STAGING, 'incoming', 3],
    [today, STAGING, 'accessed_ui', 2],
    [today, PROD, 'incoming', 4],
    [today, PROD, 'api_error', 1],
    [today, '_other', 'api_error', 5],
    [yesterday, STAGING, 'rejected', 7],
    [yesterday, PROD, 'api_inbox', 6],
  ]);
});

describe('stats page', () => {
  it('domain=all sums both domains and _other', async () => {
    const html = await (await SELF.fetch(`${UI}/stats?domain=all`)).text();
    // Stored, Rejected, API, UI, Inbox, Message, Attachment, Errors
    expect(rowCells(html, today)).toEqual([7, 0, 0, 2, 0, 0, 0, 6]);
    expect(rowCells(html, yesterday)).toEqual([0, 7, 0, 0, 6, 0, 0, 0]);
  });

  it('defaults to all', async () => {
    const html = await (await SELF.fetch(`${UI}/stats`)).text();
    expect(rowCells(html, today)).toEqual([7, 0, 0, 2, 0, 0, 0, 6]);
  });

  it('domain filter shows one domain and leaves out _other', async () => {
    const html = await (await SELF.fetch(`${UI}/stats?domain=${STAGING}`)).text();
    expect(rowCells(html, today)).toEqual([3, 0, 0, 2, 0, 0, 0, 0]);
    expect(rowCells(html, yesterday)).toEqual([0, 7, 0, 0, 0, 0, 0, 0]);
  });

  it('unknown domain is treated as all and not reflected', async () => {
    const res = await SELF.fetch(`${UI}/stats?domain=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)');
    expect(rowCells(html, today)).toEqual([7, 0, 0, 2, 0, 0, 0, 6]);
  });

  it('rows are newest first', async () => {
    const html = await (await SELF.fetch(`${UI}/stats`)).text();
    const days = [...html.matchAll(/<tr[^>]*data-day="([^"]+)"/g)].map((m) => m[1]);
    expect(days).toEqual([today, yesterday]);
  });

  it('columns are in the order Date, incoming, accessed, API calls', async () => {
    const html = await (await SELF.fetch(`${UI}/stats`)).text();
    const head = html.match(/<thead>(.*?)<\/thead>/s)![1];
    const texts = [...head.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((m) => m[1].trim());
    expect(texts).toEqual([
      'Date',
      'Emails incoming',
      'Emails accessed',
      'API calls',
      'Stored',
      'Rejected',
      'API',
      'UI',
      'Inbox',
      'Message',
      'Attachment',
      'Errors',
    ]);
  });

  it('dropdown lists allowed domains plus All', async () => {
    const html = await (await SELF.fetch(`${UI}/stats?domain=${PROD}`)).text();
    const options = [...html.matchAll(/<option value="([^"]+)"( selected)?/g)].map((m) => [m[1], !!m[2]]);
    expect(options).toEqual([
      ['all', false],
      [STAGING, false],
      [PROD, true],
    ]);
  });
});
