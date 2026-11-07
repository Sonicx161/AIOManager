import crypto from 'crypto'
import db from './db.js'
import { decrypt } from './crypto.js'
import { FALLBACK_KEYS } from './keys.js'
import { getCachedAuth, setCachedAuth, hashAuthPassword } from './state.js'
import { verifySyncPassword, upgradeLegacyPasswordHash } from './lib/sync-password.js'
import { trace } from './utils/trace.js'
import { isAdminPath } from './admin/paths.js'
import { isReadOnlyReplica } from './config.js'
import { assertAccountActive, AuthStateError, StateUnavailableError } from './admin/account-state.js'

export const timingSafeEqual = (a, b) => {
    try {
        if (a == null || b == null) return false
        const aBuf = Buffer.from(String(a), 'utf8')
        const bBuf = Buffer.from(String(b), 'utf8')
        if (aBuf.length !== bBuf.length) {
            return false
        }
        return crypto.timingSafeEqual(aBuf, bBuf)
    } catch {
        return false
    }
}

const DEVICE_ID_MAX_LENGTH = 128
const DEVICE_TOKEN_MAX_LENGTH = 512

// Reason precedence: a valid token decides the failure mode; revocation (explicit
// security action) outranks passive expiry, and both outrank generation drift.
export async function authenticateDeviceCredential(syncUser, deviceId, token, now = Date.now()) {
    if (!syncUser || !deviceId || !token) return { ok: false, reason: 'unknown' }
    if (String(deviceId).length > DEVICE_ID_MAX_LENGTH || String(token).length > DEVICE_TOKEN_MAX_LENGTH) {
        return { ok: false, reason: 'unknown' }
    }
    try {
        const row = await db.get(
            'SELECT id, account_uuid, token_hash, revoked, expires_at, credential_epoch FROM device_credentials WHERE account_uuid = $1 AND device_id = $2',
            [String(syncUser), String(deviceId)]
        )
        if (!row) return { ok: false, reason: 'unknown' }
        if ((await verifySyncPassword(String(token), row.token_hash)) !== true) return { ok: false, reason: 'unknown' }
        if (Number(row.revoked) === 1) return { ok: false, reason: 'revoked' }
        if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }
        const account = await db.get('SELECT credential_epoch FROM kv_store WHERE key = $1', [String(syncUser)])
        if (!account) return { ok: false, reason: 'unknown' }
        if (Number(account.credential_epoch) !== Number(row.credential_epoch)) return { ok: false, reason: 'generation' }
        return { ok: true, accountUuid: row.account_uuid, row }
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        // surface DB failures instead of collapsing them into the generic 'unknown' reason
        trace('auth', 'deviceCredential.error', { user: syncUser, deviceId, error: err?.message })
        return { ok: false, reason: 'unknown' }
    }
}

// Device credentials authenticate BEFORE any password check. The token is cached under
// a distinct namespace (keyed per account+device, never mixed with 'sync:'): a device
// token in the shared password cache would be accepted as the account password by
// headerless requests within the cache TTL. The hook reads its own namespace back so a
// repeat request within the TTL skips both DB reads and scrypt entirely. Revocation,
// expiry, and epoch bumps are enforced by the DB path and by explicit invalidation at
// every security action (enroll/revoke/revoke-everywhere); a revocation that bypasses
// those is honored within the same 60s TTL window the password cache already accepts.
export async function deviceAuthHook(request, reply) {
    // Sync credentials never reach the Dashboard API.
    if (isAdminPath(request.url)) return
    const deviceId = request.headers['x-sync-device']
    if (!deviceId) return
    const syncUser = request.headers['x-sync-user']
    const presented = request.headers['x-sync-password']
    // Account state gate: ahead of the cache accept, the DB accept and every telemetry
    // write, and outside the try below so a gate refusal can never be swallowed.
    await assertAccountActive(syncUser)
    const cacheKey = 'device:' + syncUser + ':' + deviceId
    const cachedTokenHash = getCachedAuth(cacheKey)
    if (cachedTokenHash && timingSafeEqual(cachedTokenHash, hashAuthPassword(presented))) {
        // accountUuid is provably syncUser here: the DB path only caches after matching
        // device_credentials rows on account_uuid = syncUser, and downstream consumers
        // compare it against the x-sync-user header, never use it as a DB handle.
        request.deviceAuth = { accountUuid: String(syncUser) }
        trace('auth', 'deviceAuth.accept', { user: syncUser, deviceId, source: 'cache' })
        return
    }
    const outcome = await authenticateDeviceCredential(syncUser, deviceId, presented)
    if (outcome.ok) {
        request.deviceAuth = { accountUuid: outcome.accountUuid }
        setCachedAuth(cacheKey, presented)
        // A replica never writes, not even best-effort telemetry, against the follower.
        if (!isReadOnlyReplica()) {
            try {
                await db.run('UPDATE device_credentials SET last_used_at = $1 WHERE id = $2', [Date.now(), outcome.row.id])
            } catch (err) {
                if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
                /* best-effort telemetry write; auth already succeeded and must not fail because of it */
            }
        }
        trace('auth', 'deviceAuth.accept', { user: syncUser, deviceId, source: 'db' })
        return
    }
    trace('auth', 'deviceAuth.reject', { user: syncUser, deviceId, reason: outcome.reason })
    reply.status(401)
    return reply.send({ error: 'Device credential rejected', reason: outcome.reason })
}

export async function verifyAuth(request) {
    // Account state gate ahead of every auth path (device early return, cache, DB).
    await assertAccountActive(request.deviceAuth?.accountUuid || request.headers['x-sync-user'])
    if (request.deviceAuth?.accountUuid) return request.deviceAuth.accountUuid
    const syncUser = request.headers['x-sync-user']
    const syncPassword = request.headers['x-sync-password']
    if (!syncUser || !syncPassword) {
        trace('auth', 'verifyAuth.reject', { reason: 'missing-credentials' })
        return null
    }
    try {
        const cached = getCachedAuth('sync:' + syncUser)
        if (cached && timingSafeEqual(cached, hashAuthPassword(syncPassword))) {
            trace('auth', 'verifyAuth.accept', { user: syncUser, source: 'cache' })
            return syncUser
        }
        const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [syncUser])
        if (!row?.password) {
            trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'unknown-user' })
            return null
        }
        const verified = await verifySyncPassword(syncPassword, row.password)
        let authorized = verified === true
        if (verified === null) {
            const decrypted = decrypt(row.password, FALLBACK_KEYS)
            if (decrypted && timingSafeEqual(decrypted, syncPassword)) {
                authorized = true
                await upgradeLegacyPasswordHash(db, syncUser, syncPassword)
            }
        }
        if (!authorized) {
            trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'password-mismatch' })
            return null
        }
        setCachedAuth('sync:' + syncUser, syncPassword)
        trace('auth', 'verifyAuth.accept', { user: syncUser, source: verified === null ? 'legacy' : 'password' })
        return syncUser
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'error', error: err?.message })
        return null
    }
}

export async function requireProxyAuth(request, reply) {
    // Account state gate ahead of every auth path (device early return, cache, DB).
    await assertAccountActive(request.deviceAuth?.accountUuid || request.headers['x-sync-user'])
    if (request.deviceAuth?.accountUuid) return null
    const syncUser = request.headers['x-sync-user']
    const syncPassword = request.headers['x-sync-password']
    if (!syncUser || !syncPassword) {
        trace('auth', 'proxyAuth.reject', { reason: 'missing-credentials' })
        reply.status(401)
        return { error: 'Authentication required' }
    }
    const cached = getCachedAuth('sync:' + syncUser)
    if (cached && timingSafeEqual(cached, hashAuthPassword(syncPassword))) {
        trace('auth', 'proxyAuth.accept', { user: syncUser, source: 'cache' })
        return null
    }
    try {
        const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [syncUser])
        if (!row) {
            trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'unknown-user' })
            reply.status(401)
            return { error: 'Unauthorized' }
        }
        const verified = await verifySyncPassword(syncPassword, row.password)
        let authorized = verified === true
        if (verified === null) {
            const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
            if (decryptedPassword && timingSafeEqual(decryptedPassword, syncPassword)) {
                authorized = true
                await upgradeLegacyPasswordHash(db, syncUser, syncPassword)
            }
        }
        if (!authorized) {
            trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'password-mismatch' })
            reply.status(401)
            return { error: 'Unauthorized' }
        }
        setCachedAuth('sync:' + syncUser, syncPassword)
        trace('auth', 'proxyAuth.accept', { user: syncUser, source: verified === null ? 'legacy' : 'password' })
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'error', error: err?.message })
        reply.status(401)
        return { error: 'Unauthorized' }
    }
    return null
}
