// Pure planner for surgical per-episode Stremio deletes: every transient or structural
// failure fails closed instead of escalating to an irreversible whole-show removal.
import type { LibraryItem } from '../types/activity.ts'
import type { MetaVideo } from './watched-episodes.ts'
import { decodeWatchedBitfield, encodeWatchedBitfield } from './watched-bitfield.ts'

export type EpisodeDeletePlan =
    | { kind: 'rewrite'; rewritten: LibraryItem }
    | { kind: 'remove-row' }
    | { kind: 'skip' }
    | { kind: 'fail'; reason: 'no-videos' | 'no-bitfield' | 'anchor-mismatch' | 'episode-not-watched' | 'non-tt' }

export async function planEpisodeBitfieldDelete(args: {
    itemId: string
    row: LibraryItem | undefined
    videos: MetaVideo[] | null
    target: { uniqueItemId?: string; season: number | null; episode: number | null }
}): Promise<EpisodeDeletePlan> {
    const { itemId, row, videos, target } = args
    // Non-tt ids (kitsu/mal/anidb) can never resolve a Cinemeta video list.
    if (!itemId.startsWith('tt')) return { kind: 'fail', reason: 'non-tt' }
    // Row absent remotely: nothing to delete remotely, the local purge handles the feed entry.
    if (!row) return { kind: 'skip' }

    const decoded = await decodeWatchedBitfield(row.state?.watched)
    if (!decoded || decoded.watchedIndices.length === 0) {
        // No watch flags either: the row records no watched episode, so there is nothing to edit remotely.
        if (!row.state?.timesWatched && !row.state?.flaggedWatched) return { kind: 'skip' }
        // An empty bitfield on a flagged row is "no data", not "nothing watched" — destroying the row would lose real state.
        return { kind: 'fail', reason: 'no-bitfield' }
    }

    // Cinemeta-free exact match: a single watched episode whose anchor id equals the target
    // is fully identified without a video list, so an unavailable meta cannot block the delete.
    if (target.uniqueItemId && decoded.watchedIndices.length === 1 && decoded.videoId === target.uniqueItemId) {
        return { kind: 'remove-row' }
    }

    if (videos == null) return { kind: 'fail', reason: 'no-videos' }

    // The anchor only has to EXIST in the video list: stremio-core never guarantees it sits
    // at the highest set bit (its own writer falls back to last_index_of(true).unwrap_or(0)),
    // so requiring max-bit equality misclassified valid states as mismatches. Ordering
    // misalignment still fails closed below, when a set bit resolves to no real video.
    if (!videos.some(v => v.id === decoded.videoId)) return { kind: 'fail', reason: 'anchor-mismatch' }
    if (decoded.watchedIndices.some(i => !videos[i])) return { kind: 'fail', reason: 'anchor-mismatch' }

    const targetIdx = decoded.watchedIndices.find(i => {
        const v = videos[i]
        if (!v) return false
        return (target.uniqueItemId && v.id === target.uniqueItemId) || (v.season === target.season && v.episode === target.episode)
    })
    if (targetIdx === undefined) return { kind: 'fail', reason: 'episode-not-watched' }

    const remaining = decoded.watchedIndices.filter(i => i !== targetIdx)
    if (remaining.length === 0) return { kind: 'remove-row' }

    const anchor = videos[remaining[remaining.length - 1]]
    const watched = await encodeWatchedBitfield(remaining, videos)
    const rewritten: LibraryItem = {
        ...row,
        state: {
            ...row.state,
            watched,
            video_id: anchor.id,
            season: anchor.season ?? undefined,
            episode: anchor.episode ?? undefined,
            timesWatched: remaining.length,
        },
    }
    return { kind: 'rewrite', rewritten }
}
