// Boot preload for Dashboard-stored settings. Runs before lib/env.js validates process.env
// (index.js awaits it, then imports the server), so every module that reads a setting at import
// sees the stored value. Precedence: environment > stored > default. Env-only keys are never
// read from the store, and a stored value that fails validation is skipped, never fatal.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { DEFAULT_DATA_DIR } from './env-schema.js'
import { SETTING_KEYS, checkSettingValue, isSecretSetting, settingSpec } from '../admin/settings-registry.js'
import { decrypt } from '../crypto.js'
import { connectWithRetry, pgConnectionConfig } from '../db.js'

const SELECT_ROWS = 'SELECT setting_key, setting_value, is_secret FROM instance_settings'
const nonEmpty = (v) => typeof v === 'string' && v !== ''
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')

let preloaded = null
export const preloadedBootState = () => preloaded

// Effective raw value per key once the store is applied; secrets are kept as a digest only.
function snapshot(env) {
    const values = new Map()
    for (const key of SETTING_KEYS) {
        if (!nonEmpty(env[key])) continue
        values.set(key, isSecretSetting(key) ? digest(env[key]) : env[key])
    }
    return values
}

// Without the preload (tests, tools), whatever is in the environment counts as .env.
export function captureBootState(env = process.env, { fromStore = new Set(), skipped = [], readFailed = false } = {}) {
    return {
        readFailed,
        // Set by reapplyStoredLiveSettings: { ok, applied } once it has run.
        liveReapply: null,
        envKeys: new Set(SETTING_KEYS.filter((k) => nonEmpty(env[k]) && !fromStore.has(k))),
        fromStore,
        skipped,
        bootValues: snapshot(env),
    }
}

export const settingDigest = digest

function readSqlite(env) {
    const file = path.join(env.DATA_DIR || DEFAULT_DATA_DIR, 'aio.db')
    if (!fs.existsSync(file)) return []
    return import('better-sqlite3').then(({ default: Database }) => {
        const conn = new Database(file, { readonly: true, fileMustExist: true })
        try {
            const exists = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'instance_settings'").get()
            return exists ? conn.prepare(SELECT_ROWS).all() : []
        } finally {
            conn.close()
        }
    })
}

// Same connection settings and retry/backoff as db.js, so a database that starts a few
// seconds after the app still has its stored settings applied.
async function readPostgres(env, { pgClient, sleep, log }) {
    const conn = pgConnectionConfig(env)
    if (!conn.connectionString) return []
    const Client = pgClient || (await import('pg')).default.Client
    return connectWithRetry(async () => {
        const c = new Client({ connectionString: conn.connectionString, ssl: conn.ssl, connectionTimeoutMillis: conn.connectionTimeoutMillis })
        try {
            await c.connect()
            const exists = await c.query("SELECT to_regclass('instance_settings') AS t")
            return exists.rows[0]?.t ? (await c.query(SELECT_ROWS)).rows : []
        } finally {
            await c.end?.().catch(() => {})
        }
    }, {
        maxRetries: conn.maxRetries,
        sleep,
        onRetry: (attempt, max, err, delay) => log.warn(`[Settings] Database not reachable for stored settings (attempt ${attempt}/${max}, ${err?.code || 'error'}); retrying in ${delay / 1000}s.`),
    })
}

function secretKeys(env) {
    const keys = []
    if (nonEmpty(env.ENCRYPTION_KEY)) keys.push(env.ENCRYPTION_KEY)
    const file = path.join(env.DATA_DIR || DEFAULT_DATA_DIR, 'server_secret.key')
    try { if (fs.existsSync(file)) keys.push(fs.readFileSync(file, 'utf8').trim()) } catch { /* no file key */ }
    return keys.filter(Boolean)
}

export async function preloadInstanceSettings({ env = process.env, log = console, readRows, pgClient, sleep } = {}) {
    let rows = []
    let readFailed = false
    try {
        const reader = readRows || ((String(env.DB_TYPE || 'sqlite') === 'postgres') ? readPostgres : readSqlite)
        rows = await reader(env, { pgClient, sleep, log })
    } catch (err) {
        log.warn(`[Settings] Could not read Dashboard settings at boot (${err?.code || err?.constructor?.name || 'Error'}); using the environment and defaults.`)
        rows = []
        readFailed = true
    }
    const fromStore = new Set()
    const skipped = []
    let keys = null
    for (const row of rows) {
        const key = String(row.setting_key)
        const spec = settingSpec(key)
        if (!spec || spec.envOnly) { skipped.push({ key, reason: 'not-storable' }); continue }
        if (nonEmpty(env[key])) continue
        let raw = row.setting_value
        if (spec.secret) {
            keys ||= secretKeys(env)
            raw = keys.length ? decrypt(String(raw), keys) : null
            if (raw === null || raw === undefined) { skipped.push({ key, reason: 'decrypt' }); continue }
        }
        const checked = checkSettingValue(key, raw)
        if (checked.error) { skipped.push({ key, reason: 'invalid' }); continue }
        env[key] = checked.value
        fromStore.add(key)
    }
    if (skipped.length) log.warn(`[Settings] Skipped stored Dashboard settings: ${skipped.map((s) => `${s.key} (${s.reason})`).join(', ')}.`)
    if (fromStore.size) log.info(`[Settings] Applied ${fromStore.size} Dashboard setting(s): ${[...fromStore].join(', ')}.`)
    preloaded = captureBootState(env, { fromStore, skipped, readFailed })
    return preloaded
}

// When the boot read failed, live keys are applied from the store once the database is open.
// Restart keys stay as they are until the next start; the Settings view says so.
export async function reapplyStoredLiveSettings(q, { env = process.env, logger = null, log = console } = {}) {
    if (!preloaded?.readFailed) return []
    let rows
    try {
        rows = await q.query(SELECT_ROWS, [])
    } catch (err) {
        log.warn(`[Settings] Could not re-read Dashboard settings after the database opened (${err?.code || err?.constructor?.name || 'Error'}).`)
        preloaded.liveReapply = { ok: false, applied: [] }
        return []
    }
    const applied = []
    for (const row of rows) {
        const key = String(row.setting_key)
        const spec = settingSpec(key)
        if (!spec || spec.envOnly || spec.secret || spec.apply !== 'live' || preloaded.envKeys.has(key)) continue
        const checked = checkSettingValue(key, row.setting_value)
        if (checked.error) {
            if (!preloaded.skipped.some((s) => s.key === key)) preloaded.skipped.push({ key, reason: 'invalid' })
            continue
        }
        env[key] = checked.value
        if (key === 'LOG_LEVEL' && logger) logger.level = checked.value
        applied.push(key)
    }
    preloaded.liveReapply = { ok: true, applied }
    if (applied.length) log.info(`[Settings] Applied ${applied.length} live Dashboard setting(s) after the database opened: ${applied.join(', ')}. Restart to apply the rest.`)
    return applied
}
