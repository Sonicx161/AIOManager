// Runtime-import-free so node --test can load it directly: cross-file imports
// are type-only and erased by --experimental-strip-types.
import type { ActivityItem } from '@/types/activity'

export interface EpisodeRangeHint { season: number; from: number; to: number }

const ORPHAN_TWIN_WINDOW_MS = 15 * 60_000
const ORPHAN_BOUND_WINDOW_MS = 48 * 60 * 60 * 1000

const isEpisodeLikeType = (type: string) => type === 'series' || type === 'anime' || type === 'episode'
const hasResolvedEpisode = (item: ActivityItem) => Number.isInteger(item.episode) && (item.episode ?? 0) > 0
const seriesBaseId = (id: string) => id.split(':')[0]

/**
 * Watches whose record lost its episode id (progress survived, the `:s:e` suffix
 * didn't) render as "Episode unknown". Two sound resolutions before settling
 * for that label: an orphan whose offset/duration signature matches a resolved
 * episode row of the same account, origin and series inside the same ingest
 * window (15 minutes; episodic content repeats lengths and stop points, so a
 * wider window would merge genuinely different episodes) is a duplicate write
 * and is dropped; an orphan strictly between two resolved watches of the same
 * series within 48h gets a truthful range instead of no identity at all.
 * No single episode number is ever claimed from ordering alone.
 */
export function resolveUnrecordedEpisodes(items: ActivityItem[]): ActivityItem[] {
    const orphans = new Map<string, ActivityItem>()
    const resolvedBySeries = new Map<string, ActivityItem[]>()
    for (const item of items) {
        if (!isEpisodeLikeType(item.type) || item.importedSavedState === true) continue
        const key = `${item.accountId}|${item.sourceConnectionId ?? ''}|${seriesBaseId(item.itemId)}`
        if (hasResolvedEpisode(item)) {
            const bucket = resolvedBySeries.get(key)
            if (bucket) bucket.push(item)
            else resolvedBySeries.set(key, [item])
        } else {
            orphans.set(`${key}|${item.id}`, item)
        }
    }
    if (orphans.size === 0) return items
    const dropped = new Set<ActivityItem>()
    const bounded = new Map<ActivityItem, EpisodeRangeHint>()
    for (const orphan of orphans.values()) {
        const key = `${orphan.accountId}|${orphan.sourceConnectionId ?? ''}|${seriesBaseId(orphan.itemId)}`
        const candidates = resolvedBySeries.get(key) ?? []
        if (candidates.length === 0) continue
        const ts = orphan.timestamp.getTime()
        if (orphan.duration > 0) {
            const twin = candidates.find(row =>
                Math.abs(row.timestamp.getTime() - ts) <= ORPHAN_TWIN_WINDOW_MS
                && row.duration > 0
                && Math.abs((orphan.watched ?? 0) - (row.watched ?? 0)) <= 120_000
                && Math.abs(orphan.duration - row.duration) <= Math.max(2_000, row.duration * 0.05))
            if (twin) { dropped.add(orphan); continue }
        }
        let prev: ActivityItem | undefined
        let next: ActivityItem | undefined
        for (const row of candidates) {
            const dt = row.timestamp.getTime() - ts
            if (dt < 0 && (!prev || row.timestamp.getTime() > prev.timestamp.getTime())) prev = row
            if (dt > 0 && (!next || row.timestamp.getTime() < next.timestamp.getTime())) next = row
        }
        if (!prev || !next) continue
        if (ts - prev.timestamp.getTime() > ORPHAN_BOUND_WINDOW_MS) continue
        if (next.timestamp.getTime() - ts > ORPHAN_BOUND_WINDOW_MS) continue
        const from = (prev.episode ?? 0) + 1
        const to = (next.episode ?? 0) - 1
        if (from > to) continue
        bounded.set(orphan, { season: prev.season ?? orphan.season ?? 1, from, to })
    }
    if (dropped.size === 0 && bounded.size === 0) return items
    return items
        .filter(item => !dropped.has(item))
        .map(item => {
            const range = bounded.get(item)
            return range ? { ...item, episodeRange: range } : item
        })
}

export function formatEpisodeRange(range: EpisodeRangeHint): string {
    const span = range.from === range.to ? `E${range.from}` : `E${range.from}-E${range.to}`
    return `S${range.season} ${span}`
}
