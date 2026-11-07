-- Migration 004: instance Dashboard (ADMIN_ENABLED)
-- Target: Dashboard credential, sessions and hash-chained audit log
--
-- The functional, dialect-safe creation path is ensureTable(...) over ADMIN_TABLES in
-- server/admin/schema.js, called from server/database/setup.js (idempotent, sqlite + postgres,
-- skipped on READ_ONLY_REPLICA). This file documents the same DDL for DBAs running migrations
-- by hand; it uses only syntax valid in BOTH sqlite and postgres.
--
-- None of these tables hold user data. Every row is written by a Dashboard action
-- (setup, sign-in, sign-out, audited action), never per Autopilot cycle. Exceptions:
-- account_admin_state and account_notices rows change only through audited admin
-- mutations (never per Autopilot cycle), and account_notices.seen_at is the one
-- non-admin write (the user's own read stamp, primary only). Sign-in lockouts are
-- kept in memory only, so a restart clears them; there is no lock table.

-- username is stored normalized (NFKC, trimmed, lower case). A row without one, from before
-- usernames existed, signs in as 'admin'. Older tables: ALTER TABLE admin_credentials ADD COLUMN username TEXT;
CREATE TABLE IF NOT EXISTS admin_credentials (
  id TEXT PRIMARY KEY,
  username TEXT,
  secret_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

-- id_hash is sha256 of the opaque session id; the id itself is never stored.
-- remembered = 1 marks a "Remember this browser" session: 30-day absolute, 7-day idle.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  ip_prefix TEXT,
  ua_hash TEXT,
  ua_family TEXT,
  remembered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- Append-only: row_hash = sha256(prev_hash || '|' || canonical row). Never UPDATE or DELETE.
CREATE TABLE IF NOT EXISTS admin_audit (
  seq BIGINT PRIMARY KEY,
  ts BIGINT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  ip_prefix TEXT,
  ua_hash TEXT,
  result TEXT NOT NULL,
  details TEXT,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit (ts);

-- Operator account state (disable / soft delete / restore). deleted_at outranks
-- disabled_at in enforcement; a prior disable is preserved across a soft delete so
-- restore returns the account to disabled. The typed reason lives only in the
-- admin_audit row, never here. signed_out_at anchors Sign out devices idempotency:
-- account_notices is capped and admin_audit is handle-keyed, so neither works.
CREATE TABLE IF NOT EXISTS account_admin_state (
  sync_user TEXT PRIMARY KEY,
  disabled_at BIGINT,
  deleted_at BIGINT,
  restore_until BIGINT,
  updated_at BIGINT NOT NULL,
  signed_out_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_account_admin_state_deleted ON account_admin_state (deleted_at);

-- Fixed-template user notices. id = sha256(sync_user | notice_key | actionTs), so an
-- audited action replayed after commit cannot double-notify. Cap 20 per user, oldest
-- pruned on insert; seen_at is stamped by the user's own read on the primary only.
CREATE TABLE IF NOT EXISTS account_notices (
  id TEXT PRIMARY KEY,
  sync_user TEXT NOT NULL,
  notice_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  seen_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_account_notices_user ON account_notices (sync_user, created_at);
