import { getEpisodeIdentity } from '@/lib/activity-utils'
import { getCachedCinemetaTmdbId } from '@/lib/cinemeta-cache'
import { loadImdbTmdbCache } from '@/lib/utils'

// Comparison-only aliases between a tmdb: id and the IMDb id of the same title, taken only
// from authoritative mappings (Cinemeta, the imdb->tmdb cache), never guessed from titles.
// Stored ids, tombstone keys, badges and event ids are never rewritten; dedup and tombstone
// checks look through the alias so one play recorded under both ids counts once.

type Kind = 'movie' | 'series'

const tmdbToImdb = new Map<string, string>()
const imdbToTmdb = new Map<string, string>()
const conflicted = new Set<string>()
let version = 0

/** Bumps whenever the known mappings change, so tombstones can be re-applied through new aliases. */
export function tmdbAliasVersion(): number {
    return version
}

function kindOf(type: string | undefined): Kind | undefined {
    if (type === 'movie') return 'movie'
    if (type === 'series' || type === 'anime' || type === 'episode' || type === 'tv') return 'series'
    return undefined
}

function tmdbKey(kind: Kind, tmdbId: string): string {
    return `${kind}|${tmdbId}`
}

function imdbKey(kind: Kind, imdbId: string): string {
    return `${kind}|${imdbId}`
}

/** Records tmdb:N <-> ttX for one kind. A tmdb id claimed by two IMDb ids (or vice versa) is dropped for good. */
export function registerTmdbAlias(imdbId: string, tmdbId: string | number, type: string | undefined): void {
    const kind = kindOf(type)
    const raw = String(tmdbId).replace(/^tmdb:/i, '')
    if (!kind || !imdbId.startsWith('tt') || !/^\d+$/.test(raw)) return
    const tKey = tmdbKey(kind, `tmdb:${raw}`)
    const iKey = imdbKey(kind, imdbId)
    if (conflicted.has(tKey) || conflicted.has(iKey)) return
    const knownImdb = tmdbToImdb.get(tKey)
    const knownTmdb = imdbToTmdb.get(iKey)
    if ((knownImdb && knownImdb !== imdbId) || (knownTmdb && knownTmdb !== `tmdb:${raw}`)) {
        conflicted.add(tKey)
        conflicted.add(iKey)
        if (knownImdb) imdbToTmdb.delete(imdbKey(kind, knownImdb))
        if (knownTmdb) tmdbToImdb.delete(tmdbKey(kind, knownTmdb))
        tmdbToImdb.delete(tKey)
        imdbToTmdb.delete(iKey)
        version++
        return
    }
    if (knownImdb === imdbId) return
    tmdbToImdb.set(tKey, imdbId)
    imdbToTmdb.set(iKey, `tmdb:${raw}`)
    version++
}

/** Registers aliases for IMDb items from metadata already on hand (Cinemeta cache, imdb->tmdb cache); never fetches. */
export function registerKnownTmdbAliases(items: ReadonlyArray<{ itemId: string; type: string }>): void {
    let cache: Record<string, string> | null = null
    for (const item of items) {
        if (!item.itemId?.startsWith('tt') || !kindOf(item.type)) continue
        const fromCinemeta = getCachedCinemetaTmdbId(item.itemId)
        if (fromCinemeta !== undefined) {
            registerTmdbAlias(item.itemId, fromCinemeta, item.type)
            continue
        }
        cache ??= loadImdbTmdbCache()
        const cached = cache[item.itemId]
        if (cached) registerTmdbAlias(item.itemId, cached, item.type)
    }
}

/** The other id of the same title, or undefined when no unambiguous alias is known. */
export function aliasItemId(itemId: string, type: string | undefined): string | undefined {
    const kind = kindOf(type)
    if (!kind || !itemId) return undefined
    if (itemId.startsWith('tmdb:')) return tmdbToImdb.get(tmdbKey(kind, itemId))
    if (itemId.startsWith('tt')) return imdbToTmdb.get(imdbKey(kind, itemId))
    return undefined
}

function swapPrefix(value: string | undefined, from: string, to: string): string | undefined {
    if (!value) return value
    return value === from || value.startsWith(`${from}:`) ? to + value.slice(from.length) : value
}

/** The item as it would be keyed under its IMDb id; the item itself when it has none. */
export function canonicalIds<T extends { itemId: string; uniqueItemId?: string; type: string }>(item: T): T {
    if (!item.itemId.startsWith('tmdb:')) return item
    const imdb = aliasItemId(item.itemId, item.type)
    if (!imdb) return item
    return { ...item, itemId: imdb, uniqueItemId: swapPrefix(item.uniqueItemId, item.itemId, imdb) }
}

/** Identity used only to compare plays across id spaces (tmdb: folds onto tt when known). */
export function canonicalEpisodeIdentity(itemId: string, videoId: string | undefined, season: number | undefined, episode: number | undefined, type: string): string {
    const imdb = itemId.startsWith('tmdb:') ? aliasItemId(itemId, type) : undefined
    if (!imdb) return getEpisodeIdentity(itemId, videoId, season, episode, type)
    return getEpisodeIdentity(imdb, swapPrefix(videoId, itemId, imdb), season, episode, type)
}

/** Every identity key a tombstone for this play may have been written under: its own and its alias. */
export function aliasIdentityKeys(scope: string, itemId: string, videoId: string | undefined, season: number | undefined, episode: number | undefined, type: string): string[] {
    const own = `${scope}:${getEpisodeIdentity(itemId, videoId, season, episode, type)}`
    const other = aliasItemId(itemId, type)
    if (!other) return [own]
    return [own, `${scope}:${getEpisodeIdentity(other, swapPrefix(videoId, itemId, other), season, episode, type)}`]
}

/** Latest tombstone time across a play's own identity and its alias. */
export function aliasDeletedAt(deleted: Record<string, number>, scope: string, itemId: string, videoId: string | undefined, season: number | undefined, episode: number | undefined, type: string): number | undefined {
    let at: number | undefined
    for (const key of aliasIdentityKeys(scope, itemId, videoId, season, episode, type)) {
        const ts = deleted[key]
        if (ts !== undefined && (at === undefined || ts > at)) at = ts
    }
    return at
}

export function resetTmdbAliasesForTest(): void {
    version++
    tmdbToImdb.clear()
    imdbToTmdb.clear()
    conflicted.clear()
}
