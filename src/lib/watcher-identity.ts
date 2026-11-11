// Cross-source watcher matching for "also watched" badges and rails.
//
// The same show is addressed differently per platform: Stremio rows carry tt ids,
// Jellyfin rows carry tt ids when metadata resolves but a connection-scoped id
// otherwise, and Nuvio rows carry provider content ids. Exact itemId equality
// therefore undercounts watchers on shared titles (a show "watched by one
// person" while other accounts clearly watched it too).
//
// Matching order: (1) exact itemId, (2) equal tt ids, (3) equal normalized
// title within the same type class (series-like vs movie), mirroring the
// name-based correlation the activity feed already uses within an account.
// Known limit: episode rows whose name is the EPISODE title (Nuvio episodes)
// will not name-match a series-level entry; tt/id paths still cover them.

export interface WatcherItemIdentity {
    itemId: string
    name?: string | null
    type?: string | null
}

const seriesLike = (t?: string | null) => t === 'series' || t === 'anime' || t === 'episode'

export function normalizeWatcherTitle(name: string | null | undefined): string {
    return (name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function ttIdOf(itemId: string | null | undefined): string | null {
    if (!itemId) return null
    const match = /^(tt\d+)/i.exec(itemId)
    return match ? match[1].toLowerCase() : null
}

// Per-object memo for the identity keys: the Activity feed recomputes these for
// every item on every metadata-overlay commit and every enrichment pass, and the
// keys are pure functions of (itemId, name, type) on items the pipeline always
// replaces instead of mutating. A WeakMap keeps the memo pinned to the item's own
// lifetime, so a new item object (a fresh name) always recomputes.
const watcherKeysCache = new WeakMap<WatcherItemIdentity, readonly string[]>()

export function watcherMatchesItem(item: WatcherItemIdentity, show: WatcherItemIdentity): boolean {
    if (item.itemId === show.itemId) return true
    const ttItem = ttIdOf(item.itemId)
    const ttShow = ttIdOf(show.itemId)
    if (ttItem && ttShow) return ttItem === ttShow
    const itemSeries = seriesLike(item.type)
    const showSeries = seriesLike(show.type)
    if (itemSeries !== showSeries) return false
    const nameItem = normalizeWatcherTitle(item.name)
    const nameShow = normalizeWatcherTitle(show.name)
    return nameItem.length > 0 && nameItem === nameShow
}

/** Safe identity keys shared by display enrichment and watcher cross-linking. */
export function watcherIdentityKeys(item: WatcherItemIdentity): readonly string[] {
    const cached = watcherKeysCache.get(item)
    if (cached) return cached
    const keys: string[] = []
    const tt = ttIdOf(item.itemId)
    if (tt) keys.push(`tt:${tt}`)
    // Episode names are usually episode titles ("Pilot", "Finale"), so they
    // must never contribute a fuzzy title key. They can still receive metadata
    // through an exact IMDb key or a series row's identity.
    if (!seriesLike(item.type) || item.type === 'series' || item.type === 'anime') {
        const title = normalizeWatcherTitle(item.name)
        if (title) keys.push(`${seriesLike(item.type) ? 's' : 'm'}:${title}`)
    }
    watcherKeysCache.set(item, keys)
    return keys
}

/**
 * Cross-link an exact-key watcher index so keys that refer to the same show
 * (different source identities) share their watchers. Keys are left unchanged so
 * existing `.get(itemId)` lookups keep working; watcher arrays are merged in
 * place. O(keys) via tt and normalized-title grouping instead of pairwise scans.
 */
export function crossLinkWatcherIndex<W extends { id: string }>(
    map: Map<string, W[]>,
    identityByKey: Map<string, WatcherItemIdentity>,
): void {
    if (map.size < 2) return
    const groups = new Map<string, string[]>()
    const titleImdbs = new Map<string, Set<string>>()
    const groupKeyOf = (identity: WatcherItemIdentity): string | null => {
        const tt = ttIdOf(identity.itemId)
        if (tt) return `tt:${tt}`
        const name = normalizeWatcherTitle(identity.name)
        if (!name) return null
        // Only fuzzy-match rows with a known type class; ambiguous rows stay exact-keyed.
        const cls = identity.type ? (seriesLike(identity.type) ? 's' : 'm') : ''
        return cls ? `${cls}:${name}` : null
    }
    // Collect IMDb identities for title groups before grouping. IMDb-keyed rows
    // intentionally live in a separate exact group, but their title still
    // makes a fuzzy tt-less row ambiguous.
    for (const identity of identityByKey.values()) {
        const title = normalizeWatcherTitle(identity.name)
        const tt = ttIdOf(identity.itemId)
        const cls = identity.type ? (seriesLike(identity.type) ? 's' : 'm') : ''
        if (!title || !tt || !cls) continue
        const key = `${cls}:${title}`
        const ids = titleImdbs.get(key) || new Set<string>()
        ids.add(tt)
        titleImdbs.set(key, ids)
    }
    for (const key of map.keys()) {
        const identity = identityByKey.get(key)
        if (!identity) continue
        const groupKey = groupKeyOf(identity)
        if (!groupKey) continue
        const list = groups.get(groupKey)
        if (list) list.push(key)
        else groups.set(groupKey, [key])
    }
    for (const [groupKey, groupKeys] of groups) {
        if (groupKeys.length < 2) continue
        if ((groupKey.startsWith('s:') || groupKey.startsWith('m:')) && (titleImdbs.get(groupKey)?.size || 0) > 1) continue
        const union: W[] = []
        for (const key of groupKeys) {
            for (const watcher of map.get(key) || []) {
                if (!union.some(w => w.id === watcher.id)) union.push(watcher)
            }
        }
        for (const key of groupKeys) {
            map.set(key, union.slice())
        }
    }
}
