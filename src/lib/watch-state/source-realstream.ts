import type { MigrationProgress, WatchStateRecord, WatchStateSnapshot, WatchStateSource } from './types.ts'
import { canonicalWatchIdentity, sourceTime, watchFingerprint } from './records.ts'

export interface RealStreamProgressPage {
    items: Record<string, unknown>[]
    totalItems: number
}

export interface RealStreamWatchSourceOptions {
    connectionId: string
    label: string
    subject: string
    scope: string
    open(signal: AbortSignal): Promise<{ fetchPage(page: number, perPage: number, signal: AbortSignal): Promise<RealStreamProgressPage> }>
}

const PER_PAGE = 200
const MAX_PAGES = 50
const IMDb_IN_POSTER = /(tt\d{5,})/i

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function intOrNull(value: unknown): number | null {
    return Number.isSafeInteger(value) ? (value as number) : null
}

function uniqueKey(entry: Record<string, unknown>, fallback: string): string {
    const uniqueId = entry.uniqueId ?? entry.unique_id
    return typeof uniqueId === 'string' && uniqueId ? uniqueId : fallback
}

function firstNonEmpty(...values: Array<unknown>): string | null {
    for (const value of values) if (typeof value === 'string' && value) return value
    return null
}

function secondsToMs(value: unknown): number | null {
    const seconds = typeof value === 'number' ? value : typeof value === 'string' && value !== '' && Number.isFinite(Number(value)) ? Number(value) : NaN
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
}

export function createRealStreamWatchSource(options: RealStreamWatchSourceOptions): WatchStateSource {
    const { connectionId, label, subject, scope } = options
    const notes = [
        'RealStream stores current progress only: watched flags and play counts are not migrated from this source.',
        'RealStream entries without an IMDb id are listed as unmatched.',
    ]

    async function read(signal: AbortSignal, progress?: MigrationProgress): Promise<WatchStateSnapshot> {
        signal.throwIfAborted()
        const { fetchPage } = await options.open(signal)
        signal.throwIfAborted()
        const collected: Record<string, unknown>[] = []
        let total: number | null = null
        let complete = true
        let capped = false
        let repeated = false
        let totalsUnverified = false
        let movingTotal = false
        let previousPageKey: string | null = null
        let page = 1
        for (; page <= MAX_PAGES; page++) {
            signal.throwIfAborted()
            progress?.(`Reading RealStream progress: page ${page}…`)
            const result = await fetchPage(page, PER_PAGE, signal)
            if (!isRecord(result) || !Array.isArray(result.items)) throw new Error('RealStream returned an unexpected response shape; nothing was interpreted as data.')
            if (typeof result.totalItems === 'number' && Number.isFinite(result.totalItems) && result.totalItems >= 0) {
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
            collected.push(...(result.items as Record<string, unknown>[]))
            if (result.items.length < PER_PAGE) break
            previousPageKey = pageKey
        }
        if (page > MAX_PAGES) {
            capped = true
            complete = false
        }
        signal.throwIfAborted()
        const entries: Array<{ key: string; entry: Record<string, unknown> | null }> = []
        const brokenContainers: Array<{ id: string; note: string }> = []
        for (const [recordIndex, record] of collected.entries()) {
            if (!isRecord(record) || !Array.isArray(record.data)) {
                brokenContainers.push({
                    id: isRecord(record) && typeof record.id === 'string' && record.id ? `realstream:${record.id}` : `realstream:record:${recordIndex}`,
                    note: isRecord(record) ? 'This RealStream progress record has no readable entry list, so its entries are listed as unmatched.' : 'This RealStream progress record could not be read, so its entries are listed as unmatched.',
                })
                continue
            }
            const recordId = typeof record.id === 'string' && record.id ? record.id : `record${recordIndex}`
            for (const [entryIndex, entry] of (record.data as unknown[]).entries()) {
                entries.push({ key: `${recordId}:${entryIndex}`, entry: isRecord(entry) ? entry : null })
            }
        }
        if (brokenContainers.length > 0) complete = false
        const records: WatchStateRecord[] = []
        for (const { key, entry } of entries) {
            if (entry === null) {
                records.push({
                    id: `realstream:${key}`,
                    title: 'RealStream entry',
                    type: 'unknown',
                    identities: [],
                    playedAt: null,
                    notes: ['This RealStream entry could not be read, so it is listed as unmatched.'],
                    fingerprint: await watchFingerprint({ scope, unreadable: key }),
                })
                continue
            }
            // Official Windows client 1.0.1+2 (burner playback, 2026-10-19) exports
            // provider-prefixed ids with progress normalized to a 10,000-point
            // scale. That duration is not a 10,000-second runtime. Keep these
            // rows visible, but never turn the percentage into elapsed time.
            if (typeof entry.uniqueId === 'string' && /^(tmdb|imdb|tvdb):/.test(entry.uniqueId) && Number(entry.duration) === 10_000) {
                records.push({
                    id: `realstream:${uniqueKey(entry, key)}`,
                    title: firstNonEmpty(entry.title, entry.name) ?? 'RealStream entry',
                    type: 'unknown',
                    identities: [],
                    playedAt: sourceTime(entry.lastWatched ?? entry.last_watched ?? entry.timestamp),
                    notes: ['RealStream saved a playback percentage without the actual runtime. An elapsed resume position cannot be verified for this entry.'],
                    fingerprint: await watchFingerprint({ scope, entry }),
                })
                continue
            }
            const positionMs = secondsToMs(entry.currentTime ?? entry.current_time ?? entry.progress ?? entry.position)
            if (positionMs === null) continue
            const posterPath = typeof entry.posterPath === 'string' ? entry.posterPath : typeof entry.poster_path === 'string' ? entry.poster_path : ''
            const imdb = IMDb_IN_POSTER.exec(posterPath)?.[1] ?? null
            const rawType = entry.mediaType ?? entry.media_type ?? entry.type
            const normalizedType = rawType != null ? String(rawType).toLowerCase() : ''
            const season = intOrNull(entry.seasonNumber ?? entry.season_number ?? entry.season)
            const episode = intOrNull(entry.episodeNumber ?? entry.episode_number ?? entry.episode)
            let type: 'movie' | 'episode' | null = null
            if (normalizedType === 'movie') type = 'movie'
            else if (normalizedType === 'tv' || season !== null && episode !== null) type = 'episode'
            const playedAt = sourceTime(entry.lastWatched ?? entry.last_watched ?? entry.timestamp ?? entry.updated ?? entry.created)
            const title = firstNonEmpty(entry.title, entry.name) ?? imdb ?? 'RealStream entry'
            if (type === null || imdb === null) {
                const unmatchedNotes: string[] = []
                if (type === null) unmatchedNotes.push('This RealStream entry has no recognizable movie or episode type, so it is listed as unmatched.')
                else unmatchedNotes.push('This RealStream entry has no IMDb id, so it cannot be matched.')
                if (playedAt === null) unmatchedNotes.push('RealStream supplied no reliable watch time for this entry.')
                records.push({
                    id: `realstream:${uniqueKey(entry, key)}`,
                    title,
                    type: 'unknown',
                    identities: [],
                    playedAt,
                    notes: unmatchedNotes,
                    fingerprint: await watchFingerprint({ scope, entry }),
                })
                continue
            }
            const identity = canonicalWatchIdentity(type, imdb, season ?? undefined, episode ?? undefined)
            if (identity === null) {
                const unmatchedNotes = ['This RealStream entry could not be mapped to a movie or episode, so it is listed as unmatched.']
                if (playedAt === null) unmatchedNotes.push('RealStream supplied no reliable watch time for this entry.')
                records.push({
                    id: `realstream:${uniqueKey(entry, key)}`,
                    title,
                    type: 'unknown',
                    identities: [],
                    playedAt,
                    notes: unmatchedNotes,
                    fingerprint: await watchFingerprint({ scope, entry }),
                })
                continue
            }
            const record: WatchStateRecord = {
                id: type === 'movie' ? `movie:${imdb}` : `episode:${imdb}:${season}:${episode}`,
                title,
                type,
                identities: [identity],
                positionMs,
                playedAt,
                fingerprint: await watchFingerprint({ scope, entry }),
            }
            if (type === 'episode') {
                record.season = season ?? undefined
                record.episode = episode ?? undefined
            }
            const durationMs = secondsToMs(entry.duration ?? entry.total_duration ?? entry.runtime)
            if (durationMs !== null) record.durationMs = durationMs
            if (playedAt === null) record.notes = ['RealStream supplied no reliable watch time for this entry.']
            else if (entry.lastWatched == null && entry.last_watched == null && entry.timestamp == null) record.dateConfidence = 'estimated'
            records.push(record)
        }
        for (const broken of brokenContainers) {
            records.push({
                id: broken.id,
                title: 'RealStream progress record',
                type: 'unknown',
                identities: [],
                playedAt: null,
                notes: [broken.note],
                fingerprint: await watchFingerprint({ scope, broken: broken.id }),
            })
        }
        records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const snapshotNotes = [...notes]
        if (capped) snapshotNotes.push(`RealStream progress exceeded the ${MAX_PAGES}-page read limit, so this read is partial.`)
        if (repeated) snapshotNotes.push('RealStream repeated a full page instead of advancing, so this read is partial.')
        if (totalsUnverified) snapshotNotes.push('RealStream did not report a usable record total, so this read cannot be confirmed complete.')
        if (movingTotal) snapshotNotes.push('The RealStream record total changed during the read, so this read is partial.')
        if (total !== null && total > collected.length) {
            complete = false
            snapshotNotes.push('RealStream reports more progress records than this read collected, so this read is partial.')
        }
        if (brokenContainers.length > 0) snapshotNotes.push('RealStream returned progress records that could not be read, so this read is partial.')
        return { connectionId, label, subject, scope, records, complete, notes: snapshotNotes }
    }

    return { read }
}
