export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ALLOWED_DOMAINS: string;
  API_HOST: string;
  UI_HOST: string;
  UI_ORIGIN: string;
  RETENTION_HOURS: string;
  STATS_RETENTION_DAYS: string;
  MAX_MESSAGE_BYTES: string;
  MAX_ATTACHMENTS: string;
  MAX_ATTACHMENT_BYTES: string;
  MAX_BODY_BYTES: string;
  UI_AUTH_MODE: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  API_TOKENS: string;
}
