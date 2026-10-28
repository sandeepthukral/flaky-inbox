import type { Env } from './env';

export type Config = {
  allowedDomains: string[];
  apiHost: string;
  uiHost: string;
  uiOrigin: string;
  retentionMs: number;
  statsRetentionDays: number;
  maxMessageBytes: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxBodyBytes: number;
  uiAuthMode: 'access' | 'dev';
  accessTeamDomain?: string;
  accessAud?: string;
  apiTokens: Record<string, string[]>;
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Minimal parse; Task 6 replaces this with parseApiTokens (validation, max two per domain).
function parseTokens(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, string[]>;
}

// Cheap on purpose: called per request/event, never cached at module level.
export function parseConfig(env: Env): Config {
  return {
    allowedDomains: (env.ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    apiHost: env.API_HOST,
    uiHost: env.UI_HOST,
    uiOrigin: env.UI_ORIGIN,
    retentionMs: num(env.RETENTION_HOURS, 72) * 3_600_000,
    statsRetentionDays: num(env.STATS_RETENTION_DAYS, 90),
    maxMessageBytes: num(env.MAX_MESSAGE_BYTES, 10_485_760),
    maxAttachments: num(env.MAX_ATTACHMENTS, 10),
    maxAttachmentBytes: num(env.MAX_ATTACHMENT_BYTES, 5_242_880),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 1_048_576),
    uiAuthMode: env.UI_AUTH_MODE === 'dev' ? 'dev' : 'access',
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
    accessAud: env.ACCESS_AUD,
    apiTokens: parseTokens(env.API_TOKENS),
  };
}
