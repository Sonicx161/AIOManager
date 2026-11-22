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

// Password cache key for one workspace id, encoded so no id can collide with another key.
export const passwordCacheKey = (id) => JSON.stringify(['sync', String(id)])

export function setCachedAuth(key, password, boundHash) {
    authCache.set(key, { passwordHash: hashAuthPassword(password), ts: Date.now(), ...(boundHash !== undefined ? { bound: boundHash } : {}) })
    // One entry per workspace with a recent password check (~350 bytes each, ~3.5 MB at the
    // default 10 000 cap). Above the cap the LRU evicts entries inside their 60s TTL, so those
    // workspaces pay a DB read and a password scrypt again. AUTH_CACHE_MAX overrides; below
    // 1000 is rejected to keep a typo from silently reintroducing the thrash.
    if (authCache.size > AUTH_CACHE_MAX) {
        const oldest = authCache.keys().next().value
        authCache.delete(oldest)
    }
}

export function invalidateCachedAuth(key) {
    authCache.delete(key)
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
