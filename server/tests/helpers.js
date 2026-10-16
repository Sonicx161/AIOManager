import Fastify from 'fastify'
import db from '../db.js'
import { initializeEncryptionKeys } from '../keys.js'
import { encrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { globalHealthCache, healthCheckInFlight, authCache, proxyQueue, domainLastRequestTime } from '../state.js'

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT,
  password TEXT,
  updated_at BIGINT,
  content_hash TEXT,
  content_hint TEXT,
  credential_epoch INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS kv_store_history (
  key TEXT,
  value TEXT,
  password TEXT,
  updated_at BIGINT,
  content_hash TEXT,
  archived_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_kv_store_history_key ON kv_store_history (key, archived_at DESC);

CREATE TABLE IF NOT EXISTS autopilot_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  connection_id TEXT,
  auth_key TEXT,
  priority_chain TEXT,
  addon_list TEXT,
  active_url TEXT,
  webhook_url TEXT,
  stabilization TEXT,
  is_active INTEGER DEFAULT 1,
  is_automatic INTEGER DEFAULT 1,
  last_check BIGINT,
  last_notification BIGINT,
  updated_at BIGINT,
  name TEXT,
  cooldown_ms INTEGER,
  message_template TEXT,
  owner_sync_user TEXT,
  custom_check_urls TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS failover_history (
  id TEXT PRIMARY KEY,
  timestamp BIGINT,
  type TEXT,
  rule_id TEXT,
  account_id TEXT,
  primary_name TEXT,
  backup_name TEXT,
  message TEXT,
  metadata TEXT,
  latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_account_ts ON failover_history (account_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_rules_account ON autopilot_rules (account_id);
CREATE INDEX IF NOT EXISTS idx_rules_active_check ON autopilot_rules (is_active, last_check, id);
CREATE INDEX IF NOT EXISTS idx_rules_active_id ON autopilot_rules (is_active, id);
CREATE INDEX IF NOT EXISTS idx_rules_worker_scan ON autopilot_rules (is_active, is_automatic, id);

CREATE TABLE IF NOT EXISTS autopilot_rule_stats (
  rule_id TEXT PRIMARY KEY,
  stabilization TEXT,
  last_check BIGINT,
  last_notification BIGINT,
  updated_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rule_stats_last_check ON autopilot_rule_stats (last_check);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  sync_user TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT,
  item_id TEXT NOT NULL DEFAULT '',
  unique_item_id TEXT,
  item_name TEXT,
  item_type TEXT,
  poster TEXT,
  season INTEGER,
  episode INTEGER,
  video_id TEXT,
  event_type TEXT NOT NULL DEFAULT '',
  event_ts BIGINT NOT NULL DEFAULT 0,
  duration BIGINT,
  progress REAL,
  watched INTEGER,
  times_watched INTEGER,
  is_in_progress INTEGER,
  overall_time_watched BIGINT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_events_user_ts ON activity_events (sync_user, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_account_ts ON activity_events (account_id, event_ts DESC);

CREATE TABLE IF NOT EXISTS activity_snapshots (
  sync_user TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  item_id TEXT NOT NULL DEFAULT '',
  unique_item_id TEXT,
  item_name TEXT,
  item_type TEXT,
  poster TEXT,
  season INTEGER,
  episode INTEGER,
  video_id TEXT,
  duration BIGINT,
  progress REAL,
  watched INTEGER,
  times_watched INTEGER,
  is_in_progress INTEGER,
  overall_time_watched BIGINT,
  mtime BIGINT,
  PRIMARY KEY (sync_user, account_id, item_id)
);

CREATE TABLE IF NOT EXISTS account_api_keys (
  account_id TEXT NOT NULL,
  sync_user TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0,
  last_used_at BIGINT
);

CREATE TABLE IF NOT EXISTS server_credentials (
  id TEXT PRIMARY KEY,
  sync_user TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT,
  auth_key TEXT,
  connection_id TEXT,
  credential_type TEXT DEFAULT 'stremio',
  updated_at BIGINT
);

CREATE TABLE IF NOT EXISTS account_canonical_addons (
  account_id TEXT PRIMARY KEY,
  sync_user TEXT NOT NULL DEFAULT '',
  addon_list TEXT,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS hydra_subscribers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sync_user TEXT NOT NULL,
  name TEXT,
  logo TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT
);

CREATE TABLE IF NOT EXISTS hydra_push_senders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sync_user TEXT NOT NULL,
  name TEXT,
  logo TEXT,
  created_at BIGINT NOT NULL,
  last_push_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_hydra_push_senders_account ON hydra_push_senders (account_id, sync_user);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  account_uuid TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('idb', 'prf')),
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  credential_epoch INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_credentials_account_device ON device_credentials (account_uuid, device_id);
CREATE INDEX IF NOT EXISTS idx_device_credentials_account ON device_credentials (account_uuid);
`

export async function setupTestEnv() {
    if (db.client) {
        db.client.close()
        db.client = null
    }
    db.type = 'sqlite'
    db.pool = null
    db.isHealthy = false
    process.env.SQLITE_DB_PATH = ':memory:'
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32bytes-long!!'

    await db.init()
    await db.exec(CORE_SCHEMA)

    const app = Fastify({ logger: false })
    await initializeEncryptionKeys(app)
    return app
}

export function cleanupTestEnv() {
    if (db.client) {
        db.client.close()
        db.client = null
    }
    db.type = 'sqlite'
    db.pool = null
    db.isHealthy = false
    globalHealthCache.clear()
    healthCheckInFlight.clear()
    authCache.clear()
    proxyQueue.length = 0
    domainLastRequestTime.clear()
}

export function mockFetch(handler) {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null
        const call = { url: String(url), options, body }
        calls.push(call)
        const result = await handler(call, calls.length)
        if (result instanceof Response) return result
        return new Response(JSON.stringify(result.body ?? result), {
            status: result.status ?? 200,
            headers: { 'content-type': 'application/json', ...(result.headers || {}) },
        })
    }
    return {
        calls,
        restore: () => { globalThis.fetch = originalFetch }
    }
}

export function encryptForTest(text) {
    return encrypt(text, FALLBACK_KEYS[0])
}
