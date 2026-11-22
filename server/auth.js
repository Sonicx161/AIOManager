import crypto from 'crypto'
import db from './db.js'
import { decrypt } from './crypto.js'
import { FALLBACK_KEYS } from './keys.js'
import { getCachedAuth, setCachedAuth, hashAuthPassword, passwordCacheKey } from './state.js'
import { verifySyncPassword, verifyDeviceToken, verifySessionKey, upgradeLegacyPasswordHash } from './lib/sync-password.js'
import { trace } from './utils/trace.js'
import { isAdminPath } from './admin/paths.js'
import { isReadOnlyReplica } from './config.js'
import { assertAccountActive, AuthStateError, StateUnavailableError, AuthUnavailableError } from './admin/account-state.js'
import { kvHeadSource } from './lib/kv-head.js'
import { isSessionDevice } from './lib/session-key.js'

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
            `SELECT d.id, d.account_uuid, d.token_hash, d.revoked, d.expires_at, d.credential_epoch, d.last_used_at,
                    a.key AS account_key, a.credential_epoch AS account_epoch,
                    a.password AS account_password, a.content_hash AS account_content_hash,
                    a.content_hint AS account_content_hint, a.updated_at AS account_updated_at
             FROM device_credentials d
             LEFT JOIN kv_store a ON a.key = d.account_uuid
             WHERE d.account_uuid = $1 AND d.device_id = $2`,
            [String(syncUser), String(deviceId)]
        )
        if (!row) return { ok: false, reason: 'unknown' }
        // The device id decides the check: a session key only ever verifies against its own hash format, a device token only against scrypt.
        const verified = isSessionDevice(String(deviceId))
            ? verifySessionKey(String(token), row.token_hash)
            : (await verifyDeviceToken(String(token), row.token_hash)) === true
        if (!verified) return { ok: false, reason: 'unknown' }
        if (Number(row.revoked) === 1) return { ok: false, reason: 'revoked' }
        if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }
        // Only a workspace row (it always has a password) counts; a passwordless kv_store row at the same key is not an account.
        if (row.account_key == null || row.account_password == null) return { ok: false, reason: 'unknown' }
        if (Number(row.account_epoch) !== Number(row.credential_epoch)) return { ok: false, reason: 'generation' }
        return { ok: true, accountUuid: row.account_uuid, row }
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        trace('auth', 'deviceCredential.error', { user: syncUser, deviceId, error: err?.message })
        throw new AuthUnavailableError(err)
    }
}

// Device credentials authenticate before any password check. Every request re-reads the exact (account_uuid, device_id) row, so
// revocation, expiry, account deletion and epoch bumps apply at once; only the token-hash memo (keyed by the stored hash) skips scrypt.
const LAST_USED_WRITE_MS = 60_000

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
    const sessionDevice = isSessionDevice(deviceId)
    const outcome = await authenticateDeviceCredential(syncUser, deviceId, presented)
    if (outcome.ok) {
        const { row } = outcome
        request.deviceAuth = { accountUuid: outcome.accountUuid }
        // SQLite reads share the connection of an open transaction, so only PostgreSQL's committed head is reusable.
        if (db.type === 'postgres') {
            request.deviceAuth.head = { password: row.account_password, content_hash: row.account_content_hash, content_hint: row.account_content_hint, updated_at: row.account_updated_at }
        }
        // A replica never writes, not even best-effort telemetry, against the follower.
        // A session key is not in the device list, so nothing reads its last use: polls with one write nothing.
        if (!isReadOnlyReplica() && !sessionDevice && !(Number(row.last_used_at) > Date.now() - LAST_USED_WRITE_MS)) {
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
        const cached = getCachedAuth(passwordCacheKey(syncUser))
        if (cached && timingSafeEqual(cached, hashAuthPassword(syncPassword))) {
            trace('auth', 'verifyAuth.accept', { user: syncUser, source: 'cache' })
            return syncUser
        }
        const row = await db.get(`SELECT password FROM ${kvHeadSource()} WHERE key = $1`, [syncUser])
        if (!row?.password) {
            trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'unknown-user' })
            return null
        }
        const verified = await verifySyncPassword(syncPassword, row.password)
        let authorized = verified === true
        let upgradedHash = null
        if (verified === null) {
            const decrypted = decrypt(row.password, FALLBACK_KEYS)
            if (decrypted && timingSafeEqual(decrypted, syncPassword)) {
                authorized = true
                upgradedHash = await upgradeLegacyPasswordHash(db, syncUser, syncPassword)
            }
        }
        if (!authorized) {
            trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'password-mismatch' })
            return null
        }
        setCachedAuth(passwordCacheKey(syncUser), syncPassword, upgradedHash || row.password)
        trace('auth', 'verifyAuth.accept', { user: syncUser, source: verified === null ? 'legacy' : 'password' })
        return syncUser
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        trace('auth', 'verifyAuth.reject', { user: syncUser, reason: 'error', error: err?.message })
        throw new AuthUnavailableError(err)
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
    const cached = getCachedAuth(passwordCacheKey(syncUser))
    if (cached && timingSafeEqual(cached, hashAuthPassword(syncPassword))) {
        trace('auth', 'proxyAuth.accept', { user: syncUser, source: 'cache' })
        return null
    }
    try {
        const row = await db.get(`SELECT password FROM ${kvHeadSource()} WHERE key = $1`, [syncUser])
        if (!row) {
            trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'unknown-user' })
            reply.status(401)
            return { error: 'Unauthorized' }
        }
        const verified = await verifySyncPassword(syncPassword, row.password)
        let authorized = verified === true
        let upgradedHash = null
        if (verified === null) {
            const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
            if (decryptedPassword && timingSafeEqual(decryptedPassword, syncPassword)) {
                authorized = true
                upgradedHash = await upgradeLegacyPasswordHash(db, syncUser, syncPassword)
            }
        }
        if (!authorized) {
            trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'password-mismatch' })
            reply.status(401)
            return { error: 'Unauthorized' }
        }
        setCachedAuth(passwordCacheKey(syncUser), syncPassword, upgradedHash || row.password)
        trace('auth', 'proxyAuth.accept', { user: syncUser, source: verified === null ? 'legacy' : 'password' })
    } catch (err) {
        if (err instanceof AuthStateError || err instanceof StateUnavailableError) throw err
        trace('auth', 'proxyAuth.reject', { user: syncUser, reason: 'error', error: err?.message })
        throw new AuthUnavailableError(err)
    }
    return null
}
