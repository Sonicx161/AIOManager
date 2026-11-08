// Native RealStream 1.0.1+2 movie progress: TMDB identity and a 10000-unit fraction.
// Writes replace a whole progress array. Re-read before writing and verify identities,
// the exact appended entry and all baseline siblings afterward. No atomic CAS exists.
// Continue Watching hydration is verified; native playback may start from the beginning.
import type { MigrationWriteResult, WatchStateDestination, WatchStatePatch, WatchStateRecord } from './types.ts'
import { sourceTime, watchFingerprint } from './records.ts'
import { assertFreshChecks } from './prewrite-fresh.ts'
import type { RealStreamProgressPage } from './source-realstream.ts'

export interface RealStreamWatchDestinationTransport {
    /** Paged read of the pinned user's progress records; totalItems may be NaN when the server omits it. */
    fetchPage(page: number, perPage: number, signal: AbortSignal): Promise<RealStreamProgressPage>
    /** Replaces one record's full data array (PATCH), or creates the user's record when recordId is null (POST). */
    writeRecord(recordId: string | null, entries: Record<string, unknown>[], signal: AbortSignal): Promise<unknown>
}

export interface RealStreamWatchDestinationOptions {
    connectionId: string
    label: string
    subject: string
    scope: string
    /** Returns a verified, user-pinned transport; the runtime wrapper owns auth and identity re-checks. */
    open(signal: AbortSignal): Promise<RealStreamWatchDestinationTransport>
}

const PER_PAGE = 200
const MAX_PAGES = 50
const TMDB_IDENTITY = /^movie:tmdb:([1-9]\d*)$/
const NATIVE_DURATION = 10_000
const READBACK_FAILED = 'The RealStream write could not be verified by reading the list back. Preview again to check whether it was saved.'

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveDuration(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function firstNonEmpty(...values: Array<unknown>): string | null {
    for (const value of values) if (typeof value === 'string' && value) return value
    return null
}

/** Stable deep-stringify for preservation checks (records.ts keeps its own private copy). */
function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]))
    }
    return value
}

function stableStringify(value: unknown): string {
    return JSON.stringify(ordered(value))
}

interface RealStreamEntryHit {
    identity: string
    entry: Record<string, unknown>
    valid: boolean
}

function tmdbIdentity(identity: string): number | null {
    const match = TMDB_IDENTITY.exec(identity)
    return match ? positiveDuration(Number(match[1])) : null
}

/** Also catches partial or contradictory native identities, so they cannot be overwritten. */
function entryHit(entry: Record<string, unknown>, identities: string[]): RealStreamEntryHit | null {
    for (const identity of identities) {
        const tmdb = tmdbIdentity(identity)
        if (tmdb === null) continue
        const uniqueId = `tmdb:${tmdb}`
        if (entry.uniqueId !== uniqueId && String(entry.tmdbId) !== String(tmdb)) continue
        return { identity, entry, valid: entry.uniqueId === uniqueId && entry.tmdbId === tmdb && entry.mediaType === 'movie' }
    }
    return null
}

interface RealStreamContainer {
    id: string
    data: Record<string, unknown>[]
}

interface RealStreamRead {
    containers: RealStreamContainer[]
    broken: Array<{ id: string; data: unknown }>
    complete: boolean
    capped: boolean
}

/** Paged read of every progress record, mirroring the source adapter's completeness guards. */
async function readAll(transport: RealStreamWatchDestinationTransport, signal: AbortSignal): Promise<RealStreamRead> {
    let total: number | null = null
    let complete = true
    let capped = false
    let repeated = false
    let totalsUnverified = false
    let movingTotal = false
    let previousPageKey: string | null = null
    const raw: Array<{ id: string; data: unknown }> = []
    let page = 1
    for (; page <= MAX_PAGES; page++) {
        signal.throwIfAborted()
        const result = await transport.fetchPage(page, PER_PAGE, signal)
        if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('RealStream returned an unexpected response shape; nothing was interpreted as data.')
        if (typeof result.totalItems === 'number' && Number.isSafeInteger(result.totalItems) && result.totalItems >= 0) {
            if (total === null) total = result.totalItems
            else if (result.totalItems !== total) { movingTotal = true; complete = false }
        } else {
            totalsUnverified = true
            complete = false
        }
        const pageKey = `${result.items.length}:${result.items.map(item => (isRecord(item) && typeof item.id === 'string' ? item.id : '')).join(',')}`
        if (result.items.length === PER_PAGE && previousPageKey !== null && pageKey === previousPageKey) {
            repeated = true
            complete = false
            break
        }
        for (const item of result.items) {
            if (!isRecord(item) || typeof item.id !== 'string' || !item.id) throw new Error('RealStream returned a progress record without a usable id; nothing was interpreted as data.')
            raw.push({ id: item.id, data: item.data })
        }
        if (result.items.length < PER_PAGE) break
        previousPageKey = pageKey
    }
    if (page > MAX_PAGES) {
        capped = true
        complete = false
    }
    const containers: RealStreamContainer[] = []
    const broken: Array<{ id: string; data: unknown }> = []
    for (const record of raw) {
        if (Array.isArray(record.data) && record.data.every(isRecord)) containers.push({ id: record.id, data: record.data as Record<string, unknown>[] })
        else broken.push(record)
    }
    if (broken.length > 0) complete = false
    if (total !== null && total !== raw.length) complete = false
    if (new Set(raw.map(record => record.id)).size !== raw.length) complete = false
    signal.throwIfAborted()
    return { containers, broken, complete: complete && !capped && !repeated && !totalsUnverified && !movingTotal, capped }
}

async function recordFromEntry(scope: string, hit: RealStreamEntryHit): Promise<WatchStateRecord> {
    // Native currentTime/duration is a fraction, never elapsed time or a runtime.
    return {
        id: hit.identity,
        title: firstNonEmpty(hit.entry.title, hit.entry.name) ?? 'RealStream entry',
        type: hit.valid ? 'movie' : 'unknown',
        identities: [hit.identity],
        playedAt: sourceTime(hit.entry.lastWatched),
        notes: [hit.valid
            ? 'RealStream already has progress for this movie. Its percentage cannot establish an exact playback position; the existing entry will be kept.'
            : 'The existing RealStream entry has incomplete or conflicting native identifiers. It will be kept.'],
        fingerprint: await watchFingerprint({ scope, entry: hit.entry }),
    }
}

async function placeholderRecord(scope: string, identity: string, expected: WatchStateRecord): Promise<WatchStateRecord> {
    const durationMs = positiveDuration(expected.durationMs)
    return {
        id: identity,
        title: expected.title || identity,
        type: 'movie',
        identities: [identity],
        watched: false,
        positionMs: 0,
        playedAt: null,
        playCount: 0,
        unmodified: true,
        ...(durationMs !== null ? { durationMs } : {}),
        fingerprint: await watchFingerprint({ scope, absent: true, identity, durationMs }),
    }
}

function buildEntry(tmdb: number, patch: WatchStatePatch, expected: WatchStateRecord, durationMs: number): Record<string, unknown> {
    return {
        uniqueId: `tmdb:${tmdb}`,
        tmdbId: tmdb,
        mediaType: 'movie',
        currentTime: Math.round((patch.positionMs as number) / durationMs * NATIVE_DURATION),
        duration: NATIVE_DURATION,
        lastWatched: patch.playedAt,
        title: expected.title,
    }
}

export function createRealStreamWatchDestination(options: RealStreamWatchDestinationOptions): WatchStateDestination {
    const { connectionId, label, subject, scope } = options
    const capabilities: WatchStateDestination['capabilities'] = {
        watched: false,
        resume: true,
        dates: true,
        requiresDates: true,
        requiresDuration: true,
        counts: false,
        combined: false,
        notes: [
            'Continue Watching imports are saved and checked. RealStream may start playback from the beginning.',
            'Only movies with a verified TMDB ID, runtime and original resume date can be imported. Episode identifiers have not been verified.',
            'RealStream saves progress as a percentage rounded to 0.01%. Existing entries are kept; watched flags and play counts cannot be imported.',
            'All reads and writes stay pinned to one verified RealStream user. Every write preserves the other entries and checks the saved result.',
            'The shared list has no atomic compare-and-swap. A write racing another device can still be lost. Import while playback is stopped.',
            'Poster artwork is not copied because the source watch-state record does not include verified artwork.',
        ],
    }

    // Preview-resolution cache: the exact read behind this instance's last successful resolve()
    // chain. Only resolve() fills it; apply() always reads live state and drops the cache.
    let previewRead: Promise<RealStreamRead> | null = null
    const ensureRead = (signal: AbortSignal): Promise<RealStreamRead> => {
        if (previewRead === null) {
            const built = (async () => {
                const transport = await options.open(signal)
                signal.throwIfAborted()
                return readAll(transport, signal)
            })()
            previewRead = built
            built.catch(() => {
                if (previewRead === built) previewRead = null
            })
        }
        return previewRead
    }

    async function resolve(record: WatchStateRecord, signal: AbortSignal): Promise<WatchStateRecord[]> {
        signal.throwIfAborted()
        if (record.type !== 'movie' || !record.identities.some(identity => tmdbIdentity(identity) !== null)) return []
        const read = await ensureRead(signal)
        const matches: WatchStateRecord[] = []
        for (const container of read.containers) {
            for (const entry of container.data) {
                const hit = entryHit(entry, record.identities)
                if (hit === null) continue
                matches.push(await recordFromEntry(scope, hit))
            }
        }
        if (matches.length > 0) return matches
        if (!read.complete) throw new Error('The RealStream progress list could not be read completely, so matches cannot be verified safely. Try the preview again.')
        for (const identity of record.identities) {
            if (tmdbIdentity(identity) !== null) return [await placeholderRecord(scope, identity, record)]
        }
        return []
    }

    async function apply(expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult> {
        signal.throwIfAborted()
        previewRead = null
        if (patch.watched === true || patch.playCount !== undefined) {
            return { status: 'conflict', message: 'RealStream stores current progress only: watched flags and play counts cannot be imported.' }
        }
        const wantsPosition = typeof patch.positionMs === 'number'
        if (!wantsPosition) return { status: 'unchanged', message: 'Nothing was selected to import for this title.' }
        const positionMs = patch.positionMs as number
        if (!Number.isSafeInteger(positionMs) || positionMs <= 0) {
            return { status: 'conflict', message: 'The proposed resume point is invalid; nothing was written.' }
        }

        const transport = await options.open(signal)
        signal.throwIfAborted()
        const read = await readAll(transport, signal)
        if (!read.complete) throw new Error('The RealStream progress list could not be read completely, so this import cannot be verified safely. Preview again.')
        const checkedAt = Date.now()

        const entryMatches: RealStreamEntryHit[] = []
        for (const container of read.containers) {
            for (const entry of container.data) {
                const hit = entryHit(entry, expected.identities)
                if (hit !== null) entryMatches.push(hit)
            }
        }
        if (entryMatches.length > 1) {
            return { status: 'conflict', message: 'More than one destination entry matches this title. They will be kept; resolve the duplicates first.', record: await recordFromEntry(scope, entryMatches[0]) }
        }
        if (entryMatches.length === 1) {
            return { status: 'conflict', message: 'RealStream already has an entry for this movie. It will be kept; preview again.', record: await recordFromEntry(scope, entryMatches[0]) }
        }

        const identity = expected.identities.find(identity => tmdbIdentity(identity) !== null)
        const tmdb = identity ? tmdbIdentity(identity) : null
        if (tmdb === null || identity === undefined || expected.type !== 'movie') {
            return { status: 'conflict', message: 'Only movies with a verified TMDB identity can be imported into RealStream.' }
        }
        const absent = await placeholderRecord(scope, identity, expected)
        if (expected.unmodified !== true || expected.fingerprint !== absent.fingerprint) {
            return { status: 'conflict', message: 'The destination state differs from the preview. Preview again before importing.' }
        }
        const durationMs = patch.durationMs === undefined ? positiveDuration(expected.durationMs) : positiveDuration(patch.durationMs)
        if (durationMs === null || durationMs < positionMs || (expected.durationMs !== undefined && expected.durationMs !== durationMs)) {
            return { status: 'conflict', message: 'A verified runtime at least as long as the resume point is required; nothing was written.' }
        }
        if (!Number.isSafeInteger(patch.playedAt) || sourceTime(patch.playedAt) === null) {
            return { status: 'conflict', message: 'An original resume date is required; nothing was written.' }
        }
        const entry = buildEntry(tmdb, patch, expected, durationMs)
        if (entry.currentTime === 0) {
            return { status: 'conflict', message: 'This resume point is too small for the progress precision in RealStream; nothing was written.' }
        }
        const container = read.containers[0] ?? null
        const sentData = container ? [...container.data, entry] : [entry]
        signal.throwIfAborted()
        assertFreshChecks(checkedAt)
        await transport.writeRecord(container ? container.id : null, sentData, signal)

        // Exact readback: the saved entry, every pre-existing entry, and every other record.
        const check = await readAll(transport, signal)
        if (!check.complete) throw new Error(READBACK_FAILED)
        const saved: RealStreamEntryHit[] = []
        for (const checked of check.containers) {
            for (const checkedEntry of checked.data) {
                const hit = entryHit(checkedEntry, expected.identities)
                if (hit !== null) saved.push(hit)
            }
        }
        if (saved.length !== 1) throw new Error(READBACK_FAILED)
        if (!saved[0].valid || stableStringify(saved[0].entry) !== stableStringify(entry)) throw new Error(READBACK_FAILED)
        // Verify each container separately and preserve duplicate sibling multiplicities.
        const anotherWriter = 'Another writer changed the RealStream progress list during the import. The write could not be verified; preview again.'
        for (const before of read.containers) {
            const after = check.containers.find(candidate => candidate.id === before.id)
            if (!after) throw new Error(anotherWriter)
            const remaining = new Map<string, number>()
            for (const sibling of after.data) {
                const key = stableStringify(sibling)
                remaining.set(key, (remaining.get(key) ?? 0) + 1)
            }
            for (const sibling of before.data) {
                const key = stableStringify(sibling)
                const count = remaining.get(key) ?? 0
                if (count === 0) throw new Error(anotherWriter)
                remaining.set(key, count - 1)
            }
        }
        for (const before of read.broken) {
            const after = check.broken.find(candidate => candidate.id === before.id) ?? check.containers.find(candidate => candidate.id === before.id)
            if (after === undefined || stableStringify(after.data) !== stableStringify(before.data)) throw new Error(anotherWriter)
        }
        if (container !== null) {
            if (!check.containers.some(candidate => candidate.id === container.id)) throw new Error(READBACK_FAILED)
        } else {
            const created = check.containers.filter(candidate => !read.containers.some(before => before.id === candidate.id) && !read.broken.some(before => before.id === candidate.id))
            if (created.length !== 1) throw new Error(READBACK_FAILED)
        }
        return { status: 'applied', message: 'Saved and verified by an exact readback.', record: await recordFromEntry(scope, saved[0]) }
    }

    return { connectionId, label, subject, scope, capabilities, resolve, apply }
}
