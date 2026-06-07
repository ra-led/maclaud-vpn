CREATE TABLE IF NOT EXISTS yookassa_payments (
  id BIGSERIAL PRIMARY KEY,
  yookassa_payment_id TEXT NOT NULL UNIQUE,
  user_id TEXT NULL,
  order_id TEXT NULL,
  plan_name TEXT NULL,
  amount_value NUMERIC(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL,
  description TEXT NULL,
  idempotence_key TEXT NULL,
  confirmation_url TEXT NULL,
  yookassa_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at TIMESTAMPTZ NULL,
  canceled_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE yookassa_payments
  ALTER COLUMN idempotence_key DROP NOT NULL;

DROP INDEX IF EXISTS ux_yookassa_payments_idempotence_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_yookassa_payments_idempotence_key
  ON yookassa_payments (idempotence_key)
  WHERE idempotence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_yookassa_payments_order_id
  ON yookassa_payments (order_id);

CREATE INDEX IF NOT EXISTS ix_yookassa_payments_status
  ON yookassa_payments (status);

CREATE TABLE IF NOT EXISTS yookassa_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_fingerprint TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payment_id TEXT NULL,
  payload JSONB NOT NULL,
  ip_address TEXT NULL,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_yookassa_webhook_events_payment_id
  ON yookassa_webhook_events (payment_id);

CREATE TABLE IF NOT EXISTS passkey_accounts (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Пользователь VPN-GO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES passkey_accounts(user_id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS ix_passkey_credentials_user_id
  ON passkey_credentials (user_id);

CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge_id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS ix_passkey_challenges_expires_at
  ON passkey_challenges (expires_at);

CREATE TABLE IF NOT EXISTS password_accounts (
  login TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES passkey_accounts(user_id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS ix_password_accounts_user_id
  ON password_accounts (user_id);

CREATE TABLE IF NOT EXISTS referral_activations (
  id BIGSERIAL PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  invited_user_id TEXT NOT NULL UNIQUE,
  bonus_kopecks INTEGER NOT NULL DEFAULT 1000,
  status TEXT NOT NULL DEFAULT 'pending',
  error_text TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  awarded_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS ix_referral_activations_referrer_user_id
  ON referral_activations (referrer_user_id);
