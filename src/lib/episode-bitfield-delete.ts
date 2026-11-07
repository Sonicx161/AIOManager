// Pure planner for surgical per-episode Stremio deletes: every transient or structural
// failure fails closed instead of escalating to an irreversible whole-show removal.
import type { LibraryItem } from '../types/activity.ts'
import type { MetaVideo } from './watched-episodes.ts'
import { decodeWatchedBitfield, encodeWatchedBitfield, hasNoWatchedBits, resolveWatchedBitsAgainstVideos } from './watched-bitfield.ts'

export type EpisodeDeletePlan =
    | { kind: 'rewrite'; rewritten: LibraryItem }
    | { kind: 'remove-row' }
    | { kind: 'skip' }
    | { kind: 'fail'; reason: 'no-videos' | 'no-bitfield' | 'anchor-mismatch' | 'non-tt' }

type DeleteTarget = { uniqueItemId?: string; season: number | null; episode: number | null }

function normalizeVideoId(id: string | undefined): string | undefined {
    const parts = id?.split(':')
    return parts?.length === 2 ? `${parts[0]}:1:${parts[1]}` : id
}

function isResumeTarget(state: LibraryItem['state'], target: DeleteTarget): boolean {
    const videoId = normalizeVideoId(state?.video_id)
    return (!!target.uniqueItemId && !!videoId && videoId === normalizeVideoId(target.uniqueItemId))
        || (target.season != null && target.episode != null && state?.season === target.season && state?.episode === target.episode)
}

export async function planEpisodeBitfieldDelete(args: {
    itemId: string
    row: LibraryItem | undefined
    videos: MetaVideo[] | null
    target: DeleteTarget
}): Promise<EpisodeDeletePlan> {
    const { itemId, row, videos, target } = args
    // Non-tt ids (kitsu/mal/anidb) can never resolve a Cinemeta video list.
    if (!itemId.startsWith('tt')) return { kind: 'fail', reason: 'non-tt' }
    // Row absent remotely: nothing to delete remotely, the local purge handles the feed entry.
    if (!row) return { kind: 'skip' }
    // Progress-only row (no bitfield, or one with every bit clear): the resume position is its
    // only state, so deleting that entry removes the row; any other entry is a stale event with
    // nothing remote to edit.
    if (!(row.state?.watched || '').trim() || await hasNoWatchedBits(row.state?.watched)) {
        return isResumeTarget(row.state, target) ? { kind: 'remove-row' } : { kind: 'skip' }
    }

    // Without a video list nothing can be shifted, so only the exact single-bit case is provable.
    if (videos == null) {
        const raw = await decodeWatchedBitfield(row.state?.watched)
        if (!raw || raw.watchedIndices.length === 0) return { kind: 'fail', reason: 'no-bitfield' }
        const [only] = raw.watchedIndices
        if (target.uniqueItemId && raw.watchedIndices.length === 1 && only === raw.length - 1 && raw.videoId === target.uniqueItemId) {
            return { kind: 'remove-row' }
        }
        return { kind: 'fail', reason: 'no-videos' }
    }

    // Decode exactly like stremio-core against the current list (anchor relocation + shift). A
    // missing anchor or a bit shifted out of the list means the write cannot be proven, so the
    // remote row is left untouched.
    const decoded = await resolveWatchedBitsAgainstVideos(row.state?.watched, videos)
    if (decoded.kind !== 'bits') return { kind: 'fail', reason: decoded.reason === 'no-bitfield' || decoded.reason === 'decode' ? 'no-bitfield' : 'anchor-mismatch' }

    const targetIdx = decoded.indices.find(i => {
        const v = videos[i]
        if (!v) return false
        return (target.uniqueItemId && v.id === target.uniqueItemId) || (v.season === target.season && v.episode === target.episode)
    })
    if (targetIdx === undefined) {
        // Not marked watched: the feed entry is either the row's current resume position
        // (progress only) or a stale event. Neither has per-episode bits to remove.
        const state = row.state
        if (!isResumeTarget(state, target)) return { kind: 'skip' }
        const lastWatched = videos[Math.max(...decoded.indices)]
        if (!lastWatched) return { kind: 'fail', reason: 'anchor-mismatch' }
        return {
            kind: 'rewrite',
            rewritten: {
                ...row,
                state: {
                    ...state,
                    video_id: lastWatched.id,
                    season: lastWatched.season ?? undefined,
                    episode: lastWatched.episode ?? undefined,
                    timeOffset: 0,
                },
            },
        }
    }

    const remaining = decoded.indices.filter(i => i !== targetIdx)
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
