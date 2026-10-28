import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_HOST: '127.0.0.1:8787',
            UI_HOST: 'localhost:8787',
            UI_ORIGIN: 'http://localhost:8787',
            ALLOWED_DOMAINS: 'staging.test.example,prod.test.example',
            UI_AUTH_MODE: 'dev',
            API_TOKENS: JSON.stringify({
              'staging.test.example': ['stage-token-a', 'stage-token-b'],
              'prod.test.example': ['prod-token'],
            }),
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
