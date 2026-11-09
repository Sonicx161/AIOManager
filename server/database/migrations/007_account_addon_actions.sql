-- Migration 007: per-account addon action identity; the functional creation path is ensureTable in server/database/setup.js.
-- url_key is a keyed hash of the client-normalized key; install_transport_url is encrypted at rest.

CREATE TABLE IF NOT EXISTS account_addon_actions (
  sync_user TEXT NOT NULL,
  account_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  install_transport_url TEXT NOT NULL DEFAULT '',
  last_install_at BIGINT,
  last_delete_at BIGINT,
  install_seq INTEGER NOT NULL DEFAULT 0,
  delete_seq INTEGER NOT NULL DEFAULT 0,
  delete_token TEXT,
  PRIMARY KEY (sync_user, account_id, url_key)
);
