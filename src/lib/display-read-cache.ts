// Short-lived stale-while-revalidate cache for display-only reads (Nuvio
// workspace tabs, grid membership, public avatar catalog, Stremio GetUser).
// Entries are keyed by the caller's full read identity (account + connection +
// backend + login scope or auth-key hash), so two accounts, backends or logins
// never share an entry. Failures are never cached. The cache is cleared on
// vault lock and logout: registered in authStore.lock and
// store-coordinator.resetAllStores.

export const DISPLAY_READ_TTL_MS = 60 * 1000

export interface DisplayCacheEntry<T> {
    value: T
    fetchedAt: number
}

interface CacheOptions {
    ttlMs?: number
    // Skip the freshness check and re-read, then refresh the stored entry.
    force?: boolean
}

const cache = new Map<string, DisplayCacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
let generation = 0

export function peekDisplayCache<T>(key: string): DisplayCacheEntry<T> | null {
    const entry = cache.get(key)
    return entry ? (entry as DisplayCacheEntry<T>) : null
}

export function isDisplayCacheFresh(entry: DisplayCacheEntry<unknown>, ttlMs: number = DISPLAY_READ_TTL_MS): boolean {
    return Date.now() - entry.fetchedAt < ttlMs
}

// Fresh entry resolves without calling load (0 requests). A stale or missing
// entry single-flights one load and every concurrent caller joins it.
export async function cachedRead<T>(key: string, load: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
    const ttlMs = options.ttlMs ?? DISPLAY_READ_TTL_MS
    const cached = cache.get(key)
    if (!options.force && cached && Date.now() - cached.fetchedAt < ttlMs) return cached.value as T
    const pending = inflight.get(key)
    if (pending) return pending as Promise<T>
    const gen = generation
    const promise = load().then((value) => {
        if (inflight.get(key) === promise) inflight.delete(key)
        // A result that lands after a lock/logout clear is dropped, never re-seeded.
        if (gen === generation) cache.set(key, { value, fetchedAt: Date.now() })
        return value
    }).catch((error) => {
        if (inflight.get(key) === promise) inflight.delete(key)
        throw error
    })
    inflight.set(key, promise)
    return promise
}

// Vault lock and logout clear everything; a prefix clears one family only.
// In-flight reads are dropped too, so they cannot re-seed after the clear.
export function clearDisplayReadCache(prefix?: string) {
    generation += 1
    if (!prefix) {
        cache.clear()
        inflight.clear()
        return
    }
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key)
    }
    for (const key of [...inflight.keys()]) {
        if (key.startsWith(prefix)) inflight.delete(key)
    }
}
