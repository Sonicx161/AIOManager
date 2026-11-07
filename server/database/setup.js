import path from 'path'
import db from '../db.js'
import { DATA_DIR, isReadOnlyReplica } from '../config.js'
import { ADMIN_TABLES } from '../admin/schema.js'
import { registerTask } from '../lib/ops-metrics.js'
import { domainLastRequestTime, globalHealthCache, proxyQueue, serverState } from '../state.js'

export async function migrateKvStoreColumns(log = console) {
    const kvTableInfo = await db.query(`PRAGMA table_info(kv_store)`)
    const hasContentHash = kvTableInfo.some(col => col.name === 'content_hash')
    const hasContentHint = kvTableInfo.some(col => col.name === 'content_hint')
    if (!hasContentHash) {
        await db.run(`ALTER TABLE kv_store ADD COLUMN content_hash TEXT`)
        log.info({ category: 'Database' }, 'Migrated: Added content_hash column to kv_store')
    }
    if (!hasContentHint) {
        await db.run(`ALTER TABLE kv_store ADD COLUMN content_hint TEXT`)
        log.info({ category: 'Database' }, 'Migrated: Added content_hint column to kv_store')
    }
    const hasCredentialEpoch = kvTableInfo.some(col => col.name === 'credential_epoch')
    if (!hasCredentialEpoch) {
        await db.run(`ALTER TABLE kv_store ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 1`)
        log.info({ category: 'Database' }, 'Migrated: Added credential_epoch column to kv_store')
    }
}

export async function initializeDatabase(fastify) {
    const dbPath = path.join(DATA_DIR, 'aio.db')
    if (db.type === 'sqlite') {
        fastify.log.info({ category: 'Database' }, `Initializing SQLite at: ${dbPath}`)
        process.env.SQLITE_DB_PATH = dbPath
    } else {
        fastify.log.info({ category: 'Database' }, 'Initializing PostgreSQL...')
    }
    await db.init()

    if (db.type === 'sqlite') {
        await db.pragma('journal_mode = WAL')
        await db.pragma('synchronous = NORMAL')
        await db.pragma('temp_store = MEMORY')
        await db.pragma('cache_size = -32000')
        await db.pragma('auto_vacuum = INCREMENTAL')
        await db.pragma('busy_timeout = 5000')
        await db.pragma('mmap_size = 268435456')

        // Schedule VACUUM weekly instead of on every startup (prevents blocking request handling)
        const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
        let vacuumLastRunAt = null
        registerTask('sqlite-vacuum', { label: 'Weekly SQLite VACUUM', intervalMs: VACUUM_INTERVAL_MS, lastRunAt: () => vacuumLastRunAt })
        const scheduleVacuum = () => {
            setTimeout(async () => {
                try {
                    fastify.log.info({ category: 'Database' }, 'Running scheduled weekly VACUUM...')
                    vacuumLastRunAt = Date.now()
                    await db.exec('VACUUM')
                    fastify.log.info({ category: 'Database' }, 'VACUUM complete.')
                } catch (e) {
                    fastify.log.warn({ category: 'Database' }, `VACUUM failed: ${e.message}`)
                }
                scheduleVacuum()
            }, VACUUM_INTERVAL_MS)
        }
        scheduleVacuum()
    }

    if (isReadOnlyReplica()) {
        fastify.log.info({ category: 'Database' }, 'READ_ONLY_REPLICA mode: skipping schema and migrations (follower DB is read-only).')
        return dbPath
    }

    const schema = `
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        password TEXT,
        updated_at BIGINT,
        content_hash TEXT,
        content_hint TEXT,
        credential_epoch INTEGER NOT NULL DEFAULT 1
      );

      -- Previous sync blobs, captured on every overwrite. The server can't validate
      -- client-encrypted payloads (zero-knowledge), so a bad push overwrites the only
      -- readable copy; history keeps the last few versions restorable with just the
      -- account password (POST /api/sync/:id/restore).
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
        auth_key TEXT,
        priority_chain TEXT,
        addon_list TEXT,
        active_url TEXT,
        webhook_url TEXT,
        notify_enabled INTEGER,
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
        platform TEXT DEFAULT 'stremio',
        connection_id TEXT,
        connection_generation TEXT,
        custom_check_urls TEXT DEFAULT NULL,
        edited_at BIGINT
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
      CREATE INDEX IF NOT EXISTS idx_history_rule_ts ON failover_history (rule_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_rules_account ON autopilot_rules (account_id);

      CREATE TABLE IF NOT EXISTS autopilot_rule_stats (
        rule_id TEXT PRIMARY KEY,
        stabilization TEXT,
        last_check BIGINT,
        last_notification BIGINT,
        updated_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS idx_rule_stats_last_check ON autopilot_rule_stats (last_check);
    `

    await db.exec(schema)

    // New tables for v2.0 activity engine - created separately with migration guards
    // so a stale intermediate table from dev builds doesn't crash the entire exec()
    async function ensureTable(tableName, createDdl, indexDdls, requiredColumns, addColumnDdls, pkColumns = []) {
        try {
            let tableExists = false
            let missingColumns = []

            const columnsToCheck = addColumnDdls
                ? [...new Set([...requiredColumns, ...Object.keys(addColumnDdls)])]
                : requiredColumns

            if (db.type === 'sqlite') {
                const cols = await db.query(`PRAGMA table_info(${tableName})`)
                tableExists = cols.length > 0
                if (tableExists) {
                    const colNames = new Set(cols.map(c => c.name))
                    for (const rc of columnsToCheck) {
                        if (!colNames.has(rc)) missingColumns.push(rc)
                    }
                }
            } else {
                const rows = await db.query(
                    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'`,
                    [tableName]
                )
                tableExists = rows.length > 0
                if (tableExists) {
                    const colNames = new Set(rows.map(r => r.column_name))
                    for (const rc of columnsToCheck) {
                        if (!colNames.has(rc)) missingColumns.push(rc)
                    }
                }
            }

            if (tableExists && missingColumns.length > 0) {
                const missingPks = missingColumns.filter(c => pkColumns.includes(c))
                if (missingPks.length > 0) {
                    fastify.log.warn({ category: 'Database' }, `${tableName} missing primary-key columns [${missingPks.join(', ')}]. Dropping and recreating (stale schema, no recoverable data).`)
                    await db.run(`DROP TABLE IF EXISTS ${tableName}`)
                    tableExists = false
                    missingColumns = []
                }
            }

            if (tableExists && missingColumns.length > 0 && addColumnDdls) {
                const stillMissing = []
                for (const col of missingColumns) {
                    const ddl = addColumnDdls[col]
                    if (ddl) {
                        try {
                            await db.run(ddl)
                            fastify.log.info({ category: 'Database' }, `Migrated: Added ${col} column to ${tableName}`)
                        } catch (alterErr) {
                            fastify.log.warn({ category: 'Database' }, `ALTER TABLE ${tableName} ADD ${col} failed: ${alterErr.message}`)
                            stillMissing.push(col)
                        }
                    } else {
                        stillMissing.push(col)
                    }
                }
                if (stillMissing.length > 0) {
                    fastify.log.warn({ category: 'Database' }, `${tableName} still missing columns after migration: [${stillMissing.join(', ')}]. Runtime errors may occur.`)
                }
            } else if (tableExists && missingColumns.length > 0 && !addColumnDdls) {
                fastify.log.warn({ category: 'Database' }, `${tableName} missing columns [${missingColumns.join(', ')}] but no migration DDL provided. Skipping.`)
            }

            if (!tableExists) {
                await db.exec(createDdl)
            }

            // PG note: missing columns are already migrated above via the guarded
            // information_schema check; SQLite has no ADD COLUMN IF NOT EXISTS, so
            // no unconditional per-column ALTER pass is needed for either backend.

            for (const idx of indexDdls) {
                try {
                    await db.run(idx)
                } catch (e) {
                    fastify.log.warn({ category: 'Database' }, `${tableName} index setup failed: ${e.message}`)
                }
            }
        } catch (e) {
            fastify.log.warn({ category: 'Database' }, `${tableName} setup warning: ${e.message}`)
        }
    }

    await ensureTable('activity_events', `
      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        sync_user TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT,
        item_id TEXT NOT NULL,
        unique_item_id TEXT,
        item_name TEXT,
        item_type TEXT,
        poster TEXT,
        season INTEGER,
        episode INTEGER,
        video_id TEXT,
        event_type TEXT NOT NULL,
        event_ts BIGINT NOT NULL,
        duration BIGINT,
        progress REAL,
        watched INTEGER,
        times_watched INTEGER,
        is_in_progress INTEGER,
        overall_time_watched BIGINT,
        metadata TEXT,
        source TEXT NOT NULL DEFAULT 'stremio'
      );
    `, [
        `CREATE INDEX IF NOT EXISTS idx_activity_events_user_ts ON activity_events (sync_user, event_ts DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_events_account_ts ON activity_events (account_id, event_ts DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_events_type ON activity_events (sync_user, event_type, event_ts DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_events_user_account_ts ON activity_events (sync_user, account_id, event_ts DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_events_user_account_type_ts ON activity_events (sync_user, account_id, event_type, event_ts DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_activity_events_source ON activity_events (sync_user, source, event_ts DESC)`,
    ], ['id', 'sync_user', 'account_id', 'item_id', 'event_type', 'event_ts'], {
        sync_user: 'ALTER TABLE activity_events ADD COLUMN sync_user TEXT NOT NULL DEFAULT \'\'',
        account_id: 'ALTER TABLE activity_events ADD COLUMN account_id TEXT NOT NULL DEFAULT \'\'',
        item_id: 'ALTER TABLE activity_events ADD COLUMN item_id TEXT NOT NULL DEFAULT \'\'',
        event_type: 'ALTER TABLE activity_events ADD COLUMN event_type TEXT NOT NULL DEFAULT \'\'',
        event_ts: 'ALTER TABLE activity_events ADD COLUMN event_ts BIGINT NOT NULL DEFAULT 0',
        account_name: 'ALTER TABLE activity_events ADD COLUMN account_name TEXT',
        unique_item_id: 'ALTER TABLE activity_events ADD COLUMN unique_item_id TEXT',
        item_name: 'ALTER TABLE activity_events ADD COLUMN item_name TEXT',
        item_type: 'ALTER TABLE activity_events ADD COLUMN item_type TEXT',
        poster: 'ALTER TABLE activity_events ADD COLUMN poster TEXT',
        season: 'ALTER TABLE activity_events ADD COLUMN season INTEGER',
        episode: 'ALTER TABLE activity_events ADD COLUMN episode INTEGER',
        video_id: 'ALTER TABLE activity_events ADD COLUMN video_id TEXT',
        duration: 'ALTER TABLE activity_events ADD COLUMN duration BIGINT',
        progress: 'ALTER TABLE activity_events ADD COLUMN progress REAL',
        watched: 'ALTER TABLE activity_events ADD COLUMN watched INTEGER',
        times_watched: 'ALTER TABLE activity_events ADD COLUMN times_watched INTEGER',
        is_in_progress: 'ALTER TABLE activity_events ADD COLUMN is_in_progress INTEGER',
        overall_time_watched: 'ALTER TABLE activity_events ADD COLUMN overall_time_watched BIGINT',
        metadata: 'ALTER TABLE activity_events ADD COLUMN metadata TEXT',
        source: 'ALTER TABLE activity_events ADD COLUMN source TEXT NOT NULL DEFAULT \'stremio\'',
    }, ['id'])

    await ensureTable('activity_snapshots', `
      CREATE TABLE IF NOT EXISTS activity_snapshots (
        sync_user TEXT NOT NULL,
        account_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
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
        time_watched BIGINT,
        source TEXT NOT NULL DEFAULT 'stremio',
        PRIMARY KEY (sync_user, account_id, item_id)
      );
    `, [], ['sync_user', 'account_id', 'item_id', 'mtime'], {
        unique_item_id: 'ALTER TABLE activity_snapshots ADD COLUMN unique_item_id TEXT',
        item_name: 'ALTER TABLE activity_snapshots ADD COLUMN item_name TEXT',
        item_type: 'ALTER TABLE activity_snapshots ADD COLUMN item_type TEXT',
        poster: 'ALTER TABLE activity_snapshots ADD COLUMN poster TEXT',
        season: 'ALTER TABLE activity_snapshots ADD COLUMN season INTEGER',
        episode: 'ALTER TABLE activity_snapshots ADD COLUMN episode INTEGER',
        video_id: 'ALTER TABLE activity_snapshots ADD COLUMN video_id TEXT',
        duration: 'ALTER TABLE activity_snapshots ADD COLUMN duration BIGINT',
        progress: 'ALTER TABLE activity_snapshots ADD COLUMN progress REAL',
        watched: 'ALTER TABLE activity_snapshots ADD COLUMN watched INTEGER',
        times_watched: 'ALTER TABLE activity_snapshots ADD COLUMN times_watched INTEGER',
        is_in_progress: 'ALTER TABLE activity_snapshots ADD COLUMN is_in_progress INTEGER',
        overall_time_watched: 'ALTER TABLE activity_snapshots ADD COLUMN overall_time_watched BIGINT',
        mtime: 'ALTER TABLE activity_snapshots ADD COLUMN mtime BIGINT',
        time_watched: 'ALTER TABLE activity_snapshots ADD COLUMN time_watched BIGINT',
        source: 'ALTER TABLE activity_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT \'stremio\'',
    }, ['sync_user', 'account_id', 'item_id'])

    await ensureTable('server_credentials', `
      CREATE TABLE IF NOT EXISTS server_credentials (
        id TEXT PRIMARY KEY,
        sync_user TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_name TEXT,
        auth_key TEXT NOT NULL,
        updated_at BIGINT,
        connection_id TEXT,
        canonical_connection_id TEXT,
        credential_type TEXT DEFAULT 'stremio',
        connection_generation TEXT
      );
    `, [
        `CREATE INDEX IF NOT EXISTS idx_creds_sync_user ON server_credentials (sync_user)`,
        `CREATE INDEX IF NOT EXISTS idx_creds_account ON server_credentials (account_id)`,
        `CREATE INDEX IF NOT EXISTS idx_creds_type_updated ON server_credentials (credential_type, updated_at DESC, id ASC)`,
        `CREATE INDEX IF NOT EXISTS idx_creds_account_sync_type ON server_credentials (account_id, sync_user, credential_type, updated_at DESC)`,
    ], ['id', 'sync_user', 'account_id', 'auth_key'], {
        sync_user: 'ALTER TABLE server_credentials ADD COLUMN sync_user TEXT NOT NULL DEFAULT \'\'',
        account_id: 'ALTER TABLE server_credentials ADD COLUMN account_id TEXT NOT NULL DEFAULT \'\'',
        auth_key: 'ALTER TABLE server_credentials ADD COLUMN auth_key TEXT NOT NULL DEFAULT \'\'',
        account_name: 'ALTER TABLE server_credentials ADD COLUMN account_name TEXT',
        updated_at: 'ALTER TABLE server_credentials ADD COLUMN updated_at BIGINT',
        connection_id: 'ALTER TABLE server_credentials ADD COLUMN connection_id TEXT',
        canonical_connection_id: 'ALTER TABLE server_credentials ADD COLUMN canonical_connection_id TEXT',
        credential_type: 'ALTER TABLE server_credentials ADD COLUMN credential_type TEXT DEFAULT \'stremio\'',
        connection_generation: 'ALTER TABLE server_credentials ADD COLUMN connection_generation TEXT',
    }, ['id'])

    await ensureTable('account_api_keys', `
      CREATE TABLE IF NOT EXISTS account_api_keys (
        account_id TEXT NOT NULL,
        sync_user TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT,
        UNIQUE (sync_user, api_key_hash)
      );
    `, [
        `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON account_api_keys (api_key_hash)`,
        `CREATE INDEX IF NOT EXISTS idx_api_keys_sync_user ON account_api_keys (sync_user)`,
    ], ['account_id', 'sync_user', 'api_key_hash', 'created_at'], {
        api_key_hash: 'ALTER TABLE account_api_keys ADD COLUMN api_key_hash TEXT NOT NULL DEFAULT \'\'',
        created_at: 'ALTER TABLE account_api_keys ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0',
        last_used_at: 'ALTER TABLE account_api_keys ADD COLUMN last_used_at BIGINT',
    }, ['account_id', 'sync_user'])

    await ensureTable('account_canonical_addons', `
      CREATE TABLE IF NOT EXISTS account_canonical_addons (
        account_id TEXT PRIMARY KEY,
        sync_user TEXT NOT NULL,
        addon_list TEXT,
        updated_at BIGINT
      );
    `, [
        `CREATE INDEX IF NOT EXISTS idx_canonical_addons_sync_user ON account_canonical_addons (sync_user)`,
    ], ['account_id', 'sync_user'], {
        sync_user: 'ALTER TABLE account_canonical_addons ADD COLUMN sync_user TEXT NOT NULL DEFAULT \'\'',
        addon_list: 'ALTER TABLE account_canonical_addons ADD COLUMN addon_list TEXT',
        updated_at: 'ALTER TABLE account_canonical_addons ADD COLUMN updated_at BIGINT',
    }, ['account_id'])

    // Pull-mode Hydra apps (backendless, e.g. Fusion) register on connect so they surface as
    // connection cards with a last-seen time. AIOManager never pushes to them; they pull.
    await ensureTable('hydra_subscribers', `
      CREATE TABLE IF NOT EXISTS hydra_subscribers (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sync_user TEXT NOT NULL,
        name TEXT,
        logo TEXT,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT
      );
    `, [
        `CREATE INDEX IF NOT EXISTS idx_hydra_subs_account ON hydra_subscribers (account_id, sync_user)`,
    ], ['id', 'account_id', 'sync_user', 'created_at'], {
        name: 'ALTER TABLE hydra_subscribers ADD COLUMN name TEXT',
        logo: 'ALTER TABLE hydra_subscribers ADD COLUMN logo TEXT',
        last_seen_at: 'ALTER TABLE hydra_subscribers ADD COLUMN last_seen_at BIGINT',
    }, ['id'])

    const metadataKeysCreateDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS metadata_keys (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            key_format TEXT DEFAULT 'unknown',
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            UNIQUE(user_id, provider)
          );`
        : `CREATE TABLE IF NOT EXISTS metadata_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_key TEXT NOT NULL,
            key_format TEXT DEFAULT 'unknown',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, provider)
          );`

    await ensureTable('metadata_keys', metadataKeysCreateDdl, [
        `CREATE INDEX IF NOT EXISTS idx_metadata_keys_user ON metadata_keys (user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_metadata_keys_user_provider ON metadata_keys (user_id, provider)`,
    ], ['user_id', 'provider', 'encrypted_key', 'created_at', 'updated_at'], {
        user_id: `ALTER TABLE metadata_keys ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
        provider: `ALTER TABLE metadata_keys ADD COLUMN provider TEXT NOT NULL DEFAULT ''`,
        encrypted_key: `ALTER TABLE metadata_keys ADD COLUMN encrypted_key TEXT NOT NULL DEFAULT ''`,
        key_format: `ALTER TABLE metadata_keys ADD COLUMN key_format TEXT DEFAULT 'unknown'`,
        created_at: `ALTER TABLE metadata_keys ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0`,
        updated_at: `ALTER TABLE metadata_keys ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0`,
    }, [])

    const metadataCacheCreateDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS metadata_cache (
            key TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            expires_at BIGINT NOT NULL,
            created_at BIGINT NOT NULL
          );`
        : `CREATE TABLE IF NOT EXISTS metadata_cache (
            key TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );`

    await ensureTable('metadata_cache', metadataCacheCreateDdl, [
        `CREATE INDEX IF NOT EXISTS idx_metadata_cache_expires ON metadata_cache (expires_at)`,
    ], ['key', 'response', 'expires_at', 'created_at'], {
        key: `ALTER TABLE metadata_cache ADD COLUMN key TEXT NOT NULL DEFAULT ''`,
        response: `ALTER TABLE metadata_cache ADD COLUMN response TEXT NOT NULL DEFAULT ''`,
        expires_at: `ALTER TABLE metadata_cache ADD COLUMN expires_at BIGINT NOT NULL DEFAULT 0`,
        created_at: `ALTER TABLE metadata_cache ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0`,
    }, ['key'])

    const stremioCatalogCreateDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS stremio_catalog (
            user_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            poster TEXT,
            watchers INTEGER DEFAULT 1,
            last_watched BIGINT NOT NULL,
            created_at BIGINT NOT NULL,
            UNIQUE(user_id, item_id)
        );`
        : `CREATE TABLE IF NOT EXISTS stremio_catalog (
            user_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            poster TEXT,
            watchers INTEGER DEFAULT 1,
            last_watched INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(user_id, item_id)
        );`
    await ensureTable('stremio_catalog', stremioCatalogCreateDdl, [
        `CREATE INDEX IF NOT EXISTS idx_stremio_catalog_user ON stremio_catalog (user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_stremio_catalog_user_type ON stremio_catalog (user_id, type)`,
    ], ['user_id', 'item_id', 'type', 'name', 'poster', 'watchers', 'last_watched', 'created_at'], {
        user_id: `ALTER TABLE stremio_catalog ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
        item_id: `ALTER TABLE stremio_catalog ADD COLUMN item_id TEXT NOT NULL DEFAULT ''`,
        type: `ALTER TABLE stremio_catalog ADD COLUMN type TEXT NOT NULL DEFAULT 'movie'`,
        name: `ALTER TABLE stremio_catalog ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
        poster: `ALTER TABLE stremio_catalog ADD COLUMN poster TEXT`,
        watchers: `ALTER TABLE stremio_catalog ADD COLUMN watchers INTEGER DEFAULT 1`,
        last_watched: `ALTER TABLE stremio_catalog ADD COLUMN last_watched BIGINT NOT NULL DEFAULT 0`,
        created_at: `ALTER TABLE stremio_catalog ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0`,
    }, ['user_id', 'item_id'])

    const catalogConfigsDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS catalog_configs (
            id TEXT NOT NULL,
            sync_user TEXT NOT NULL,
            catalog_name TEXT NOT NULL,
            catalog_type TEXT NOT NULL DEFAULT 'movie',
            filters TEXT NOT NULL DEFAULT '{}',
            created_at BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (id, sync_user)
        );`
        : `CREATE TABLE IF NOT EXISTS catalog_configs (
            id TEXT NOT NULL,
            sync_user TEXT NOT NULL,
            catalog_name TEXT NOT NULL,
            catalog_type TEXT NOT NULL DEFAULT 'movie',
            filters TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, sync_user)
        );`
    await ensureTable('catalog_configs', catalogConfigsDdl, [
        `CREATE INDEX IF NOT EXISTS idx_catalog_configs_user ON catalog_configs (sync_user)`,
    ], ['id', 'sync_user', 'catalog_name', 'catalog_type', 'filters', 'created_at'], {
        id: `ALTER TABLE catalog_configs ADD COLUMN id TEXT NOT NULL DEFAULT ''`,
        sync_user: `ALTER TABLE catalog_configs ADD COLUMN sync_user TEXT NOT NULL DEFAULT ''`,
        catalog_name: `ALTER TABLE catalog_configs ADD COLUMN catalog_name TEXT NOT NULL DEFAULT ''`,
        catalog_type: `ALTER TABLE catalog_configs ADD COLUMN catalog_type TEXT NOT NULL DEFAULT 'movie'`,
        filters: `ALTER TABLE catalog_configs ADD COLUMN filters TEXT NOT NULL DEFAULT '{}'`,
        created_at: `ALTER TABLE catalog_configs ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0`,
    }, ['id', 'sync_user'])

    const watchlistDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS watchlist_items (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL DEFAULT 'movie',
            item_name TEXT,
            poster TEXT,
            added_at BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id, item_id)
        );`
        : `CREATE TABLE IF NOT EXISTS watchlist_items (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL DEFAULT 'movie',
            item_name TEXT,
            poster TEXT,
            added_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id, item_id)
        );`
    await ensureTable('watchlist_items', watchlistDdl, [
        `CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist_items (sync_user)`,
        `CREATE INDEX IF NOT EXISTS idx_watchlist_user_account ON watchlist_items (sync_user, account_id)`,
    ], ['sync_user', 'item_id', 'item_type', 'item_name', 'poster', 'added_at'], {
        sync_user: `ALTER TABLE watchlist_items ADD COLUMN sync_user TEXT NOT NULL DEFAULT ''`,
        account_id: `ALTER TABLE watchlist_items ADD COLUMN account_id TEXT NOT NULL DEFAULT '__household__'`,
        item_id: `ALTER TABLE watchlist_items ADD COLUMN item_id TEXT NOT NULL DEFAULT ''`,
        item_type: `ALTER TABLE watchlist_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'movie'`,
        item_name: `ALTER TABLE watchlist_items ADD COLUMN item_name TEXT`,
        poster: `ALTER TABLE watchlist_items ADD COLUMN poster TEXT`,
        added_at: `ALTER TABLE watchlist_items ADD COLUMN added_at BIGINT NOT NULL DEFAULT 0`,
    }, ['sync_user', 'account_id', 'item_id'])

    try {
        if (db.type === 'postgres') {
            // Legacy column migration. On current schemas every column below already
            // exists (the CREATE TABLE above includes them all), so check once per
            // table instead of issuing 14 no-op ALTER round trips on every boot.
            // The ALTERs keep IF NOT EXISTS so a concurrently booting replica of
            // this process cannot fail on the check-then-add gap; if the column
            // read itself fails we fall back to running every ALTER unguarded.
            const ruleColNames = await db.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name = 'autopilot_rules' AND table_schema = 'public'`
            ).then(rows => new Set(rows.map(r => r.column_name))).catch(() => null)
            const ruleColumnAdds = [
                ['is_active', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1`],
                ['last_check', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS last_check BIGINT`],
                ['addon_list', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS addon_list TEXT`],
                ['active_url', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS active_url TEXT`],
                ['webhook_url', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS webhook_url TEXT`],
                ['is_automatic', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS is_automatic INTEGER DEFAULT 1`],
                ['stabilization', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS stabilization TEXT`],
                ['last_notification', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS last_notification BIGINT`],
                ['name', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS name TEXT`],
                ['cooldown_ms', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS cooldown_ms INTEGER`],
                ['message_template', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS message_template TEXT`],
                ['owner_sync_user', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS owner_sync_user TEXT`],
                ['platform', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'stremio'`],
                ['connection_id', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS connection_id TEXT`],
                ['connection_generation', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS connection_generation TEXT`],
                ['custom_check_urls', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS custom_check_urls TEXT DEFAULT NULL`],
                ['notify_enabled', `ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS notify_enabled INTEGER`],
            ]
            for (const [ruleCol, ruleAddDdl] of ruleColumnAdds) {
                if (ruleColNames?.has(ruleCol)) continue
                try { await db.run(ruleAddDdl) } catch (e) { if (!String(e?.message).includes('already exists')) fastify.log.warn({ category: 'Database' }, `PG migration ${ruleCol}: ${e?.message}`) }
            }

            // edited_at is stamped only by user rule saves (the engine never writes it); existing
            // rows start from their last updated_at so current orphans age out from here.
            if (!ruleColNames?.has('edited_at')) {
                try {
                    await db.run(`ALTER TABLE autopilot_rules ADD COLUMN IF NOT EXISTS edited_at BIGINT`)
                    await db.run(`UPDATE autopilot_rules SET edited_at = updated_at WHERE edited_at IS NULL`)
                } catch (e) { fastify.log.warn({ category: 'Database' }, `PG migration edited_at: ${e.message}`) }
            }

            try {
                const platformBackfill = await db.run(`UPDATE autopilot_rules SET platform = 'stremio' WHERE platform IS NULL`)
                if (platformBackfill?.changes > 0) {
                    fastify.log.info({ category: 'Database' }, `Autopilot Rules: backfilled platform='stremio' for ${platformBackfill.changes} rows.`)
                }
            } catch (e) { fastify.log.warn({ category: 'Database' }, `PG migration platform backfill: ${e.message}`) }

            // Migration: Ensure columns are TEXT/VARCHAR for encrypted strings, not JSONB
            // We use try/catch to avoid aborting if the types are already correct
            // Using explicit casting (USING column::TEXT) ensures stability if columns were manually tweaked
            try { await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN priority_chain TYPE TEXT USING priority_chain::TEXT`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN addon_list TYPE TEXT USING addon_list::TEXT`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`ALTER TABLE autopilot_rules ALTER COLUMN stabilization TYPE TEXT USING stabilization::TEXT`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }

            // Same guarded check as autopilot_rules above: current schemas already
            // carry all three columns; only legacy databases pay the ALTER cost.
            const kvColNames = await db.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name = 'kv_store' AND table_schema = 'public'`
            ).then(rows => new Set(rows.map(r => r.column_name))).catch(() => null)
            const kvColumnAdds = [
                ['content_hash', `ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS content_hash TEXT`],
                ['content_hint', `ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS content_hint TEXT`],
                ['credential_epoch', `ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS credential_epoch INTEGER NOT NULL DEFAULT 1`],
            ]
            for (const [kvCol, kvAddDdl] of kvColumnAdds) {
                if (kvColNames?.has(kvCol)) continue
                try { await db.run(kvAddDdl) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            }

            // These indexes sit on migration-added columns (is_active, last_check,
            // is_automatic): creating them in the top schema exec crashed boot on
            // databases that predate the columns (#17). They are created here,
            // after the column adds, idempotently.
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_active_check ON autopilot_rules (is_active, last_check, id)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_active_id ON autopilot_rules (is_active, id)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_worker_scan ON autopilot_rules (is_active, is_automatic, id)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_owner ON autopilot_rules (owner_sync_user)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_platform ON autopilot_rules (platform)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try { await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_connection ON autopilot_rules (connection_id)`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }

            const fhColNames = await db.query(
                `SELECT column_name FROM information_schema.columns WHERE table_name = 'failover_history' AND table_schema = 'public'`
            ).then(rows => new Set(rows.map(r => r.column_name))).catch(() => null)
            if (!fhColNames?.has('latency_ms')) {
                try { await db.run(`ALTER TABLE failover_history ADD COLUMN IF NOT EXISTS latency_ms INTEGER`) } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            }

            try {
                const pruned = await db.run(`DELETE FROM account_api_keys a USING account_api_keys b WHERE a.sync_user = b.sync_user AND a.api_key_hash = b.api_key_hash AND a.ctid < b.ctid`)
                if (pruned?.changes > 0) fastify.log.warn({ category: 'Database' }, `account_api_keys: removed ${pruned.changes} duplicate row(s) before creating the unique index.`)
                await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_hash ON account_api_keys (sync_user, api_key_hash)`)
            } catch (e) {
                // The API-key push path hard-depends on this table's integrity; a silent
                // failure here means keys silently stop registering. Fail the boot.
                fastify.log.error({ category: 'Database' }, `Failed to create idx_api_keys_user_hash: ${e.message}`)
                throw e
            }

            fastify.log.info({ category: 'Database' }, 'Postgres Migration: Verified columns and types for encryption support.')
        } else {
            // SQLite doesn't have IF NOT EXISTS for columns, so we check first
            const tableInfo = await db.query(`PRAGMA table_info(autopilot_rules)`)
            const hasAddonList = tableInfo.some(col => col.name === 'addon_list')
            if (!hasAddonList) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN addon_list TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added addon_list column to autopilot_rules')
            }
            const hasIsAutomatic = tableInfo.some(col => col.name === 'is_automatic')
            if (!hasIsAutomatic) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN is_automatic INTEGER DEFAULT 1`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added is_automatic column to autopilot_rules')
            }
            const hasName = tableInfo.some(col => col.name === 'name')
            if (!hasName) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN name TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added name column to autopilot_rules')
            }
            const hasCooldownMs = tableInfo.some(col => col.name === 'cooldown_ms')
            if (!hasCooldownMs) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN cooldown_ms INTEGER`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added cooldown_ms column to autopilot_rules')
            }
            const hasWebhookUrl = tableInfo.some(col => col.name === 'webhook_url')
            if (!hasWebhookUrl) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN webhook_url TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added webhook_url column to autopilot_rules')
            }
            const hasActiveUrl = tableInfo.some(col => col.name === 'active_url')
            if (!hasActiveUrl) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN active_url TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added active_url column to autopilot_rules')
            }
            const hasStabilization = tableInfo.some(col => col.name === 'stabilization')
            if (!hasStabilization) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN stabilization TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added stabilization column to autopilot_rules')
            }
            const hasLastNotification = tableInfo.some(col => col.name === 'last_notification')
            if (!hasLastNotification) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN last_notification BIGINT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added last_notification column to autopilot_rules')
            }
            const hasIsActive = tableInfo.some(col => col.name === 'is_active')
            if (!hasIsActive) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN is_active INTEGER DEFAULT 1`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added is_active column to autopilot_rules')
            }
            // autopilot_rules.last_check is a legacy mirror; the live value is autopilot_rule_stats.last_check.
            const hasLastCheck = tableInfo.some(col => col.name === 'last_check')
            if (!hasLastCheck) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN last_check BIGINT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added last_check column to autopilot_rules')
            }
            const hasMessageTemplate = tableInfo.some(col => col.name === 'message_template')
            if (!hasMessageTemplate) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN message_template TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added message_template column to autopilot_rules')
            }
            const hasOwnerSyncUser = tableInfo.some(col => col.name === 'owner_sync_user')
            if (!hasOwnerSyncUser) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN owner_sync_user TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added owner_sync_user column to autopilot_rules')
            }
            const hasPlatform = tableInfo.some(col => col.name === 'platform')
            if (!hasPlatform) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN platform TEXT DEFAULT 'stremio'`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added platform column to autopilot_rules')
            }
            const hasConnectionId = tableInfo.some(col => col.name === 'connection_id')
            if (!hasConnectionId) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN connection_id TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added connection_id column to autopilot_rules')
            }
            const hasConnectionGeneration = tableInfo.some(col => col.name === 'connection_generation')
            if (!hasConnectionGeneration) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN connection_generation TEXT`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added connection_generation column to autopilot_rules')
            }
            const hasCustomCheckUrls = tableInfo.some(col => col.name === 'custom_check_urls')
            if (!hasCustomCheckUrls) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN custom_check_urls TEXT DEFAULT NULL`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added custom_check_urls column to autopilot_rules')
            }
            const hasNotifyEnabled = tableInfo.some(col => col.name === 'notify_enabled')
            if (!hasNotifyEnabled) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN notify_enabled INTEGER`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added notify_enabled column to autopilot_rules')
            }
            if (!tableInfo.some(col => col.name === 'edited_at')) {
                await db.run(`ALTER TABLE autopilot_rules ADD COLUMN edited_at BIGINT`)
                await db.run(`UPDATE autopilot_rules SET edited_at = updated_at WHERE edited_at IS NULL`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added edited_at column to autopilot_rules')
            }
            if (!hasPlatform) {
                try {
                    const platformBackfill = await db.run(`UPDATE autopilot_rules SET platform = 'stremio' WHERE platform IS NULL`)
                    if (platformBackfill?.changes > 0) {
                        fastify.log.info({ category: 'Database' }, `Autopilot Rules: backfilled platform='stremio' for ${platformBackfill.changes} rows.`)
                    }
                } catch (e) { fastify.log.warn({ category: 'Database' }, `SQLite migration platform backfill: ${e.message}`) }
            }
            await migrateKvStoreColumns(fastify.log)
            const fhTableInfo = await db.query(`PRAGMA table_info(failover_history)`)
            const hasLatencyMs = fhTableInfo.some(col => col.name === 'latency_ms')
            if (!hasLatencyMs) {
                await db.run(`ALTER TABLE failover_history ADD COLUMN latency_ms INTEGER`)
                fastify.log.info({ category: 'Database' }, 'Migrated: Added latency_ms column to failover_history')
            }
            // Same as the Postgres branch: these indexes sit on migration-added
            // columns, so they run after the column adds above, not in the top
            // schema exec (boot crash on pre-column databases, #17).
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_active_check ON autopilot_rules (is_active, last_check, id)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_active_id ON autopilot_rules (is_active, id)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_worker_scan ON autopilot_rules (is_active, is_automatic, id)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_owner ON autopilot_rules (owner_sync_user)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_platform ON autopilot_rules (platform)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_rules_connection ON autopilot_rules (connection_id)`)
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
            try {
                const pruned = await db.run(`DELETE FROM account_api_keys WHERE rowid NOT IN (SELECT MAX(rowid) FROM account_api_keys GROUP BY sync_user, api_key_hash)`)
                if (pruned?.changes > 0) fastify.log.warn({ category: 'Database' }, `account_api_keys: removed ${pruned.changes} duplicate row(s) before creating the unique index.`)
                await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_hash ON account_api_keys (sync_user, api_key_hash)`)
            } catch (e) {
                fastify.log.error({ category: 'Database' }, `Failed to create idx_api_keys_user_hash: ${e.message}`)
                throw e
            }
        }

        // Backfill any rules that lack a stats row. Idempotent and cheap when fully populated.
        // SQLite needs INSERT OR IGNORE - INSERT-SELECT-ON-CONFLICT is parser-ambiguous against
        // SELECT 's JOIN ... ON clause; PostgreSQL takes the standard ON CONFLICT form.
        try {
            const beforeCount = await db.get(`SELECT COUNT(*) as c FROM autopilot_rule_stats`)
            if (db.type === 'postgres') {
                await db.run(`
                    INSERT INTO autopilot_rule_stats (rule_id, stabilization, last_check, last_notification, updated_at)
                    SELECT id, stabilization, last_check, last_notification, updated_at
                    FROM autopilot_rules
                    ON CONFLICT (rule_id) DO NOTHING
                `)
            } else {
                await db.run(`
                    INSERT OR IGNORE INTO autopilot_rule_stats (rule_id, stabilization, last_check, last_notification, updated_at)
                    SELECT id, stabilization, last_check, last_notification, updated_at
                    FROM autopilot_rules
                `)
            }
            const afterCount = await db.get(`SELECT COUNT(*) as c FROM autopilot_rule_stats`)
            const inserted = Number(afterCount?.c || 0) - Number(beforeCount?.c || 0)
            if (inserted > 0) {
                fastify.log.info({ category: 'Database' }, `Autopilot Rule Stats: seeded ${inserted} missing rows.`)
            }
        } catch (statsBackfillErr) {
            fastify.log.warn({ category: 'Database' }, `Autopilot Rule Stats backfill warning: ${statsBackfillErr.message}`)
        }

        try {
            const credsCount = await db.get(`SELECT COUNT(*) as c FROM server_credentials`)
            if (Number(credsCount?.c || 0) === 0) {
                const rules = await db.query(
                    `SELECT DISTINCT r.account_id, r.auth_key, r.owner_sync_user FROM autopilot_rules r WHERE r.auth_key IS NOT NULL AND r.owner_sync_user IS NOT NULL`
                )
                let credsSeeded = 0
                for (const rule of rules) {
                    try {
                        const credId = `${rule.owner_sync_user}:${rule.account_id}`
                        if (db.type === 'postgres') {
                            await db.run(
                                `INSERT INTO server_credentials (id, sync_user, account_id, auth_key, updated_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET auth_key = EXCLUDED.auth_key, updated_at = EXCLUDED.updated_at`,
                                [credId, rule.owner_sync_user, rule.account_id, rule.auth_key, Date.now()]
                            )
                        } else {
                            await db.run(
                                `INSERT OR REPLACE INTO server_credentials (id, sync_user, account_id, auth_key, updated_at) VALUES ($1, $2, $3, $4, $5)`,
                                [credId, rule.owner_sync_user, rule.account_id, rule.auth_key, Date.now()]
                            )
                        }
                        credsSeeded++
                    } catch (e) {
                        fastify.log.warn({ category: 'Database' }, `Credential backfill failed for ${rule.account_id}: ${e.message}`)
                    }
                }
                if (credsSeeded > 0) {
                    fastify.log.info({ category: 'Database' }, `Server Credentials: backfilled ${credsSeeded} accounts from autopilot rules.`)
                }
            }
        } catch (credsBackfillErr) {
            fastify.log.warn({ category: 'Database' }, `Server Credentials backfill warning: ${credsBackfillErr.message}`)
        }

        try {
            const backfilled = await db.run(
                `UPDATE server_credentials SET credential_type = 'stremio' WHERE credential_type IS NULL`
            )
            if (backfilled?.changes > 0) {
                fastify.log.info({ category: 'Database' }, `Server Credentials: backfilled credential_type for ${backfilled.changes} rows.`)
            }
            try {
                await db.run(`CREATE INDEX IF NOT EXISTS idx_creds_connection ON server_credentials (connection_id)`)
                // idx_creds_type_updated is owned by the ensureTable('server_credentials')
                // index list above (byte-identical DDL); re-issuing it here was a second
                // no-op round trip on every boot.
            } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
        } catch (e) { fastify.log.warn({ category: 'Database' }, `Migration step failed: ${e.message}`) }
    } catch (migrationErr) {
        fastify.log.warn({ category: 'Database' }, `Migration warning: ${migrationErr.message}`)
    }

    const recCacheCreateDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS recommendation_cache (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            catalog_type TEXT NOT NULL,
            items TEXT NOT NULL DEFAULT '[]',
            updated_at BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id, catalog_type)
        );`
        : `CREATE TABLE IF NOT EXISTS recommendation_cache (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            catalog_type TEXT NOT NULL,
            items TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id, catalog_type)
        );`
    await ensureTable('recommendation_cache', recCacheCreateDdl, [
        `CREATE INDEX IF NOT EXISTS idx_rec_cache_user ON recommendation_cache (sync_user)`,
        `CREATE INDEX IF NOT EXISTS idx_rec_cache_user_account ON recommendation_cache (sync_user, account_id)`,
    ], ['sync_user', 'catalog_type', 'items', 'updated_at'], {
        sync_user: `ALTER TABLE recommendation_cache ADD COLUMN sync_user TEXT NOT NULL DEFAULT ''`,
        account_id: `ALTER TABLE recommendation_cache ADD COLUMN account_id TEXT NOT NULL DEFAULT '__household__'`,
        catalog_type: `ALTER TABLE recommendation_cache ADD COLUMN catalog_type TEXT NOT NULL DEFAULT ''`,
        items: `ALTER TABLE recommendation_cache ADD COLUMN items TEXT NOT NULL DEFAULT '[]'`,
        updated_at: `ALTER TABLE recommendation_cache ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0`,
    }, ['sync_user', 'catalog_type'])

    const discoveryPrefsDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS discovery_prefs (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            prefs_json TEXT NOT NULL DEFAULT '{}',
            updated_at BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id)
        );`
        : `CREATE TABLE IF NOT EXISTS discovery_prefs (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL DEFAULT '__household__',
            prefs_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id)
        );`
    await ensureTable('discovery_prefs', discoveryPrefsDdl, [
        `CREATE INDEX IF NOT EXISTS idx_discovery_prefs_user ON discovery_prefs (sync_user)`,
    ], ['sync_user', 'account_id', 'prefs_json', 'updated_at'], {
        sync_user: `ALTER TABLE discovery_prefs ADD COLUMN sync_user TEXT NOT NULL DEFAULT ''`,
        account_id: `ALTER TABLE discovery_prefs ADD COLUMN account_id TEXT NOT NULL DEFAULT '__household__'`,
        prefs_json: `ALTER TABLE discovery_prefs ADD COLUMN prefs_json TEXT NOT NULL DEFAULT '{}'`,
        updated_at: `ALTER TABLE discovery_prefs ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0`,
    }, ['sync_user', 'account_id'])

    // Command queue jobs (POST /api/commands). Keep DDL in sync with migrations/002_commands.sql.
    const commandsDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS commands (
            id TEXT PRIMARY KEY,
            sync_user TEXT NOT NULL,
            command TEXT NOT NULL,
            account_ids TEXT NOT NULL,
            status TEXT NOT NULL,
            results TEXT,
            error TEXT,
            created_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL DEFAULT 0
        );`
        : `CREATE TABLE IF NOT EXISTS commands (
            id TEXT PRIMARY KEY,
            sync_user TEXT NOT NULL,
            command TEXT NOT NULL,
            account_ids TEXT NOT NULL,
            status TEXT NOT NULL,
            results TEXT,
            error TEXT,
            created_at BIGINT NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );`
    await ensureTable('commands', commandsDdl, [
        `CREATE INDEX IF NOT EXISTS idx_commands_user_updated ON commands (sync_user, updated_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_commands_status ON commands (status)`,
    ], ['id', 'sync_user', 'command', 'account_ids', 'status', 'created_at', 'updated_at'], {
        sync_user: `ALTER TABLE commands ADD COLUMN sync_user TEXT NOT NULL DEFAULT ''`,
        command: `ALTER TABLE commands ADD COLUMN command TEXT NOT NULL DEFAULT ''`,
        account_ids: `ALTER TABLE commands ADD COLUMN account_ids TEXT NOT NULL DEFAULT '[]'`,
        status: `ALTER TABLE commands ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'`,
        results: `ALTER TABLE commands ADD COLUMN results TEXT`,
        error: `ALTER TABLE commands ADD COLUMN error TEXT`,
        created_at: `ALTER TABLE commands ADD COLUMN created_at BIGINT NOT NULL DEFAULT 0`,
        updated_at: `ALTER TABLE commands ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0`,
    }, ['id'])

    // Deleted-account guard for rule and credential writes; keep DDL in sync with migrations/004_account_server_tombstones.sql.
    await ensureTable('account_server_tombstones', `CREATE TABLE IF NOT EXISTS account_server_tombstones (
            sync_user TEXT NOT NULL,
            account_id TEXT NOT NULL,
            deleted_at BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (sync_user, account_id)
        );`, [], ['sync_user', 'account_id', 'deleted_at'], {
        deleted_at: `ALTER TABLE account_server_tombstones ADD COLUMN deleted_at BIGINT NOT NULL DEFAULT 0`,
    }, ['sync_user', 'account_id'])

    // Remembered-device credentials; keep DDL in sync with migrations/003_device_credentials.sql.
    const deviceCredentialsDdl = db.type === 'postgres'
        ? `CREATE TABLE IF NOT EXISTS device_credentials (
            id TEXT PRIMARY KEY,
            account_uuid TEXT NOT NULL,
            device_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            tier TEXT NOT NULL CHECK (tier IN ('idb', 'prf')),
            label TEXT,
            created_at BIGINT NOT NULL DEFAULT 0,
            expires_at BIGINT NOT NULL DEFAULT 0,
            revoked INTEGER NOT NULL DEFAULT 0,
            last_used_at BIGINT,
            credential_epoch INTEGER NOT NULL DEFAULT 1
        );`
        : `CREATE TABLE IF NOT EXISTS device_credentials (
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
        );`
    await ensureTable('device_credentials', deviceCredentialsDdl, [
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_device_credentials_account_device ON device_credentials (account_uuid, device_id)`,
        `CREATE INDEX IF NOT EXISTS idx_device_credentials_account ON device_credentials (account_uuid)`,
    ], ['id', 'account_uuid', 'device_id', 'token_hash', 'tier', 'created_at', 'expires_at'], {
        tier: `ALTER TABLE device_credentials ADD COLUMN tier TEXT NOT NULL DEFAULT 'idb'`,
        label: `ALTER TABLE device_credentials ADD COLUMN label TEXT`,
        expires_at: `ALTER TABLE device_credentials ADD COLUMN expires_at BIGINT NOT NULL DEFAULT 0`,
        revoked: `ALTER TABLE device_credentials ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`,
        last_used_at: `ALTER TABLE device_credentials ADD COLUMN last_used_at BIGINT`,
        credential_epoch: `ALTER TABLE device_credentials ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 1`,
    }, ['id'])

    // Dashboard tables; keep DDL in sync with migrations/006_admin.sql.
    for (const table of ADMIN_TABLES) {
        await ensureTable(table.name, table.ddl, table.indexes, table.columns, table.addColumns || null, table.pk)
    }

    try {
        const MIGRATION_KEY = 'migration:activity_season_clamp_v1'
        const done = await db.get(`SELECT key FROM kv_store WHERE key = $1`, [MIGRATION_KEY])
        if (!done) {
            const e1 = await db.run(`UPDATE activity_events SET season = NULL WHERE season > 100 OR season < 0`)
            const e2 = await db.run(`UPDATE activity_snapshots SET season = NULL WHERE season > 100 OR season < 0`)
            await db.run(
                db.type === 'postgres'
                    ? `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`
                    : `INSERT OR IGNORE INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3)`,
                [MIGRATION_KEY, '1', Date.now()]
            )
            const cleaned = Number(e1?.changes || 0) + Number(e2?.changes || 0)
            if (cleaned > 0) {
                fastify.log.info({ category: 'Database' }, `Activity cleanup: nulled ${cleaned} implausible season values (anime id pollution).`)
            }
        }
    } catch (e) {
        fastify.log.warn({ category: 'Database' }, `Activity season cleanup failed: ${e.message}`)
    }

    try {
        if (db.type === 'sqlite') {
            await db.pragma('wal_checkpoint(TRUNCATE)')
            fastify.log.info({ category: 'Database' }, 'Startup: WAL checkpoint completed - cleared stale locks.')
        } else if (db.type === 'postgres') {
            await db.run(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid() AND usename = current_user`).catch((e) => { fastify.log.warn({ category: 'Database' }, `pg_terminate_backend cleanup failed: ${e.message}`) })
            fastify.log.info({ category: 'Database' }, 'Startup: Cleared stale PostgreSQL transactions.')
        }
        serverState.isWorkerRunning = false
        proxyQueue.length = 0
        domainLastRequestTime.clear()
        globalHealthCache.clear()
        // Command queue jobs run in-process; anything still queued/running at boot died
        // with the previous session and must not be reported as live forever.
        try {
            const staleJobs = await db.run(
                `UPDATE commands SET status = 'failed', error = 'server restarted', updated_at = $1 WHERE status IN ('queued', 'running')`,
                [Date.now()]
            )
            if (staleJobs?.changes > 0) {
                fastify.log.info({ category: 'Commands' }, `Startup cleanup: marked ${staleJobs.changes} orphaned command job(s) as failed (server restarted).`)
            }
        } catch (e) { fastify.log.warn({ category: 'Commands' }, `Command job startup cleanup failed: ${e.message}`) }
        fastify.log.info({ category: 'Server' }, 'Startup cleanup: Reset in-memory state from previous session.')
    } catch (cleanupErr) {
        fastify.log.warn({ category: 'Database' }, `Startup cleanup warning: ${cleanupErr.message}`)
    }
    return dbPath
}
