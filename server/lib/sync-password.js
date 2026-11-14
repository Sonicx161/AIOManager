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

// A session key is 256 random bits this server generated, so it is stored as a plain SHA-256 under its own prefix.
// The prefix can never match the scrypt format above, and passwords and device tokens are never checked this way.
const SESSION_KEY_HASH_RE = /^s256:[0-9a-f]{64}$/
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/

export function isSessionKeyHash(stored) {
    return typeof stored === 'string' && SESSION_KEY_HASH_RE.test(stored)
}

export function hashSessionKey(key) {
    return `s256:${crypto.createHash('sha256').update(String(key)).digest('hex')}`
}

export function verifySessionKey(key, stored) {
    if (typeof key !== 'string' || !SESSION_KEY_RE.test(key) || !isSessionKeyHash(stored)) return false
    const computed = crypto.createHash('sha256').update(key).digest()
    const expected = Buffer.from(stored.slice(5), 'hex')
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected)
}

// Returns true/false for scrypt-formatted stored values, or null when the stored
// value is not a scrypt hash, signaling the caller to fall back to the legacy
// decrypt-and-compare path.
// Concurrent cold checks of the same (stored hash, presented password) pair share one scrypt.
// The key hashes the presented password, so a different or wrong password never rides another
// caller's result; entries live only while the scrypt is in flight.
const verifyInflight = new Map()

// Device tokens only: an entry is a fast check of the secret, safe for 256 random bits and not for a password.
const VERIFIED_MAX_ENTRIES = 100_000
const VERIFIED_TTL_MS = 12 * 60 * 60 * 1000
const VERIFIED_SWEEP_MS = 5 * 60 * 1000
const verifiedTokens = new Map()

const isVerifiedToken = (key) => {
    const at = verifiedTokens.get(key)
    if (at === undefined) return false
    verifiedTokens.delete(key)
    if (Date.now() - at > VERIFIED_TTL_MS) return false
    verifiedTokens.set(key, at)
    return true
}

const rememberVerifiedToken = (key) => {
    verifiedTokens.delete(key)
    verifiedTokens.set(key, Date.now())
    if (verifiedTokens.size > VERIFIED_MAX_ENTRIES) verifiedTokens.delete(verifiedTokens.keys().next().value)
}

setInterval(() => {
    const now = Date.now()
    for (const [key, at] of verifiedTokens) if (now - at > VERIFIED_TTL_MS) verifiedTokens.delete(key)
}, VERIFIED_SWEEP_MS).unref()

const verifyScrypt = async (password, stored) => {
    const [saltHex, hashHex] = stored.split(':')
    const computed = (await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS)).toString('hex')
    const computedBuf = Buffer.from(computed, 'utf8')
    const storedBuf = Buffer.from(hashHex, 'utf8')
    return computedBuf.length === storedBuf.length && crypto.timingSafeEqual(computedBuf, storedBuf)
}

const verifyShared = (password, stored, memo) => {
    // A session key hash is refused here outright, so it never reaches the legacy compare either.
    if (isSessionKeyHash(stored)) return false
    if (!isScryptHash(stored)) return null
    const key = crypto.createHash('sha256').update(stored).update(String(password)).digest('hex')
    if (memo && isVerifiedToken(key)) return true
    let pending = verifyInflight.get(key)
    if (!pending) {
        pending = verifyScrypt(password, stored).finally(() => verifyInflight.delete(key))
        verifyInflight.set(key, pending)
    }
    return memo ? pending.then((ok) => { if (ok) rememberVerifiedToken(key); return ok }) : pending
}

export async function verifySyncPassword(password, stored) {
    return verifyShared(password, stored, false)
}

// Only for tokens the client generated at random; a repeat of a verified token skips the KDF.
export async function verifyDeviceToken(token, stored) {
    return verifyShared(token, stored, true)
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
