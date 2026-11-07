// Dashboard tables. Keep in sync with database/migrations/006_admin.sql and
// 005_instance_settings.sql. All rows are written only by Dashboard actions (setup, sign-in,
// audit, settings saves), never per Autopilot cycle. Exceptions: account_admin_state and
// account_notices rows change only through audited admin mutations, and account_notices.seen_at
// is the one non-admin write (the user's own read stamp, primary only). Sign-in locks are in
// memory only and have no table.
export const ADMIN_TABLES = [
    {
        name: 'admin_credentials',
        ddl: `CREATE TABLE IF NOT EXISTS admin_credentials (
            id TEXT PRIMARY KEY,
            username TEXT,
            secret_hash TEXT NOT NULL,
            created_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL DEFAULT 0
        );`,
        indexes: [],
        columns: ['id', 'username', 'secret_hash', 'created_at', 'updated_at'],
        pk: ['id'],
        addColumns: { username: 'ALTER TABLE admin_credentials ADD COLUMN username TEXT' },
    },
    {
        name: 'admin_sessions',
        ddl: `CREATE TABLE IF NOT EXISTS admin_sessions (
            id_hash TEXT PRIMARY KEY,
            created_at BIGINT NOT NULL,
            last_seen_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            ip_prefix TEXT,
            ua_hash TEXT,
            ua_family TEXT,
            remembered INTEGER NOT NULL DEFAULT 0
        );`,
        indexes: ['CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at)'],
        columns: ['id_hash', 'created_at', 'last_seen_at', 'expires_at', 'ip_prefix', 'ua_hash', 'ua_family', 'remembered'],
        pk: ['id_hash'],
        addColumns: { remembered: 'ALTER TABLE admin_sessions ADD COLUMN remembered INTEGER NOT NULL DEFAULT 0' },
    },
    {
        name: 'admin_audit',
        ddl: `CREATE TABLE IF NOT EXISTS admin_audit (
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
        );`,
        indexes: ['CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit (ts)'],
        columns: ['seq', 'ts', 'event', 'actor', 'ip_prefix', 'ua_hash', 'result', 'details', 'prev_hash', 'row_hash'],
        pk: ['seq'],
    },
    {
        name: 'instance_settings',
        ddl: `CREATE TABLE IF NOT EXISTS instance_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL,
            is_secret INTEGER NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            updated_by_admin TEXT
        );`,
        indexes: [],
        columns: ['setting_key', 'setting_value', 'is_secret', 'updated_at', 'updated_by_admin'],
        pk: ['setting_key'],
    },
    // Operator account state (disable/soft delete). deleted_at outranks disabled_at in
    // enforcement; a prior disable is preserved across a soft delete so restore returns
    // the account to disabled. The typed reason lives only in the audit row, never here.
    // signed_out_at is the idempotency marker for Sign out devices: the audit feed is
    // handle-keyed and account_notices is capped, so neither can anchor a repeat check.
    {
        name: 'account_admin_state',
        ddl: `CREATE TABLE IF NOT EXISTS account_admin_state (
            sync_user TEXT PRIMARY KEY,
            disabled_at BIGINT,
            deleted_at BIGINT,
            restore_until BIGINT,
            updated_at BIGINT NOT NULL,
            signed_out_at BIGINT
        );`,
        indexes: ['CREATE INDEX IF NOT EXISTS idx_account_admin_state_deleted ON account_admin_state (deleted_at)'],
        columns: ['sync_user', 'disabled_at', 'deleted_at', 'restore_until', 'updated_at'],
        pk: ['sync_user'],
        addColumns: { signed_out_at: 'ALTER TABLE account_admin_state ADD COLUMN signed_out_at BIGINT' },
    },
    // Fixed-template user notices; seen_at is stamped by the user's own read on the primary.
    {
        name: 'account_notices',
        ddl: `CREATE TABLE IF NOT EXISTS account_notices (
            id TEXT PRIMARY KEY,
            sync_user TEXT NOT NULL,
            notice_key TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            seen_at BIGINT
        );`,
        indexes: ['CREATE INDEX IF NOT EXISTS idx_account_notices_user ON account_notices (sync_user, created_at)'],
        columns: ['id', 'sync_user', 'notice_key', 'created_at', 'seen_at'],
        pk: ['id'],
    },
]

export async function ensureAdminSchema(db) {
    for (const table of ADMIN_TABLES) {
        await db.exec(table.ddl)
        for (const idx of table.indexes) await db.run(idx)
    }
}
