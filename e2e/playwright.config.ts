import { defineConfig } from '@playwright/test';

// One shell command: make .dev.vars (gitignored) from the example when missing, reset the local
// D1/R2 state, apply migrations, then serve. MAX_MESSAGE_BYTES is low so the oversize test is cheap;
// every other test's mail stays well under it.
const PERSIST = '.wrangler/e2e';
const command = [
  'cp -n .dev.vars.example .dev.vars',
  `rm -rf ${PERSIST}`,
  `pnpm exec wrangler d1 migrations apply flaky-inbox --local --persist-to ${PERSIST}`,
  `exec pnpm exec wrangler dev --port 8787 --persist-to ${PERSIST} --var MAX_MESSAGE_BYTES:200000`,
].join(' ; ');

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:8787' },
  webServer: {
    command,
    cwd: '..',
    // Unauthenticated, so it answers 401: Playwright counts that as "server is up".
    url: 'http://127.0.0.1:8787/api/v2/domains/staging.test.example/inboxes/ping',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
