// Nuvio watch-state destination (manual import): pure, transport-injected, UI-free.
//
// Interface for runtime integration (the parent owns factories/session wrappers):
//   createNuvioWatchDestination(options) -> WatchStateDestination
//   options: { connectionId, label, subject, scope, open(signal) }
//   options.open(signal) resolves AFTER re-verifying the connection and returns a
//   profile-pinned transport: { profileIndex, rpc(fn, body, signal) } where fn is one of
//   'sync_pull_watched_items' | 'sync_pull_watch_progress' | 'sync_push_watched_items' | 'sync_push_watch_progress'.
//   This module owns matching, write decisions and readback verification; it never authenticates.
//
// Nuvio contracts used by this adapter:
//   - sync_push_watched_items { p_profile_id, p_items: [{ content_id, content_type 'movie'|'series',
//     title, watched_at epoch ms, season?, episode? }] } upserts on
//     (user_id, content_id, season, episode, profile_id), dedups by max watched_at and only
//     writes when a tracked field changed.
//   - sync_push_watch_progress { p_profile_id, p_entries: [{ content_id, content_type, video_id,
//     season, episode, position ms, duration ms, last_watched epoch ms }] } ignores stale pushes:
//     a position not newer than stored progress, or not newer than an existing completion unless
//     the position is >= 90% of the duration. Positions >= 90% of a duration >= 60 s also store a
//     watched row automatically.
//   - Completion (watched_at) and resume (last_watched) are independent fields with independent
//     original times: the watched push carries the patch completion date (patch.playedAt) and the
//     progress push carries the patch resume date (patch.resumePlayedAt when the source exposes
//     one, patch.playedAt otherwise; an explicit null means unknown and is never invented from
//     the completion time). Identity is content_id plus exact season/episode, and movies never
//     carry them.
import type { MigrationWriteResult, WatchStateDestination, WatchStatePatch, WatchStateRecord } from './types.ts'
import { canonicalWatchIdentity, hasSavedWatchState, sameWatchTitle, sourceTime, watchFingerprint } from './records.ts'
import { assertFreshChecks, StaleChecksError } from './prewrite-fresh.ts'

export type NuvioWatchRpcName = 'sync_pull_watched_items' | 'sync_pull_watch_progress' | 'sync_push_watched_items' | 'sync_push_watch_progress'

export interface NuvioWatchDestinationTransport {
    /** Every RPC in this transport stays pinned to one Nuvio profile index. */
    profileIndex: number
    rpc(fn: NuvioWatchRpcName, body: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void): Promise<unknown>
}

export interface NuvioWatchDestinationOptions {
    connectionId: string
    label: string
    subject: string
    scope: string
    /** Returns a verified, profile-pinned transport; the runtime wrapper owns auth and identity re-checks. */
    open(signal: AbortSignal): Promise<NuvioWatchDestinationTransport>
    /** Runs once before the first write of an import run (fresh token and identity check). */
    beginRun?(signal: AbortSignal): Promise<void>
    /**
     * Off by default. When true, apply() may reuse the previous row's pull (its readback, or an early-exit pre-write pull
     * with no write since) as this row's pre-write state if it is younger than reuseWindowMs. The readback after a write is never skipped.
     */
    reuseRecentPull?: boolean
    reuseWindowMs?: number
    now?: () => number
}

const CONTENT_ID = /^(?:tt\d{5,}|tmdb:\d+)$/
const PAGE_SIZE = 1_000
const MAX_ROWS = 5_000
const MAX_PAGES = 100
const DEFAULT_REUSE_WINDOW_MS = 2_000
const READBACK_FAILED = 'The Nuvio write could not be verified by reading the profile back. Preview again to check whether it was saved.'

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

function resultRows(result: unknown, fn: string): unknown[] {
    if (Array.isArray(result)) return result
    if (isRecord(result)) {
        for (const key of ['items', 'rows', 'entries', 'list', 'data', 'results']) {
            const value = result[key]
            if (Array.isArray(value)) return value
        }
    }
    throw new Error(`Nuvio ${fn} returned an unexpected response shape; nothing was interpreted as data.`)
}

function firstString(...values: Array<unknown>): string | null {
    for (const value of values) if (typeof value === 'string' && value) return value
    return null
}

function checkPushResult(result: unknown, fn: string): void {
    if (isRecord(result)) {
        if (result.success === false) throw new Error(`Nuvio ${fn} rejected the update.`)
        if (result.error !== undefined && result.error !== null) throw new Error(`Nuvio ${fn} returned an application error.`)
    }
}

interface NuvioTarget {
    identity: string
    contentId: string
    type: 'movie' | 'episode'
    season?: number
    episode?: number
}

/** Maps a pulled row onto its canonical identity; unmappable rows are skipped, never guessed. */
function parseRowTarget(entry: unknown, fn: string): NuvioTarget | null {
    if (!isRecord(entry)) throw new Error(`Nuvio ${fn} returned a malformed row; refusing to guess.`)
    const contentId = entry.content_id
    if (typeof contentId !== 'string' || !CONTENT_ID.test(contentId)) return null
    const contentType = entry.content_type === 'movie' ? 'movie' : entry.content_type === 'series' ? 'series' : null
    if (!contentType) return null
    if (contentType === 'movie') {
        const identity = canonicalWatchIdentity('movie', contentId)
        return identity ? { identity, contentId, type: 'movie' } : null
    }
    const season = intOrUndefined(entry.season)
    const episode = intOrUndefined(entry.episode)
    const identity = canonicalWatchIdentity('episode', contentId, season, episode)
    return identity ? { identity, contentId, type: 'episode', season, episode } : null
}

/** Only imdb and tmdb identities are addressable by the Nuvio profile tables. */
function parseCanonicalTarget(identity: string): NuvioTarget | null {
    const parts = identity.split(':')
    if (parts.length < 3) return null
    const type = parts[0]
    if (type !== 'movie' && type !== 'episode') return null
    let contentId: string
    let seasonIndex: number
    if (parts[1] === 'imdb') {
        contentId = parts[2]
        seasonIndex = 3
    } else if (parts[1] === 'tmdb') {
        contentId = `tmdb:${parts[2]}`
        seasonIndex = 3
    } else return null
    if (!CONTENT_ID.test(contentId)) return null
    if (type === 'movie') return parts.length === 3 ? { identity, contentId, type: 'movie' } : null
    const season = Number(parts[seasonIndex])
    const episode = Number(parts[seasonIndex + 1])
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) return null
    return { identity, contentId, type: 'episode', season, episode }
}

interface NuvioRow {
    target: NuvioTarget
    row: Record<string, unknown>
}

interface NuvioPull {
    history: Map<string, NuvioRow>
    progress: Map<string, NuvioRow>
    complete: boolean
}

// The pull loops mirror source-nuvio.ts deliberately (they are parent-owned there and not
// exported); the pagination guards and the strict-cursor tie handling stay identical.
async function pullWatched(profileIndex: number, rpc: NuvioWatchDestinationTransport['rpc'], signal: AbortSignal): Promise<{ rows: Map<string, NuvioRow>; complete: boolean }> {
    const byIdentity = new Map<string, NuvioRow>()
    let complete = true
    let previousPageKey: string | null = null
    let seen = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
        signal.throwIfAborted()
        const result = await rpc('sync_pull_watched_items', { p_profile_id: profileIndex, p_page: page, p_page_size: PAGE_SIZE }, signal)
        const rows = resultRows(result, 'sync_pull_watched_items')
        if (rows.length === 0) break
        const pageIdentities: string[] = []
        for (const entry of rows) {
            const parsed = parseRowTarget(entry, 'sync_pull_watched_items')
            if (!parsed) continue
            pageIdentities.push(parsed.identity)
            const row = entry as Record<string, unknown>
            const existing = byIdentity.get(parsed.identity)
            if (!existing || (epochMs(row.watched_at) ?? -1) >= (epochMs(existing.row.watched_at) ?? -1)) byIdentity.set(parsed.identity, { target: parsed, row })
        }
        const pageKey = pageIdentities.length > 0 ? pageIdentities.join('|') : null
        if (pageKey !== null && previousPageKey !== null && pageKey === previousPageKey) {
            complete = false
            break
        }
        if (pageKey !== null) previousPageKey = pageKey
        seen += rows.length
        if (rows.length < PAGE_SIZE) break
        if (seen >= MAX_ROWS) { complete = false; break }
    }
    return { rows: byIdentity, complete }
}

async function pullProgress(profileIndex: number, rpc: NuvioWatchDestinationTransport['rpc'], signal: AbortSignal): Promise<{ rows: Map<string, NuvioRow>; complete: boolean }> {
    const byIdentity = new Map<string, NuvioRow>()
    let complete = true
    let cursor = 0
    let seen = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
        signal.throwIfAborted()
        const result = await rpc('sync_pull_watch_progress', { p_profile_id: profileIndex, p_since_last_watched: cursor, p_limit: PAGE_SIZE }, signal)
        const rows = resultRows(result, 'sync_pull_watch_progress')
        if (rows.length === 0) break
        let pageMax: number | null = null
        for (const entry of rows) {
            const parsed = parseRowTarget(entry, 'sync_pull_watch_progress')
            if (!parsed) continue
            const row = entry as Record<string, unknown>
            const time = epochMs(row.last_watched)
            if (time !== null && (pageMax === null || time > pageMax)) pageMax = time
            const existing = byIdentity.get(parsed.identity)
            const existingTime = existing ? epochMs(existing.row.last_watched) : null
            if (!existing || (time !== null && (existingTime === null || time >= existingTime))) byIdentity.set(parsed.identity, { target: parsed, row })
        }
        seen += rows.length
        if (pageMax !== null && pageMax <= cursor) { complete = false; break }
        // p_since_last_watched is a strict '>' cursor, so a full page can always hide a tied row.
        if (rows.length >= PAGE_SIZE) complete = false
        if (rows.length < PAGE_SIZE) break
        if (seen >= MAX_ROWS) { complete = false; break }
        if (pageMax !== null) cursor = pageMax
    }
    return { rows: byIdentity, complete }
}

async function pullAll(profileIndex: number, rpc: NuvioWatchDestinationTransport['rpc'], signal: AbortSignal): Promise<NuvioPull> {
    const [history, progress] = await Promise.all([
        pullWatched(profileIndex, rpc, signal),
        pullProgress(profileIndex, rpc, signal),
    ])
    return { history: history.rows, progress: progress.rows, complete: history.complete && progress.complete }
}

async function mergedRecord(scope: string, target: NuvioTarget, historyRow: Record<string, unknown> | null, progressRow: Record<string, unknown> | null): Promise<WatchStateRecord> {
    const watched = historyRow !== null
    const position = progressRow ? finiteNumber(progressRow.position) : null
    const positionMs = position !== null && position > 0 ? Math.round(position) : null
    const duration = progressRow ? positiveDuration(progressRow.duration) : null
    const watchedAt = historyRow ? epochMs(historyRow.watched_at) : null
    const lastWatched = progressRow ? epochMs(progressRow.last_watched) : null
    const videoId = progressRow && typeof progressRow.video_id === 'string' ? progressRow.video_id : null
    const record: WatchStateRecord = {
        id: target.type === 'movie' ? `movie:${target.contentId}` : `episode:${target.contentId}:${target.season}:${target.episode}`,
        title: firstString(historyRow?.title, progressRow?.title) ?? target.contentId,
        type: target.type,
        identities: [target.identity],
        watched,
        // Mirror of the source merge: an existing history row makes the completion date the
        // watch date even when it is unknown; only an absent history row falls back to the
        // resume date, so a missing completion date is never silently replaced by it.
        playedAt: watched ? watchedAt : lastWatched,
        ...(progressRow ? { resumePlayedAt: lastWatched } : {}),
        fingerprint: await watchFingerprint({ scope, identity: target.identity, watched, positionMs, durationMs: duration, watchedAt, lastWatched, videoId }),
    }
    if (target.type === 'episode') {
        record.season = target.season
        record.episode = target.episode
    }
    if (positionMs !== null) record.positionMs = positionMs
    if (duration !== null) record.durationMs = Math.round(duration)
    return record
}

/** Exact confirmed absence: no invented time, no invented state, source duration carried for the write. */
async function placeholderRecord(scope: string, target: NuvioTarget, expected: WatchStateRecord): Promise<WatchStateRecord> {
    const durationMs = positiveDuration(expected.durationMs)
    const record: WatchStateRecord = {
        id: target.type === 'movie' ? `movie:${target.contentId}` : `episode:${target.contentId}:${target.season}:${target.episode}`,
        title: expected.title || target.contentId,
        type: target.type,
        identities: [target.identity],
        watched: false,
        positionMs: 0,
        playedAt: null,
        playCount: 0,
        unmodified: true,
        fingerprint: await watchFingerprint({ scope, absent: true, identity: target.identity, durationMs }),
    }
    if (target.type === 'episode') {
        record.season = target.season
        record.episode = target.episode
    }
    if (durationMs !== null) record.durationMs = durationMs
    return record
}

export function createNuvioWatchDestination(options: NuvioWatchDestinationOptions): WatchStateDestination {
    const { connectionId, label, subject, scope } = options
    const capabilities: WatchStateDestination['capabilities'] = {
        watched: true,
        resume: true,
        dates: true,
        counts: false,
        combined: true,
        requiresDates: true,
        requiresDuration: true,
        notes: [
            'All Nuvio reads and writes stay pinned to the one selected Nuvio profile; other profiles of the account are never touched.',
            'Nuvio sync pushes have no conditional writes: every write re-reads the profile before and after it, and newer destination edits win.',
            'Nuvio stores completion and resume times independently: a title with both keeps each field’s exact original time, and a resume time the source cannot date is never invented from the completion time.',
            'Watched flags and resume points are imported only when the source supplies the original time and, for resume points, a verified runtime; an unknown date or runtime is skipped instead of being stamped with the import time.',
            'Nuvio treats a pushed position at or above 90% of a runtime of one minute or more as completed playback and stores a watched row dated at the resume time.',
            'When such a high-progress resume is newer than the requested completion, Nuvio would keep the newer completion, so the exact pair cannot be preserved and the import is refused before anything is written.',
            'Nuvio ignores a resume position that is not newer than an existing completion, so a completed title cannot receive an older or same-time resume point.',
            'This destination never deletes or resets Nuvio history and never changes library or collection membership.',
            'Live playback cannot be detected from the Nuvio sync tables, so an in-progress destination stream is unknown; import while playback is stopped.',
        ],
    }

    // Preview-resolution cache: the exact pull behind this instance's last successful resolve()
    // chain. Only resolve() fills it; apply() always pulls live state and drops the cache.
    let previewPull: Promise<NuvioPull> | null = null
    const ensurePull = (signal: AbortSignal): Promise<NuvioPull> => {
        if (previewPull === null) {
            const built = (async () => {
                const transport = await options.open(signal)
                signal.throwIfAborted()
                return pullAll(transport.profileIndex, transport.rpc, signal)
            })()
            previewPull = built
            built.catch(() => {
                if (previewPull === built) previewPull = null
            })
        }
        return previewPull
    }

    // Opt-in: the last pull of this run and when it finished. Cleared before any push and on begin.
    let recentPull: { pull: NuvioPull; profileIndex: number; at: number } | null = null
    const now = options.now ?? Date.now
    const reuseWindowMs = options.reuseWindowMs ?? DEFAULT_REUSE_WINDOW_MS

    async function resolve(record: WatchStateRecord, signal: AbortSignal): Promise<WatchStateRecord[]> {
        signal.throwIfAborted()
        if (!record.identities.length) return []
        const targets = record.identities.map(parseCanonicalTarget).filter((target): target is NuvioTarget => target !== null)
        if (!targets.length) return []
        const pull = await ensurePull(signal)
        const matches: WatchStateRecord[] = []
        const seen = new Set<string>()
        for (const target of targets) {
            if (seen.has(target.identity)) continue
            const history = pull.history.get(target.identity) ?? null
            const progress = pull.progress.get(target.identity) ?? null
            if (!history && !progress) continue
            seen.add(target.identity)
            matches.push(await mergedRecord(scope, target, history?.row ?? null, progress?.row ?? null))
        }
        if (matches.length > 0) return matches
        if (!pull.complete) throw new Error('The Nuvio profile could not be read completely, so matches cannot be verified safely. Try the preview again.')
        return [await placeholderRecord(scope, targets[0], record)]
    }

    async function apply(expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult> {
        signal.throwIfAborted()
        previewPull = null
        const target = parseCanonicalTarget(expected.identities[0] ?? '')
        if (!target || (target.type === 'episode') !== (expected.type === 'episode')) {
            return { status: 'conflict', message: 'This record is not addressable by the Nuvio profile tables; nothing was written.' }
        }
        const wantsWatched = patch.watched === true
        const wantsPosition = typeof patch.positionMs === 'number'
        if (!wantsWatched && !wantsPosition) return { status: 'unchanged', message: 'Nothing was selected to import for this title.' }

        const transport = await options.open(signal)
        signal.throwIfAborted()
        const candidate = recentPull
        recentPull = null
        const reusable = options.reuseRecentPull === true && candidate !== null && candidate.profileIndex === transport.profileIndex && now() - candidate.at <= reuseWindowMs
        const pull = reusable ? candidate.pull : await pullAll(transport.profileIndex, transport.rpc, signal)
        // A reused pull ran no new check just now, so its own finish time dates the checks.
        const checkedAt = reusable ? candidate.at : now()
        if (options.reuseRecentPull === true) recentPull = { pull, profileIndex: transport.profileIndex, at: reusable ? candidate.at : now() }
        const historyRow = pull.history.get(target.identity)?.row ?? null
        const progressRow = pull.progress.get(target.identity)?.row ?? null
        let freshRecord: WatchStateRecord
        if (!historyRow && !progressRow) {
            if (!pull.complete) throw new Error('The Nuvio profile read was incomplete, so this title could not be verified. Preview again.')
            freshRecord = await placeholderRecord(scope, target, expected)
        } else {
            freshRecord = await mergedRecord(scope, target, historyRow, progressRow)
        }
        if (!sameWatchTitle(expected, freshRecord)) {
            return { status: 'conflict', message: 'The destination item changed since the preview. It will be kept; preview again.', record: freshRecord }
        }

        const freshWatchedAt = historyRow ? epochMs(historyRow.watched_at) : null
        const freshLastWatched = progressRow ? epochMs(progressRow.last_watched) : null
        // Completion and resume keep independent original times: the watched push carries the
        // completion date (patch.playedAt) and the progress push carries the resume date
        // (patch.resumePlayedAt when the source distinguishes them, patch.playedAt otherwise).
        // An explicit null resumePlayedAt means the resume date is unknown; it is never
        // borrowed from the completion date or stamped with the import time.
        const completionTime = epochMs(patch.playedAt)
        const resumeTime = patch.resumePlayedAt !== undefined ? epochMs(patch.resumePlayedAt) : completionTime
        const undatedCompletion = patch.playedAt === undefined
        const undatedResume = patch.resumePlayedAt === undefined && patch.playedAt === undefined
        const watchedSatisfied = !wantsWatched || (freshRecord.watched === true && (undatedCompletion || (completionTime !== null && freshWatchedAt === completionTime)))
        const positionSatisfied = !wantsPosition || (freshRecord.positionMs === patch.positionMs && (undatedResume || (resumeTime !== null && freshLastWatched === resumeTime)))
        if (watchedSatisfied && positionSatisfied) {
            return { status: 'unchanged', message: 'The destination already has the selected state. Nothing was written.', record: freshRecord }
        }
        if (wantsPosition && patch.resumePlayedAt === null) {
            return { status: 'conflict', message: 'The source does not know the original resume time for this title. Nuvio keeps each field’s original time, so the resume point was skipped instead of being dated with the completion time.', record: freshRecord }
        }
        if ((wantsWatched && completionTime === null) || (wantsPosition && resumeTime === null)) {
            return { status: 'conflict', message: 'The source has no reliable watch time for this title. Nuvio keeps each field’s original time, so it was skipped instead of being stamped with the import time.', record: freshRecord }
        }

        let durationMs: number | null = null
        if (wantsPosition) {
            const positionMs = patch.positionMs as number
            if (!Number.isFinite(positionMs) || positionMs <= 0) return { status: 'conflict', message: 'The proposed resume point is invalid; nothing was written.', record: freshRecord }
            durationMs = positiveDuration(patch.durationMs) ?? positiveDuration(expected.durationMs)
            if (durationMs === null) return { status: 'conflict', message: 'This title has no meaningful duration, so a resume point was not written.', record: freshRecord }
            if (positionMs > durationMs) return { status: 'conflict', message: 'The proposed resume point is outside this title’s runtime; nothing was written.', record: freshRecord }
        }
        const autoWatchExpected = durationMs !== null && durationMs >= 60_000 && (patch.positionMs as number) >= durationMs * 0.9
        // A resume at or above 90% of a long runtime makes Nuvio store a completion dated at
        // the resume time, and the watched upsert keeps the newest completion. When the
        // requested completion is older than the resume time, no push order preserves the
        // exact pair, so the import is refused before anything is written.
        if (wantsWatched && autoWatchExpected && (resumeTime as number) > (completionTime as number)) {
            return { status: 'conflict', message: 'The original resume time is newer than the original completion time. Nuvio would keep the newer completion that a resume at or above 90% of the runtime stores, so the exact requested dates cannot be preserved; nothing was written.', record: freshRecord }
        }

        let doWatched = wantsWatched && !(freshRecord.watched === true && freshWatchedAt === completionTime)
        let doProgress = wantsPosition && !(freshRecord.positionMs === patch.positionMs && freshLastWatched === resumeTime)
        if (freshRecord.fingerprint === expected.fingerprint) {
            if (hasSavedWatchState(freshRecord)) {
                return { status: 'conflict', message: 'The destination item has watch state the preview did not show. It will be kept.', record: freshRecord }
            }
        } else {
            // The destination moved since the preview. Recognize only our own half-landed
            // write — an exact requested half with the other half absent, or the completion
            // our own >= 90% resume push auto-dated at the resume time; every other edit is kept.
            const progressHalfExact = wantsPosition && freshRecord.positionMs === patch.positionMs && freshLastWatched === resumeTime
            const watchedHalfExact = wantsWatched && freshRecord.watched === true && freshWatchedAt === completionTime
            const autoWatchShadow = wantsWatched && autoWatchExpected && freshRecord.watched === true && freshWatchedAt === resumeTime
            if (progressHalfExact && (!wantsWatched || freshRecord.watched !== true || autoWatchShadow)) {
                doProgress = false
                if (wantsWatched && (freshRecord.watched !== true || autoWatchShadow)) doWatched = true
            } else if (watchedHalfExact && wantsPosition && freshRecord.positionMs === undefined) {
                doWatched = false
                if ((resumeTime as number) <= (freshWatchedAt as number) && !autoWatchExpected) {
                    return { status: 'conflict', message: 'The destination already stores this completion. Nuvio ignores a resume position that is not newer than it, so the resume point cannot be added; the completion is kept.', record: freshRecord }
                }
            } else {
                return { status: 'conflict', message: 'The destination item changed since the preview. It will be kept; preview again.', record: freshRecord }
            }
        }
        if (!doWatched && !doProgress) {
            return { status: 'unchanged', message: 'The destination already has the selected state. Nothing was written.', record: freshRecord }
        }

        recentPull = null
        const contentType = target.type === 'movie' ? 'movie' : 'series'
        // Push the resume first: a completion dated at or after the resume makes the server
        // ignore the resume push, so the completion must land after the position.
        if (doProgress) {
            assertFreshChecks(checkedAt, now())
            const entry = {
                content_id: target.contentId,
                content_type: contentType,
                video_id: target.type === 'episode' ? `${target.contentId}:${target.season}:${target.episode}` : target.contentId,
                season: target.type === 'episode' ? target.season : null,
                episode: target.type === 'episode' ? target.episode : null,
                position: patch.positionMs,
                duration: durationMs,
                last_watched: resumeTime,
            }
            checkPushResult(await transport.rpc('sync_push_watch_progress', { p_profile_id: transport.profileIndex, p_entries: [entry] }, signal, () => assertFreshChecks(checkedAt, now())), 'sync_push_watch_progress')
        }
        if (doWatched) {
            try {
                assertFreshChecks(checkedAt, now())
            } catch (error) {
                throw error instanceof StaleChecksError && doProgress ? new StaleChecksError(true) : error
            }
            const item: Record<string, unknown> = {
                content_id: target.contentId,
                content_type: contentType,
                title: firstString(expected.title, target.contentId) as string,
                watched_at: completionTime,
            }
            if (target.type === 'episode') {
                item.season = target.season
                item.episode = target.episode
            }
            const watchedFresh = () => {
                try {
                    assertFreshChecks(checkedAt, now())
                } catch (error) {
                    throw error instanceof StaleChecksError && doProgress ? new StaleChecksError(true) : error
                }
            }
            checkPushResult(await transport.rpc('sync_push_watched_items', { p_profile_id: transport.profileIndex, p_items: [item] }, signal, watchedFresh), 'sync_push_watched_items')
        }

        const check = await pullAll(transport.profileIndex, transport.rpc, signal)
        const checkHistory = check.history.get(target.identity)?.row ?? null
        const checkProgress = check.progress.get(target.identity)?.row ?? null
        if (!checkHistory && !checkProgress) throw new Error(READBACK_FAILED)
        const verified = await mergedRecord(scope, target, checkHistory, checkProgress)
        if (!sameWatchTitle(expected, verified)) throw new Error(READBACK_FAILED)
        const verifiedWatchedAt = checkHistory ? epochMs(checkHistory.watched_at) : null
        const verifiedLastWatched = checkProgress ? epochMs(checkProgress.last_watched) : null
        if (wantsWatched && !(verified.watched === true && verifiedWatchedAt === completionTime)) throw new Error(READBACK_FAILED)
        if (wantsPosition && !((verified.positionMs as number) === patch.positionMs && verifiedLastWatched === resumeTime && verified.durationMs === durationMs)) throw new Error(READBACK_FAILED)
        if (autoWatchExpected && verified.watched !== true) throw new Error(READBACK_FAILED)
        if (options.reuseRecentPull === true) recentPull = { pull: check, profileIndex: transport.profileIndex, at: now() }
        return { status: 'applied', message: 'Saved and verified by an exact readback.', record: verified }
    }

    async function beginRun(signal: AbortSignal): Promise<void> {
        recentPull = null
        await options.beginRun?.(signal)
    }

    return { connectionId, label, subject, scope, capabilities, resolve, apply, beginRun }
}
