// Routing predicates for Activity deletions: which entries may attempt a surgical
// per-episode Stremio delete, and which must remove the whole library row instead.
import type { ActivityItem, LibraryItem } from '../types/activity.ts'

export interface EpisodeScopedItem {
    type: string
    season: number
    episode: number
}

// Per-episode surgery needs a series-like item carrying real season/episode coordinates.
// Movies can arrive with season 0 / episode 0, so a null check alone misroutes them into
// the per-episode path where they die at 'no-bitfield' — the type decides FIRST.
export function isEpisodeScopedDelete(item: Pick<ActivityItem, 'type' | 'season' | 'episode'>): item is EpisodeScopedItem {
    const isSeries = item.type === 'series' || item.type === 'anime' || item.type === 'episode'
    return isSeries && item.season != null && item.episode != null
}

// A part-watched episode (video_id anchored, no watched bitfield) is the row's ONLY watch
// state: there is nothing to rewrite, so deleting the entry means removing the whole row.
export function isBareAnchoredEpisode(row: LibraryItem | undefined, targetUniqueId: string | undefined): boolean {
    if (!row || !targetUniqueId) return false
    return !(row.state?.watched || '').trim() && row.state?.video_id === targetUniqueId
}

// The retry prompt is only honest while an entry is still kept because its remote delete failed.
export function hasPendingRemoteDelete(outcome: { failed: boolean; keptIds: ReadonlySet<string> }): boolean {
    return outcome.failed && outcome.keptIds.size > 0
}
