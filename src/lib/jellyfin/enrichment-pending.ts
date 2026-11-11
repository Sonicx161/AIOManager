// Pending count of detached Jellyfin identity-enrichment passes (parent-series
// lookups that republish enriched query data after their query resolved).
// Activity's count header holds on this so it never shows a pre-enrichment
// number that the next collapse pass would revise. Entries are keyed per
// workspace + account + connection and carry one token per chain, so only the
// connections feeding the current view can hold the header and cleared scopes
// can never desync a live chain's count.

const pending = new Map<string, Set<object>>()
const listeners = new Set<() => void>()

function publish(): void {
    for (const listener of listeners) listener()
}

/** Tracker key for one connection's enrichment chains: workspace + account + connection + the exact remote subject. */
export function mediaEnrichmentKey(job: {
    workspaceId?: string
    accountId: string
    connection: { id: string; credentials?: { jellyfin?: string }; mediaServer?: { userId?: string; serverId?: string } }
}): string {
    const media = job.connection.mediaServer
    return `${job.workspaceId || ''}|${job.accountId}|${job.connection.id}|${job.connection.credentials?.jellyfin ?? ''}|${media?.userId ?? ''}|${media?.serverId ?? ''}`
}

/** Registers one detached enrichment pass as pending until its whole chain settles. */
export function trackMediaEnrichment<T>(scopeKey: string, chain: Promise<T>): Promise<T> {
    let set = pending.get(scopeKey)
    if (!set) {
        set = new Set()
        pending.set(scopeKey, set)
    }
    const token: object = {}
    set.add(token)
    publish()
    const release = (): void => {
        const current = pending.get(scopeKey)
        if (!current?.delete(token)) return
        if (current.size === 0) pending.delete(scopeKey)
        publish()
    }
    chain.then(() => release(), () => release())
    return chain
}

/** Pending count; with keys, only those scopes. */
export function pendingMediaEnrichment(keys?: readonly string[]): number {
    let total = 0
    if (!keys) {
        for (const set of pending.values()) total += set.size
        return total
    }
    for (const key of keys) total += pending.get(key)?.size ?? 0
    return total
}

/** Drops registrations: everything, or every key the filter rejects. */
export function clearMediaEnrichment(filter?: (key: string) => boolean): void {
    let changed = false
    if (!filter) {
        changed = pending.size > 0
        pending.clear()
    } else {
        for (const key of [...pending.keys()]) {
            if (!filter(key)) continue
            pending.delete(key)
            changed = true
        }
    }
    if (changed) publish()
}

export function subscribeMediaEnrichment(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}
