// Pure planner for surgical per-episode Stremio deletes: every transient or structural
// failure fails closed instead of escalating to an irreversible whole-show removal.
import type { LibraryItem } from '../types/activity.ts'
import type { MetaVideo } from './watched-episodes.ts'
import { decodeStremioVisibleIndices, encodeEmptyWatchedBitfield, encodeWatchedBitfield } from './watched-bitfield.ts'

export type EpisodeDeletePlan =
    | { kind: 'rewrite'; rewritten: LibraryItem }
    | { kind: 'skip' }
    | { kind: 'fail'; reason: 'no-videos' | 'no-bitfield' | 'anchor-mismatch' | 'non-tt' | 'unsafe-list' }

type DeleteTarget = { uniqueItemId?: string; season: number | null; episode: number | null }

export async function planEpisodeBitfieldDelete(args: {
    itemId: string
    row: LibraryItem | undefined
    videos: MetaVideo[] | null
    target: DeleteTarget
    safeList?: boolean
}): Promise<EpisodeDeletePlan> {
    const { row, videos, target } = args
    if (!row) return { kind: 'skip' }
    if (!args.safeList || !videos) return { kind: 'fail', reason: 'unsafe-list' }
    const matches = videos.filter(v => target.uniqueItemId
        ? v.id === target.uniqueItemId
        : target.season != null && target.episode != null && v.season === target.season && v.episode === target.episode)
    if (matches.length !== 1) return { kind: 'fail', reason: 'unsafe-list' }
    const watched = row.state?.watched
    if (!watched) return { kind: 'fail', reason: 'no-bitfield' }
    const anchorId = watched.split(':').slice(0, -2).join(':')
    if (!videos.some(v => v.id === anchorId)) return { kind: 'fail', reason: 'anchor-mismatch' }
    const before = await decodeStremioVisibleIndices(watched, videos)
    if (!before) return { kind: 'fail', reason: 'no-bitfield' }
    const ids = new Set(before.map(i => videos[i].id))
    const resumeId = row.state?.video_id
    const hasResumeId = !!resumeId && resumeId !== row._id
    const coordinatesMatch = matches[0].season != null && matches[0].episode != null && row.state?.season === matches[0].season && row.state?.episode === matches[0].episode
    if (!hasResumeId && coordinatesMatch && videos.filter(v => v.season === matches[0].season && v.episode === matches[0].episode).length !== 1) return { kind: 'fail', reason: 'unsafe-list' }
    const resumeIsTarget = hasResumeId ? resumeId === matches[0].id : coordinatesMatch
    if (!ids.delete(matches[0].id)) return resumeIsTarget && (row.state?.timeOffset ?? 0) > 0 ? { kind: 'fail', reason: 'no-bitfield' } : { kind: 'skip' }
    const remaining = videos.flatMap((v, i) => ids.has(v.id) ? [i] : [])
    const encoded = remaining.length ? await encodeWatchedBitfield(remaining, videos) : await encodeEmptyWatchedBitfield(anchorId)
    const after = await decodeStremioVisibleIndices(encoded, videos)
    if (!after || after.length !== ids.size || after.some(i => !ids.has(videos[i].id))) return { kind: 'fail', reason: 'anchor-mismatch' }
    const anchor = remaining.length ? videos[remaining[remaining.length - 1]] : undefined
    return { kind: 'rewrite', rewritten: {
        ...row,
        state: { ...row.state, watched: encoded, ...(resumeIsTarget ? { video_id: anchor?.id ?? '', season: anchor?.season ?? 0, episode: anchor?.episode ?? 0, timeOffset: 0 } : {}) },
    } }
}

export async function verifyEpisodeDeleteReadback(
    itemId: string,
    expected: LibraryItem | null,
    read: () => Promise<LibraryItem[]>,
): Promise<LibraryItem | null> {
    const rows = await read()
    if (rows.length !== 1 || rows[0]._id !== itemId) throw new Error('The deletion could not be verified')
    const saved = rows[0]
    if (expected === null) {
        if (saved.removed !== true) throw new Error('The deletion could not be verified')
        return null
    }
    const fields = ['watched', 'video_id', 'season', 'episode', 'timeOffset', 'timesWatched'] as const
    if (saved.removed === true || saved.type !== expected.type || fields.some(field => saved.state?.[field] !== expected.state?.[field])) throw new Error('The deletion could not be verified')
    return saved
}
