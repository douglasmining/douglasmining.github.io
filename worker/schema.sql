-- Encrypted newsletter list. The Worker never sees a plaintext address:
-- `ciphertext` is an armored PGP message the browser encrypted to the inbox key.
CREATE TABLE IF NOT EXISTS subscribers (
  id         TEXT PRIMARY KEY,
  ref        TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  size       INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',   -- active | unsubscribed
  ciphertext TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscribers_created ON subscribers (created_at);

-- Daily rate-limit counters (keyed by hashed IP or "all:<day>").
CREATE TABLE IF NOT EXISTS hits (
  k TEXT PRIMARY KEY,
  d TEXT NOT NULL,
  n INTEGER NOT NULL
);
