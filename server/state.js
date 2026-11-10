import crypto from 'crypto'

export const authCache = new Map()
export const AUTH_CACHE_TTL = 60_000

// Env-tunable LRU cap for the shared auth cache (sync + device namespaces);
// see setCachedAuth for the sizing rationale.
export const AUTH_CACHE_MAX = Math.max(1000, parseInt(process.env.AUTH_CACHE_MAX || '10000', 10) || 10000)

export const hashAuthPassword = (password) => crypto.createHash('sha256').update(String(password)).digest('hex')

export function getCachedAuth(key) {
    const entry = authCache.get(key)
    if (!entry) return null
    if (Date.now() - entry.ts > AUTH_CACHE_TTL) {
        authCache.delete(key)
        return null
    }
    authCache.delete(key)
    authCache.set(key, entry)
    return entry.passwordHash
}

// Bound variant: an entry created with setCachedAuth(key, password, storedHash)
// certifies that password only for that exact stored credential. A hit requires
// the stored credential still to be the identical string, so a stale entry can
// never authorize against a credential it did not verify (e.g. installed by a
// racing restore). Entries without a binding never match here.
export function getCachedAuthBound(key, storedHash) {
    const entry = authCache.get(key)
    if (!entry || entry.bound === undefined || entry.bound !== storedHash) return null
    if (Date.now() - entry.ts > AUTH_CACHE_TTL) {
        authCache.delete(key)
        return null
    }
    authCache.delete(key)
    authCache.set(key, entry)
    return entry.passwordHash
}

export function setCachedAuth(key, password, boundHash) {
    authCache.set(key, { passwordHash: hashAuthPassword(password), ts: Date.now(), ...(boundHash !== undefined ? { bound: boundHash } : {}) })
    // Cap sized for the namespace mix: 'sync:<uuid>' (one per account) plus
    // 'device:<uuid>:<deviceId>' (one per enrolled device). Above the cap the
    // LRU evicts entries inside their 60s TTL, so every request from the
    // evicted credentials pays a DB read, a device-token scrypt and a
    // last_used_at write. Default 10 000 keeps both namespaces resident for
    // public instances: ~350 bytes per entry (64-char hex hash string, key
    // string, Map slots, entry object) -> ~3.5 MB at the cap, versus ~1 MB at
    // the old 1000. AUTH_CACHE_MAX overrides; below the previous default of
    // 1000 is rejected to keep a typo from silently reintroducing the thrash.
    if (authCache.size > AUTH_CACHE_MAX) {
        const oldest = authCache.keys().next().value
        authCache.delete(oldest)
    }
}

export function invalidateCachedAuth(key) {
    authCache.delete(key)
}

// Invalidate every entry under a namespace prefix, e.g. 'device:<uuid>:' when
// a credential epoch bump kills all of an account's device sessions.
export function invalidateCachedAuthPrefix(prefix) {
    for (const key of authCache.keys()) {
        if (key.startsWith(prefix)) authCache.delete(key)
    }
}

export const proxyQueue = []
export const domainLastRequestTime = new Map()
export const globalHealthCache = new Map()
export const healthCheckInFlight = new Map()
export const proxyQueueKeyCounts = new Map()

export const connectionHealthCache = new Map()
export const driverRegistry = new Map()

export const serverState = {
    activeProxyRequests: 0,
    domainLastPruneTime: 0,
    isWorkerRunning: false,
    lastWorkerRun: Date.now(),
    autopilotInterval: null,
    autopilotScanCursor: '',
    autopilotLastCycleStats: null,
    autopilotLastCycleEndedAt: null,
    autopilotWatchdog: null
}
