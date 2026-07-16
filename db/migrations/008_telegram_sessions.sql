CREATE TABLE IF NOT EXISTS telegram_sessions (
  telegram_user_id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS telegram_sessions_expires_at_idx
  ON telegram_sessions (expires_at);
