-- Migration 005: Dashboard settings store (ADMIN_ENABLED)
-- Target: instance settings changed from the Dashboard Settings screen
--
-- The functional, dialect-safe creation path is ensureTable(...) over ADMIN_TABLES in
-- server/admin/schema.js, called from server/database/setup.js (idempotent, sqlite + postgres,
-- skipped on READ_ONLY_REPLICA). This file documents the same DDL for DBAs running migrations
-- by hand; it uses only syntax valid in BOTH sqlite and postgres.
--
-- Owner-less: one row per instance setting, never per user, written only by an audited
-- Dashboard save. Precedence at boot is environment > this table > built-in default; keys
-- needed to open the database or that guard the Dashboard are never read from here.
-- Secret values (is_secret = 1) are encrypted with the server key and never returned by the API.
CREATE TABLE IF NOT EXISTS instance_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  updated_by_admin TEXT
);
