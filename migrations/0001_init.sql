CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  inbox TEXT NOT NULL,
  from_name TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  headers_json TEXT,
  text_body TEXT,
  html_body TEXT,
  skipped_attachments INTEGER NOT NULL DEFAULT 0,
  attachments_incomplete INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_inbox ON messages (domain, inbox, received_at DESC);
CREATE INDEX idx_domain_time ON messages (domain, received_at DESC);
CREATE INDEX idx_expires ON messages (expires_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  filename TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL
);
CREATE INDEX idx_att_message ON attachments (message_id);

CREATE TABLE daily_stats (
  day TEXT NOT NULL,
  domain TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, domain, metric)
);
