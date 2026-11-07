import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'

const STREMIO_CRED_PREDICATE = "(credential_type = 'stremio' OR credential_type IS NULL)"

export async function listStremioCredentialedAccountIds(syncUser, conn = db) {
    const rows = await conn.query(
        `SELECT DISTINCT account_id FROM server_credentials WHERE sync_user = $1 AND ${STREMIO_CRED_PREDICATE}`,
        [syncUser]
    )
    return rows.map(r => r.account_id)
}

export async function stremioCredentialVersion(syncUser) {
    return db.get(
        `SELECT COUNT(*) AS n, MAX(updated_at) AS max_ts FROM server_credentials WHERE sync_user = $1 AND ${STREMIO_CRED_PREDICATE}`,
        [syncUser]
    )
}

// Canonical pin for account-level Stremio APIs (commands, hydra inbound reads/writes):
// the account-level row (connection_id IS NULL) is the mirror of the canonical login the
// client reports. Secondary logins register per-connection rows; letting "latest row
// wins" run across those would pin enforcement to whichever login synced most recently —
// a nondeterministic choice that can silently route an account-level action through a
// secondary's session. Fail closed instead: with no account-level row there is NO
// well-defined canonical target for an account-level API (the client always registers
// the canonical login account-level, so absence means not-yet-registered), and callers
// report exactly that rather than guessing.
export async function getLatestStremioCredential(accountId, syncUser) {
    return db.get(
        `SELECT auth_key FROM server_credentials WHERE account_id = $1 AND sync_user = $2 AND ${STREMIO_CRED_PREDICATE} AND connection_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
        [accountId, syncUser]
    )
}

export async function resolveStremioAuthKey(accountId, syncUser) {
    const row = await getLatestStremioCredential(accountId, syncUser)
    if (!row?.auth_key) return null
    return decrypt(row.auth_key, FALLBACK_KEYS) || null
}

// The canonical row keeps a bare activity scope (connection_id IS NULL), while
// canonical_connection_id records the actual client login for destination rules.
// Older clients can still be resolved by key-matching their per-login rows.
export async function resolveStremioConnectionIdentity(accountId, syncUser, authKey, preferredConnectionId) {
    const rows = await db.query(
        `SELECT connection_id, canonical_connection_id, auth_key FROM server_credentials
         WHERE account_id = $1 AND sync_user = $2 AND ${STREMIO_CRED_PREDICATE}`,
        [accountId, syncUser || '']
    )
    const matches = new Set()
    const canonicalMatches = new Set()
    let hasConnectionRows = false
    for (const row of rows) {
        if (row.connection_id) hasConnectionRows = true
        if (!row.auth_key || decrypt(row.auth_key, FALLBACK_KEYS) !== authKey) continue
        if (row.connection_id) matches.add(row.connection_id)
        else if (row.canonical_connection_id) canonicalMatches.add(row.canonical_connection_id)
    }
    if (preferredConnectionId && (matches.has(preferredConnectionId) || canonicalMatches.has(preferredConnectionId))) {
        return { connectionId: preferredConnectionId }
    }
    if (canonicalMatches.size === 1) return { connectionId: [...canonicalMatches][0] }
    if (canonicalMatches.size > 1 || matches.size > 1 || (hasConnectionRows && matches.size === 0)) return { ambiguous: true }
    if (matches.size === 1) return { connectionId: [...matches][0] }
    return { connectionId: `${accountId}:stremio`, legacy: true }
}
