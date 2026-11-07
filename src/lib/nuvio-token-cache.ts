const TOKEN_BUFFER_MS = 5 * 60 * 1000
const DEFAULT_TTL_MS = 60 * 60 * 1000

interface CachedNuvioToken {
    accessToken: string
    profileId: string | null
    expiresAt: number
}

const cache = new Map<string, CachedNuvioToken>()
const inFlight = new Map<string, Promise<CachedNuvioToken>>()
const generations = new Map<string, number>()
const revisions = new Map<string, number>()

interface NuvioTokenScope {
    accountId?: string
    baseUrl?: string | null
}

function cacheKey(connectionId: string, scope?: NuvioTokenScope): string {
    return `${scope?.accountId ?? ''}|${scope?.baseUrl ?? ''}|${connectionId}`
}

export function getCachedNuvioToken(connectionId: string, scope?: NuvioTokenScope): CachedNuvioToken | null {
    const key = cacheKey(connectionId, scope)
    const entry = cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt - TOKEN_BUFFER_MS) {
        cache.delete(key)
        return null
    }
    return entry
}

export function setCachedNuvioToken(connectionId: string, token: { accessToken: string; profileId?: string | null; expiresAt?: number }, scope?: NuvioTokenScope) {
    if (!token?.accessToken) return
    const key = cacheKey(connectionId, scope)
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
    cache.set(key, {
        accessToken: token.accessToken,
        profileId: token.profileId ?? null,
        expiresAt: token.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
    })
}

export async function getOrFetchNuvioToken(
    connectionId: string,
    load: () => Promise<{ accessToken: string; profileId?: string | null; expiresAt?: number }>,
    scope?: NuvioTokenScope,
): Promise<CachedNuvioToken> {
    const key = cacheKey(connectionId, scope)
    const cached = getCachedNuvioToken(connectionId, scope)
    if (cached) return cached
    const existing = inFlight.get(key)
    if (existing) return existing
    const generation = generations.get(key) ?? 0
    const revision = revisions.get(key) ?? 0
    const pending = load().then((token) => {
        if (!token?.accessToken) throw new Error('Nuvio token response did not include an access token')
        if (generation === (generations.get(key) ?? 0) && revision === (revisions.get(key) ?? 0)) setCachedNuvioToken(connectionId, token, scope)
        const newer = cache.get(key)
        if (newer && (generation !== (generations.get(key) ?? 0) || revision !== (revisions.get(key) ?? 0))) return newer
        return {
            accessToken: token.accessToken,
            profileId: token.profileId ?? null,
            expiresAt: token.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
        }
    }).finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key)
    })
    inFlight.set(key, pending)
    return pending
}

export function invalidateNuvioToken(connectionId: string, scope?: NuvioTokenScope) {
    const prefix = scope ? cacheKey(connectionId, scope) : null
    for (const key of new Set([...cache.keys(), ...inFlight.keys(), ...generations.keys()])) {
        if (prefix ? key !== prefix : !key.endsWith(`|${connectionId}`)) continue
        generations.set(key, (generations.get(key) ?? 0) + 1)
        cache.delete(key)
        inFlight.delete(key)
    }
}
