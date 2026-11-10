// Client-side reuse of vended RealStream tokens. An entry belongs to one owner: the
// sync session (workspace, sync server), the account, the connection and its exact
// credentials and incarnation. Reauth, a base URL edit or a re-added connection
// therefore never sees the previous token, and session changes drop everything.
// A load that started before an invalidation rejects instead of handing back a
// token minted for the superseded credentials.

const TOKEN_BUFFER_MS = 5 * 60 * 1000
const DEFAULT_TTL_MS = 60 * 60 * 1000

interface CachedRealStreamToken {
    accessToken: string
    expiresAt: number
}

export interface RealStreamTokenOwner {
    session: string
    accountId: string
    connection: {
        id: string
        generation?: string
        credentials?: Record<string, string>
    }
}

interface Entry {
    connectionId: string
    token: CachedRealStreamToken
}

const cache = new Map<string, Entry>()
const inFlight = new Map<string, { connectionId: string; promise: Promise<CachedRealStreamToken> }>()
const renewals = new Map<string, { connectionId: string; rejected: string; promise: Promise<CachedRealStreamToken> }>()
const connectionGenerations = new Map<string, number>()
let epoch = 0

export function realStreamTokenKey(owner: RealStreamTokenOwner): string {
    const { connection } = owner
    return JSON.stringify([owner.session, owner.accountId, connection.id, connection.generation ?? null, connection.credentials ?? null])
}

export class RealStreamTokenSupersededError extends Error {
    constructor() {
        super('RealStream credentials changed while a token was being fetched')
        this.name = 'RealStreamTokenSupersededError'
    }
}

export function getCachedRealStreamToken(owner: RealStreamTokenOwner): CachedRealStreamToken | null {
    const key = realStreamTokenKey(owner)
    const entry = cache.get(key)
    if (!entry) return null
    if (Date.now() > entry.token.expiresAt - TOKEN_BUFFER_MS) {
        cache.delete(key)
        return null
    }
    return entry.token
}

export async function getOrFetchRealStreamToken(
    owner: RealStreamTokenOwner,
    load: () => Promise<{ accessToken: string; expiresAt?: number }>,
): Promise<CachedRealStreamToken> {
    const key = realStreamTokenKey(owner)
    const cached = getCachedRealStreamToken(owner)
    if (cached) return cached
    const existing = inFlight.get(key)
    if (existing) return existing.promise
    const connectionId = owner.connection.id
    const startEpoch = epoch
    const startGeneration = connectionGenerations.get(connectionId) ?? 0
    const promise = load().then((token) => {
        if (!token?.accessToken) throw new Error('RealStream token response did not include an access token')
        if (startEpoch !== epoch || startGeneration !== (connectionGenerations.get(connectionId) ?? 0)) {
            throw new RealStreamTokenSupersededError()
        }
        const entry = {
            accessToken: token.accessToken,
            expiresAt: token.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
        }
        cache.set(key, { connectionId, token: entry })
        return entry
    }).finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
    })
    inFlight.set(key, { connectionId, promise })
    return promise
}

// Forced renewal after the server rejected a token. Callers that hit the same
// rejected token join one renewal, and a token already renewed past it is reused;
// only then is the connection invalidated and a fresh token fetched.
export function refreshRealStreamToken(
    owner: RealStreamTokenOwner,
    rejectedAccessToken: string,
    load: () => Promise<{ accessToken: string; expiresAt?: number }>,
): Promise<CachedRealStreamToken> {
    const key = realStreamTokenKey(owner)
    const pending = renewals.get(key)
    if (pending && pending.rejected === rejectedAccessToken) return pending.promise
    const cached = getCachedRealStreamToken(owner)
    if (cached && cached.accessToken !== rejectedAccessToken) return Promise.resolve(cached)
    invalidateRealStreamToken(owner.connection.id)
    const promise = getOrFetchRealStreamToken(owner, load).finally(() => {
        if (renewals.get(key)?.promise === promise) renewals.delete(key)
    })
    renewals.set(key, { connectionId: owner.connection.id, rejected: rejectedAccessToken, promise })
    return promise
}

export function invalidateRealStreamToken(connectionId: string) {
    connectionGenerations.set(connectionId, (connectionGenerations.get(connectionId) ?? 0) + 1)
    for (const [key, entry] of cache) if (entry.connectionId === connectionId) cache.delete(key)
    for (const [key, entry] of inFlight) if (entry.connectionId === connectionId) inFlight.delete(key)
    for (const [key, entry] of renewals) if (entry.connectionId === connectionId) renewals.delete(key)
}

export function clearRealStreamTokens() {
    epoch++
    cache.clear()
    inFlight.clear()
    renewals.clear()
}
