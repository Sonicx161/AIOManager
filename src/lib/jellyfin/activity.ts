import type { ActivityItem } from '../../types/activity.ts'
import type { Connection } from '../../types/connection.ts'
import type { JellyfinMediaReads } from './reads.ts'
import type { JellyfinItem, JellyfinNowPlayingItem, JellyfinSession } from './types.ts'
import { metahubPosterUrl } from '../activity-artwork.ts'
import { jellyfinCanonicalId, jellyfinTmdbId } from './metadata.ts'
import { createWorkspaceResetSubscription } from '../workspace-reset-subscription.ts'

export interface MediaAccount { id: string; name: string }
export interface MediaPlayback {
    item: ActivityItem
    state: 'playing' | 'paused' | 'resume'
    checkedAt: number
    productName: string
}
export interface MediaActivity {
    history: ActivityItem[]
    inProgress: ActivityItem[]
    playback: MediaPlayback[]
}

const playbackOrder = { playing: 0, paused: 1, resume: 2 }
export function compareMediaPlayback(a: MediaPlayback, b: MediaPlayback): number {
    return playbackOrder[a.state] - playbackOrder[b.state] || b.item.timestamp.getTime() - a.item.timestamp.getTime()
}

const milliseconds = (ticks: unknown) => typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0 ? ticks / 10_000 : 0
const index = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
function playedDate(value: unknown, now: number): Date | undefined {
    if (typeof value !== 'string') return undefined
    const time = Date.parse(value)
    return Number.isFinite(time) && time >= Date.UTC(1995, 0, 1) && time <= now + 60_000 ? new Date(time) : undefined
}

/** A projected item may remember the connection-scoped id it carried before its series resolved. */
export type JellyfinActivityItem = ActivityItem & { legacyItemId?: string }

function identifiers(item: JellyfinItem | JellyfinNowPlayingItem, connectionId: string) {
    const episode = item.Type === 'Episode'
    // An episode's IMDb/TMDB ID identifies the episode, not its parent series.
    // Resolve the parent's provider IDs, or an explicit canonical SeriesId.
    const canonical = episode
        ? jellyfinCanonicalId(item.SeriesProviderIds) || (typeof item.SeriesId === 'string' && /^tt\d+$/.test(item.SeriesId) ? item.SeriesId : undefined)
        : jellyfinCanonicalId(item.ProviderIds)
    // Artwork fallback only: the row's TMDB id never enters base/unique/legacy identity.
    const tmdbId = jellyfinTmdbId(episode ? item.SeriesProviderIds : item.ProviderIds)
    const scoped = `jellyfin:${encodeURIComponent(connectionId)}:${encodeURIComponent(episode ? item.SeriesId || item.Id || '' : item.Id || '')}`
    const base = canonical || scoped
    const season = index(item.ParentIndexNumber)
    const episodeNumber = index(item.IndexNumber)
    // An episode stays episode-scoped even when its series resolves.
    const unique = episode
        ? season !== undefined && episodeNumber !== undefined ? `${base}:${season}:${episodeNumber}` : `jellyfin:${encodeURIComponent(connectionId)}:${encodeURIComponent(item.Id || '')}`
        : canonical || `jellyfin:${encodeURIComponent(connectionId)}:${encodeURIComponent(item.Id || '')}`
    const legacy = episode && canonical && canonical !== scoped && !(typeof item.SeriesId === 'string' && /^tt\d+$/.test(item.SeriesId)) ? scoped : undefined
    return { base, unique, season, episode: episodeNumber, canonical, legacy, tmdbId }
}

function activityItem(account: MediaAccount, colorIndex: number, connection: Connection, item: JellyfinItem | JellyfinNowPlayingItem, kind: 'resume' | 'played' | 'live', checkedAt: number, now: number, positionTicks?: number): JellyfinActivityItem | undefined {
    if (typeof item.Id !== 'string' || !item.Id || typeof item.Name !== 'string' || !item.Name.trim()) return undefined
    if (item.Type !== 'Movie' && item.Type !== 'Episode' && !(kind === 'live' && item.Type === undefined)) return undefined
    const ids = identifiers(item, connection.id)
    const duration = milliseconds(item.RunTimeTicks)
    const position = milliseconds(positionTicks ?? item.UserData?.PlaybackPositionTicks)
    const played = kind === 'played' && item.UserData?.Played === true
    const timestamp = playedDate(item.UserData?.LastPlayedDate, now)
    const progress = played ? 100 : duration > 0 ? Math.min(100, position / duration * 100) : 0
    return {
        id: `${account.id}:jellyfin:${connection.id}:${encodeURIComponent(item.Id)}`,
        accountId: account.id, accountName: account.name, accountColorIndex: colorIndex,
        itemId: ids.base, uniqueItemId: ids.unique,
        name: item.Type === 'Episode' && typeof item.SeriesName === 'string' ? item.SeriesName || item.Name : item.Name,
        type: item.Type === 'Episode' ? 'series' : item.Type === 'Movie' ? 'movie' : 'video',
        poster: ids.canonical && /^tt\d+$/.test(ids.canonical) ? metahubPosterUrl(ids.canonical) : '',
        // Undated resume points are useful in Continue Watching, never a dated event.
        timestamp: timestamp || new Date(0),
        // The resume position rides on mediaObservation.positionMs; watch hours credit it from there, not from watched.
        duration, watched: 0, progress,
        isInProgress: kind === 'live' || (kind !== 'played' && position > 0 && !played),
        season: ids.season, episode: ids.episode,
        source: 'jellyfin',
        mediaObservation: { connectionId: connection.id, productName: connection.mediaServer?.productName || 'Jellyfin', kind, checkedAt, hasPlayedDate: !!timestamp, positionMs: position },
        mediaTargets: [{ connectionId: connection.id, itemId: item.Id }],
        ...(ids.tmdbId ? { tmdbId: ids.tmdbId } : {}),
        ...(ids.legacy ? { legacyItemId: ids.legacy } : {}),
    }
}

const BURST_MIN_ITEMS = 10
const BURST_MIN_TITLES = 3
const BURST_UNKNOWN_RUNTIME_GAP_MS = 60_000

/** Marks a row stamped inside an import burst; cleared once the row is resolved as a copy or a real play. */
export type BurstKind = 'multi' | 'series'
export type BurstItem = ActivityItem & { importBurst?: BurstKind }

/** A real play whose clock time is only approximate (marked together with others). */
export const isTimeApproximate = (item: ActivityItem): boolean => item.timeApproximate === true

/**
 * A server that stamps many plays at ingest time reports them closer together
 * than they could have been watched. Runs of BURST_MIN_ITEMS or more such
 * plays on one connection are tentatively saved state until collapseImportedCopies
 * resolves them: a multi-title run is a migration (copies of other platforms'
 * plays), a single-series run is a binge marked together (real plays).
 */
export function flagImportBursts(items: ActivityItem[]): void {
    const dated = items.filter(item => item.mediaObservation?.kind === 'played' && item.timestamp.getTime() > 0)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    let run: ActivityItem[] = []
    const close = () => {
        if (run.length >= BURST_MIN_ITEMS) {
            const kind: BurstKind = new Set(run.map(item => item.itemId)).size >= BURST_MIN_TITLES ? 'multi' : 'series'
            for (const item of run) { item.backfill = true; item.importedSavedState = true; (item as BurstItem).importBurst = kind }
        }
        run = []
    }
    for (const item of dated) {
        const previous = run[run.length - 1]
        if (previous) {
            const known = [previous.duration, item.duration].filter(value => value > 0)
            const limit = known.length ? Math.min(...known) / 2 : BURST_UNKNOWN_RUNTIME_GAP_MS
            if (item.timestamp.getTime() - previous.timestamp.getTime() >= limit) close()
        }
        run.push(item)
    }
    close()
}

/** The identity string an old-form row of this episode was tombstoned under. */
export function legacyEpisodeIdentity(item: Pick<JellyfinActivityItem, 'legacyItemId' | 'season' | 'episode'>): string | undefined {
    return item.legacyItemId && item.episode !== undefined ? `${item.legacyItemId}:s${item.season ?? 1}:e${item.episode}` : undefined
}

/** Latest deletion tombstone for an item under its current or pre-resolution identity. */
export function mediaDeletedAt(deleted: Record<string, number>, scope: string, current: string, item: Pick<JellyfinActivityItem, 'legacyItemId' | 'season' | 'episode'>): number | undefined {
    const legacy = legacyEpisodeIdentity(item)
    const a = deleted[`${scope}:${current}`]
    const b = legacy ? deleted[`${scope}:${legacy}`] : undefined
    return a === undefined ? b : b === undefined ? a : Math.max(a, b)
}

function fresh(session: JellyfinSession, userId: string, now: number) {
    const checked = Date.parse(session.LastPlaybackCheckIn || '')
    return session.UserId === userId && !!session.NowPlayingItem && !!session.PlayState
        && Number.isFinite(checked) && checked <= now + 5_000 && now - checked <= 120_000
}

function libraryActivity(account: MediaAccount, colorIndex: number, connection: Connection, reads: JellyfinMediaReads | null, now: number): MediaActivity {
    const result: MediaActivity = { history: [], inProgress: [], playback: [] }
    if (!reads || !connection.enabled || !connection.mediaServer?.userId) return result
    for (const kind of ['played', 'resume'] as const) {
        const read = reads[kind]
        if (read.status !== 'success') continue
        for (const source of read.data.items) {
            if (kind === 'played' && source.UserData?.Played !== true) continue
            const item = activityItem(account, colorIndex, connection, source, kind, read.checkedAt, now)
            if (!item) continue
            if (item.mediaObservation?.hasPlayedDate) result.history.push(item)
            if (item.isInProgress) {
                result.inProgress.push(item)
                result.playback.push({ item, state: 'resume', checkedAt: read.checkedAt, productName: item.mediaObservation!.productName })
            }
        }
    }
    flagImportBursts(result.history)
    return result
}

function appendSessions(result: MediaActivity, account: MediaAccount, colorIndex: number, connection: Connection, reads: JellyfinMediaReads, now: number): void {
    if (!connection.mediaServer?.userId) return
    if (reads.sessions.status === 'success') {
        for (const session of reads.sessions.data) {
            if (!fresh(session, connection.mediaServer.userId, now)) continue
            const resume = reads.resume.status === 'success' ? reads.resume.data.items.find(item => item.Id === session.NowPlayingItem?.Id) : undefined
            const item = activityItem(account, colorIndex, connection, { ...resume, ...session.NowPlayingItem }, 'live', reads.sessions.checkedAt, now, session.PlayState?.PositionTicks)
            if (!item) continue
            item.mediaObservation!.isPaused = session.PlayState?.IsPaused === true
            item.mediaObservation!.reportedAt = Date.parse(session.LastPlaybackCheckIn!)
            if (item.isInProgress) result.inProgress.unshift(item)
            result.playback.unshift({ item, state: session.PlayState?.IsPaused ? 'paused' : 'playing', checkedAt: reads.sessions.checkedAt, productName: item.mediaObservation!.productName })
        }
    }
}

export function jellyfinMediaActivity(account: MediaAccount, colorIndex: number, connection: Connection, reads: JellyfinMediaReads | null, now = Date.now()): MediaActivity {
    const result = libraryActivity(account, colorIndex, connection, reads, now)
    if (!reads || !connection.enabled || !connection.mediaServer?.userId) return result
    appendSessions(result, account, colorIndex, connection, reads, now)
    result.history = mergeMediaItems([], result.history)
    result.inProgress = mergeMediaItems([], result.inProgress)
    result.playback.sort(compareMediaPlayback)
    return result
}

/** Per-consumer reuse of library projections; sessions always derive against the current clock. */
export function createJellyfinActivityProjector() {
    let cached: {
        accountId: string; accountName: string; colorIndex: number; connection: Connection
        played: JellyfinMediaReads['played']; resume: JellyfinMediaReads['resume']
        at: number; validUntil: number; zone: string; library: MediaActivity; history: ActivityItem[]
    } | undefined
    return (account: MediaAccount, colorIndex: number, connection: Connection, reads: JellyfinMediaReads, now = Date.now()): MediaActivity => {
        if (!connection.enabled || !connection.mediaServer?.userId || !Number.isFinite(now)) {
            cached = undefined
            return jellyfinMediaActivity(account, colorIndex, connection, reads, now)
        }
        // Offset-free provider dates depend on the runtime timezone. Its IANA
        // identity is needed too: two zones can share today's UTC offset while
        // disagreeing on the date of an older watch.
        let zone: string
        try {
            zone = `${Intl.DateTimeFormat().resolvedOptions().timeZone}|${new Date(now).getTimezoneOffset()}`
        } catch {
            cached = undefined
            return jellyfinMediaActivity(account, colorIndex, connection, reads, now)
        }
        if (!cached || cached.accountId !== account.id || cached.accountName !== account.name
            || cached.colorIndex !== colorIndex || cached.connection !== connection
            || cached.played !== reads.played || cached.resume !== reads.resume
            || cached.zone !== zone || now < cached.at || now >= cached.validUntil) {
            const library = libraryActivity(account, colorIndex, connection, reads, now)
            // A future LastPlayedDate becomes eligible once it is within the
            // existing one-minute tolerance. Never memoize across that boundary
            // or a clock rollback, even when the provider data is unchanged.
            let validUntil = Infinity
            for (const kind of ['played', 'resume'] as const) {
                const read = reads[kind]
                if (read.status !== 'success') continue
                for (const item of read.data.items) {
                    const date = item.UserData?.LastPlayedDate
                    if (typeof date !== 'string') continue
                    const time = Date.parse(date)
                    if (Number.isFinite(time) && time > now + 60_000) validUntil = Math.min(validUntil, time - 60_000)
                }
            }
            const history = mergeMediaItems([], library.history)
            library.history = []
            cached = { accountId: account.id, accountName: account.name, colorIndex, connection,
                played: reads.played, resume: reads.resume, at: now, validUntil, zone, library,
                history }
        }
        const result = { history: cached.history, inProgress: [...cached.library.inProgress], playback: [...cached.library.playback] }
        appendSessions(result, account, colorIndex, connection, reads, now)
        result.inProgress = mergeMediaItems([], result.inProgress)
        result.playback.sort(compareMediaPlayback)
        return result
    }
}

function identity(item: Pick<ActivityItem, 'accountId' | 'type' | 'itemId' | 'uniqueItemId' | 'season' | 'episode' | 'source' | 'sourceConnectionId'>) {
    const series = item.type === 'series' || item.type === 'episode' || item.type === 'anime'
    // Saved native logins own independent progress. The media overlay also runs when
    // no media-server observations exist, so its merge key must preserve those origins.
    const origin = item.sourceConnectionId ? `|${item.source || 'stremio'}:${item.sourceConnectionId}` : ''
    return `${item.accountId}${origin}|${series ? 'series' : item.type}|${item.itemId}|${series ? `${item.season ?? '?'}:${item.episode ?? item.uniqueItemId}` : ''}`
}

function mergeCurrentState(prior: ActivityItem, item: ActivityItem): ActivityItem {
    const labels = [...new Set([...(prior.mediaSources || []), ...(item.mediaSources || []), prior.mediaObservation?.productName, item.mediaObservation?.productName].filter((value): value is string => !!value))]
    const targets = [...new Map([...(prior.mediaTargets || []), ...(item.mediaTargets || [])].map(target => [JSON.stringify([target.connectionId, target.itemId]), target])).values()]
    const priorLive = prior.mediaObservation?.kind === 'live'
    const incomingLive = item.mediaObservation?.kind === 'live'
    const priorPlaying = priorLive && !prior.mediaObservation?.isPaused
    const incomingPlaying = incomingLive && !item.mediaObservation?.isPaused
    const preferred = priorPlaying !== incomingPlaying ? (priorPlaying ? prior : item)
        : priorLive !== incomingLive ? (priorLive ? prior : item)
        : prior.timestamp.getTime() !== item.timestamp.getTime() ? (prior.timestamp > item.timestamp ? prior : item)
        : prior.source !== 'jellyfin' ? prior : item.source !== 'jellyfin' ? item : prior
    return { ...preferred, mediaSources: labels, mediaTargets: targets }
}

/** The identity key a resolved episode carried before its series id was known. */
function legacyKeyOf(item: ActivityItem): string | undefined {
    const legacyItemId = (item as JellyfinActivityItem).legacyItemId
    return legacyItemId ? identity({ ...item, itemId: legacyItemId }) : undefined
}

/** Keeps the resolved identity when one side is its old connection-scoped form. */
function adoptResolved(merged: ActivityItem, prior: ActivityItem, item: ActivityItem): ActivityItem {
    const resolved = (item as JellyfinActivityItem).legacyItemId ? item : (prior as JellyfinActivityItem).legacyItemId ? prior : undefined
    if (!resolved || (merged.itemId === resolved.itemId && merged.uniqueItemId === resolved.uniqueItemId)) return merged
    return { ...merged, itemId: resolved.itemId, uniqueItemId: resolved.uniqueItemId, poster: resolved.poster || merged.poster, legacyItemId: (resolved as JellyfinActivityItem).legacyItemId } as ActivityItem
}

/** One current state per title/episode; a newer media observation can replace old native state. */
export function mergeMediaItems(existing: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
    const merged = new Map<string, ActivityItem>()
    const aliases = new Map<string, string>()
    for (const item of [...existing, ...incoming]) {
        const own = identity(item)
        const legacy = legacyKeyOf(item)
        let key = own
        if (!merged.has(own)) {
            const aliased = aliases.get(own)
            if (aliased && merged.has(aliased)) key = aliased
            else if (legacy && merged.has(legacy)) {
                merged.set(own, merged.get(legacy)!)
                merged.delete(legacy)
            }
        }
        if (legacy) aliases.set(legacy, key)
        const prior = merged.get(key)
        merged.set(key, prior ? adoptResolved(mergeCurrentState(prior, item), prior, item) : item)
    }
    return [...merged.values()]
}

const CROSS_SOURCE_WINDOW_MS = 36 * 3_600_000
const sourceOf = (item: Pick<ActivityItem, 'source'>) => item.source || 'stremio'

/** Preserve watch events on different days; snapshots can only augment the same reported watch day (or, across sources, the same play within a UTC window). */
export function mergeMediaHistory(existing: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
    const history = [...existing]
    if (incoming.length === 0) return history
    // Only an identical title/episode and owner can merge. Index that candidate
    // set once rather than rescanning the whole history for every media-server
    // item on each live-session poll.
    const candidates = new Map<string, number[]>()
    const addCandidate = (key: string, index: number) => {
        const indices = candidates.get(key)
        if (indices) indices.push(index)
        else candidates.set(key, [index])
    }
    // A resolved episode and its old connection-scoped form are one title.
    const aliases = new Map<string, string>()
    for (let index = 0; index < history.length; index++) {
        const item = history[index]
        const key = identity(item)
        addCandidate(key, index)
        const legacy = legacyKeyOf(item)
        if (legacy) aliases.set(legacy, key)
    }
    for (const item of incoming) {
        const key = identity(item)
        const day = item.timestamp.toDateString()
        const time = item.timestamp.getTime()
        const origin = sourceOf(item)
        const legacy = legacyKeyOf(item)
        const keys = [key, legacy, aliases.get(key)].filter((value, at, all): value is string => !!value && all.indexOf(value) === at)
        let match = -1
        let distance = Infinity
        for (const candidate of keys) {
            for (const index of candidates.get(candidate) || []) {
                const prior = history[index]
                const difference = Math.abs(prior.timestamp.getTime() - time)
                // Another platform's record of one play can straddle a local-day or timezone boundary.
                const same = prior.timestamp.toDateString() === day || (sourceOf(prior) !== origin && difference <= CROSS_SOURCE_WINDOW_MS)
                if (same && difference < distance) { match = index; distance = difference }
            }
        }
        if (match === -1) {
            addCandidate(key, history.length)
            if (legacy) aliases.set(legacy, key)
            history.push(item)
            continue
        }
        const prior = history[match]
        const merged = mergeCurrentState(prior, item)
        history[match] = prior.source !== 'jellyfin'
            ? { ...prior, mediaSources: merged.mediaSources, mediaTargets: merged.mediaTargets }
            : adoptResolved(merged, prior, item)
    }
    return history
}

const COPY_SOURCE_LABELS: Record<string, string> = { nuvio: 'Nuvio', realstream: 'RealStream', jellyfin: 'Jellyfin' }
const COPY_ID_PATTERN = /^(tt\d+)/i

function copyShape(item: ActivityItem): { cls: 's' | 'm'; episode: string } | undefined {
    if (item.type === 'movie') return { cls: 'm', episode: '' }
    if (item.type !== 'series' && item.type !== 'anime' && item.type !== 'episode') return undefined
    return item.episode === undefined ? undefined : { cls: 's', episode: `${item.season ?? 1}:${item.episode}` }
}

function copyTitle(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const isUndated = (item: ActivityItem) => !!item.backfill || !!item.importedSavedState || !(item.timestamp.getTime() > 0)

/** Burst rows no original claimed are real plays at their stamp time, flagged as approximate. */
function settleBursts(items: ActivityItem[]): ActivityItem[] {
    if (!items.some(item => (item as BurstItem).importBurst)) return items
    return items.map(item => {
        if (!(item as BurstItem).importBurst) return item
        const { importBurst: _burst, backfill: _backfill, importedSavedState: _saved, ...rest } = item as BurstItem
        return { ...rest, timeApproximate: true }
    })
}

/**
 * Plays another platform holds as copies of a Stremio watch count once, at the original
 * time. A copy collapses only when it sits within 36 h of the original (one play seen
 * twice) or belongs to a multi-title import burst (a migration stamping its own time).
 * A single-series burst is a binge marked together: it collapses only per row within
 * 36 h. Burst rows that match nothing become real plays with approximate time. The
 * original row keeps its timestamp and gains the copy's source. Each copy source
 * collapses at most one play per original, so genuine rewatches survive. Matching
 * ignores login origin; names only bridge ids that share no IMDb form, and only when
 * the title is unambiguous for the account.
 */
export function collapseImportedCopies(items: ActivityItem[]): ActivityItem[] {
    const byId = new Map<string, ActivityItem[]>()
    const byTitle = new Map<string, ActivityItem[]>()
    const titleIds = new Map<string, Set<string>>()
    const copies: ActivityItem[] = []
    const push = (map: Map<string, ActivityItem[]>, key: string, item: ActivityItem) => {
        const list = map.get(key)
        if (list) list.push(item)
        else map.set(key, [item])
    }
    for (const item of items) {
        const shape = copyShape(item)
        if (!shape) continue
        if (sourceOf(item) === 'stremio') {
            if (item.isInProgress || item.mediaObservation?.kind === 'live') continue
            const scope = `${item.accountId}|${shape.cls}|`
            push(byId, `${scope}id:${item.itemId}|${shape.episode}`, item)
            const tt = COPY_ID_PATTERN.exec(item.itemId)?.[1].toLowerCase()
            if (tt && tt !== item.itemId) push(byId, `${scope}id:${tt}|${shape.episode}`, item)
            const title = copyTitle(item.name)
            if (title) {
                push(byTitle, `${scope}${title}|${shape.episode}`, item)
                const ids = titleIds.get(`${scope}${title}`) || new Set<string>()
                ids.add(tt || item.itemId)
                titleIds.set(`${scope}${title}`, ids)
            }
        } else {
            const completed = item.mediaObservation ? item.mediaObservation.kind === 'played' : !item.isInProgress
            if (completed) copies.push(item)
        }
    }
    if (copies.length === 0 || byId.size === 0) return settleBursts(items)

    const used = new Map<string, Set<ActivityItem>>()
    const dropped = new Set<ActivityItem>()
    const replaced = new Map<ActivityItem, ActivityItem>()
    copies.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    for (const copy of copies) {
        const shape = copyShape(copy)!
        const scope = `${copy.accountId}|${shape.cls}|`
        const tt = COPY_ID_PATTERN.exec(copy.itemId)?.[1].toLowerCase()
        let originals = byId.get(`${scope}id:${copy.itemId}|${shape.episode}`) || (tt ? byId.get(`${scope}id:${tt}|${shape.episode}`) : undefined)
        if (!originals && !tt) {
            const title = copyTitle(copy.name)
            if (title && titleIds.get(`${scope}${title}`)?.size === 1) originals = byTitle.get(`${scope}${title}|${shape.episode}`)
        }
        if (!originals) continue
        const usedKey = `${sourceOf(copy)}|${copy.mediaObservation?.connectionId || copy.sourceConnectionId || ''}|${scope}${copy.itemId}|${shape.episode}`
        const taken = used.get(usedKey) || new Set<ActivityItem>()
        const time = copy.timestamp.getTime()
        const flagged = isUndated(copy) && (copy as BurstItem).importBurst !== 'series'
        let target: ActivityItem | undefined
        let best = Infinity
        for (const original of originals) {
            if (taken.has(original)) continue
            const gap = time - original.timestamp.getTime()
            const likely = isUndated(original) ? flagged : flagged || Math.abs(gap) <= CROSS_SOURCE_WINDOW_MS
            if (likely && Math.abs(gap) < best) { target = original; best = Math.abs(gap) }
        }
        if (!target) continue
        taken.add(target)
        used.set(usedKey, taken)
        const base = replaced.get(target) || target
        const label = copy.mediaObservation?.productName || COPY_SOURCE_LABELS[sourceOf(copy)] || sourceOf(copy)
        const mediaSources = [...new Set([...(base.mediaSources || []), ...(copy.mediaSources || []), label])]
        const mediaTargets = [...new Map([...(base.mediaTargets || []), ...(copy.mediaTargets || [])].map(entry => [JSON.stringify([entry.connectionId, entry.itemId]), entry])).values()]
        replaced.set(target, { ...base, mediaSources, ...(mediaTargets.length ? { mediaTargets } : {}) })
        dropped.add(copy)
    }
    if (dropped.size === 0) return settleBursts(items)
    return settleBursts(items.filter(item => !dropped.has(item)).map(item => replaced.get(item) || item))
}

export function isReadOnlyMediaActivity(item: Pick<ActivityItem, 'source' | 'readOnly'>): boolean {
    return item.readOnly === true
}

export const RECENT_ACTIVITY_WINDOW_MS = 5 * 60_000
export type ActivityNowStatus = 'playing' | 'recent'

/** "Now" is recent activity; only an actual player report establishes live playback. */
export function activityNowStatus(item: ActivityItem, now = Date.now()): ActivityNowStatus | undefined {
    if (item.mediaObservation?.kind === 'live') {
        const age = now - (item.mediaObservation.reportedAt ?? item.mediaObservation.checkedAt)
        return !item.mediaObservation.isPaused && age >= -5_000 && age < 120_000 ? 'playing' : undefined
    }
    // 95 mirrors the row model's own in-progress cap (transformLibraryItemToActivityItem);
    // a 90-94.9% resume row is unfinished and must keep its Now badge.
    if (item.backfill || !item.isInProgress || item.progress >= 95 || (item.flaggedWatched ?? 0) > 0 || item.mediaObservation?.kind === 'played') return undefined
    const age = now - item.timestamp.getTime()
    return age >= -60_000 && age < RECENT_ACTIVITY_WINDOW_MS ? 'recent' : undefined
}

/** Inputs of the now-status scan that depend only on the two history lists, not on the clock. */
interface NowStatusInputs {
    /** Latest eligible row per account (history first, then current). */
    latest: Map<string, ActivityItem>
    /** Latest history row per merge identity. */
    latestByIdentity: Map<string, ActivityItem>
    /** History rows by id, for the account-latest id match. */
    rowsById: Map<string, ActivityItem>
    /** History rows carrying a live observation: they can go 'playing' on their own. */
    liveHistoryRows: ActivityItem[]
    /** `latest` skipped rows newer than builtAt + 60s; stays valid while now + 60s stays below this. */
    minFutureTime: number
    builtAt: number
}

// Keyed by the history array identity, so it dies with the feed that produced it and
// can never leak rows across workspaces or scope changes (a new publication is a new array).
let nowStatusInputsCache: WeakMap<ActivityItem[], { current: ActivityItem[]; inputs: NowStatusInputs }> | null = null

// One-step reuse across the metadata-overlay commits: the overlay republishes the
// feed with items replaced by copies that only differ in display fields. Those
// copies feed activityNowStatus exactly the same answers, so the full scan can
// be skipped when every position is either the same object or such a copy.
let lastNowStatusInputs: { history: ActivityItem[]; current: ActivityItem[]; inputs: NowStatusInputs } | null = null

/**
 * Release the retained scan inputs. Invoked on sign-out and workspace switch
 * (store-coordinator) and on every persistence namespace transition below;
 * without this the roots below outlive the page and hold the previous
 * workspace's rows until another Activity render overwrites them.
 */
export function resetNowStatusCaches(): void {
    nowStatusInputsCache = null
    lastNowStatusInputs = null
    workspaceSubscription.release()
}

// Namespace transitions (login, session expiry, the sync-store reset) switch
// persistence directly and never run the store-coordinator reset; explicit
// logout still goes through resetAllStores. The subscription activates on the
// first cache use, is released by the reset above, and its HMR dispose keeps
// superseded module generations from stacking listeners.
const workspaceSubscription = createWorkspaceResetSubscription(resetNowStatusCaches, import.meta.hot)

/** Cache-shape introspection for tests: whether the retained inputs root is live. */
export function nowStatusCacheStatsForTests(): { retained: number } {
    return { retained: lastNowStatusInputs ? 1 : 0 }
}

const itemTimeMs = (t: ActivityItem['timestamp']): number => (t instanceof Date ? t.getTime() : new Date(t).getTime())

function nowStatusInputsReusable(history: ActivityItem[], prev: ActivityItem[]): boolean {
    if (prev.length !== history.length) return false
    for (let i = 0; i < history.length; i++) {
        const a = history[i]
        const b = prev[i]
        if (a === b) continue
        // Every field buildNowStatusInputs and the per-tick evaluation read.
        if (
            a.id !== b.id || a.accountId !== b.accountId || a.itemId !== b.itemId
            || a.uniqueItemId !== b.uniqueItemId || a.type !== b.type || a.source !== b.source
            || a.sourceConnectionId !== b.sourceConnectionId || a.season !== b.season || a.episode !== b.episode
            || a.backfill !== b.backfill || a.isInProgress !== b.isInProgress
            || a.progress !== b.progress || a.flaggedWatched !== b.flaggedWatched
            || a.mediaObservation !== b.mediaObservation
            || itemTimeMs(a.timestamp) !== itemTimeMs(b.timestamp)
        ) return false
    }
    return true
}

function buildNowStatusInputs(history: ActivityItem[], current: ActivityItem[], now: number): NowStatusInputs {
    const latest = new Map<string, ActivityItem>()
    const latestByIdentity = new Map<string, ActivityItem>()
    const rowsById = new Map<string, ActivityItem>()
    const liveHistoryRows: ActivityItem[] = []
    let minFutureTime = Infinity
    const cutoff = now + 60_000
    const considerLatest = (item: ActivityItem) => {
        if (item.backfill) return
        const time = item.timestamp.getTime()
        if (!Number.isFinite(time) || time <= 0) return
        if (time > cutoff) {
            if (time < minFutureTime) minFutureTime = time
            return
        }
        const prior = latest.get(item.accountId)
        if (!prior || time > prior.timestamp.getTime() || (time === prior.timestamp.getTime() && item.id < prior.id)) latest.set(item.accountId, item)
    }
    for (const item of history) {
        considerLatest(item)
        const key = identity(item)
        const prior = latestByIdentity.get(key)
        if (!prior || item.timestamp > prior.timestamp) latestByIdentity.set(key, item)
        if (!rowsById.has(item.id)) rowsById.set(item.id, item)
        if (item.mediaObservation?.kind === 'live') liveHistoryRows.push(item)
    }
    for (const item of current) considerLatest(item)
    return { latest, latestByIdentity, rowsById, liveHistoryRows, minFutureTime, builtAt: now }
}

/** Select from the full feed so searching cannot revive an older episode's badge. */
export function activityNowStatuses(history: ActivityItem[], now = Date.now(), current: ActivityItem[] = []): Map<string, ActivityNowStatus> {
    // The workspace-release subscription above activates on this first cache
    // use; importing or resetting the module without scanning rows must not
    // install a listener.
    workspaceSubscription.ensure()
    const list = current
    const cache = nowStatusInputsCache ??= new WeakMap()
    let entry = cache.get(history)
    if (!entry || entry.current !== list || now < entry.inputs.builtAt || now + 60_000 >= entry.inputs.minFutureTime) {
        let inputs: NowStatusInputs | null = null
        const last = lastNowStatusInputs
        if (
            entry === undefined && last && last.current === list
            && now >= last.inputs.builtAt && now + 60_000 < last.inputs.minFutureTime
            && nowStatusInputsReusable(history, last.history)
        ) {
            inputs = last.inputs
        }
        if (!inputs) inputs = buildNowStatusInputs(history, list, now)
        entry = { current: list, inputs }
        cache.set(history, entry)
    }
    lastNowStatusInputs = { history, current: list, inputs: entry.inputs }
    const { latest, latestByIdentity, rowsById, liveHistoryRows } = entry.inputs

    const liveByIdentity = new Map<string, ActivityItem>()
    for (const item of list) {
        if (item.mediaObservation?.kind === 'live') {
            const key = identity(item)
            const prior = liveByIdentity.get(key)
            if (!prior || activityNowStatus(item, now) === 'playing') liveByIdentity.set(key, item)
        }
    }

    // Only rows the full scan could ever report are evaluated per tick: the latest row of a
    // live identity, the account-latest rows (by id and by identity), and history rows that
    // carry a live observation themselves. Everything else can never gain a status.
    const status = new Map<string, ActivityNowStatus>()
    const evaluate = (item: ActivityItem) => {
        const key = identity(item)
        const live = liveByIdentity.get(key)
        if (live && latestByIdentity.get(key)?.id !== item.id) return
        const latestItem = latest.get(item.accountId)
        const isLatest = latestItem?.id === item.id || (!!latestItem && identity(latestItem) === key && latestByIdentity.get(key)?.id === item.id)
        const value = activityNowStatus(live || (isLatest ? latestItem! : item), now)
        if (value === 'playing' || (value === 'recent' && isLatest)) status.set(item.id, value)
    }
    for (const key of liveByIdentity.keys()) {
        const row = latestByIdentity.get(key)
        if (row) evaluate(row)
    }
    for (const latestItem of latest.values()) {
        const row = rowsById.get(latestItem.id)
        if (row) evaluate(row)
        const latestRow = latestByIdentity.get(identity(latestItem))
        if (latestRow) evaluate(latestRow)
    }
    for (const row of liveHistoryRows) evaluate(row)
    return status
}

/** Dated resume points compete with every platform's latest item. Only live reports override it. */
export function accountMediaPlayback(playback: MediaPlayback[], latest: ActivityItem | null): MediaPlayback | undefined {
    return playback.find(item => item.state === 'playing') || playback.find(item => item.state === 'paused')
        || (!latest ? playback.find(item => !item.item.mediaObservation?.hasPlayedDate) : undefined)
}
