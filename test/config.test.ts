import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import type { Env } from '../src/env';

const baseEnv = {
  ALLOWED_DOMAINS: 'staging.test.example',
  API_HOST: '127.0.0.1:8787',
  UI_HOST: 'localhost:8787',
  UI_ORIGIN: 'http://localhost:8787',
  UI_AUTH_MODE: 'dev',
  API_TOKENS: '{"staging.test.example":["a"]}',
};

describe('parseConfig', () => {
  it('parses defaults and lowercases domains', () => {
    const cfg = parseConfig({
      ...baseEnv,
      ALLOWED_DOMAINS: ' Staging.Test.Example ,prod.test.example',
      RETENTION_HOURS: '',
    } as Env);
    expect(cfg.allowedDomains).toEqual(['staging.test.example', 'prod.test.example']);
    expect(cfg.retentionMs).toBe(72 * 3_600_000);
    expect(cfg.maxAttachmentBytes).toBe(5_242_880);
    expect(cfg.statsRetentionDays).toBe(90);
    expect(cfg.maxMessageBytes).toBe(10_485_760);
    expect(cfg.maxAttachments).toBe(10);
    expect(cfg.maxBodyBytes).toBe(1_048_576);
  });

  it('fails closed on unknown auth mode', () => {
    expect(parseConfig({ ...baseEnv, UI_AUTH_MODE: 'DEV ' } as Env).uiAuthMode).toBe('access');
    expect(parseConfig({ ...baseEnv, UI_AUTH_MODE: undefined } as unknown as Env).uiAuthMode).toBe(
      'access',
    );
    expect(parseConfig({ ...baseEnv, UI_AUTH_MODE: 'dev' } as Env).uiAuthMode).toBe('dev');
  });

  it('parses explicit numbers and api tokens', () => {
    const cfg = parseConfig({ ...baseEnv, RETENTION_HOURS: '1', MAX_ATTACHMENTS: '2' } as Env);
    expect(cfg.retentionMs).toBe(3_600_000);
    expect(cfg.maxAttachments).toBe(2);
    expect(cfg.apiTokens).toEqual({ 'staging.test.example': ['a'] });
  });
});
