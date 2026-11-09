import crypto from 'crypto'
import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'

// Byte-identical to the client tombstone key (src/lib/addon-tombstones.ts normUrl); applied
// only to raw Hydra URLs. Keys the client already normalized are used verbatim: re-normalizing
// a key such as ".../manifest.json" would strip its suffix and silently miss the row.
export function addonActionUrlKey(url) {
    if (!url) return ''
    let n = String(url).trim()
    n = n.replace(/^stremio:\/\//i, 'https://')
    n = n.replace(/\/manifest\.json$/i, '')
    n = n.replace(/\/+$/, '')
    return n.toLowerCase()
}

const atRestSecret = () => PRIMARY_KEY || FALLBACK_KEYS[0] || ''

// Row key: keyed hash, so the table never stores a URL in plaintext.
export function addonActionRowKey(key) {
    return crypto.createHmac('sha256', atRestSecret()).update(String(key)).digest('hex')
}

const PRUNE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const READ_CAP = 200

const greatest = () => (db.type === 'postgres' ? 'GREATEST' : 'MAX')
const lastActivity = () => `${greatest()}(COALESCE(last_install_at, 0), COALESCE(last_delete_at, 0))`
// Postgres ON CONFLICT DO UPDATE sees unqualified names as ambiguous with EXCLUDED, so they carry the table prefix.
const nextSeq = () => db.type === 'postgres'
    ? 'GREATEST(COALESCE(account_addon_actions.install_seq, 0), COALESCE(account_addon_actions.delete_seq, 0)) + 1'
    : 'MAX(COALESCE(install_seq, 0), COALESCE(delete_seq, 0)) + 1'

// Tombstone tokens merge across devices by max, so a repeated or older acknowledgement
// must not restamp the row and bury a newer install. A null token is a server-side
// explicit delete and always stamps.
function keepsExistingToken(token, existing) {
    if (existing === undefined || token == null || typeof existing !== 'string') return false
    if (token === existing) return true
    const incoming = Number(token)
    const current = Number(existing)
    return Number.isFinite(incoming) && Number.isFinite(current) && incoming < current
}

// entries: [{ url, action, token }]. Installs and deletes write disjoint columns,
// so interleaved actions keep both timestamps. With keysAreNormalized the url values
// are already client-normalized keys and are hashed verbatim.
export async function recordAddonActions(runner, { syncUser, accountId, entries, actedAt, keysAreNormalized = false }) {
    if (!Array.isArray(entries) || entries.length === 0) return 0
    const at = actedAt ?? Date.now()
    const unique = []
    const seen = new Set()
    for (const entry of entries) {
        const plainKey = keysAreNormalized ? String(entry?.url ?? '') : addonActionUrlKey(entry?.url)
        if (!plainKey || seen.has(plainKey)) continue
        seen.add(plainKey)
        unique.push({ key: addonActionRowKey(plainKey), url: String(entry.url), action: entry.action, token: entry.token == null ? null : String(entry.token) })
    }
    if (unique.length === 0) return 0
    await runner.run(
        `DELETE FROM account_addon_actions WHERE sync_user = $1 AND account_id = $2 AND delete_token IS NULL AND ${lastActivity()} < $3`,
        [syncUser, accountId, at - PRUNE_WINDOW_MS]
    )
    const existingTokens = new Map()
    const deleteEntries = unique.filter(e => e.action !== 'install')
    for (let i = 0; i < deleteEntries.length; i += READ_CAP) {
        const chunk = deleteEntries.slice(i, i + READ_CAP).map(e => e.key)
        const inList = chunk.map((_, j) => `$${j + 3}`).join(', ')
        const rows = await runner.query(
            `SELECT url_key, delete_token FROM account_addon_actions WHERE sync_user = $1 AND account_id = $2 AND url_key IN (${inList})`,
            [syncUser, accountId, ...chunk]
        )
        for (const row of rows) existingTokens.set(row.url_key, row.delete_token == null ? null : String(row.delete_token))
    }
    let written = 0
    for (const entry of unique) {
        if (entry.action === 'install') {
            await runner.run(
                db.type === 'postgres'
                    ? `INSERT INTO account_addon_actions (sync_user, account_id, url_key, install_transport_url, last_install_at, install_seq)
                       VALUES ($1, $2, $3, $4, $5, 1)
                       ON CONFLICT (sync_user, account_id, url_key) DO UPDATE
                       SET install_transport_url = EXCLUDED.install_transport_url, last_install_at = EXCLUDED.last_install_at,
                           install_seq = ${nextSeq()}`
                    : `INSERT INTO account_addon_actions (sync_user, account_id, url_key, install_transport_url, last_install_at, install_seq)
                       VALUES ($1, $2, $3, $4, $5, 1)
                       ON CONFLICT (sync_user, account_id, url_key) DO UPDATE
                       SET install_transport_url = excluded.install_transport_url, last_install_at = excluded.last_install_at,
                           install_seq = ${nextSeq()}`,
                [syncUser, accountId, entry.key, encrypt(entry.url, atRestSecret()), at]
            )
            written++
        } else if (keepsExistingToken(entry.token, existingTokens.get(entry.key))) {
            continue
        } else {
            await runner.run(
                db.type === 'postgres'
                    ? `INSERT INTO account_addon_actions (sync_user, account_id, url_key, last_delete_at, delete_seq, delete_token)
                       VALUES ($1, $2, $3, $4, 1, $5)
                       ON CONFLICT (sync_user, account_id, url_key) DO UPDATE
                       SET last_delete_at = EXCLUDED.last_delete_at,
                           delete_token = COALESCE(EXCLUDED.delete_token, account_addon_actions.delete_token),
                           delete_seq = ${nextSeq()}`
                    : `INSERT INTO account_addon_actions (sync_user, account_id, url_key, last_delete_at, delete_seq, delete_token)
                       VALUES ($1, $2, $3, $4, 1, $5)
                       ON CONFLICT (sync_user, account_id, url_key) DO UPDATE
                       SET last_delete_at = excluded.last_delete_at,
                           delete_token = COALESCE(excluded.delete_token, account_addon_actions.delete_token),
                           delete_seq = ${nextSeq()}`,
                [syncUser, accountId, entry.key, at, entry.token]
            )
            written++
        }
    }
    return written
}

const ACTION_COLUMNS = 'url_key, install_transport_url, last_install_at, last_delete_at, install_seq, delete_seq, delete_token'

const toActionRow = (r) => ({
    urlKey: r.url_key,
    transportUrl: r.install_transport_url === '' ? '' : decrypt(r.install_transport_url, FALLBACK_KEYS),
    lastInstallAt: r.last_install_at == null ? null : Number(r.last_install_at) || 0,
    lastDeleteAt: r.last_delete_at == null ? null : Number(r.last_delete_at) || 0,
    installSeq: Number(r.install_seq) || 0,
    deleteSeq: Number(r.delete_seq) || 0,
    deleteToken: r.delete_token == null ? null : String(r.delete_token),
})

// urlKeys are the client's already-normalized keys: each is hashed verbatim and the
// response echoes the requested key back so the caller can correlate rows.
export async function readAddonActions(syncUser, accountId, urlKeys) {
    if (Array.isArray(urlKeys) && urlKeys.length > 0) {
        const requestedByHash = new Map()
        const rows = []
        for (let i = 0; i < urlKeys.length; i += READ_CAP) {
            const chunk = urlKeys.slice(i, i + READ_CAP)
            const hashes = chunk.map(k => addonActionRowKey(k))
            hashes.forEach((h, j) => requestedByHash.set(h, chunk[j]))
            const inList = hashes.map((_, j) => `$${j + 3}`).join(', ')
            rows.push(...await db.query(
                `SELECT ${ACTION_COLUMNS} FROM account_addon_actions
                 WHERE sync_user = $1 AND account_id = $2 AND url_key IN (${inList})
                 ORDER BY ${lastActivity()} DESC, url_key ASC`,
                [syncUser, accountId, ...hashes]
            ))
        }
        return rows.map(r => ({ ...toActionRow(r), urlKey: requestedByHash.get(r.url_key) || r.url_key }))
    }
    const rows = await db.query(
        `SELECT ${ACTION_COLUMNS} FROM account_addon_actions
         WHERE sync_user = $1 AND account_id = $2
         ORDER BY ${lastActivity()} DESC, url_key ASC LIMIT ${READ_CAP}`,
        [syncUser, accountId]
    )
    return rows.map(toActionRow)
}

const hydraLockTails = new Map()

function acquireHydraLock(key) {
    const previous = hydraLockTails.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const tail = previous.then(() => current)
    hydraLockTails.set(key, tail)
    return previous.then(() => () => {
        release()
        if (hydraLockTails.get(key) === tail) hydraLockTails.delete(key)
    })
}

export async function withHydraFanoutLock(account, fn) {
    const release = await acquireHydraLock(`fanout:${account.sync_user || ''}:${account.account_id}`)
    try {
        return await fn()
    } finally {
        release()
    }
}

// Serialized per account in-process only: assumes a single writable instance, and fn
// must keep every write in a short transaction after its platform work.
export async function withHydraAccountLock(account, fn) {
    const release = await acquireHydraLock(`${account.sync_user || ''}\u0000${account.account_id}`)
    try {
        return await fn(db)
    } finally {
        release()
    }
}
