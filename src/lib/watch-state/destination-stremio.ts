// Stremio watch-state destination (manual import): pure, transport-injected, UI-free.
//
// Interface for runtime integration (the parent owns factories/session wrappers):
//   createStremioWatchDestination(options) -> WatchStateDestination
//   options: { connectionId, label, subject, scope, open(signal), seriesVideos?(id) } - exactly
//   what stremioWatchSession(account, connection, key, signal, assertCurrent) returns, so the
//   parent can pass it straight through. options.open(signal) resolves AFTER re-verifying the
//   remote user and returns a request(body, signal) transport whose Put calls the parent's
//   assertCurrent; the transport unwraps the wire envelope and only ever hands us data.result.
//   Writes are request({ type: 'DatastorePut', collection: 'libraryItem', changes: [fullRow] });
//   reads are request({ collection: 'libraryItem', all: true } or { ids: [id] }).
//   This module owns matching, write decisions and readback verification; it never authenticates.
//
// Stremio contracts used by this adapter:
//   - DatastorePut libraryItem changes are FULL-ROW replacements, not patches: preserving
//     existing metadata means echoing the entire row back with only `state` modified.
//   - state.timeOffset/duration are MILLISECONDS; flaggedWatched > 0 marks movies watched;
//     series timesWatched counts watched episodes; state.watched is the per-episode bitfield
//     "{videoId}:{length}:{base64(zlib-deflate(bits))}" indexed by the series' videos sorted
//     (season, episode, released); state.video_id/season/episode/timeOffset form the single
//     per-series resume slot.
//   - There is no compare-and-swap: every apply re-opens the session (remote-user pin), re-reads
//     the row immediately before the Put, and verifies the saved row with an exact readback.
import type { MigrationWriteResult, WatchStateDestination, WatchStatePatch, WatchStateRecord } from './types.ts'
import { canonicalWatchIdentity, hasSavedWatchState, sourceTime, watchFingerprint } from './records.ts'
import { skippedNoIdRowsNote } from './source-stremio.ts'
import { encodeWatchedBitfield, interpretWatchedBitfield } from '../watched-bitfield.ts'
import { isLiveLibraryRow } from '../stremio-liveness.ts'
import { migrationStage, GlobalMatchFailure, WatchMigrationError } from './failures.ts'
import { assertFreshChecks } from './prewrite-fresh.ts'
import { UNSAFE_EPISODE_LIST } from '../stremio-bitfield-guard.ts'

export interface StremioDestinationVideo {
    id: string
    season?: number | null
    episode?: number | null
    released?: string | null
}

export interface StremioWatchDestinationOptions {
    connectionId: string
    label: string
    subject: string
    scope: string
    /** Returns a transport pinned to the remote user verified at session creation; the runtime wrapper owns auth and identity re-checks. */
    open(signal: AbortSignal): Promise<{ request(body: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void): Promise<unknown> }>
    /** Ordered-video provider (Cinemeta via the runtime wrapper); absent or ambiguous lists fail closed for episode writes. */
    seriesVideos?(id: string): Promise<StremioDestinationVideo[] | null>
    safeBitfieldVideos?(id: string, type: string): Promise<StremioDestinationVideo[] | null>
}

type DestinationRequest = (body: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void) => Promise<unknown>

const PROVIDER_ITEM_ID = /^(?:tt\d{5,}|tmdb:\d+)$/
const MAX_LIBRARY_ITEMS = 10_000

const APPLIED_MESSAGE = 'Saved and verified by an exact readback.'
const READBACK_FAILED = 'The write could not be verified by reading the item back. Preview again to check whether it was saved.'
const CHANGED_MESSAGE = 'The destination item changed since the preview. It will be kept; preview again.'
const SAVED_UNSEEN = 'The destination item has watch state the preview did not show. It will be kept.'
const SERIES_UNPROVABLE = 'The destination series has watch state that cannot be verified episode by episode. It will be kept.'
const CANNOT_COMBINE = 'This destination cannot combine a watched flag with a resume point in one write.'
const SLOT_OTHER = 'The destination keeps one resume point per series and it is anchored to another episode. It will be kept.'
const SLOT_UNVERIFIED = 'The resume point saved for this series could not be verified, so it cannot be replaced.'
const RESUME_EXISTS = 'The destination already has a different resume point for this episode. It will be kept.'
const NO_EPISODE_ORDER = 'Episode order for this series could not be verified on the destination, so this episode cannot be imported safely.'
const EPISODE_NOT_LISTED = 'This episode is not in the verified episode list for this series on the destination.'
const REMOVED_ROW = 'The destination library entry for this title was removed. It will be kept; preview again.'
const NOTHING_SELECTED = 'Nothing was selected to import for this title.'
const ALREADY_SAVED = 'The destination already has the selected state. Nothing was written.'
const BAD_TARGET = 'The destination target could not be interpreted. Preview again.'
const BAD_RESUME = 'The resume point could not be copied exactly.'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function intOrUndefined(value: unknown): number | undefined {
    return Number.isSafeInteger(value) ? (value as number) : undefined
}

function positiveDuration(value: unknown): number | null {
    const number = finiteNumber(value)
    return number !== null && number > 0 ? number : null
}

/** Millisecond epochs only; values before 1973 cannot be honest playback dates. */
function epochMs(value: unknown): number | null {
    const time = sourceTime(value)
    return time !== null && time >= 100_000_000_000 ? time : null
}

function libraryEntries(result: unknown): unknown[] {
    if (Array.isArray(result)) return result
    if (isRecord(result) && Array.isArray(result.library)) return result.library
    throw new Error('Stremio returned an unexpected library shape; nothing was interpreted as data.')
}

interface DestinationRow {
    raw: Record<string, unknown>
    id: string
    name: string
    kind: 'movie' | 'series' | null
    removed: boolean
    state: Record<string, unknown>
}

/** Null means the row has no usable id (junk other tools can leave behind): it can never be matched or written, so callers skip it. */
function parseDestinationRow(entry: unknown): DestinationRow | null {
    if (!isRecord(entry)) return null
    const id = entry._id
    if (typeof id !== 'string' || !id) return null
    return {
        raw: entry,
        id,
        name: typeof entry.name === 'string' && entry.name ? entry.name : id,
        kind: entry.type === 'movie' ? 'movie' : entry.type === 'series' || entry.type === 'anime' ? 'series' : null,
        removed: !isLiveLibraryRow(entry),
        state: isRecord(entry.state) ? entry.state : {},
    }
}

function preservedRow(row: Record<string, unknown>): Record<string, unknown> {
    const clone: Record<string, unknown> = { ...row }
    delete clone._mtime
    return clone
}

async function rowFingerprint(row: Record<string, unknown>): Promise<string> {
    return watchFingerprint(preservedRow(row))
}

async function recordFingerprint(scope: string, row: Record<string, unknown>, episode?: string): Promise<string> {
    return watchFingerprint(episode === undefined ? { scope, item: preservedRow(row) } : { scope, item: preservedRow(row), episode })
}

interface SeriesVideoSlot {
    id: string
    season: number
    episode: number
    released: string
}

interface StremioSeriesIndex {
    order: SeriesVideoSlot[]
    bySeasonEpisode: Map<string, number>
    byVideoId: Map<string, number>
}

function seasonEpisodeKey(season: number, episode: number): string {
    return `${season}:${episode}`
}

/**
 * Normalizes a raw video list into the write index space. Anything that makes the ordering
 * ambiguous fails closed: duplicate video ids, two videos sharing (season, episode) - the
 * (season, episode, released) sort could then depend on data we do not have - or entries
 * without integer season/episode numbers, whose index position stremio-core never defines.
 */
function normalizeSeriesVideos(list: unknown): StremioSeriesIndex | null {
    if (!Array.isArray(list) || list.length === 0) return null
    const videos: SeriesVideoSlot[] = []
    for (const entry of list) {
        if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return null
        const season = intOrUndefined(entry.season)
        const episode = intOrUndefined(entry.episode)
        if (season === undefined || episode === undefined) return null
        videos.push({ id: entry.id, season, episode, released: typeof entry.released === 'string' ? entry.released : '' })
    }
    const seenIds = new Set<string>()
    const seenEpisodes = new Set<string>()
    for (const video of videos) {
        if (seenIds.has(video.id)) return null
        seenIds.add(video.id)
        const key = seasonEpisodeKey(video.season, video.episode)
        if (seenEpisodes.has(key)) return null
        seenEpisodes.add(key)
    }
    videos.sort((a, b) => a.season - b.season || a.episode - b.episode || a.released.localeCompare(b.released))
    const bySeasonEpisode = new Map<string, number>()
    const byVideoId = new Map<string, number>()
    videos.forEach((video, index) => {
        bySeasonEpisode.set(seasonEpisodeKey(video.season, video.episode), index)
        byVideoId.set(video.id, index)
    })
    return { order: videos, bySeasonEpisode, byVideoId }
}

type SeriesBits = { kind: 'none' } | { kind: 'bits'; indices: number[] } | { kind: 'unprovable' }

/**
 * Interprets state.watched against the verified index space. A non-empty string that decodes
 * to zero bits is NOT proven empty (decode returns [] even for corrupt compression), flags or
 * counts without any bitfield are not proven empty either, and any anchor/bit that does not
 * resolve inside the list makes the row unprovable. 'unprovable' always fails closed.
 */
async function readSeriesBits(state: Record<string, unknown>, index: StremioSeriesIndex): Promise<SeriesBits> {
    const watched = state.watched
    if (typeof watched !== 'string' || watched === '') {
        if ((finiteNumber(state.flaggedWatched) ?? 0) > 0) return { kind: 'unprovable' }
        if ((finiteNumber(state.timesWatched) ?? 0) > 0) return { kind: 'unprovable' }
        return { kind: 'none' }
    }
    const timesWatched = finiteNumber(state.timesWatched)
    const interpreted = await interpretWatchedBitfield(watched, index.order, { anchorPolicy: 'max', timesWatched })
    return interpreted.kind === 'bits' ? { kind: 'bits', indices: interpreted.indices } : { kind: 'unprovable' }
}

type SlotStatus = 'absent' | 'target' | 'other' | 'unverified'

/** Locates the single per-series resume slot relative to the target episode. */
function slotStatus(state: Record<string, unknown>, index: StremioSeriesIndex, season: number, episode: number): SlotStatus {
    const slotSeason = intOrUndefined(state.season)
    const slotEpisode = intOrUndefined(state.episode)
    const videoId = typeof state.video_id === 'string' && state.video_id ? state.video_id : null
    // Official DatastoreGet fills an unused slot with season/episode 0, empty video_id,
    // and timeOffset 0. Those schema defaults are not a saved episode resume point.
    if (slotSeason === 0 && slotEpisode === 0 && videoId === null && positiveDuration(state.timeOffset) === null) return 'absent'
    if (slotSeason === undefined && slotEpisode === undefined && videoId === null) {
        return positiveDuration(state.timeOffset) !== null ? 'unverified' : 'absent'
    }
    if (slotSeason === undefined || slotEpisode === undefined) {
        const videoIndex = videoId === null ? undefined : index.byVideoId.get(videoId)
        if (videoIndex === undefined) return 'unverified'
        const video = index.order[videoIndex]
        return video.season === season && video.episode === episode ? 'target' : 'other'
    }
    if (slotSeason !== season || slotEpisode !== episode) return 'other'
    const targetIndex = index.bySeasonEpisode.get(seasonEpisodeKey(season, episode))
    if (targetIndex === undefined) return 'unverified'
    if (videoId !== null && index.order[targetIndex].id !== videoId) return 'unverified'
    return 'target'
}

type ParsedWatchTarget =
    | { kind: 'movie'; rowId: string }
    | { kind: 'episode'; rowId: string; season: number; episode: number }

function parseTargetId(expected: WatchStateRecord): ParsedWatchTarget | null {
    if (expected.type === 'movie' && expected.id.startsWith('movie:')) {
        const rowId = expected.id.slice('movie:'.length)
        return rowId ? { kind: 'movie', rowId } : null
    }
    if (expected.type === 'episode' && expected.id.startsWith('episode:')) {
        const parts = expected.id.split(':')
        if (parts.length < 4) return null
        const episode = Number(parts.pop())
        const season = Number(parts.pop())
        const rowId = parts.slice(1).join(':')
        if (!rowId || !Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 1) return null
        return { kind: 'episode', rowId, season, episode }
    }
    return null
}

/** Provider row ids behind a record's canonical identities, imdb first (Cinemeta-indexed), then tmdb, then tvdb. */
function candidateRowIds(record: WatchStateRecord): string[] {
    const ranked: Array<{ rank: number; id: string }> = []
    for (const identity of record.identities) {
        const parts = identity.split(':')
        if (parts[0] !== 'movie' && parts[0] !== 'episode') continue
        const provider = parts[1]
        const value = parts[2] ?? ''
        if (provider === 'imdb' && /^tt\d{5,}$/.test(value)) ranked.push({ rank: 0, id: value })
        else if ((provider === 'tmdb' || provider === 'tvdb') && /^\d+$/.test(value)) ranked.push({ rank: provider === 'tmdb' ? 1 : 2, id: `${provider}:${value}` })
    }
    ranked.sort((a, b) => a.rank - b.rank)
    const ids: string[] = []
    for (const entry of ranked) if (!ids.includes(entry.id)) ids.push(entry.id)
    return ids
}

/**
 * lastWatched is one date per library row and only ever moves forward. A movie takes the
 * newest exact date the patch carries; a series takes it only for the resume episode.
 */
function plannedLastWatched(existing: unknown, patch: WatchStatePatch, scope: 'movie' | 'series'): string | null {
    if (scope === 'series' && patch.positionMs === undefined && patch.resumeSlot !== true) return null
    const times: number[] = []
    if (patch.watched === true) {
        const time = epochMs(patch.playedAt)
        if (time !== null) times.push(time)
    }
    if (patch.positionMs !== undefined) {
        const time = epochMs(patch.resumePlayedAt !== undefined ? patch.resumePlayedAt : patch.playedAt)
        if (time !== null) times.push(time)
    }
    if (times.length === 0) return null
    const newest = Math.max(...times)
    const current = epochMs(existing)
    return current !== null && newest <= current ? null : new Date(newest).toISOString()
}

/**
 * Stremio devices pull a library row only when its _mtime is newer than the copy they hold,
 * so a real change must advance _mtime. Continue Watching sorts by _mtime, so it moves only as far
 * as the watch date requires: just past the stored value, or to a newer exact lastWatched.
 */
function stampedRow(base: Record<string, unknown>, state: Record<string, unknown>): Record<string, unknown> {
    const previous = typeof base._mtime === 'string' ? Date.parse(base._mtime) : Number.NaN
    const watched = typeof state.lastWatched === 'string' ? Date.parse(state.lastWatched) : Number.NaN
    const floor = Number.isFinite(previous) ? previous + 1 : Date.now()
    const next = Math.min(Number.isFinite(watched) ? Math.max(floor, watched) : floor, Math.max(floor, Date.now()))
    return { ...base, state, _mtime: new Date(next).toISOString() }
}

function createdMtime(state: Record<string, unknown>, now: string): string {
    const watched = typeof state.lastWatched === 'string' ? Date.parse(state.lastWatched) : Number.NaN
    return Number.isFinite(watched) && watched <= Date.parse(now) ? new Date(watched).toISOString() : now
}

interface EpisodeWriteCheck {
    patch: WatchStatePatch
    lastWatched?: string | null
    index: StremioSeriesIndex
    season: number
    episode: number
    targetIndex: number
    prewrite: DestinationRow
    expectedBits: number[]
}

const STATE_FIELDS = ['flaggedWatched', 'lastWatched', 'timesWatched', 'timeOffset', 'duration', 'video_id', 'season', 'episode', 'watched'] as const

export function createStremioWatchDestination(options: StremioWatchDestinationOptions): WatchStateDestination {
    const { connectionId, label, subject, scope } = options
    const capabilities: WatchStateDestination['capabilities'] = {
        watched: true,
        resume: true,
        dates: true,
        counts: false,
        combined: false,
        notes: [
            'Stremio keeps one resume point per series: resume points for different episodes of the same series cannot be combined or replaced.',
            'Stremio stores no per-episode watch dates or play counts: it keeps one last-watched date per title, only ever moved forward, and exact dates are copied only for movies and the resume episode.',
            'Watched episodes are merged into the destination series row; other watched episodes, the resume point and all library fields are preserved.',
            'Stremio offers no compare-and-swap: every write re-reads the row immediately before saving and verifies it by reading it back.',
        ],
    }
    const rowLocks = new Map<string, Promise<unknown>>()
    const ownWrites = new Map<string, { fingerprint: string; episodes: Map<string, { watched?: true; positionMs?: number }> }>()
    const seriesIndexCache = new Map<string, Promise<StremioSeriesIndex | null>>()
    let inventoryPromise: Promise<Map<string, DestinationRow>> | null = null

    const seriesIndexFor = (rowId: string): Promise<StremioSeriesIndex | null> => {
        const cached = seriesIndexCache.get(rowId)
        if (cached !== undefined) return cached
        const promise = (async () => {
            if (!options.seriesVideos) return null
            try {
                return normalizeSeriesVideos(await options.seriesVideos(rowId))
            } catch {
                return null
            }
        })()
        seriesIndexCache.set(rowId, promise)
        return promise
    }

    const ensureInventory = (signal: AbortSignal): Promise<Map<string, DestinationRow>> => {
        if (inventoryPromise === null) {
            const built = (async () => {
                const { request } = await migrationStage('identity', () => options.open(signal))
                signal.throwIfAborted()
                const result = await request({ collection: 'libraryItem', all: true }, signal)
                signal.throwIfAborted()
                let entries: unknown[]
                try { entries = libraryEntries(result) } catch (error) {
                    throw new GlobalMatchFailure(error instanceof Error && error.message ? error.message : 'The destination library could not be read.')
                }
                if (entries.length > MAX_LIBRARY_ITEMS) {
                    throw new GlobalMatchFailure(`The destination library exceeded ${MAX_LIBRARY_ITEMS.toLocaleString()} items, so matches cannot be verified safely.`)
                }
                const rows = new Map<string, DestinationRow>()
                let skippedNoId = 0
                for (const entry of entries) {
                    const row = parseDestinationRow(entry)
                    if (row === null) {
                        skippedNoId++
                        continue
                    }
                    if (rows.has(row.id)) throw new GlobalMatchFailure('Stremio returned duplicate library rows; refusing to guess.')
                    rows.set(row.id, row)
                }
                // Surfaced through the plan notes: the destination capabilities array is
                // read only after the resolves that build this inventory.
                if (skippedNoId > 0 && !capabilities.notes.includes(skippedNoIdRowsNote(skippedNoId))) {
                    capabilities.notes.push(skippedNoIdRowsNote(skippedNoId))
                }
                return rows
            })()
            inventoryPromise = built
            built.catch(() => {
                if (inventoryPromise === built) inventoryPromise = null
            })
        }
        return inventoryPromise
    }

    const readRow = async (request: DestinationRequest, rowId: string, signal: AbortSignal, stage: 'prewrite' | 'readback' = 'prewrite'): Promise<DestinationRow | null> => migrationStage(stage, async () => {
        const result = await request({ collection: 'libraryItem', ids: [rowId] }, signal)
        const rows: DestinationRow[] = []
        for (const entry of libraryEntries(result)) {
            if (entry === null || entry === undefined) continue
            const row = parseDestinationRow(entry)
            // An exact read must never treat a malformed answer as absence: that would turn
            // the full-row write into a replacement of an existing row.
            if (row === null) throw new Error('Stremio returned a malformed library item; refusing to guess.')
            if (row.id === rowId) rows.push(row)
        }
        if (rows.length > 1) throw new Error('Stremio returned duplicate rows for this title; refusing to guess.')
        return rows.length === 1 ? rows[0] : null
    })

    const putRow = async (request: DestinationRequest, checkedAt: number, row: Record<string, unknown>, signal: AbortSignal): Promise<void> => {
        assertFreshChecks(checkedAt)
        signal.throwIfAborted()
        // The transport awaits headers and a pacer reservation before the fetch; the
        // guard re-runs through beforeDispatch immediately before the write leaves.
        const result = await migrationStage('write', () => request({ type: 'DatastorePut', collection: 'libraryItem', changes: [row] }, signal, () => assertFreshChecks(checkedAt)))
        // The official API returns { success: true }; some compatible transports return
        // a bare true. An acknowledgement only permits the mandatory readback below.
        if (result !== true && !(isRecord(result) && result.success === true)) throw new WatchMigrationError({ stage: 'write', reason: 'acknowledgement' }, 'Stremio did not confirm the library update.')
    }

    const trackOwnWrite = async (rowId: string, row: Record<string, unknown>, episodeKey: string | null, entry: { watched?: true; positionMs?: number }): Promise<void> => {
        const fingerprint = await rowFingerprint(row)
        const existing = ownWrites.get(rowId)
        if (existing !== undefined && existing.fingerprint === fingerprint) {
            if (episodeKey !== null) existing.episodes.set(episodeKey, { ...existing.episodes.get(episodeKey), ...entry })
            return
        }
        const episodes = new Map(existing === undefined ? [] : existing.episodes)
        if (episodeKey !== null) episodes.set(episodeKey, entry)
        ownWrites.set(rowId, { fingerprint, episodes })
    }

    const ownWriteFor = async (rowId: string, row: DestinationRow, episodeKey: string | null): Promise<{ watched?: true; positionMs?: number } | null> => {
        const own = ownWrites.get(rowId)
        if (own === undefined || episodeKey === null) return null
        if (own.fingerprint !== await rowFingerprint(row.raw)) return null
        return own.episodes.get(episodeKey) ?? null
    }

    const movieView = async (row: DestinationRow): Promise<WatchStateRecord> => {
        const flaggedWatched = finiteNumber(row.state.flaggedWatched)
        const timesWatched = finiteNumber(row.state.timesWatched)
        const watched = (flaggedWatched !== null && flaggedWatched > 0) || (timesWatched !== null && timesWatched > 0)
        const rawOffset = finiteNumber(row.state.timeOffset)
        const offset = rawOffset !== null && rawOffset > 0 ? Math.round(rawOffset) : null
        const playedAt = epochMs(row.state.lastWatched)
        const identity = canonicalWatchIdentity('movie', row.id)
        const record: WatchStateRecord = {
            id: `movie:${row.id}`,
            title: row.name,
            type: 'movie',
            identities: identity === null ? [] : [identity],
            playedAt,
            fingerprint: await recordFingerprint(scope, row.raw),
        }
        if (!watched && offset === null && playedAt === null) {
            record.watched = false
            record.positionMs = 0
            record.playCount = 0
            record.unmodified = true
            return record
        }
        record.watched = watched
        if (offset !== null) record.positionMs = offset
        const playCount = intOrUndefined(timesWatched)
        if (playCount !== undefined && playCount >= 0) record.playCount = playCount
        return record
    }

    const episodeView = async (row: DestinationRow, index: StremioSeriesIndex | null, season: number, episode: number): Promise<WatchStateRecord> => {
        const identity = canonicalWatchIdentity('episode', row.id, season, episode)
        const record: WatchStateRecord = {
            id: `episode:${row.id}:${season}:${episode}`,
            title: row.name,
            type: 'episode',
            seriesTitle: row.name,
            identities: identity === null ? [] : [identity],
            season,
            episode,
            playedAt: null,
            positionMs: 0,
            playCount: 0,
            fingerprint: await recordFingerprint(scope, row.raw, identity ?? undefined),
        }
        if (index === null) return { ...record, notes: [NO_EPISODE_ORDER] }
        const bits = await readSeriesBits(row.state, index)
        if (bits.kind === 'unprovable') return { ...record, notes: [SERIES_UNPROVABLE] }
        const targetIndex = index.bySeasonEpisode.get(seasonEpisodeKey(season, episode))
        if (targetIndex === undefined) return { ...record, notes: [EPISODE_NOT_LISTED] }
        const watched = bits.kind === 'bits' && bits.indices.includes(targetIndex)
        const offset = slotStatus(row.state, index, season, episode) === 'target' ? positiveDuration(row.state.timeOffset) : null
        record.watched = watched
        if (offset !== null) record.positionMs = Math.round(offset)
        if (!watched && offset === null) record.unmodified = true
        return record
    }

    const mismatchView = async (row: DestinationRow, record: WatchStateRecord): Promise<WatchStateRecord> => {
        const suffix = record.type === 'episode' && record.season !== undefined && record.episode !== undefined ? `:${record.season}:${record.episode}` : ''
        return {
            id: `${record.type}:${row.id}${suffix}`,
            title: row.name,
            type: 'unknown',
            identities: [],
            playedAt: null,
            notes: [row.removed ? REMOVED_ROW : 'The destination identifiers disagree with this title, so it cannot be imported.'],
            fingerprint: await recordFingerprint(scope, row.raw),
        }
    }

    const createTargets = async (record: WatchStateRecord): Promise<WatchStateRecord[]> => {
        const rowId = candidateRowIds(record).find(id => PROVIDER_ITEM_ID.test(id))
        if (rowId === undefined) return []
        if (record.type === 'movie') {
            const identity = canonicalWatchIdentity('movie', rowId)
            if (identity === null) return []
            return [{
                id: `movie:${rowId}`,
                title: record.title,
                type: 'movie',
                identities: [identity],
                watched: false,
                positionMs: 0,
                playedAt: null,
                playCount: 0,
                unmodified: true,
                notes: [],
                fingerprint: await watchFingerprint({ scope, planned: `movie:${rowId}` }),
            }]
        }
        if (record.type === 'episode' && record.season !== undefined && record.episode !== undefined) {
            const identity = canonicalWatchIdentity('episode', rowId, record.season, record.episode)
            if (identity === null) return []
            const index = await seriesIndexFor(rowId)
            if (index === null || !index.bySeasonEpisode.has(seasonEpisodeKey(record.season, record.episode))) return []
            return [{
                id: `episode:${rowId}:${record.season}:${record.episode}`,
                title: record.seriesTitle || record.title,
                type: 'episode',
                seriesTitle: record.seriesTitle,
                episodeTitle: record.episodeTitle,
                identities: [identity],
                season: record.season,
                episode: record.episode,
                watched: false,
                positionMs: 0,
                playedAt: null,
                playCount: 0,
                unmodified: true,
                notes: [],
                fingerprint: await watchFingerprint({ scope, planned: `episode:${rowId}:${record.season}:${record.episode}` }),
            }]
        }
        return []
    }

    const resolve = async (record: WatchStateRecord, resolveSignal: AbortSignal): Promise<WatchStateRecord[]> => {
        if (!record.identities.length) return []
        const inventory = await ensureInventory(resolveSignal)
        resolveSignal.throwIfAborted()
        const matched = new Map<string, DestinationRow>()
        for (const rowId of candidateRowIds(record)) {
            const row = inventory.get(rowId)
            if (row !== undefined) matched.set(rowId, row)
        }
        if (matched.size === 0) return createTargets(record)
        const views: WatchStateRecord[] = []
        for (const row of matched.values()) {
            if (record.type === 'movie') {
                views.push(row.removed || row.kind !== 'movie' ? await mismatchView(row, record) : await movieView(row))
            } else if (record.type === 'episode') {
                if (row.removed || row.kind !== 'series' || record.season === undefined || record.episode === undefined) {
                    views.push(await mismatchView(row, record))
                } else {
                    views.push(await episodeView(row, await seriesIndexFor(row.id), record.season, record.episode))
                }
            } else {
                views.push(await mismatchView(row, record))
            }
        }
        return views
    }

    const verifyMovieReadback = async (
        readback: DestinationRow,
        patch: WatchStatePatch,
        baseline: DestinationRow | null,
        createdRow: Record<string, unknown> | null,
        lastWatched: string | null = null
    ): Promise<WatchStateRecord> => {
        if (readback.removed || readback.kind !== 'movie') throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        const state = readback.state
        if (patch.watched === true && !((finiteNumber(state.flaggedWatched) ?? 0) > 0 || (finiteNumber(state.timesWatched) ?? 0) > 0)) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        if (patch.positionMs !== undefined) {
            if (finiteNumber(state.timeOffset) !== patch.positionMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (patch.durationMs !== undefined && finiteNumber(state.duration) !== patch.durationMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        if (lastWatched !== null && epochMs(state.lastWatched) !== Date.parse(lastWatched)) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        if (baseline !== null) {
            if (readback.id !== baseline.id || readback.name !== baseline.name) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        } else if (createdRow !== null) {
            if (readback.id !== createdRow._id || readback.name !== createdRow.name) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        if (baseline !== null) {
            const written = new Set<string>()
            if (patch.watched === true) written.add('flaggedWatched')
            if (patch.positionMs !== undefined) written.add('timeOffset')
            if (patch.positionMs !== undefined && patch.durationMs !== undefined) written.add('duration')
            if (lastWatched !== null) written.add('lastWatched')
            for (const field of STATE_FIELDS) {
                if (!written.has(field) && state[field] !== baseline.state[field]) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            }
        }
        return movieView(readback)
    }

    const verifyEpisodeReadback = async (readback: DestinationRow, check: EpisodeWriteCheck): Promise<WatchStateRecord> => {
        if (readback.removed || readback.kind !== 'series') throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        if (readback.id !== check.prewrite.id || readback.name !== check.prewrite.name) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        const written = new Set<string>()
        if (check.lastWatched) {
            written.add('lastWatched')
            if (epochMs(readback.state.lastWatched) !== Date.parse(check.lastWatched)) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        if (check.patch.watched === true) {
            written.add('watched')
            written.add('timesWatched')
            const bits = await readSeriesBits(readback.state, check.index)
            if (bits.kind !== 'bits' || bits.indices.length !== check.expectedBits.length) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            for (const bit of bits.indices) if (!check.expectedBits.includes(bit)) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (finiteNumber(readback.state.timesWatched) !== check.expectedBits.length) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        if (check.patch.positionMs !== undefined) {
            written.add('video_id')
            written.add('season')
            written.add('episode')
            written.add('timeOffset')
            if (slotStatus(readback.state, check.index, check.season, check.episode) !== 'target') throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (readback.state.video_id !== check.index.order[check.targetIndex].id) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (intOrUndefined(readback.state.season) !== check.season || intOrUndefined(readback.state.episode) !== check.episode) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (finiteNumber(readback.state.timeOffset) !== check.patch.positionMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (check.patch.durationMs !== undefined) {
                if (finiteNumber(readback.state.duration) !== check.patch.durationMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
                written.add('duration')
            }
        }
        for (const field of STATE_FIELDS) {
            if (!written.has(field) && readback.state[field] !== check.prewrite.state[field]) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        return episodeView(readback, check.index, check.season, check.episode)
    }

    const createMovieRow = async (request: DestinationRequest, checkedAt: number, rowId: string, expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult> => {
        if (!PROVIDER_ITEM_ID.test(rowId)) throw new Error(BAD_TARGET)
        const now = new Date().toISOString()
        const state: Record<string, unknown> = {}
        if (patch.watched === true) state.flaggedWatched = 1
        if (patch.positionMs !== undefined) {
            state.timeOffset = patch.positionMs
            if (patch.durationMs !== undefined && Number.isSafeInteger(patch.durationMs) && patch.durationMs >= patch.positionMs) state.duration = patch.durationMs
        }
        const lastWatched = plannedLastWatched(undefined, patch, 'movie')
        if (lastWatched !== null) state.lastWatched = lastWatched
        const row: Record<string, unknown> = { _id: rowId, name: expected.title || rowId, type: 'movie', poster: '', removed: false, temp: false, _ctime: now, _mtime: createdMtime(state, now), state }
        await putRow(request, checkedAt, row, signal)
        await trackOwnWrite(rowId, row, null, patch.watched === true ? { watched: true } : { positionMs: patch.positionMs })
        signal.throwIfAborted()
        const readback = await readRow(request, rowId, signal, 'readback')
        if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        const view = await verifyMovieReadback(readback, patch, null, row, lastWatched)
        return { status: 'applied', message: APPLIED_MESSAGE, record: view }
    }

    const applyMovie = async (rowId: string, expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult> => {
        const { request } = await migrationStage('identity', () => options.open(signal))
        signal.throwIfAborted()
        const fresh = await readRow(request, rowId, signal)
        signal.throwIfAborted()
        const checkedAt = Date.now()
        const keptRecord = fresh === null ? undefined : await movieView(fresh)
        if (patch.watched !== undefined && patch.positionMs !== undefined) return { status: 'conflict', message: CANNOT_COMBINE, record: keptRecord }
        if (patch.watched === undefined && patch.positionMs === undefined) return { status: 'unchanged', message: NOTHING_SELECTED, record: keptRecord }
        if (patch.positionMs !== undefined && (!Number.isSafeInteger(patch.positionMs) || patch.positionMs <= 0)) return { status: 'conflict', message: BAD_RESUME, record: keptRecord }
        if (fresh === null) return createMovieRow(request, checkedAt, rowId, expected, patch, signal)
        if (fresh.removed) return { status: 'conflict', message: REMOVED_ROW, record: keptRecord }
        if (fresh.kind !== 'movie') return { status: 'conflict', message: CHANGED_MESSAGE, record: keptRecord }
        const desired = (patch.watched === true && keptRecord !== undefined && keptRecord.watched === true)
            || (patch.positionMs !== undefined && keptRecord !== undefined && keptRecord.positionMs === patch.positionMs)
        if (desired && keptRecord !== undefined) {
            const own = await ownWriteFor(rowId, fresh, null)
            if (own === null) return { status: 'unchanged', message: ALREADY_SAVED, record: keptRecord }
            const readback = await readRow(request, rowId, signal, 'readback')
            if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            const view = await verifyMovieReadback(readback, patch, fresh, null)
            return { status: 'applied', message: APPLIED_MESSAGE, record: view }
        }
        if (keptRecord !== undefined && hasSavedWatchState(keptRecord)) return { status: 'conflict', message: SAVED_UNSEEN, record: keptRecord }
        const state: Record<string, unknown> = { ...fresh.state }
        if (patch.watched === true) state.flaggedWatched = 1
        if (patch.positionMs !== undefined) {
            state.timeOffset = patch.positionMs
            if (patch.durationMs !== undefined && Number.isSafeInteger(patch.durationMs) && patch.durationMs >= patch.positionMs) state.duration = patch.durationMs
        }
        const lastWatched = plannedLastWatched(fresh.state.lastWatched, patch, 'movie')
        if (lastWatched !== null) state.lastWatched = lastWatched
        const row = stampedRow(fresh.raw, state)
        await putRow(request, checkedAt, row, signal)
        await trackOwnWrite(rowId, row, null, patch.watched === true ? { watched: true } : { positionMs: patch.positionMs })
        signal.throwIfAborted()
        const readback = await readRow(request, rowId, signal, 'readback')
        if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        const view = await verifyMovieReadback(readback, patch, fresh, null, lastWatched)
        return { status: 'applied', message: APPLIED_MESSAGE, record: view }
    }

    const createEpisodeRow = async (
        request: DestinationRequest,
        checkedAt: number,
        rowId: string,
        season: number,
        episode: number,
        targetIndex: number,
        index: StremioSeriesIndex,
        expected: WatchStateRecord,
        patch: WatchStatePatch,
        signal: AbortSignal
    ): Promise<MigrationWriteResult> => {
        if (!PROVIDER_ITEM_ID.test(rowId)) throw new Error(BAD_TARGET)
        const now = new Date().toISOString()
        const state: Record<string, unknown> = {}
        if (patch.watched === true) {
            state.watched = await encodeWatchedBitfield([targetIndex], index.order)
            state.timesWatched = 1
        } else if (patch.positionMs !== undefined) {
            state.video_id = index.order[targetIndex].id
            state.season = season
            state.episode = episode
            state.timeOffset = patch.positionMs
            if (patch.durationMs !== undefined && Number.isSafeInteger(patch.durationMs) && patch.durationMs >= patch.positionMs) state.duration = patch.durationMs
        }
        const lastWatched = plannedLastWatched(undefined, patch, 'series')
        if (lastWatched !== null) state.lastWatched = lastWatched
        const row: Record<string, unknown> = { _id: rowId, name: expected.seriesTitle || expected.title || rowId, type: 'series', poster: '', removed: false, temp: false, _ctime: now, _mtime: createdMtime(state, now), state }
        await putRow(request, checkedAt, row, signal)
        await trackOwnWrite(rowId, row, seasonEpisodeKey(season, episode), patch.watched === true ? { watched: true } : { positionMs: patch.positionMs })
        signal.throwIfAborted()
        const readback = await readRow(request, rowId, signal, 'readback')
        if (readback === null || readback.removed || readback.kind !== 'series' || readback.id !== rowId || readback.name !== row.name) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        if (lastWatched !== null && epochMs(readback.state.lastWatched) !== Date.parse(lastWatched)) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        if (patch.watched === true) {
            const bits = await readSeriesBits(readback.state, index)
            if (bits.kind !== 'bits' || bits.indices.length !== 1 || bits.indices[0] !== targetIndex) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (finiteNumber(readback.state.timesWatched) !== 1) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        } else if (patch.positionMs !== undefined) {
            if (readback.state.video_id !== index.order[targetIndex].id
                || intOrUndefined(readback.state.season) !== season
                || intOrUndefined(readback.state.episode) !== episode
                || finiteNumber(readback.state.timeOffset) !== patch.positionMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            if (patch.durationMs !== undefined && finiteNumber(readback.state.duration) !== patch.durationMs) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        }
        return { status: 'applied', message: APPLIED_MESSAGE, record: await episodeView(readback, index, season, episode) }
    }

    const preflight = async (record: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<string | null> => {
        if (record.type !== 'episode' || patch.watched !== true) return null
        const rowId = candidateRowIds(record).find(id => PROVIDER_ITEM_ID.test(id))
        if (!rowId) return UNSAFE_EPISODE_LIST
        const inventory = await ensureInventory(signal)
        const row = inventory.get(rowId)
        const type = row ? row.raw.type : 'series'
        if (typeof type !== 'string') return UNSAFE_EPISODE_LIST
        const started = Date.now()
        const videos = await options.safeBitfieldVideos?.(rowId, type).catch(() => null)
        signal.throwIfAborted()
        const index = normalizeSeriesVideos(videos ?? null)
        if (!index || Date.now() < started || Date.now() - started > 60_000) return UNSAFE_EPISODE_LIST
        seriesIndexCache.set(rowId, Promise.resolve(index))
        return null
    }

    const applyEpisode = async (rowId: string, season: number, episode: number, expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult> => {
        const episodeKey = seasonEpisodeKey(season, episode)
        const { request } = await migrationStage('identity', () => options.open(signal))
        signal.throwIfAborted()
        const checkedAt = Date.now()
        const fresh = await readRow(request, rowId, signal)
        signal.throwIfAborted()
        const type = fresh ? fresh.raw.type : 'series'
        const videos = typeof type === 'string' ? await options.safeBitfieldVideos?.(rowId, type).catch(() => null) : null
        signal.throwIfAborted()
        const index = normalizeSeriesVideos(videos ?? null)
        if (index === null) return { status: 'skipped', message: UNSAFE_EPISODE_LIST }
        const unready = async (message: string): Promise<MigrationWriteResult> => ({
            status: 'conflict',
            message,
            record: fresh === null ? undefined : await episodeView(fresh, index, season, episode),
        })
        if (patch.watched !== undefined && patch.positionMs !== undefined) return unready(CANNOT_COMBINE)
        const positionMs = patch.positionMs
        if (positionMs !== undefined && (!Number.isSafeInteger(positionMs) || positionMs <= 0)) return unready(BAD_RESUME)
        const targetIndex = index.bySeasonEpisode.get(episodeKey)
        if (targetIndex === undefined) return unready(EPISODE_NOT_LISTED)
        if (fresh === null) return createEpisodeRow(request, checkedAt, rowId, season, episode, targetIndex, index, expected, patch, signal)
        if (fresh.removed) return unready(REMOVED_ROW)
        if (fresh.kind !== 'series') return unready(CHANGED_MESSAGE)
        const bits = await readSeriesBits(fresh.state, index)
        if (bits.kind === 'unprovable') return unready(SERIES_UNPROVABLE)
        const existingBits = bits.kind === 'bits' ? bits.indices : []
        const slot = slotStatus(fresh.state, index, season, episode)
        const slotOffset = positiveDuration(fresh.state.timeOffset)
        if (patch.watched === true) {
            if (existingBits.includes(targetIndex)) {
                const view = await episodeView(fresh, index, season, episode)
                const own = await ownWriteFor(rowId, fresh, episodeKey)
                if (own === null || own.watched !== true) return { status: 'unchanged', message: ALREADY_SAVED, record: view }
                const readback = await readRow(request, rowId, signal, 'readback')
                if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
                const verified = await verifyEpisodeReadback(readback, { patch, index, season, episode, targetIndex, prewrite: fresh, expectedBits: existingBits })
                return { status: 'applied', message: APPLIED_MESSAGE, record: verified }
            }
            if (slot === 'target' && slotOffset !== null) return unready(SAVED_UNSEEN)
            const mergedBits = [...existingBits, targetIndex].sort((a, b) => a - b)
            const state: Record<string, unknown> = { ...fresh.state, watched: await encodeWatchedBitfield(mergedBits, index.order), timesWatched: mergedBits.length }
            const lastWatched = plannedLastWatched(fresh.state.lastWatched, patch, 'series')
            if (lastWatched !== null) state.lastWatched = lastWatched
            const row = stampedRow(fresh.raw, state)
            await putRow(request, checkedAt, row, signal)
            await trackOwnWrite(rowId, row, episodeKey, { watched: true })
            signal.throwIfAborted()
            const readback = await readRow(request, rowId, signal, 'readback')
            if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
            const verified = await verifyEpisodeReadback(readback, { patch, lastWatched, index, season, episode, targetIndex, prewrite: fresh, expectedBits: mergedBits })
            return { status: 'applied', message: APPLIED_MESSAGE, record: verified }
        }
        if (existingBits.includes(targetIndex)) return unready(SAVED_UNSEEN)
        if (positionMs === undefined) return { status: 'unchanged', message: NOTHING_SELECTED, record: await episodeView(fresh, index, season, episode) }
        if (slot === 'target' && slotOffset !== null) {
            if (Math.round(slotOffset) === positionMs) {
                const view = await episodeView(fresh, index, season, episode)
                const own = await ownWriteFor(rowId, fresh, episodeKey)
                if (own === null || own.positionMs !== positionMs) return { status: 'unchanged', message: ALREADY_SAVED, record: view }
                const readback = await readRow(request, rowId, signal, 'readback')
                if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
                const verified = await verifyEpisodeReadback(readback, { patch, index, season, episode, targetIndex, prewrite: fresh, expectedBits: existingBits })
                return { status: 'applied', message: APPLIED_MESSAGE, record: verified }
            }
            return unready(RESUME_EXISTS)
        }
        if (slot !== 'absent' && slot !== 'target') return unready(slot === 'other' ? SLOT_OTHER : SLOT_UNVERIFIED)
        const state: Record<string, unknown> = {
            ...fresh.state,
            video_id: index.order[targetIndex].id,
            season,
            episode,
            timeOffset: positionMs,
        }
        if (patch.durationMs !== undefined && Number.isSafeInteger(patch.durationMs) && patch.durationMs >= positionMs) state.duration = patch.durationMs
        const lastWatched = plannedLastWatched(fresh.state.lastWatched, patch, 'series')
        if (lastWatched !== null) state.lastWatched = lastWatched
        const row = stampedRow(fresh.raw, state)
        await putRow(request, checkedAt, row, signal)
        await trackOwnWrite(rowId, row, episodeKey, { positionMs })
        signal.throwIfAborted()
        const readback = await readRow(request, rowId, signal, 'readback')
        if (readback === null) throw new WatchMigrationError({ stage: 'verification', reason: 'state_mismatch' }, READBACK_FAILED)
        const verified = await verifyEpisodeReadback(readback, { patch, lastWatched, index, season, episode, targetIndex, prewrite: fresh, expectedBits: existingBits })
        return { status: 'applied', message: APPLIED_MESSAGE, record: verified }
    }

    const apply = async (expected: WatchStateRecord, patch: WatchStatePatch, applySignal: AbortSignal): Promise<MigrationWriteResult> => {
        const target = parseTargetId(expected)
        if (target === null || (target.kind === 'movie') !== (expected.type === 'movie')) throw new Error(BAD_TARGET)
        const run = (): Promise<MigrationWriteResult> => target.kind === 'movie'
            ? applyMovie(target.rowId, expected, patch, applySignal)
            : applyEpisode(target.rowId, target.season, target.episode, expected, patch, applySignal)
        const previous = rowLocks.get(target.rowId) ?? Promise.resolve()
        const result = previous.then(run, run)
        rowLocks.set(target.rowId, result.then(() => undefined, () => undefined))
        return result
    }

    return { connectionId, label, subject, scope, capabilities, preflight, resolve, apply }
}
