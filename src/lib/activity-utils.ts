import { LibraryItem, ActivityItem } from '@/types/activity'
import { Account } from '@/types/account'
import type { HistoryEntry } from '@/hooks/useWatchHistory'
import { getAccountEmail } from '@/store/accountStore'
import { sanitizePosterUrl } from '@/lib/utils'
import { fetchCinemetaSlim } from './cinemeta-cache.ts'
import { nuvioSourceTime } from './nuvio-time.ts'
import {
    isSavedOnlySeriesRow,
    isFlaggedOnlyMovieRow,
    isDatelessSavedWatchState,
    resolveWatchBadgePct,
    summarizeSavedEpisodes,
    formatSavedEpisodeRanges,
} from './imported-watch-state.ts'
import { getWatchTimestamp, isPlausibleWatchMs, isResumeDismissal, MIN_PLAUSIBLE_WATCH_MS } from './watch-time.ts'

export { sanitizePosterUrl }
export { isSavedOnlySeriesRow, isFlaggedOnlyMovieRow, isDatelessSavedWatchState, resolveWatchBadgePct, summarizeSavedEpisodes, formatSavedEpisodeRanges }
export { getWatchTimestamp, isPlausibleWatchMs, isResumeDismissal, MIN_PLAUSIBLE_WATCH_MS }
export type { ResumeDismissalPrior } from './watch-time.ts'

/**
 * Stable per-connection scope key for watch attribution: a secondary Stremio login's
 * history lives under `${accountId}::${connectionId}`, while the canonical/legacy
 * scope stays the bare accountId so every pre-multiplicity row, snapshot and
 * tombstone keeps resolving exactly as before. Connection ids are uuids, so the
 * double-colon separator can never occur inside either id.
 */
export function watchContextKey(accountId: string, sourceConnectionId?: string): string {
    return sourceConnectionId ? `${accountId}::${sourceConnectionId}` : accountId
}

/** Canonical native Stremio login per account; its rows share the bare account scope. */
export function canonicalStremioConnections(accounts: ReadonlyArray<Pick<Account, 'id' | 'connections' | 'primaryConnectionId'>>): Map<string, string | undefined> {
    const canonical = new Map<string, string | undefined>()
    for (const account of accounts) {
        const native = (account.connections || []).filter(c => c.platform === 'stremio' && (c.connectionType == null || c.connectionType === 'native'))
        canonical.set(account.id, native.find(c => c.id === account.primaryConnectionId)?.id ?? native[0]?.id)
    }
    return canonical
}

/**
 * Scope of a cumulative counter such as overallTimeWatched: one per account, platform,
 * login and title, so different viewers of the same title never offset each other.
 */
export function cumulativeWatchKey(
    item: Pick<ActivityItem, 'accountId' | 'source' | 'sourceConnectionId' | 'itemId'>,
    canonical?: ReadonlyMap<string, string | undefined>
): string {
    const source = item.source || 'stremio'
    const connection = item.sourceConnectionId && !(source === 'stremio' && canonical?.get(item.accountId) === item.sourceConnectionId)
        ? item.sourceConnectionId
        : ''
    return `${item.accountId}|${source}|${connection}|${item.itemId}`
}

/**
 * Split a server-side scoped account id (`${accountId}::${connectionId}` for
 * per-connection rows, bare accountId for canonical/legacy rows) back into the real
 * account and the originating connection. The connection part is absent for
 * canonical/legacy history.
 */
export function parseScopedAccountId(scopedAccountId: string): { accountId: string; sourceConnectionId?: string } {
    const raw = String(scopedAccountId || '')
    const sep = raw.indexOf('::')
    if (sep < 0) return { accountId: raw }
    const accountId = raw.slice(0, sep)
    const sourceConnectionId = raw.slice(sep + 2)
    if (!accountId || !sourceConnectionId) return { accountId: raw }
    return { accountId, sourceConnectionId }
}

/** Cache/feed identity of a Stremio item: canonical keeps the legacy key, secondaries carry their connection. */
export function stremioActivityItemKey(accountId: string, uniqueItemId: string, sourceConnectionId?: string): string {
    return sourceConnectionId
        ? `${accountId}:stremio:${sourceConnectionId}:${uniqueItemId}`
        : `${accountId}:${uniqueItemId}`
}

/**
 * Human label distinguishing same-account peer logins (rail/detail surfaces): the
 * connection's own email or displayName when known, else a stable per-platform ordinal
 * ("Login 2"). Returns undefined without attribution or when the platform has only one
 * login (the account label already covers it). Raw values — callers apply privacy masking.
 */
export function peerLoginLabel(
    account: { connections?: Array<{ id: string; platform: string; enabled?: boolean; displayName?: string; credentials?: Record<string, string> }> } | undefined,
    sourceConnectionId?: string,
): string | undefined {
    if (!account || !sourceConnectionId) return undefined
    const conns = (account.connections || []).filter(c => c.platform !== 'jellyfin')
    const conn = conns.find(c => c.id === sourceConnectionId)
    if (!conn) return undefined
    const samePlatform = conns.filter(c => c.platform === conn.platform)
    if (samePlatform.length <= 1) return undefined
    const email = conn.credentials?.email
    if (email && email.includes('@')) return email
    if (conn.displayName) return conn.displayName
    return `Login ${samePlatform.findIndex(c => c.id === sourceConnectionId) + 1}`
}

export {
    fetchCinemetaDetail,
    getCachedCinemetaName,
    type CinemetaCastMember,
    type CinemetaCrewMember,
    type CinemetaDirectorMember,
    type CinemetaMeta,
    type CinemetaRelatedItem,
    type CinemetaReview,
    type CinemetaVideo,
} from './cinemeta-cache.ts'

export function isActuallyWatched(item: LibraryItem): boolean {
    const s = item.state || {}
    if ((s.timesWatched ?? 0) > 0) return true
    // Stremio's watched flag is a positive watch marker on its own (marked-watched movies,
    // imported saved state); it must admit the row even when nothing else is accounted.
    if ((s.flaggedWatched ?? 0) > 0) return true
    if (s.video_id && s.video_id.trim() !== '') return true
    if ((s.timeOffset ?? 0) > 0) return true
    if ((s.timeWatched ?? 0) > 0 || (s.overallTimeWatched ?? 0) > 0) return true
    return false
}

export function getUniqueItemId(item: LibraryItem): string {
    const baseId = item._id
    if ((item.type === 'series' || item.type === 'anime' || item.type === 'episode') && item.state?.video_id) {
        const videoId = item.state.video_id
        const parts = videoId.split(':')
        // Standard format: "tt123:season:episode" (3 parts) or Kitsu "kitsu:id:s:e" (4 parts)
        if (parts.length >= 3) return videoId
        // Format: "tt123:episode" (2 parts, no season)
        if (parts.length === 2) return `${parts[0]}:1:${parts[1]}`
    }
    return baseId
}


export function getSeasonEpisode(item: LibraryItem): { season?: number; episode?: number } {
    if ((item.type !== 'series' && item.type !== 'anime' && item.type !== 'episode') || !item.state?.video_id) {
        return {}
    }

    const parts = item.state.video_id.split(':')
    const firstPart = parts[0]?.toLowerCase() || ''
    const animeProviders = ['kitsu', 'mal', 'anilist', 'anidb']
    const isAnimeProvider = animeProviders.includes(firstPart)

    const safeParseInt = (val: string | undefined, fallback: number): number => {
        if (val === undefined) return fallback
        const stripped = val.replace(/^[^0-9]*/, '')
        const n = parseInt(stripped, 10)
        return Number.isNaN(n) ? fallback : n
    }

    if (parts.length >= 4) {
        return {
            season: safeParseInt(parts[parts.length - 2], 1),
            episode: safeParseInt(parts[parts.length - 1], 0)
        }
    }

    if (parts.length === 3 && isAnimeProvider) {
        return { season: 1, episode: safeParseInt(parts[2], 0) }
    }

    if (parts.length === 3) {
        return {
            season: safeParseInt(parts[1], 1),
            episode: safeParseInt(parts[2], 0)
        }
    }

    if (parts.length === 2 && !isAnimeProvider) {
        return { season: 1, episode: safeParseInt(parts[1], 0) }
    }

    return {
        season: item.state.season ?? 1,
        episode: item.state.episode
    }
}

export function getLocalDayKey(timestamp: number): string {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return 'unknown'
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Per-identity replay proof that releases an Activity tombstone (Sol R1 F4): the
 * episode's OWN resume position moved from a known baseline after the delete. A
 * lastWatched-only advance (Stremio bumps it when other episodes are marked watched)
 * or any mark change never releases it, and an unknown baseline is never evidence.
 * Used by the event differencer's tombstone gates.
 */
export function tombstoneReplayProven(args: {
    deletedAt: number | undefined
    offset: number
    priorOffset?: number
    lastWatched: number
}): boolean {
    if (args.deletedAt === undefined) return false
    if (args.priorOffset === undefined) return false
    return args.offset > 0 && args.offset !== args.priorOffset && args.lastWatched > args.deletedAt
}

export function getEpisodeIdentity(
    itemId: string,
    videoId: string | undefined,
    season: number | undefined,
    episode: number | undefined,
    type: string
): string {
    const isSeries = type === 'series' || type === 'anime' || type === 'episode'
    if (!isSeries) return itemId
    if (episode !== undefined) return `${itemId}:s${season ?? 1}:e${episode}`
    if (videoId && videoId !== itemId) {
        const parts = videoId.split(':')
        if (parts.length >= 3) {
            const s = parseInt(parts[parts.length - 2])
            const e = parseInt(parts[parts.length - 1])
            if (!isNaN(e)) return `${itemId}:s${isNaN(s) ? 1 : s}:e${e}`
        }
        if (parts.length === 2) {
            const e = parseInt(parts[1])
            if (!isNaN(e)) return `${itemId}:s1:e${e}`
        }
    }
    return videoId || itemId
}

export function parseStremioDate(dateStr: string | undefined): Date | undefined {
    if (!dateStr) return undefined
    const d = new Date(dateStr)
    if (isNaN(d.getTime()) || d.getTime() < MIN_PLAUSIBLE_WATCH_MS) return undefined
    return d.getTime() > Date.now() + 5 * 60 * 1000 ? new Date() : d
}

export function transformLibraryItemToActivityItem(
    item: LibraryItem,
    account: Account,
    accounts: Account[],
    options?: { connectionId?: string; distinctId?: boolean }
): ActivityItem {
    const uniqueItemId = getUniqueItemId(item)
    const timestamp = getWatchTimestamp(item)
    const firstWatched = parseStremioDate(item._ctime)
    const { season, episode } = getSeasonEpisode(item)
    let duration = item.state?.duration || 0
    const timeOffset = item.state?.timeOffset || 0
    const overallTimeWatched = item.state?.overallTimeWatched
    const timesWatched = item.state?.timesWatched
    const flaggedWatched = item.state?.flaggedWatched
    // Imported saved watch state (bitfield-aggregate series / flagged-only movie) carries no
    // watch dates and no resume: presentation layers must treat it as saved state, never as
    // a dated, percent-complete watch. Detection is conservative — any real anchor, resume,
    // accounted time or watch date opts the row out.
    const importedSavedState = isDatelessSavedWatchState(item)

    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

    if (duration > TWENTY_FOUR_HOURS_MS) {
        duration = 0
    }

    const progress = duration > 0 ? Math.min(100, Math.max(0, (timeOffset / duration) * 100)) : 0
    const isInProgress = (timeOffset > 3000 || progress > 0.5) && progress < 95
    const accountColorIndex = accounts.indexOf(account) % 10
    // Stable per-origin identity: BOTH canonical and secondary items record which login
    // they came from (deletes resolve the exact key after a canonical switch/promotion),
    // but only a SECONDARY tags its id — the canonical keeps the legacy id so cached
    // feeds, deleted-entry keys and tombstones stay valid, and two logins watching the
    // same title stay independently visible and independently deletable.
    const itemId = options?.connectionId && options.distinctId !== false
        ? stremioActivityItemKey(account.id, uniqueItemId, options.connectionId)
        : `${account.id}:${uniqueItemId}`

    return {
        id: itemId,
        accountId: account.id,
        accountName: account.name || getAccountEmail(account)?.split('@')[0] || account.id || 'Unknown',
        accountColorIndex,
        itemId: item._id,
        uniqueItemId,
        name: item.name || 'Unknown Title',
        type: item.type || 'other',
        poster: sanitizePosterUrl(item.poster) || '',
        timestamp,
        firstWatched,
        duration,
        watched: timeOffset,
        progress,
        timesWatched,
        flaggedWatched,
        importedSavedState,
        isInProgress,
        season,
        episode,
        overallTimeWatched,
        source: 'stremio',
        ...(options?.connectionId ? { sourceConnectionId: options.connectionId } : {}),
    }
}

interface NuvioWatchedItem {
    content_id: string
    content_type?: string
    title?: string
    season?: number | null
    episode?: number | null
    watched_at?: number | string
}

interface NuvioProgressItem {
    content_id: string
    content_type?: string
    video_id?: string
    season?: number | null
    episode?: number | null
    position?: number
    duration?: number
    /** Explicit percentage-only progress from providers without an elapsed time/runtime. */
    progressPercent?: number
    last_watched?: number | string
}

export interface CinemetaResolution {
    name: string
    poster: string
    genres: string[]
}

/** Per-run share of one Cinemeta lookup: the many episode rows of a series resolve once. */
export type CinemetaMemo = Map<string, Promise<CinemetaResolution>>

export function createCinemetaMemo(): CinemetaMemo {
    return new Map()
}

async function resolveCinemeta(imdbId: string, type?: string, memo?: CinemetaMemo): Promise<CinemetaResolution> {
    const memoKey = `${type || ''}|${imdbId}`
    const shared = memo?.get(memoKey)
    if (shared) return shared
    const task = (async (): Promise<CinemetaResolution> => {
        const slim = await fetchCinemetaSlim(imdbId, type)
        if (!slim) return { name: '', poster: '', genres: [] }
        return {
            name: slim.name,
            poster: sanitizePosterUrl(slim.poster) || '',
            genres: slim.genres ?? [],
        }
    })()
    memo?.set(memoKey, task)
    return task
}

function nuvioUniqueId(contentId: string, season?: number | null, episode?: number | null): string {
    if (episode != null) return `${contentId}:${season ?? 1}:${episode}`
    return contentId
}

function stripNuvioEpisodeTag(title: string, episode?: number | null): string {
    if (episode == null) return title
    return title.replace(/[\s-]*s\d{1,3}\s*e\d{1,3}\s*$/i, '').trim()
}

export function nuvioProgressKey(contentId: string, season?: number | null, episode?: number | null): string {
    if (episode != null) return `${contentId}_s${season ?? 1}e${episode}`
    return contentId
}

function accountActivityMeta(account: Account, accounts: Account[]) {
    return {
        name: account.name || getAccountEmail(account)?.split('@')[0] || account.id || 'Unknown',
        colorIndex: accounts.indexOf(account) % 10,
    }
}

export async function transformNuvioWatchedItemToActivityItem(row: NuvioWatchedItem, account: Account, accounts: Account[], options?: { connectionId?: string; cinemetaMemo?: CinemetaMemo }): Promise<ActivityItem> {
    const uniqueItemId = nuvioUniqueId(row.content_id, row.season, row.episode)
    const meta = accountActivityMeta(account, accounts)
    // Undated rows must not borrow the sync time as a fake watch date: during a
    // large-library sync hundreds of them land within minutes of each other and
    // chain into one giant fake binge session. Observation time still orders the
    // row in lists, but the backfill marker excludes it from time-based stats,
    // exactly like Stremio bitfield recoveries.
    const watchedAtMs = nuvioSourceTime(row.watched_at)
    const undated = watchedAtMs === null
    const watchedAt = undated ? Date.now() : watchedAtMs
    const resolved = await resolveCinemeta(row.content_id, row.content_type, options?.cinemetaMemo)
    let name: string
    if (row.episode != null && resolved.name.trim()) {
        name = resolved.name
    } else {
        name = stripNuvioEpisodeTag(row.title || '', row.episode)
        if (!name.trim()) name = resolved.name
    }
    const poster = resolved.poster
    const genres = resolved.genres.length > 0 ? resolved.genres : undefined
    return {
        // Per-origin identity: with several Nuvio logins bound, each copy tags its
        // connection so same-title watches stay separately visible and separately
        // deletable; the single-connection shape keeps the legacy id untouched.
        id: options?.connectionId
            ? `${account.id}:nuvio:${options.connectionId}:${uniqueItemId}`
            : `${account.id}:nuvio:${uniqueItemId}`,
        accountId: account.id,
        accountName: meta.name,
        accountColorIndex: meta.colorIndex,
        itemId: row.content_id,
        uniqueItemId,
        name: name || 'Unknown Title',
        type: row.content_type || 'other',
        poster,
        timestamp: new Date(Math.min(watchedAt, Date.now())),
        ...(undated ? { backfill: true } : {}),
        duration: 0,
        watched: 0,
        progress: 100,
        isInProgress: false,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        source: 'nuvio',
        ...(options?.connectionId ? { sourceConnectionId: options.connectionId } : {}),
        genres,
    }
}

// Progress rows carry no title (only watched rows do), so the caller can pass a title resolved
// from the watched-items list for the same content_id to avoid showing a raw id as the name.
export async function transformNuvioProgressToActivityItem(row: NuvioProgressItem, account: Account, accounts: Account[], titleHint?: string, options?: { connectionId?: string; cinemetaMemo?: CinemetaMemo }): Promise<ActivityItem> {
    const uniqueItemId = row.video_id || nuvioUniqueId(row.content_id, row.season, row.episode)
    const meta = accountActivityMeta(account, accounts)
    const percentOnly = row.progressPercent !== undefined
    const duration = percentOnly ? 0 : Number(row.duration) || 0
    const position = percentOnly ? 0 : Number(row.position) || 0
    const progress = percentOnly
        ? (Number.isFinite(row.progressPercent) && row.progressPercent! >= 0 && row.progressPercent! <= 100 ? row.progressPercent! : 0)
        : duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0
    // Same undated rule as watched rows: no real last_watched means the timestamp
    // is the sync observation, not a watch date; mark it so binge/session stats
    // and other time-based metrics exclude it.
    const lastWatchedMs = nuvioSourceTime(row.last_watched)
    const undated = lastWatchedMs === null
    const lastWatched = undated ? Date.now() : lastWatchedMs
    const resolved = await resolveCinemeta(row.content_id, row.content_type, options?.cinemetaMemo)
    let name: string
    if (row.episode != null && resolved.name.trim()) {
        name = resolved.name
    } else {
        name = stripNuvioEpisodeTag(titleHint?.trim() || '', row.episode)
        if (!name.trim()) name = resolved.name
    }
    const poster = resolved.poster
    const genres = resolved.genres.length > 0 ? resolved.genres : undefined
    return {
        id: options?.connectionId
            ? `${account.id}:nuvio:${options.connectionId}:${uniqueItemId}`
            : `${account.id}:nuvio:${uniqueItemId}`,
        accountId: account.id,
        accountName: meta.name,
        accountColorIndex: meta.colorIndex,
        itemId: row.content_id,
        uniqueItemId,
        name: name || row.content_id,
        type: row.content_type || 'other',
        poster,
        timestamp: new Date(Math.min(lastWatched, Date.now())),
        ...(undated ? { backfill: true } : {}),
        duration,
        watched: position,
        progress,
        isInProgress: progress > 0 && progress < 90,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        source: 'nuvio',
        ...(options?.connectionId ? { sourceConnectionId: options.connectionId } : {}),
        genres,
    }
}

export function historyEntryToActivityItem(entry: HistoryEntry): ActivityItem {
    return {
        id: entry.id,
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountColorIndex: entry.accountColorIndex,
        itemId: entry.itemId,
        uniqueItemId: entry.video_id,
        name: entry.name,
        type: entry.type,
        poster: sanitizePosterUrl(entry.poster) || '',
        timestamp: entry.timestamp,
        firstWatched: entry.firstWatched,
        duration: entry.duration,
        watched: entry.isFromEventLog ? entry.watched : (entry.liveWatched ?? entry.watched),
        // The live overlay is the CURRENT state of this exact play identity (attached only
        // to the newest event of the identity while the library still holds the row), so
        // its progress is the display state; the event's own measure stays historical
        // (#85's unmeasured-event borrow and Sol R1 F5's 23%-event-vs-93%-row both hold).
        progress: Math.min(
            entry.liveProgress ?? entry.progress,
            100,
        ),
        // Authoritative current resume, separate from the credited time above (Sol R2-10):
        // present only when the overlay supplied one, so a near-zero reset never falls
        // back to historical event credit in the badge.
        liveResume: entry.liveWatched,
        timesWatched: entry.timesWatched,
        flaggedWatched: entry.flaggedWatched,
        isInProgress: entry.isInProgress,
        season: entry.season,
        episode: entry.episode,
        overallTimeWatched: entry.overallTimeWatched,
        source: entry.source,
        sourceConnectionId: entry.sourceConnectionId,
        backfill: entry.backfill,
        importedSavedState: entry.importedSavedState,
        timeApproximate: entry.timeApproximate,
        savedEpisodes: entry.savedEpisodes,
        genres: entry.genres,
        readOnly: entry.readOnly,
        mediaObservation: entry.mediaObservation,
        mediaSources: entry.mediaSources,
        mediaTargets: entry.mediaTargets,
    }
}

// Saved-only imported series resolve no watch badge at all (see imported-watch-state.ts).
