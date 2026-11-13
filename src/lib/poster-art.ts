// One artwork per title across every poster surface: the first image that loads for a
// title is published and every other poster of that title follows it, and an image that
// fails anywhere is skipped everywhere for a while, so fallbacks also land on the same art.
// An img error carries no status, so a first failure (often a 502 or 504 from a busy proxy)
// only backs off briefly; a source that fails again within the window is skipped for the full TTL.

export interface ArtCandidate {
    /** Unsized source URL, the identity shared across poster sizes. */
    base: string
    /** URL this poster requests (sized or proxied for its display width). */
    url: string
}

export const ART_FAILURE_TTL_MS = 10 * 60_000
export const ART_RETRY_AFTER_MS = 30_000

const failedAt = new Map<string, { at: number; repeat: boolean }>()
const published = new Map<string, string>()
const versions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

function bump(key: string): void {
    versions.set(key, (versions.get(key) ?? 0) + 1)
    listeners.get(key)?.forEach(listener => listener())
}

export function artIdentity(input: { imdbId?: string; tmdbId?: number; itemType?: string; kitsuId?: string }): string | null {
    if (input.imdbId) return `imdb:${input.imdbId.toLowerCase()}`
    if (typeof input.tmdbId === 'number') return `tmdb:${input.itemType === 'movie' ? 'movie' : 'tv'}:${input.tmdbId}`
    if (input.kitsuId) return `kitsu:${input.kitsuId}`
    return null
}

export function isArtFailed(base: string, now = Date.now()): boolean {
    const entry = failedAt.get(base)
    if (!entry) return false
    const age = now - entry.at
    if (age > ART_FAILURE_TTL_MS) {
        failedAt.delete(base)
        return false
    }
    return entry.repeat || age <= ART_RETRY_AFTER_MS
}

export function publishedArt(identity: string | null): string | undefined {
    return identity ? published.get(identity) : undefined
}

/** Published art first, then the poster's own sources, minus anything that failed recently. */
export function orderArtCandidates(
    own: readonly ArtCandidate[],
    identity: string | null,
    sizeFor: (base: string) => string,
    now = Date.now(),
    pinned?: ArtCandidate,
): ArtCandidate[] {
    const pub = publishedArt(identity)
    const lead = pub ? [{ base: pub, url: sizeFor(pub) }, ...own.filter(c => c.base !== pub)] : [...own]
    const list = pinned ? [pinned, ...lead.filter(c => c.base !== pinned.base)] : lead
    const seen = new Set<string>()
    return list.filter(c => {
        if (seen.has(c.base) || isArtFailed(c.base, now)) return false
        seen.add(c.base)
        return true
    })
}

export function markArtLoaded(identity: string | null, base: string): void {
    if (!identity || published.has(identity)) return
    published.set(identity, base)
    bump(identity)
}

export function markArtFailed(identity: string | null, base: string, now = Date.now()): void {
    const previous = failedAt.get(base)
    // Another error inside the first backoff is the same failure (a second poster of this source), not a retry.
    if (previous && !previous.repeat && now - previous.at <= ART_RETRY_AFTER_MS) return
    failedAt.set(base, { at: now, repeat: !!previous && now - previous.at <= ART_FAILURE_TTL_MS })
    if (identity && published.get(identity) === base) {
        published.delete(identity)
        bump(identity)
    }
    bump(base)
}

export function subscribeArt(keys: readonly string[], listener: () => void): () => void {
    for (const key of keys) {
        let set = listeners.get(key)
        if (!set) listeners.set(key, set = new Set())
        set.add(listener)
    }
    return () => {
        for (const key of keys) {
            const set = listeners.get(key)
            set?.delete(listener)
            if (set && set.size === 0) listeners.delete(key)
        }
    }
}

export function artSnapshot(keys: readonly string[]): string {
    return keys.map(key => versions.get(key) ?? 0).join(',')
}

/** A reconnect retries everything that failed while offline. */
export function clearArtFailures(): void {
    const keys = [...failedAt.keys()]
    failedAt.clear()
    keys.forEach(bump)
}

export function resetArtRegistryForTests(): void {
    failedAt.clear()
    published.clear()
    versions.clear()
    listeners.clear()
}
