CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint_digest text NOT NULL UNIQUE,
  fingerprint_version text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_identities_user_idx ON browser_identities(user_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS qq_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bot_account_id text NOT NULL,
  qq_open_id text NOT NULL,
  bound_at timestamptz NOT NULL,
  UNIQUE(bot_account_id, qq_open_id)
);

CREATE TABLE IF NOT EXISTS identity_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('bind_qq', 'unbind_qq')),
  code_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  consumed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_challenges_user_idx ON identity_challenges(user_id, purpose);

CREATE TABLE IF NOT EXISTS qq_message_receipts (
  id uuid PRIMARY KEY,
  bot_account_id text NOT NULL,
  platform_message_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE(bot_account_id, platform_message_id)
);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  reason_code text,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_audit_events_user_idx ON identity_audit_events(user_id, created_at);
