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

// Fails closed: any problem means no tokens (every API call 401s) instead of a thrown 500.
export function parseApiTokens(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('not an object');
    const out: Record<string, string[]> = {};
    for (const [domain, list] of Object.entries(data)) {
      if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) {
        throw new Error(`tokens for ${domain} must be an array of strings`);
      }
      out[domain.trim().toLowerCase()] = (list as string[]).filter((t) => t !== '').slice(0, 2);
    }
    return out;
  } catch (err) {
    console.error('API_TOKENS is invalid; API access is disabled', err);
    return {};
  }
}

// Cheap on purpose: called per request/event, never cached at module level.
export function parseConfig(env: Env): Config {
  return {
    allowedDomains: (env.ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    apiHost: (env.API_HOST ?? '').trim().toLowerCase(),
    uiHost: (env.UI_HOST ?? '').trim().toLowerCase(),
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
    apiTokens: parseApiTokens(env.API_TOKENS),
  };
}
