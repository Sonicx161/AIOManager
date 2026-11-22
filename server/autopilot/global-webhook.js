import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'

// The rule UI's "Use global webhook" option stores no per-rule URL; this is the
// server-side fallback the engine resolves at notification time. kv_store rows
// keyed by anything other than a bare account UUID are invisible to the sync
// push/pull/delete flows (all of them filter on key = account id).
// Owner-scoped on purpose: a flat key would route one tenant's failover events
// (account names included) to whatever webhook the last writer saved.
const KEY_PREFIX = 'autopilot_global_webhook:'

export const globalWebhookKey = (owner) => `${KEY_PREFIX}${owner}`
const keyFor = globalWebhookKey
// Webhook rows never carry a password and workspace rows always do, so a workspace whose id happens to equal a webhook key is never read, overwritten or deleted here.

export async function getGlobalWebhook(owner) {
    if (!owner) return null
    try {
        const row = await db.get('SELECT value FROM kv_store WHERE key = $1 AND password IS NULL', [keyFor(owner)])
        if (!row?.value) return null
        return decrypt(row.value, FALLBACK_KEYS) || null
    } catch {
        return null
    }
}

export async function setGlobalWebhook(owner, url) {
    const key = keyFor(owner)
    if (!url) {
        await db.run('DELETE FROM kv_store WHERE key = $1 AND password IS NULL', [key])
        return true
    }
    const value = encrypt(url, PRIMARY_KEY)
    const now = Date.now()
    // Saved only while the owner's workspace still exists; the shared lock orders this against the workspace delete, which removes the webhook too.
    return db.tx(async (tx) => {
        const workspace = await tx.get(`SELECT password FROM kv_store WHERE key = $1${db.type === 'postgres' ? ' FOR SHARE' : ''}`, [owner])
        if (!workspace || workspace.password == null) return false
        const result = db.type === 'postgres'
            ? await tx.run(
                `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at WHERE kv_store.password IS NULL`,
                [key, value, now]
            )
            : await tx.run(
                `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, $3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE password IS NULL`,
                [key, value, now]
            )
        return Boolean(result?.changes)
    }, { immediate: true })
}

export function maskWebhookUrl(url) {
    if (typeof url !== 'string' || url.length <= 8) return null
    try {
        const { host } = new URL(url)
        return `${host}…${url.slice(-4)}`
    } catch {
        return `••••${url.slice(-4)}`
    }
}
