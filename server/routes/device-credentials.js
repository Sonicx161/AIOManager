import crypto from 'crypto'
import db from '../db.js'
import { verifyAuth } from '../auth.js'
import { assertWritablePrimary } from '../admin/account-state.js'
import { invalidateCachedAuth, invalidateCachedAuthPrefix } from '../state.js'
import { hashSyncPassword } from '../lib/sync-password.js'

const DEVICE_TIERS = new Set(['idb', 'prf'])
// Fixed server-side policy; renewal = re-enroll, which slides expires_at to now + 180d.
const DEVICE_LIFETIME_DAYS = 180
const DAY_MS = 86400000

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

        if (!deviceId || deviceId.length > 128) { reply.status(400); return { error: 'deviceId required (1-128 chars)' } }
        if (!/^[A-Za-z0-9_-]{43,512}$/.test(deviceToken)) { reply.status(400); return { error: 'deviceToken must be 43-512 base64url chars' } }

        try {
            const account = await db.get('SELECT credential_epoch FROM kv_store WHERE key = $1', [authUser])
            if (!account) { reply.status(404); return { error: 'Account not found' } }
            const now = Date.now()
            const expiresAt = now + DEVICE_LIFETIME_DAYS * DAY_MS
            const epoch = Number(account.credential_epoch) || 1
            // scrypt stays outside the tx (finding #4): the hash depends only on the request.
            const tokenHash = await hashSyncPassword(deviceToken)
            const row = await db.tx(async (tx) => {
                await tx.run('DELETE FROM device_credentials WHERE account_uuid = $1 AND device_id = $2', [authUser, deviceId])
                const id = crypto.randomUUID()
                await tx.run(
                    `INSERT INTO device_credentials (id, account_uuid, device_id, token_hash, tier, label, created_at, expires_at, revoked, last_used_at, credential_epoch)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, $9)`,
                    [id, authUser, deviceId, tokenHash, tier, label, now, expiresAt, epoch]
                )
                return await tx.get('SELECT * FROM device_credentials WHERE id = $1', [id])
            })
            // Re-enrollment replaced the credential: any cached token for this device is dead.
            invalidateCachedAuth('device:' + authUser + ':' + deviceId)
            return { success: true, device: publicDeviceRecord(row) }
        } catch {
            reply.status(500)
            return { error: 'Enrollment failed' }
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
            const row = await db.get(
                'SELECT id FROM device_credentials WHERE account_uuid = $1 AND device_id = $2',
                [authUser, deviceId]
            )
            if (!row) return { success: true, found: false }
            await db.run('UPDATE device_credentials SET revoked = 1 WHERE id = $1', [row.id])
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
                'SELECT id, device_id, tier, label, created_at, expires_at, revoked, last_used_at, credential_epoch FROM device_credentials WHERE account_uuid = $1 ORDER BY created_at DESC',
                [authUser]
            )
            return { devices: (rows || []).map(publicDeviceRecord) }
        } catch {
            return { devices: [] }
        }
    })
}
