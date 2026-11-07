-- Migration 004: Deleted-account guard for Autopilot rule and credential writes
--
-- The functional creation path is ensureTable('account_server_tombstones', ...) in
-- server/database/setup.js. DELETE /api/accounts/:accountId/server-state records a row;
-- rule and credential writes for that owner and account are refused until
-- DELETE /api/accounts/:accountId/server-tombstone lifts it.

CREATE TABLE IF NOT EXISTS account_server_tombstones (
  sync_user TEXT NOT NULL,
  account_id TEXT NOT NULL,
  deleted_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (sync_user, account_id)
);
