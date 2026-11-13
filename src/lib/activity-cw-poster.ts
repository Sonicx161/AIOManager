import type { ActivityItem } from '@/types/activity'

const TT_ID = /^tt\d+$/

function normalizedTtId(itemId: string | undefined): string | undefined {
    const key = itemId?.trim().toLowerCase()
    return key && TT_ID.test(key) ? key : undefined
}

/** Posters the shown Continue Watching rows can lend the feed, keyed by normalized IMDb itemId; an id two rows disagree on is left out. */
export function continueWatchingPosterIndex(rows: readonly ActivityItem[]): ReadonlyMap<string, string> {
    const posters = new Map<string, string>()
    const contested = new Set<string>()
    for (const row of rows) {
        const key = normalizedTtId(row.itemId)
        if (!key || !row.poster) continue
        const prior = posters.get(key)
        if (prior === undefined) posters.set(key, row.poster)
        else if (prior !== row.poster) contested.add(key)
    }
    for (const key of contested) posters.delete(key)
    return posters
}

export function continueWatchingPosterFor(index: ReadonlyMap<string, string> | undefined, itemId: string | undefined): string | undefined {
    const key = normalizedTtId(itemId)
    return (key ? index?.get(key) : undefined) || undefined
}
