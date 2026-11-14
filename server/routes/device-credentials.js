import crypto from 'crypto'
import db from '../db.js'
import { verifyAuth, authenticateDeviceCredential, timingSafeEqual } from '../auth.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { assertWritablePrimary } from '../admin/account-state.js'
import { invalidateCachedAuth, invalidateCachedAuthPrefix, getCachedAuthBound, hashAuthPassword } from '../state.js'
import { hashSyncPassword, hashSessionKey, verifySyncPassword } from '../lib/sync-password.js'
import { isReadOnlyReplica } from '../config.js'
import { SESSION_DEVICE_PREFIX, SESSION_KEY_LIFETIME_MS, SESSION_KEYS_PER_ACCOUNT, isSessionDevice } from '../lib/session-key.js'

const DEVICE_TIERS = new Set(['idb', 'prf'])
// Fixed server-side policy; renewal = re-enroll, which slides expires_at to now + 180d.
const DEVICE_LIFETIME_DAYS = 180
const DAY_MS = 86400000
const SESSION_SWEEP_MS = 60 * 60 * 1000

// Session keys of closed tabs are never revoked by anyone, so expired ones are removed here.
export async function sweepExpiredSessionKeys(now = Date.now()) {
    if (isReadOnlyReplica()) return 0
    const result = await db.run('DELETE FROM device_credentials WHERE substr(device_id, 1, 8) = $1 AND expires_at < $2', [SESSION_DEVICE_PREFIX, now])
    return result?.changes || 0
}

async function passwordMatchesLockedRow(request, user, row) {
    if (!row?.password) return false
    const password = request.headers['x-sync-password']
    const cached = getCachedAuthBound('sync:' + user, row.password)
    if (cached && timingSafeEqual(cached, hashAuthPassword(password))) return true
    const verified = await verifySyncPassword(password, row.password)
    if (verified !== null) return verified === true
    const decrypted = decrypt(row.password, FALLBACK_KEYS)
    return !!decrypted && timingSafeEqual(decrypted, password)
}

function publicDeviceRecord(row) {
    return {
        id: row.id,
        deviceId: row.device_id,
        tier: row.tier,
        label: row.label,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
        revoked: Number(row.revoked) === 1,
        lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
        credentialEpoch: Number(row.credential_epoch),
    }
}

export function registerDeviceCredentialRoutes(fastify) {
    fastify.post('/api/devices/enroll', {
        bodyLimit: 8192,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const body = request.body || {}
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
        const deviceToken = typeof body.deviceToken === 'string' ? body.deviceToken : ''
        const tier = DEVICE_TIERS.has(body.tier) ? body.tier : 'idb'
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 100) : null

        if (!deviceId || deviceId.length > 128 || isSessionDevice(deviceId)) { reply.status(400); return { error: 'deviceId required (1-128 chars)' } }
        if (request.deviceAuth && (isSessionDevice(request.headers['x-sync-device']) || request.headers['x-sync-device'] !== deviceId)) { reply.status(403); return { error: 'Password sign-in required' } }
        if (!/^[A-Za-z0-9_-]{43,512}$/.test(deviceToken)) { reply.status(400); return { error: 'deviceToken must be 43-512 base64url chars' } }

        try {
            const account = await db.get('SELECT credential_epoch FROM kv_store WHERE key = $1', [authUser])
            if (!account) { reply.status(404); return { error: 'Account not found' } }
            const self = request.deviceAuth ? await authenticateDeviceCredential(authUser, deviceId, request.headers['x-sync-password']) : null
            if (request.deviceAuth && !self?.ok) { reply.status(401); return { error: 'Unauthorized' } }
            const now = Date.now()
            const expiresAt = now + DEVICE_LIFETIME_DAYS * DAY_MS
            const epoch = Number(account.credential_epoch) || 1
            // scrypt stays outside the tx (finding #4): the hash depends only on the request.
            const tokenHash = await hashSyncPassword(deviceToken)
            const row = await db.tx(async (tx) => {
                const lock = db.type === 'postgres' ? ' FOR UPDATE' : ''
                const current = await tx.get('SELECT password, credential_epoch FROM kv_store WHERE key = $1' + lock, [authUser])
                if (!current || Number(current.credential_epoch) !== Number(account.credential_epoch)) return { unauthorized: true }
                const existing = await tx.get('SELECT id, token_hash, revoked, expires_at, credential_epoch FROM device_credentials WHERE account_uuid = $1 AND device_id = $2', [authUser, deviceId])
                if (isSessionDevice(deviceId.toLowerCase()) && !existing) return { reserved: true }
                if (self) {
                    if (!existing || existing.id !== self.row.id || existing.token_hash !== self.row.token_hash || Number(existing.revoked) === 1 || Number(existing.expires_at) <= Date.now() || Number(existing.credential_epoch) !== Number(current.credential_epoch)) return { unauthorized: true }
                } else if (!(await passwordMatchesLockedRow(request, authUser, current))) return { unauthorized: true }
                if (existing) {
                    const liveCondition = self ? ' AND revoked = 0 AND expires_at > $11 AND credential_epoch = $12' : ''
                    const params = [tokenHash, tier, label, now, expiresAt, Number(current.credential_epoch) || 1, existing.id, authUser, deviceId, existing.token_hash]
                    if (self) params.push(Date.now(), epoch)
                    const updated = await tx.run(
                        `UPDATE device_credentials SET token_hash = $1, tier = $2, label = $3, created_at = $4, expires_at = $5, last_used_at = NULL, revoked = 0, credential_epoch = $6
                         WHERE id = $7 AND account_uuid = $8 AND device_id = $9 AND token_hash = $10${liveCondition}`,
                        params
                    )
                    if (!updated.changes) return { unauthorized: true }
                    return await tx.get('SELECT * FROM device_credentials WHERE id = $1', [existing.id])
                }
                const id = crypto.randomUUID()
                await tx.run(
                    `INSERT INTO device_credentials (id, account_uuid, device_id, token_hash, tier, label, created_at, expires_at, revoked, last_used_at, credential_epoch)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, $9)`,
                    [id, authUser, deviceId, tokenHash, tier, label, now, expiresAt, epoch]
                )
                return await tx.get('SELECT * FROM device_credentials WHERE id = $1', [id])
            }, { immediate: true })
            if (row.reserved) { reply.status(400); return { error: 'deviceId required (1-128 chars)' } }
            if (row.unauthorized) { reply.status(401); return { error: 'Unauthorized' } }
            // Re-enrollment replaced the credential: any cached token for this device is dead.
            invalidateCachedAuth('device:' + authUser + ':' + deviceId)
            return { success: true, device: publicDeviceRecord(row) }
        } catch {
            reply.status(500)
            return { error: 'Enrollment failed' }
        }
    })

    // One key per password sign-in, generated here so it is always random and can be stored as a plain SHA-256. It authenticates on the device path,
    // lives one day, and only a password-authenticated request can ask for one.
    fastify.post('/api/devices/session', {
        bodyLimit: 1024,
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        if (request.deviceAuth) { reply.status(403); return { error: 'Password sign-in required' } }
        assertWritablePrimary()

        try {
            const account = await db.get('SELECT password, credential_epoch FROM kv_store WHERE key = $1', [authUser])
            if (!account) { reply.status(404); return { error: 'Account not found' } }
            const now = Date.now()
            const expiresAt = now + SESSION_KEY_LIFETIME_MS
            const deviceId = SESSION_DEVICE_PREFIX + crypto.randomUUID()
            const token = crypto.randomBytes(32).toString('base64url')
            const tokenHash = hashSessionKey(token)
            const issued = await db.tx(async (tx) => {
                const lock = db.type === 'postgres' ? ' FOR UPDATE' : ''
                const current = await tx.get('SELECT password, credential_epoch FROM kv_store WHERE key = $1' + lock, [authUser])
                if (!current || current.password !== account.password || Number(current.credential_epoch) !== Number(account.credential_epoch) || !(await passwordMatchesLockedRow(request, authUser, current))) return false
                await tx.run(
                    // Keeps this account's newest live keys; its expired ones and anything over the cap go with this sign-in.
                    `DELETE FROM device_credentials WHERE account_uuid = $1 AND substr(device_id, 1, 8) = $2 AND id NOT IN (
                        SELECT id FROM device_credentials WHERE account_uuid = $3 AND substr(device_id, 1, 8) = $4 AND expires_at >= $5
                        ORDER BY created_at DESC LIMIT ${SESSION_KEYS_PER_ACCOUNT - 1}
                     )`,
                    [authUser, SESSION_DEVICE_PREFIX, authUser, SESSION_DEVICE_PREFIX, now]
                )
                await tx.run(
                    `INSERT INTO device_credentials (id, account_uuid, device_id, token_hash, tier, label, created_at, expires_at, revoked, last_used_at, credential_epoch)
                     VALUES ($1, $2, $3, $4, 'idb', NULL, $5, $6, 0, NULL, $7)`,
                    [crypto.randomUUID(), authUser, deviceId, tokenHash, now, expiresAt, Number(account.credential_epoch) || 1]
                )
                return true
            }, { immediate: true })
            if (!issued) { reply.status(401); return { error: 'Unauthorized' } }
            reply.header('Cache-Control', 'no-store')
            return { success: true, session: { deviceId, token, expiresAt } }
        } catch (err) {
            if (err?.statusCode === 503) throw err
            reply.status(500)
            return { error: 'Session key failed' }
        }
    })

    fastify.post('/api/devices/revoke', {
        bodyLimit: 2048,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const body = request.body || {}
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
        if (!deviceId) { reply.status(400); return { error: 'deviceId required' } }

        try {
            const found = await db.tx(async (tx) => {
                const lock = db.type === 'postgres' ? ' FOR UPDATE' : ''
                const account = await tx.get('SELECT credential_epoch FROM kv_store WHERE key = $1' + lock, [authUser])
                if (!account) return false
                const result = isSessionDevice(deviceId)
                    ? await tx.run('DELETE FROM device_credentials WHERE account_uuid = $1 AND device_id = $2', [authUser, deviceId])
                    : await tx.run('UPDATE device_credentials SET revoked = 1 WHERE account_uuid = $1 AND device_id = $2', [authUser, deviceId])
                return result.changes > 0
            }, { immediate: true })
            if (!found) return { success: true, found: false }
            invalidateCachedAuth('sync:' + authUser)
            invalidateCachedAuth('device:' + authUser + ':' + deviceId)
            return { success: true, found: true }
        } catch {
            reply.status(500)
            return { error: 'Revoke failed' }
        }
    })

    fastify.post('/api/devices/revoke-everywhere', {
        bodyLimit: 1024,
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        try {
            const account = await db.get('SELECT credential_epoch FROM kv_store WHERE key = $1', [authUser])
            if (!account) { reply.status(404); return { error: 'Account not found' } }
            const nextEpoch = (Number(account.credential_epoch) || 1) + 1
            await db.run('UPDATE kv_store SET credential_epoch = $1 WHERE key = $2', [nextEpoch, authUser])
            invalidateCachedAuth('sync:' + authUser)
            invalidateCachedAuthPrefix('device:' + authUser + ':')
            return { success: true, credentialEpoch: nextEpoch }
        } catch {
            reply.status(500)
            return { error: 'Revoke everywhere failed' }
        }
    })

    fastify.post('/api/devices/rename', {
        bodyLimit: 2048,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const body = request.body || {}
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 100) : ''
        if (!deviceId) { reply.status(400); return { error: 'deviceId required' } }
        if (!label) { reply.status(400); return { error: 'label required' } }

        try {
            const row = await db.get('SELECT id FROM device_credentials WHERE account_uuid = $1 AND device_id = $2', [authUser, deviceId])
            if (!row) { reply.status(404); return { error: 'Device not found' } }
            await db.run('UPDATE device_credentials SET label = $1 WHERE id = $2', [label, row.id])
            const updated = await db.get('SELECT * FROM device_credentials WHERE id = $1', [row.id])
            return { success: true, device: publicDeviceRecord(updated) }
        } catch {
            reply.status(500)
            return { error: 'Rename failed' }
        }
    })

    fastify.get('/api/devices', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        try {
            // Only the columns publicDeviceRecord reads; never pulls token_hash material.
            const rows = await db.query(
                'SELECT id, device_id, tier, label, created_at, expires_at, revoked, last_used_at, credential_epoch FROM device_credentials WHERE account_uuid = $1 AND substr(device_id, 1, 8) <> $2 ORDER BY created_at DESC',
                [authUser, SESSION_DEVICE_PREFIX]
            )
            return { devices: (rows || []).map(publicDeviceRecord) }
        } catch {
            return { devices: [] }
        }
    })

    const sweep = setInterval(() => { sweepExpiredSessionKeys().catch(() => {}) }, SESSION_SWEEP_MS)
    sweep.unref()
    fastify.addHook('onClose', async () => clearInterval(sweep))
}
