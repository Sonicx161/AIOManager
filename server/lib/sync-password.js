import crypto from 'crypto'
import { promisify } from 'util'
import { isReadOnlyReplica } from '../config.js'

// Stored format is `${saltHex}:${scryptHex}`. Scrypt params must never change:
// verification recomputes the hash, so a param change orphans every stored row.
//
// Both functions are async (promisified crypto.scrypt) so the N=16384 KDF never
// blocks the event loop on auth hot paths (finding #4). A scrypt run occupies a
// libuv threadpool worker instead of the JS thread; concurrency is bounded by
// the pool size, and auth requests interleave freely.
const scryptAsync = promisify(crypto.scrypt)
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
const SCRYPT_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{64}$/

export async function hashSyncPassword(password) {
    const salt = crypto.randomBytes(16)
    const hash = (await scryptAsync(String(password), salt, 32, SCRYPT_PARAMS)).toString('hex')
    return `${salt.toString('hex')}:${hash}`
}

export function isScryptHash(stored) {
    return typeof stored === 'string' && SCRYPT_HASH_RE.test(stored)
}

// Returns true/false for scrypt-formatted stored values, or null when the stored
// value is not a scrypt hash, signaling the caller to fall back to the legacy
// decrypt-and-compare path.
// Concurrent cold checks of the same (stored hash, presented password) pair share one scrypt.
// The key hashes the presented password, so a different or wrong password never rides another
// caller's result; entries live only while the scrypt is in flight.
const verifyInflight = new Map()

const verifyScrypt = async (password, stored) => {
    const [saltHex, hashHex] = stored.split(':')
    const computed = (await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS)).toString('hex')
    const computedBuf = Buffer.from(computed, 'utf8')
    const storedBuf = Buffer.from(hashHex, 'utf8')
    return computedBuf.length === storedBuf.length && crypto.timingSafeEqual(computedBuf, storedBuf)
}

export async function verifySyncPassword(password, stored) {
    if (!isScryptHash(stored)) return null
    const key = crypto.createHash('sha256').update(stored).update(String(password)).digest('hex')
    let pending = verifyInflight.get(key)
    if (!pending) {
        pending = verifyScrypt(password, stored).finally(() => verifyInflight.delete(key))
        verifyInflight.set(key, pending)
    }
    return pending
}

// Opportunistic upgrade after a successful legacy auth. Never throws: a failed
// upgrade must not fail the enclosing request; the next successful auth retries.
// Best-effort hashing for an upgrade whose write happens later (outside a held tx).
export async function prepareLegacyPasswordUpgrade(id, password) {
    if (isReadOnlyReplica()) return null
    try {
        return await hashSyncPassword(password)
    } catch (err) {
        console.warn(`[SyncPassword] Legacy password hash upgrade failed for ${id}: ${err?.message}`)
        return null
    }
}

// Best-effort write of a prepared upgrade; a failure keeps the legacy credential.
export async function applyLegacyPasswordUpgrade(runner, id, hashed) {
    if (!hashed || isReadOnlyReplica()) return null
    try {
        await runner.run('UPDATE kv_store SET password = $1 WHERE key = $2', [hashed, id])
        return hashed
    } catch (err) {
        console.warn(`[SyncPassword] Legacy password hash upgrade failed for ${id}: ${err?.message}`)
        return null
    }
}

export async function upgradeLegacyPasswordHash(runner, id, password) {
    // A read-only replica never writes; the primary upgrades on its next legacy auth.
    if (isReadOnlyReplica()) return null
    try {
        const hashed = await hashSyncPassword(password)
        await runner.run('UPDATE kv_store SET password = $1 WHERE key = $2', [hashed, id])
        return hashed
    } catch (err) {
        console.warn(`[SyncPassword] Legacy password hash upgrade failed for ${id}: ${err?.message}`)
        return null
    }
}
