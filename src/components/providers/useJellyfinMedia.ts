import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { QueryClient, useQueries, replaceEqualDeep, type UseQueryResult } from '@tanstack/react-query'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useConnectionStore } from '@/store/connectionStore'
import { encrypt, decrypt } from '@/lib/crypto'
import { trace } from '@/lib/trace'
import { getActivePersistence, getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { createJellyfinClient, JellyfinError, PLAYED_PAGE_SIZE } from '@/lib/jellyfin/client'
import { openJellyfinSecret } from '@/lib/jellyfin/connection-data'
import {
    HEAD_PROBE_MAX_AGE_MS,
    MEDIA_READ_WAITING_MESSAGE,
    loadMediaObservation,
    loadSealedMediaObservation,
    decodeSealedMediaObservation,
    mediaCacheStorageKey,
    sealMediaObservationSections,
    observedArchiveRead,
    observedLibraryReads,
    orphanedMediaCacheKeys,
    archiveRewalkDue,
    archiveBreakerOpen,
    archiveRefetchDelay,
    createPlayedComposeMemo,
    dedupeTrace,
    headObservationSignature,
    headProbeEligible,
    headProbeMatches,
    resumeMatches,
    playedComposeTrace,
    playedReadsReconcile,
    preferHydratedArchive,
    pruneToLive,
    rearmArchiveBreaker,
    recordArchiveFailure,
    scopeJitteredInterval,
    stableRandom,
    sessionRefetchDelay,
    setBounded,
    SETTLED_ARCHIVE_MAX,
    type ArchiveFailureState,
    type PlayedComposeTrace,
    restoredLibraryReads,
    composeJobPlayed,
    type ArchiveRewalkState,
    sameMediaCacheScope,
    type MediaCacheObservation,
    type MediaCacheObservationSections,
    type MediaCacheReadObservation,
    type MediaCacheScope,
    type MediaCacheStorage,
} from '@/lib/jellyfin/media-cache'
import { captureMediaRead, retryOnceOnTransient, type JellyfinMediaReads, type MediaRead } from '@/lib/jellyfin/reads'
import { applyKnownParents, createParentSeriesLookup, resolveJellyfinSeries, SERIES_LOOKUPS_PER_PASS, type SeriesBatchReader } from '@/lib/jellyfin/metadata'
import { canApplyMediaReadFailure, jellyfinConnectionReadFailure } from '@/lib/jellyfin/connection-health'
import type { JellyfinItem, JellyfinItemResult, JellyfinSession, JellyfinPagedReadOptions } from '@/lib/jellyfin/types'
import type { Connection } from '@/types/connection'
import { supportsLiveSessions } from './connection-state'

// Shared across cards, Activity and connection details. Keep the in-memory
// query entries briefly when a lazy route unmounts: Activity → Metrics should
// reuse the settled archive instead of starting another full remote walk.
// Head/session reads retain a short freshness window; the archive query below
// supplies its own ten-minute staleTime and remains the expensive boundary.
const mediaQueries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000, staleTime: 30_000, refetchOnMount: true } } })
const vaultEpochs = new WeakMap<CryptoKey, number>()
let nextEpoch = 0
function epoch(key: CryptoKey) {
    if (!vaultEpochs.has(key)) vaultEpochs.set(key, ++nextEpoch)
    return vaultEpochs.get(key)!
}
const waiting = { status: 'waiting' as const, message: MEDIA_READ_WAITING_MESSAGE }
function combine<T>(queries: UseQueryResult<T>[]) {
    // TanStack structurally shares each combined child. Fetch status can change
    // without replacing the data/error arrays used by Activity derivation.
    return {
        data: queries.map(query => query.data),
        fetching: queries.map(query => query.isFetching),
        pending: queries.map(query => query.isPending),
        errors: queries.map(query => query.isError),
    }
}
type LibraryReads = Pick<JellyfinMediaReads, 'resume' | 'played'> & {
    /** In-memory continuation of this exact head read, never a persisted cache. */
    readInitialArchive?: (onProgress: JellyfinPagedReadOptions['onProgress'], signal: AbortSignal) => Promise<JellyfinItemResult>
}
/** Restored observations additionally carry the last full-history archive walk. */
type RestoredLibraryReads = LibraryReads & { archive?: MediaRead<JellyfinItemResult> }
function libraryItems(reads: LibraryReads | undefined): JellyfinItem[] {
    return reads ? [reads.resume, reads.played].flatMap(read => read.status === 'success' ? read.data.items : []) : []
}

/**
 * Full-history archive cadence: the fast 60s poll only refreshes the head
 * (resume + first played pages), while the full walk reconciles deletions and
 * the archive tail at this bounded cadence, on manual refresh, and whenever
 * the head stops reconciling with the retained archive.
 */
const ARCHIVE_REUSE_WINDOW_MS = 30 * 60_000
const ARCHIVE_PAGE_RETRIES = 2
const ARCHIVE_STALE_MS = 10 * 60_000
/**
 * With DatePlayed sorting accepted and a complete archive whose rows match its
 * total, a reconciling archive catches new watches, rewatches, deletions and
 * unwatches. A delete plus an old-dated import in the tail still reconciles, so
 * a full walk stays due within this bound. Display-only: migration and deletes
 * read live.
 */
const ARCHIVE_SORTED_REUSE_MS = 2 * 60 * 60_000
function archiveReuseWindow(head: JellyfinItemResult, archive: JellyfinItemResult, defaultWindowMs: number): number {
    const trusted = head.sortAccepted === true && archive.complete === true && archive.limited !== true
        && archive.total !== null && archive.items.length === archive.total
    return trusted ? ARCHIVE_SORTED_REUSE_MS : defaultWindowMs
}
/** One retry per head page for transient failures; 4xx is never retried. */
const HEAD_PAGE_RETRIES = 1
/** Consecutive failed walks per subject (and the last failure, served while the breaker is open). */
const archiveFailures = new Map<string, ArchiveFailureState>()
const archiveFailureReads = new Map<string, MediaRead<JellyfinItemResult>>()

// ---------------------------------------------------------------------------
// Persisted library observations (see lib/jellyfin/media-cache).
//
// The media query client above is transient on purpose, so a full page reload
// restores the last successful per-connection observation from encrypted,
// workspace-scoped storage while the fresh read is in flight. Restored reads
// are placeholders for pending reads only — a live error replaces them — and
// they are keyed by vault epoch plus the exact subject scope, so a vault
// lock/unlock, workspace transition, reconnect, user change or server change
// can never restore another subject's history.
// ---------------------------------------------------------------------------

function captureMediaCacheStorage(): MediaCacheStorage {
    // Pin the database before any await. A workspace switch must not redirect
    // an old request's encrypted observation into the new owner's database.
    const persistence = getActivePersistence()
    return {
        getItem: async key => { const value = await persistence.getItem(key); return typeof value === 'string' ? value : null },
        setItem: (key, value) => persistence.setItem(key, value),
        removeItem: key => persistence.removeItem(key),
        keys: () => persistence.keys(),
    }
}

interface RestoredMediaCache { epoch: number; reads: Map<string, RestoredLibraryReads>; completed: Set<string> }
const emptyRestoredMediaCache: RestoredMediaCache = { epoch: -1, reads: new Map(), completed: new Set() }
let restoredMediaCache: RestoredMediaCache = emptyRestoredMediaCache
let hydrationGeneration = 0
const pendingHydrations = new Set<string>()
/** Cooldown bookkeeping for head/archive reconcile triggers (per subject key). */
const archiveReconcileAt = new Map<string, ArchiveRewalkState>()
/** Parent-series answers (found and confirmed provider-less), keyed per connection/user. */
const parentSeries = createParentSeriesLookup()
/** Scopes where the server proved the Ids batch query unusable; per-item lookups resume there. */
const seriesBatchUnsupported = new Set<string>()
/** Last completed archive per exact job scope. Progressive refresh pages never
 * replace this value, so consumers can keep rendering the settled snapshot. */
type SettledArchiveRead = Extract<MediaRead<JellyfinItemResult>, { status: 'success' }>
const settledArchives = new Map<string, SettledArchiveRead>()
const archiveForceRefreshAt = new Map<string, number>()
/** Last successful merged played listing per subject, so a failed refetch never erases history. */
const lastGoodPlayed = new Map<string, SettledArchiveRead>()
/** Head content signature per scope recorded after a successful persist, so an
 * unchanged head skips the whole storage write cycle. */
const persistedHeadSignatures = new Map<string, string>()
/** Archive checkedAt this session last persisted per archive scope: a hydrated
 * archive older than that must not stand in for the persisted one. */
const lastPersistedArchiveAt = new Map<string, number>()
/** Scope key -> marker set by mutations, manual refresh and full walks: the
 * next head read must skip the probe and read the full head. */
const forceFullHeadAt = new Map<string, number>()
/** Wall clock of the last completed full head read per scope; probes are only
 * eligible within the 5 minute window it bounds. */
const lastFullHeadAt = new Map<string, number>()
/** Consecutive /Sessions polls per connection that reported no live row. */
const sessionsIdleStreak = new Map<string, number>()
/** Page-scope media consumers (Activity and the other full pages) mounted. */
let pageScopeMediaConsumers = 0
let archiveCacheLimit = SETTLED_ARCHIVE_MAX
const composeTraceSeen = new Map<string, string>()
const hydrationListeners = new Set<() => void>()
function publishRestoredMediaCache(next: RestoredMediaCache) {
    restoredMediaCache = next
    hydrationListeners.forEach(listener => listener())
}
const subscribeHydration = (listener: () => void) => {
    hydrationListeners.add(listener)
    return () => { hydrationListeners.delete(listener) }
}
// A workspace transition invalidates everything: in-flight hydration ends
// without publishing, and restored observations never cross vault owners.
function clearRestoredMediaCache() {
    hydrationGeneration++
    pendingHydrations.clear()
    parentSeries.clear()
    seriesBatchUnsupported.clear()
    settledArchives.clear()
    lastGoodPlayed.clear()
    archiveForceRefreshAt.clear()
    archiveFailures.clear()
    archiveFailureReads.clear()
    archiveReconcileAt.clear()
    composeTraceSeen.clear()
    persistedHeadSignatures.clear()
    lastPersistedArchiveAt.clear()
    forceFullHeadAt.clear()
    lastFullHeadAt.clear()
    sessionsIdleStreak.clear()
    publishRestoredMediaCache(emptyRestoredMediaCache)
}
subscribeWorkspaceChanges(clearRestoredMediaCache)
useAuthStore.subscribe((state, previous) => {
    if (state.encryptionKey !== previous.encryptionKey) clearRestoredMediaCache()
})
// Removed connections and rotated credentials leave their scope keys behind;
// drop every per-scope entry the live accounts no longer own.
useAccountStore.subscribe((state, previous) => {
    if (state.accounts !== previous.accounts) pruneDeadMediaScopes()
})
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) rearmArchiveBreakers(() => true) })
}

function mediaScopeFor(job: { accountId: string; connection: Connection }): MediaCacheScope | null {
    const credentials = job.connection.credentials?.jellyfin
    const userId = job.connection.mediaServer?.userId
    if (!credentials || !userId) return null
    return {
        accountId: job.accountId,
        connectionId: job.connection.id,
        credentials,
        userId,
        serverId: job.connection.mediaServer?.serverId || '',
    }
}

function parentSeriesKeyPrefix(job: { accountId: string; connection: Connection; workspaceId?: string }, userId: string): string {
    return [job.workspaceId || '', job.accountId, job.connection.id, job.connection.credentials?.jellyfin || '', job.connection.mediaServer?.serverId || '', userId].join('|')
}

function parentSeriesKeys(job: { accountId: string; connection: Connection; workspaceId?: string }, userId: string): (seriesId: string) => string {
    const prefix = parentSeriesKeyPrefix(job, userId)
    return seriesId => `${prefix}|${seriesId}`
}

function withKnownParents(read: MediaRead<JellyfinItemResult>, keyOf: (seriesId: string) => string): MediaRead<JellyfinItemResult> {
    if (read.status !== 'success') return read
    const items = applyKnownParents(read.data.items, parentSeries, keyOf)
    return items === read.data.items ? read : { ...read, data: { ...read.data, items } }
}

/**
 * Structural sharing for composed reads: a poll whose content is unchanged
 * keeps the previous read object (with its older checkedAt) so the activity
 * projector cache and every derived history identity survive a no-op poll.
 * Only the verification timestamp is allowed to drift; failures and changed
 * data adopt the fresh object immediately.
 */
export function stableRead(previous: MediaRead<JellyfinItemResult> | undefined, next: MediaRead<JellyfinItemResult>): MediaRead<JellyfinItemResult> {
    if (previous?.status === 'success' && next.status === 'success'
        && sharedPlayedResult(previous.data, next.data) === previous.data) return previous
    return next
}

// Composed rows are plain JSON DTOs, so this verdict compare can decide reuse
// without replaceEqualDeep's shared-copy build at every level; anything not
// plain (arrays, Dates, class instances) delegates to it for the verdict.
function dtoEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    const protoA = Object.getPrototypeOf(a)
    const protoB = Object.getPrototypeOf(b)
    const plainA = protoA === Object.prototype || protoA === null
    const plainB = protoB === Object.prototype || protoB === null
    if (!plainA || !plainB) return replaceEqualDeep(a, b) === a
    const aRecord = a as Record<string, unknown>
    const bRecord = b as Record<string, unknown>
    let aSize = 0
    for (const _ in aRecord) aSize++
    let bSize = 0
    for (const key in bRecord) {
        bSize++
        const av = aRecord[key]
        const bv = bRecord[key]
        if (av === bv) {
            if (bv === undefined && !Object.hasOwn(aRecord, key)) return false
            continue
        }
        if (!dtoEqual(av, bv)) return false
    }
    return aSize === bSize
}

function sharedPlayedRows(previous: JellyfinItem[], next: JellyfinItem[]): JellyfinItem[] {
    let shared: JellyfinItem[] | null = null
    for (let i = 0; i < next.length; i++) {
        const old: JellyfinItem | undefined = previous[i]
        const row = next[i]!
        let kept: JellyfinItem
        if (old === undefined) kept = row
        else if (old === row || dtoEqual(old, row)) kept = old
        else kept = replaceEqualDeep(old, row)
        if (shared === null) {
            if (kept === old) continue
            shared = previous.slice(0, i)
        }
        shared.push(kept)
    }
    return shared ?? (previous.length === next.length ? previous : previous.slice(0, next.length))
}

function playedFieldsEqual(previous: JellyfinItemResult, next: JellyfinItemResult): boolean {
    const prevRecord = previous as unknown as Record<string, unknown>
    const nextRecord = next as unknown as Record<string, unknown>
    let aSize = 0
    for (const _ in prevRecord) aSize++
    let bSize = 0
    for (const key in nextRecord) {
        bSize++
        if (key === 'items') continue
        const av = prevRecord[key]
        const bv = nextRecord[key]
        if (av === bv) {
            if (bv === undefined && !Object.hasOwn(prevRecord, key)) return false
            continue
        }
        if (!dtoEqual(av, bv)) return false
    }
    return aSize === bSize
}

export function sharedPlayedResult(previous: JellyfinItemResult, next: JellyfinItemResult): JellyfinItemResult {
    const rows = sharedPlayedRows(previous.items, next.items)
    if (rows === previous.items && playedFieldsEqual(previous, next)) return previous
    return { ...next, items: rows }
}

/** Last composed read objects per job, keyed by the same subject-scoped key as the compose memo. */
type StableLibraryReads = { resume: MediaRead<JellyfinItemResult>; played: MediaRead<JellyfinItemResult>; historyPlayed: MediaRead<JellyfinItemResult> }

function setSettledArchive(key: string, value: SettledArchiveRead): void {
    setBounded(settledArchives, key, value, archiveCacheLimit)
}

function getSettledArchive(key: string): SettledArchiveRead | undefined {
    const value = settledArchives.get(key)
    if (!value) return undefined
    setBounded(settledArchives, key, value, archiveCacheLimit)
    return value
}

function rearmArchiveBreakers(match: (scopeKey: string) => boolean): void {
    for (const [key, state] of archiveFailures) {
        if (!match(key)) continue
        const next = rearmArchiveBreaker(state)
        if (next && next !== state) archiveFailures.set(key, next)
    }
}

function mediaQueryKey(scope: JellyfinMediaScope, encryptionKey: CryptoKey, workspaceId: string): unknown[] {
    return ['jellyfin-media', scope.accountId, scope.connection.id, epoch(encryptionKey), scope.connection.credentials.jellyfin, scope.connection.mediaServer!.userId, scope.connection.mediaServer?.serverId || '', workspaceId]
}

function headScopeKey(job: { accountId: string; connection: Connection }): string {
    return `${job.accountId}|${job.connection.id}`
}

function headSignatureKey(scope: MediaCacheScope): string {
    return `${mediaCacheStorageKey(scope)}|${scope.credentials}|${scope.userId}|${scope.serverId}`
}

function pruneDeadMediaScopes(): void {
    const encryptionKey = useAuthStore.getState().encryptionKey
    if (!encryptionKey) return
    const workspaceId = getActiveWorkspaceId()
    const archiveKeys = new Set<string>()
    const goodKeys = new Set<string>()
    const headKeys = new Set<string>()
    const scopeKeys = new Set<string>()
    const connectionIds = new Set<string>()
    for (const account of useAccountStore.getState().accounts) {
        for (const connection of account.connections || []) {
            if (connection.platform !== 'jellyfin' || !connection.enabled || !connection.credentials?.jellyfin || !connection.mediaServer?.userId) continue
            archiveKeys.add(JSON.stringify([...mediaQueryKey({ accountId: account.id, connection }, encryptionKey, workspaceId), 'archive']))
            goodKeys.add(restorationKeyForJob({ accountId: account.id, connection, encryptionKey }))
            connectionIds.add(connection.id)
            scopeKeys.add(headScopeKey({ accountId: account.id, connection }))
            const scope = mediaScopeFor({ accountId: account.id, connection })
            if (scope) headKeys.add(headSignatureKey(scope))
        }
    }
    archiveCacheLimit = Math.max(SETTLED_ARCHIVE_MAX, archiveKeys.size)
    pruneToLive(settledArchives, archiveKeys)
    pruneToLive(archiveForceRefreshAt, archiveKeys)
    pruneToLive(archiveFailures, archiveKeys)
    pruneToLive(archiveFailureReads, archiveKeys)
    pruneToLive(lastPersistedArchiveAt, archiveKeys)
    pruneToLive(lastGoodPlayed, goodKeys)
    pruneToLive(archiveReconcileAt, goodKeys)
    pruneToLive(persistedHeadSignatures, headKeys)
    pruneToLive(forceFullHeadAt, scopeKeys)
    pruneToLive(lastFullHeadAt, scopeKeys)
    pruneToLive(sessionsIdleStreak, connectionIds)
}

function archiveScopeKey(job: { queryKey: unknown[] }): string {
    return JSON.stringify([...job.queryKey, 'archive'])
}

function readCachedParentSeries(
    job: { accountId: string; connection: Connection; workspaceId?: string },
    userId: string,
    readItem: (id: string, signal: AbortSignal) => Promise<JellyfinItem>,
    seriesId: string,
    signal: AbortSignal,
): Promise<JellyfinItem> {
    return parentSeries.read(parentSeriesKeys(job, userId)(seriesId), seriesId, readItem, signal)
}

/** Head-only consumers fall back to archive walks exactly when the server rejected DatePlayed sorting. */
function headSortRejected(played: Pick<LibraryReads, 'played'>['played'] | undefined): boolean {
    return played?.status === 'success' && played.data.inProgress !== true && played.data.sortAccepted === false
}

/**
 * Native Jellyfin walks use 1000-row windows with 3 in flight. AIOMetadata's facade clamps
 * Limit to 500 (addon/lib/jellyfin/index.ts, Users/:userId/Items) and rebuilds the whole
 * played list per request, so it walks 500-row windows, 2 in flight. Other facades keep the
 * 250-row sequential walk until their cap is verified.
 */
function archiveWalkOptions(job: { connection: Connection }): { pageSize?: number; windowConcurrency: number } {
    const product = job.connection.mediaServer?.product
    if (product === 'jellyfin') return { pageSize: 1000, windowConcurrency: 3 }
    if (product === 'aiometadata') return { pageSize: 500, windowConcurrency: 2 }
    return { windowConcurrency: 1 }
}

interface JellyfinSeriesResolution {
    readItem: (id: string, signal: AbortSignal) => Promise<JellyfinItem>
    batch?: SeriesBatchReader
}

/**
 * Parent-series reads for one job scope. Native Jellyfin batches the lookups
 * through the Ids query; facades keep one GET per series. Batch rows are
 * accepted only on an exact Id plus Type Series, and an id a batch omitted is
 * retried per-item instead of being negative-cached.
 */
function seriesResolutionFor(
    job: { accountId: string; connection: Connection; workspaceId?: string },
    secret: { accessToken: string; userId: string },
    client: ReturnType<typeof createJellyfinClient>,
): JellyfinSeriesResolution {
    const keyOf = parentSeriesKeys(job, secret.userId)
    const prefix = parentSeriesKeyPrefix(job, secret.userId)
    const readItem = (id: string, metadataSignal: AbortSignal) =>
        readCachedParentSeries(job, secret.userId, childId => client.readItem(secret.accessToken, secret.userId, childId, metadataSignal), id, metadataSignal)
    if (job.connection.mediaServer?.product !== 'jellyfin') return { readItem }
    return {
        readItem,
        batch: {
            read: (ids, batchSignal) => {
                if (seriesBatchUnsupported.has(prefix)) return Promise.reject(new JellyfinError('unsupported', 'Ids query is not supported for this scope'))
                return client.queryUserItems(secret.accessToken, secret.userId, { ids, includeItemTypes: 'Series' }, batchSignal)
            },
            learn: (item, canonical) => {
                if (canonical) parentSeries.learn(keyOf(item.Id), item.Id, item.ProviderIds ?? {})
                else parentSeries.learnAbsent(keyOf(item.Id))
            },
            onUnsupported: () => { seriesBatchUnsupported.add(prefix) },
        },
    }
}

function restorationKey(scope: MediaCacheScope, vaultEpoch: number): string {
    return [vaultEpoch, scope.accountId, scope.connectionId, scope.credentials, scope.userId, scope.serverId].join('|')
}

function restorationKeyForJob(job: { accountId: string; connection: Connection; encryptionKey: CryptoKey }): string {
    const scope = mediaScopeFor(job)
    return scope ? restorationKey(scope, epoch(job.encryptionKey)) : ''
}

interface MediaCacheJob { accountId: string; connection: Connection; encryptionKey: CryptoKey; workspaceId: string; storage: MediaCacheStorage; queryKey: unknown[] }
function cacheJobIsCurrent(job: MediaCacheJob, scope: MediaCacheScope): boolean {
    if (useAuthStore.getState().encryptionKey !== job.encryptionKey || getActiveWorkspaceId() !== job.workspaceId) return false
    const account = useAccountStore.getState().accounts.find(item => item.id === job.accountId)
    const connection = account?.connections?.find(item => item.id === job.connection.id && item.enabled !== false)
    const currentScope = connection ? mediaScopeFor({ accountId: job.accountId, connection }) : null
    return !!currentScope && sameMediaCacheScope(currentScope, scope)
}

const HEAD_HYDRATION_SECTIONS = ['resume', 'played'] as const

async function hydrateMediaCache(jobs: MediaCacheJob[], vaultEpoch: number): Promise<void> {
    const generation = hydrationGeneration
    let nextJob = 0
    // Publish merges what this worker restored into the live cache. The read
    // and the publish are synchronous together, so concurrent workers never
    // overwrite each other's entries.
    const publish = (reads: Map<string, RestoredLibraryReads>, completed: Set<string>) => {
        if (generation !== hydrationGeneration) return
        const previous = restoredMediaCache.epoch === vaultEpoch ? restoredMediaCache : emptyRestoredMediaCache
        publishRestoredMediaCache({ epoch: vaultEpoch, reads: new Map([...previous.reads, ...reads]), completed: new Set([...previous.completed, ...completed]) })
    }
    async function hydrateNext(): Promise<void> {
        const reads = new Map<string, RestoredLibraryReads>()
        const completed = new Set<string>()
        while (nextJob < jobs.length && generation === hydrationGeneration) {
            const job = jobs[nextJob++]
            const scope = mediaScopeFor(job)
            if (!scope) continue
            const jobKey = restorationKey(scope, vaultEpoch)
            try {
                const sealed = await loadSealedMediaObservation(job.storage, scope)
                if (generation !== hydrationGeneration) return
                if (sealed === null) {
                    completed.add(jobKey)
                    pendingHydrations.delete(jobKey)
                    publish(reads, completed)
                    continue
                }
                const cipher = { decrypt: (value: string) => decrypt(value, job.encryptionKey) }
                // Head first: resume and played publish as soon as they decrypt
                // so cards and Activity paint without waiting for the archive.
                const headObservation = await decodeSealedMediaObservation(sealed, cipher, scope, HEAD_HYDRATION_SECTIONS)
                if (generation !== hydrationGeneration) return
                const headRestored = headObservation ? restoredLibraryReads(headObservation) : null
                if (headRestored && cacheJobIsCurrent(job, scope)) {
                    reads.set(jobKey, headRestored)
                    publish(reads, completed)
                }
                completed.add(jobKey)
                pendingHydrations.delete(jobKey)
                // Completion is published even when nothing restored, so loading never waits on it.
                publish(reads, completed)
                const archiveObservation = await decodeSealedMediaObservation(sealed, cipher, scope, ['archive'] as const)
                if (generation !== hydrationGeneration) return
                const restoredArchive = archiveObservation?.archive && cacheJobIsCurrent(job, scope)
                    ? restoredLibraryReads({ archive: archiveObservation.archive, savedAt: 0 })?.archive
                    : undefined
                if (restoredArchive) {
                    const existing = reads.get(jobKey) ?? { resume: waiting, played: waiting }
                    reads.set(jobKey, { ...existing, archive: restoredArchive })
                    publish(reads, completed)
                }
            } catch {
                // Unreadable observation: this subject waits for its live read.
                completed.add(jobKey)
                pendingHydrations.delete(jobKey)
                publish(reads, completed)
            }
        }
    }
    // Overlap bounded storage/decryption work; each job publishes independently.
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, hydrateNext))
}

const mediaCacheWrites = new Map<string, Promise<boolean>>()
function persistMediaSections(job: MediaCacheJob, scope: MediaCacheScope, sections: MediaCacheObservationSections): Promise<boolean> {
    const queueKey = JSON.stringify([job.workspaceId, scope.accountId, scope.connectionId])
    const pending = (mediaCacheWrites.get(queueKey) ?? Promise.resolve()).then(() => persistMediaSectionsNow(job, scope, sections))
    mediaCacheWrites.set(queueKey, pending)
    void pending.finally(() => { if (mediaCacheWrites.get(queueKey) === pending) mediaCacheWrites.delete(queueKey) })
    return pending
}

/**
 * Persists a head observation only when its content changed since the last
 * successful write for this scope: an unchanged poll skips the storage read,
 * decrypt, re-seal and write entirely. The signature is recorded only after a
 * successful write, so a failed write retries on the next poll.
 */
function persistHeadObservation(job: MediaCacheJob, scope: MediaCacheScope, persisted: MediaCacheObservation): void {
    const key = headSignatureKey(scope)
    const signature = headObservationSignature(persisted)
    if (persistedHeadSignatures.get(key) === signature) return
    void persistMediaSections(job, scope, persisted).then(written => {
        if (written) persistedHeadSignatures.set(key, signature)
    })
}

async function persistMediaSectionsNow(job: MediaCacheJob, scope: MediaCacheScope, sections: MediaCacheObservationSections): Promise<boolean> {
    const key = job.encryptionKey
    const generation = hydrationGeneration
    try {
        if (!cacheJobIsCurrent(job, scope)) return false
        // Serialize read-modify-write for this subject: head and archive writes
        // must see the last committed sections instead of racing from one base.
        const stored = await job.storage.getItem(mediaCacheStorageKey(scope))
        if (!cacheJobIsCurrent(job, scope) || generation !== hydrationGeneration) return false
        const sealed = await sealMediaObservationSections(stored, {
            encrypt: plain => encrypt(plain, key),
            decrypt: encrypted => decrypt(encrypted, key),
        }, scope, sections)
        if (!sealed) return false
        // Reject late writes: if the vault re-locked or the workspace switched
        // while sealing, this observation belongs to another owner's session
        // and must never land in the active workspace's storage.
        if (!cacheJobIsCurrent(job, scope) || generation !== hydrationGeneration) return false
        await job.storage.setItem(mediaCacheStorageKey(scope), sealed)
        // Prune entries whose account/connection no longer exists so deleted
        // or removed subjects never accumulate (and can never be revived).
        const liveKeys = useAccountStore.getState().accounts.flatMap(account =>
            (account.connections || [])
                .filter(connection => connection.platform === 'jellyfin')
                .map(connection => mediaCacheStorageKey({ accountId: account.id, connectionId: connection.id }))
        )
        for (const orphan of orphanedMediaCacheKeys(await job.storage.keys(), liveKeys)) {
            if (!cacheJobIsCurrent(job, scope) || generation !== hydrationGeneration) return false
            await job.storage.removeItem(orphan)
        }
        return true
    } catch {
        // Best-effort cache: the live read this observation came from already succeeded.
        return false
    }
}

function archiveResultOf(observation: MediaCacheReadObservation): JellyfinItemResult {
    return {
        items: observation.items,
        total: observation.total,
        complete: observation.complete,
        ...(observation.paginationComplete ? { paginationComplete: true as const } : {}),
        ...(observation.limited ? { limited: true as const } : {}),
        limit: observation.limit,
    }
}
export interface JellyfinMediaScope { accountId: string; connection: Connection }

export function refreshJellyfinMedia(accountId: string, connectionId: string): void {
    const inScope = (key: string) => { try { const parsed = JSON.parse(key); return parsed[1] === accountId && parsed[2] === connectionId } catch { return false } }
    rearmArchiveBreakers(inScope)
    // A delete rewalk is scoped: only the connection whose history changed walks the archive again.
    for (const key of [...settledArchives.keys(), ...archiveFailureReads.keys()]) {
        if (inScope(key)) archiveForceRefreshAt.set(key, Date.now())
    }
    // Watch-state mutations always pay a full head read: the probe could
    // otherwise confirm a prefix captured before the change.
    forceFullHeadAt.set(`${accountId}|${connectionId}`, Date.now())
    void mediaQueries.invalidateQueries({ queryKey: ['jellyfin-media', accountId, connectionId] })
}

export interface JellyfinMediaOptions {
    /** Live /Sessions polling; callers that never show live playback turn it off. */
    sessions?: boolean
    /** Full-history archive walks; callers that only need the latest-watched head turn it off. */
    archive?: boolean
    /**
     * Card-scope consumers only: /Sessions may idle back after several empty
     * polls. Page-scope consumers (Activity and the other full pages) keep the
     * 15s cadence regardless.
     */
    sessionsBackoff?: boolean
}

const subscribeVisibility = (onChange: () => void) => {
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
}
const isDocumentVisible = () => typeof document === 'undefined' || !document.hidden

export function useJellyfinMediaConnections(scopes: JellyfinMediaScope[], options: JellyfinMediaOptions = {}) {
    const sessionsEnabled = options.sessions !== false
    const archiveEnabled = options.archive !== false
    const sessionsBackoff = options.sessionsBackoff === true
    const encryptionKey = useAuthStore(state => state.encryptionKey)
    const workspaceId = useSyncExternalStore(subscribeWorkspaceChanges, getActiveWorkspaceId, () => '')
    // A full-history walk never starts in a hidden tab; one already running finishes.
    const documentVisible = useSyncExternalStore(subscribeVisibility, isDocumentVisible, () => true)
    useEffect(() => { mediaQueries.mount(); return () => mediaQueries.unmount() }, [])
    useEffect(() => {
        // Page-scope consumers hold /Sessions at the 15s cadence for every
        // connection; only card-only trees may idle back.
        if (sessionsBackoff) return undefined
        pageScopeMediaConsumers += 1
        return () => { pageScopeMediaConsumers -= 1 }
    }, [sessionsBackoff])
    // Jobs stay mounted while the tab is hidden: TanStack pauses the poll
    // intervals in the background, and emptying the queries on hide would
    // cancel in-flight walks, drop the projector inputs and force a full
    // restart on return.
    const jobsSignature = useMemo(() => JSON.stringify([
        encryptionKey ? epoch(encryptionKey) : null,
        workspaceId,
        scopes.map(({ accountId, connection }) => [
            accountId,
            connection.id,
            connection.platform === 'jellyfin' && connection.enabled && !!connection.credentials?.jellyfin && !!connection.mediaServer?.userId,
            connection.credentials?.jellyfin ?? '',
            connection.mediaServer?.userId ?? '',
            connection.mediaServer?.serverId ?? '',
            connection.mediaServer?.product ?? '',
            connection.status ?? '',
        ]),
    ]), [scopes, encryptionKey, workspaceId])
    const jobsRef = useRef<{ signature: string; jobs: MediaCacheJob[] }>({ signature: '', jobs: [] })
    let jobs: MediaCacheJob[] = jobsRef.current.jobs
    if (!encryptionKey) {
        jobs = []
    } else if (jobsRef.current.signature !== jobsSignature) {
        const storage = captureMediaCacheStorage()
        jobs = scopes
            .filter(({ connection }) => connection.platform === 'jellyfin' && connection.enabled && connection.credentials?.jellyfin && connection.mediaServer?.userId)
            .map(scope => ({ ...scope, encryptionKey, workspaceId, storage, queryKey: mediaQueryKey(scope, encryptionKey, workspaceId) }))
        jobsRef.current = { signature: jobsSignature, jobs }
    }
    const vaultEpoch = encryptionKey ? epoch(encryptionKey) : -1
    const hydration = useSyncExternalStore(subscribeHydration, () => restoredMediaCache, () => emptyRestoredMediaCache)
    useEffect(() => {
        if (!encryptionKey || jobs.length === 0) return
        const missing = jobs.filter(job => {
            const jobKey = restorationKeyForJob(job)
            return !pendingHydrations.has(jobKey) && (hydration.epoch !== vaultEpoch || !hydration.completed.has(jobKey))
        })
        if (!missing.length) return
        missing.forEach(job => pendingHydrations.add(restorationKeyForJob(job)))
        void hydrateMediaCache(missing, vaultEpoch).catch(() => {})
    }, [encryptionKey, jobs, hydration, vaultEpoch])
    const library = useQueries({ queries: jobs.map(job => ({
        queryKey: [...job.queryKey, 'library'], refetchInterval: job.connection.status === 'expired' ? false : scopeJitteredInterval(60_000, job.connection.id),
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
            const secret = await openJellyfinSecret(job.connection, value => decrypt(value, job.encryptionKey))
            signal.throwIfAborted()
            const client = createJellyfinClient(secret.baseUrl, { deviceId: secret.deviceId })
            const previous = mediaQueries.getQueryData<LibraryReads>([...job.queryKey, 'library'])
            const persistScope = mediaScopeFor(job)
            const headKey = headScopeKey(job)
            // Consumed only by a successful full head read, so a failed forced read stays forced.
            const forcedFull = forceFullHeadAt.get(headKey)
            const previousPlayed = previous?.played
            const probeCandidate = previous && previousPlayed?.status === 'success'
                && previousPlayed.data.sortAccepted === true
                && previousPlayed.data.inProgress !== true
                ? previousPlayed
                : undefined
            // Native Jellyfin, sorted head, no forced read, and a full head read
            // inside the probe window: a 25-row probe decides whether the poll
            // needs the full head at all.
            if (previous && probeCandidate && headProbeEligible({
                product: job.connection.mediaServer?.product,
                forced: forcedFull !== undefined,
                now: Date.now(),
                lastFullHeadAt: lastFullHeadAt.get(headKey),
                resume: previous?.resume,
                played: previousPlayed,
                lastFullHeadMaxAgeMs: HEAD_PROBE_MAX_AGE_MS,
            })) {
                try {
                    // Continue Watching is small and changes when a watch starts, so it is read every poll.
                    const [probe, resumeNow] = await Promise.all([
                        client.probePlayedHead(secret.accessToken, secret.userId, signal),
                        retryOnceOnTransient(() => client.readResume(secret.accessToken, secret.userId, signal), signal),
                    ])
                    signal.throwIfAborted()
                    if (headProbeMatches(probe, probeCandidate.data)
                        && previous.resume.status === 'success' && resumeMatches(resumeNow, previous.resume.data)) {
                        // The head is provably unchanged: return the previous data
                        // references (new checkedAt) so every downstream memo and
                        // projector cache keeps its identity.
                        return {
                            resume: previous.resume,
                            played: { status: 'success', data: probeCandidate.data, checkedAt: Date.now() },
                            readInitialArchive: previous.readInitialArchive,
                        } satisfies LibraryReads
                    }
                } catch {
                    // A failed probe falls through to the full head read; an
                    // aborted poll rethrows here.
                    signal.throwIfAborted()
                }
            }
            let resume: LibraryReads['resume'] = { status: 'waiting', message: MEDIA_READ_WAITING_MESSAGE }
            let played: LibraryReads['played'] = { status: 'waiting', message: MEDIA_READ_WAITING_MESSAGE }
            let observedHead: JellyfinItemResult | undefined
            const { readItem: readParentItem, batch: seriesBatch } = seriesResolutionFor(job, secret, client)
            const keyOf = parentSeriesKeys(job, secret.userId)
            // A second head page is worth prefetching only when something
            // already saw more than one page of history for this subject.
            const headSecondPageLikely = (): boolean => {
                const over = (read: LibraryReads['played'] | undefined) =>
                    read?.status === 'success' && (read.data.total ?? 0) > PLAYED_PAGE_SIZE
                const restored = restoredMediaCache.reads.get(restorationKeyForJob(job))
                const settled = getSettledArchive(archiveScopeKey(job))
                return over(previous?.played) || over(restored?.played) || over(restored?.archive)
                    || (!!settled && (settled.data.total ?? 0) > PLAYED_PAGE_SIZE)
            }
            const readInitialArchive = (onProgress: JellyfinPagedReadOptions['onProgress'], archiveSignal: AbortSignal) => {
                archiveSignal.throwIfAborted()
                if (!persistScope || !cacheJobIsCurrent(job, persistScope)) throw new DOMException('Media scope changed', 'AbortError')
                return client.readAllPlayed(secret.accessToken, secret.userId, { onProgress, prefetchedHead: observedHead, pageRetries: ARCHIVE_PAGE_RETRIES, ...archiveWalkOptions(job) }, archiveSignal)
            }
            const publishPartial = () => {
                // A settled head is never swapped for a partial re-read of itself:
                // an in-progress head publish settles behind the previous settled
                // one, so a no-op poll never invalidates downstream identities.
                // First loads (no settled head yet) still publish progressive
                // snapshots; failures and changed finals publish immediately.
                const settledPrevious = previous?.played?.status === 'success' && previous.played.data.inProgress !== true
                    ? previous.played
                    : undefined
                const visiblePlayed = played.status === 'waiting' && previous?.played && previous.played.status !== 'waiting'
                    ? previous.played
                    : played.status === 'success' && played.data.inProgress === true && settledPrevious
                        ? settledPrevious
                        : played
                mediaQueries.setQueryData<LibraryReads>([...job.queryKey, 'library'], { resume, played: visiblePlayed, readInitialArchive })
            }
            const resumePromise = captureMediaRead(
                () => retryOnceOnTransient(() => client.readResume(secret.accessToken, secret.userId, signal), signal),
                signal,
                { baseUrl: secret.baseUrl },
            ).then(value => {
                resume = value
                publishPartial()
                return value
            })
            const playedPromise = captureMediaRead(() => client.readPlayed(secret.accessToken, secret.userId, signal, snapshot => {
                played = { status: 'success', data: snapshot, checkedAt: Date.now() }
                observedHead = snapshot
                publishPartial()
            }, headSecondPageLikely(), HEAD_PAGE_RETRIES), signal, { baseUrl: secret.baseUrl }).then(value => {
                played = value
                observedHead = value.status === 'success' ? value.data : undefined
                publishPartial()
                return value
            })
            const [resolvedResume, resolvedPlayed] = await Promise.all([resumePromise, playedPromise])
            resume = resolvedResume
            played = resolvedPlayed
            if (played.status === 'success') {
                lastFullHeadAt.set(headKey, Date.now())
                // A mutation marked during this read is newer and stays pending.
                if (forcedFull !== undefined && forceFullHeadAt.get(headKey) === forcedFull) forceFullHeadAt.delete(headKey)
            }
            const rawItems = libraryItems({ resume, played })
            const previousItems = libraryItems(previous)
            const resolveSeries = () => resolveJellyfinSeries(rawItems, readParentItem, signal, previousItems, SERIES_LOOKUPS_PER_PASS, id => parentSeries.has(keyOf(id)), seriesBatch)
            let offset = 0
            for (const read of [resume, played]) {
                if (read.status !== 'success') continue
                const length = read.data.items.length
                read.data = { ...read.data, items: rawItems.slice(offset, offset + length) }
                offset += length
            }
            const persisted = persistScope ? observedLibraryReads({ resume, played }) : null
            if (persistScope && persisted) persistHeadObservation(job, persistScope, persisted)
            const initial = { resume, played, readInitialArchive }
            // The head is valid playback data on its own. Resolve parent-series
            // provider IDs after publishing it so Activity can render immediately;
            // the enrichment only changes canonical identity/poster fields.
            void resolveSeries().then(items => {
                if (signal.aborted || !persistScope || !cacheJobIsCurrent(job, persistScope)) return
                if (items === rawItems) return
                const latest = mediaQueries.getQueryData<LibraryReads>([...job.queryKey, 'library'])
                if (!latest) return
                // Do not let a slower enrichment from an older read replace a
                // newer head that was published after a refresh.
                if (latest.played.status === 'success' && played.status === 'success'
                    && latest.played.checkedAt !== played.checkedAt) return
                if (latest.resume.status === 'success' && resume.status === 'success'
                    && latest.resume.checkedAt !== resume.checkedAt) return
                let nextOffset = 0
                const next: LibraryReads = { ...latest }
                for (const key of ['resume', 'played'] as const) {
                    const read = next[key]
                    if (read.status !== 'success') continue
                    const length = read.data.items.length
                    next[key] = { ...read, data: { ...read.data, items: items.slice(nextOffset, nextOffset + length) } }
                    nextOffset += length
                }
                mediaQueries.setQueryData([...job.queryKey, 'library'], next)
                const enriched = observedLibraryReads(next)
                if (enriched && persistScope) persistHeadObservation(job, persistScope, enriched)
            }).catch(() => { /* metadata enrichment is optional; the head remains usable */ })
            return initial
        },
    })), combine }, mediaQueries)
    // Full-history archive walk: the 60s poll above only refreshes the head,
    // so the complete listing (and deletion reconciliation) happens here — on
    // first load, at a bounded cadence, on manual refresh, and whenever the
    // head stops reconciling with the retained archive. Pages publish
    // progressively (inProgress snapshots) so history is usable mid-walk.
    const archive = useQueries({ queries: jobs.map((job, i) => ({
        queryKey: [...job.queryKey, 'archive'],
        // Wait for the head: the reuse check below needs it, and a reload with
        // a fresh reconciling cache then skips the walk entirely.
        // A resume-only partial must not start a duplicate full-history walk;
        // wait until the played head has either succeeded or failed.
        // Head-only consumers keep the walk disabled unless the server
        // rejected DatePlayed sorting: then the head order is arbitrary and
        // only the archive can answer for the latest-watched row.
        enabled: (!!library.data[i]
            && library.data[i].played.status !== 'waiting'
            && (library.data[i].played.status !== 'success' || library.data[i].played.data.inProgress !== true))
            && (archiveEnabled || headSortRejected(library.data[i].played))
            && documentVisible,
        refetchInterval: job.connection.status === 'expired' ? false : (query: { state: { status: string; data?: MediaRead<JellyfinItemResult> } }) => {
            const data = query.state.data
            const stranded = query.state.status === 'error' || (data?.status === 'success' && data.data.inProgress === true)
            const failureKey = archiveScopeKey(job)
            const failures = archiveFailures.get(failureKey)
            // TanStack restarts the timer whenever the interval value changes, so the jitter
            // must be stable across renders or head polls postpone the walk indefinitely.
            return archiveRefetchDelay(failures, Date.now(), stableRandom(`${failureKey}|${failures?.failures ?? 0}|${stranded}`), stranded)
        },
        staleTime: ARCHIVE_STALE_MS,
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
            const scopeKey = archiveScopeKey(job)
            const forceRefresh = archiveForceRefreshAt.get(scopeKey)
            if (forceRefresh) archiveForceRefreshAt.delete(scopeKey)
            // Failure budget spent: no automatic request until visibility, a
            // user refresh or the breaker cap re-arms this scope.
            const failedRead = archiveFailureReads.get(scopeKey)
            if (!forceRefresh && failedRead && archiveBreakerOpen(archiveFailures.get(scopeKey), Date.now())) return failedRead
            const secret = await openJellyfinSecret(job.connection, value => decrypt(value, job.encryptionKey))
            signal.throwIfAborted()
            const client = createJellyfinClient(secret.baseUrl, { deviceId: secret.deviceId })
            const archiveKey = [...job.queryKey, 'archive']
            const libraryNow = mediaQueries.getQueryData<LibraryReads>([...job.queryKey, 'library'])
            const headNow = libraryNow?.played
            const priorArchive = mediaQueries.getQueryData<JellyfinMediaReads['played']>(archiveKey)
            const scope = mediaScopeFor(job)
            const settled = getSettledArchive(scopeKey)
            if (!forceRefresh && settled
                && headNow?.status === 'success'
                && Date.now() - settled.checkedAt < archiveReuseWindow(headNow.data, settled.data, ARCHIVE_REUSE_WINDOW_MS)
                && playedReadsReconcile(headNow.data, settled.data)) {
                return settled
            }
            if (scope && !priorArchive) {
                // A fresh persisted walk that still reconciles with the live
                // head is provably current: reuse it instead of re-walking
                // thousands of rows on a fresh mount. A settled query must
                // walk again when explicitly refreshed or invalidated; reusing
                // the same stored archive there would swallow manual refreshes.
                // Bounded cache reuse, never a cap: any
                // divergence (e.g. cached total 1 vs head total 2027) falls
                // through to a full walk. The hydration already paid one
                // IndexedDB read and decrypt for this observation, so prefer
                // its archive over a second storage round trip; an archive this
                // session persisted after hydration is newer and wins.
                const hydratedRead = restoredMediaCache.epoch === epoch(job.encryptionKey)
                    ? restoredMediaCache.reads.get(restorationKeyForJob(job))?.archive
                    : undefined
                const hydratedObservation = hydratedRead?.status === 'success' ? observedArchiveRead(hydratedRead) : undefined
                let storedArchive = preferHydratedArchive(hydratedObservation, lastPersistedArchiveAt.get(scopeKey))
                    ? hydratedObservation
                    : undefined
                if (!storedArchive) {
                    const stored = await loadMediaObservation(job.storage, { decrypt: sealed => decrypt(sealed, job.encryptionKey) }, scope)
                    signal.throwIfAborted()
                    storedArchive = stored?.archive
                }
                if (storedArchive
                    && headNow?.status === 'success'
                    && Date.now() - storedArchive.checkedAt < archiveReuseWindow(headNow.data, archiveResultOf(storedArchive), ARCHIVE_STALE_MS)
                    && playedReadsReconcile(headNow.data, archiveResultOf(storedArchive))) {
                    const storedRead: SettledArchiveRead = { status: 'success', data: archiveResultOf(storedArchive), checkedAt: storedArchive.checkedAt }
                    setSettledArchive(scopeKey, storedRead)
                    return storedRead
                }
                // A stale or non-reconciling persisted archive still outranks a
                // partial or failed walk on screen; only a settled walk replaces it.
                if (storedArchive) setSettledArchive(scopeKey, { status: 'success', data: archiveResultOf(storedArchive), checkedAt: storedArchive.checkedAt })
            }
            const resolvedSoFar: JellyfinItem[] = []
            let lastProgressPublish = 0
            const onProgress: JellyfinPagedReadOptions['onProgress'] = async snapshot => {
                // Publish the raw page immediately. Resolving parent-series
                // provider IDs after every page serialized the archive walk
                // behind remote metadata requests and made a large history
                // appear much slower than the other platform snapshots. The
                // pages are invisible while the initial archive is loading and
                // settled snapshots hide them during refresh, so coalesce the
                // cache publications to avoid rerunning the full history/feed
                // derivation for every 250-item page.
                const page = snapshot.items.slice(resolvedSoFar.length)
                resolvedSoFar.push(...page)
                // A settled archive shields consumers during refreshes. Keep
                // collecting pages for the read itself, but do not publish
                // invisible intermediate snapshots that would still trigger
                // Activity/Metrics derivations.
                if (settled) return
                const now = performance.now()
                if (now - lastProgressPublish < 750) return
                lastProgressPublish = now
                const partial: JellyfinMediaReads['played'] = { status: 'success', data: { ...snapshot, items: [...resolvedSoFar] }, checkedAt: Date.now() }
                mediaQueries.setQueryData(archiveKey, partial)
            }
            // Only the first cold walk may continue its just-fetched head. Later
            // refreshes and failed walks always request every page live again.
            const read = await captureMediaRead(() => !priorArchive && libraryNow?.readInitialArchive
                ? libraryNow.readInitialArchive(onProgress, signal)
                : client.readAllPlayed(secret.accessToken, secret.userId, { onProgress, pageRetries: ARCHIVE_PAGE_RETRIES, ...archiveWalkOptions(job) }, signal), signal, { baseUrl: secret.baseUrl })
            // A fresh walk changes what the head probe may stand in for: the
            // next head read must be full so the merge cannot argue from a
            // prefix the walk just invalidated.
            forceFullHeadAt.set(headScopeKey(job), Date.now())
            if (read.status === 'success') {
                // The paged archive is valid playback data before parent-series
                // identity enrichment. Settle it immediately so Activity and
                // Metrics do not wait behind up to 32 extra metadata requests.
                // Enrichment updates the same query afterward and improves
                // cross-platform identity without delaying the first render.
                setSettledArchive(archiveScopeKey(job), read)
                const persistScope = mediaScopeFor(job)
                const persistedArchive = persistScope ? observedArchiveRead(read) : undefined
                if (persistScope && persistedArchive) {
                    lastPersistedArchiveAt.set(scopeKey, persistedArchive.checkedAt)
                    void persistMediaSections(job, persistScope, { archive: persistedArchive })
                }
                const archiveItems = read.data.items
                const { readItem: readParentItem, batch: seriesBatch } = seriesResolutionFor(job, secret, client)
                const keyOf = parentSeriesKeys(job, secret.userId)
                void resolveJellyfinSeries(archiveItems, readParentItem, signal, [
                    ...libraryItems(libraryNow),
                    ...(priorArchive?.status === 'success' ? priorArchive.data.items : []),
                ], SERIES_LOOKUPS_PER_PASS, id => parentSeries.has(keyOf(id)), seriesBatch).then(resolved => {
                    if (signal.aborted || resolved === archiveItems) return
                    const latest = mediaQueries.getQueryData<JellyfinMediaReads['played']>(archiveKey)
                    if (latest?.status === 'success' && latest.data.inProgress === true) return
                    if (latest?.status === 'success' && latest.checkedAt !== read.checkedAt) return
                    const enriched: JellyfinMediaReads['played'] = { ...read, data: { ...read.data, items: resolved } }
                    setSettledArchive(archiveScopeKey(job), enriched)
                    mediaQueries.setQueryData(archiveKey, enriched)
                    const latestScope = mediaScopeFor(job)
                    const observed = latestScope ? observedArchiveRead(enriched) : undefined
                    if (latestScope && observed) void persistMediaSections(job, latestScope, { archive: observed })
                }).catch(() => { /* parent identity enrichment is optional */ })
            }
            // A failed walk never stays the final state: retry with backoff.
            if (read.status === 'success') {
                archiveFailures.delete(scopeKey)
                archiveFailureReads.delete(scopeKey)
            } else {
                archiveFailures.set(scopeKey, recordArchiveFailure(archiveFailures.get(scopeKey), Date.now()))
                archiveFailureReads.set(scopeKey, read)
            }
            return read
        },
    })), combine }, mediaQueries)
    const sessions = useQueries({ queries: jobs.map(job => ({
        queryKey: [...job.queryKey, 'sessions'], enabled: sessionsEnabled && supportsLiveSessions(job.connection),
        refetchInterval: sessionsEnabled && supportsLiveSessions(job.connection) && job.connection.status !== 'expired'
            ? () => sessionRefetchDelay(sessionsIdleStreak.get(job.connection.id) ?? 0, pageScopeMediaConsumers > 0, job.connection.id)
            : false,
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
            const secret = await openJellyfinSecret(job.connection, value => decrypt(value, job.encryptionKey))
            signal.throwIfAborted()
            const client = createJellyfinClient(secret.baseUrl, { deviceId: secret.deviceId })
            const read = await captureMediaRead(() => client.readSessions(secret.accessToken, secret.userId, signal), signal, { baseUrl: secret.baseUrl })
            if (read.status !== 'success') return read
            sessionsIdleStreak.set(job.connection.id, read.data.length > 0 ? 0 : (sessionsIdleStreak.get(job.connection.id) ?? 0) + 1)
            if (read.data.length === 0) return read
            const keyOf = parentSeriesKeys(job, secret.userId)
            const rawItems = read.data.flatMap(session => session.NowPlayingItem ? [session.NowPlayingItem] : [])
            const { readItem: readParentItem, batch: seriesBatch } = seriesResolutionFor(job, secret, client)
            const sessionsKey = [...job.queryKey, 'sessions']
            // Live rows publish first with the parent identities already known;
            // the enrichment only refines identity and poster fields.
            const knownItems = applyKnownParents(rawItems, parentSeries, keyOf)
            if (knownItems !== rawItems) {
                const byId = new Map(knownItems.map(item => [item.Id, item]))
                read.data = read.data.map((session): JellyfinSession => ({ ...session, NowPlayingItem: byId.get(session.NowPlayingItem?.Id) || session.NowPlayingItem }))
            }
            const priorSessions = mediaQueries.getQueryData<JellyfinMediaReads['sessions']>(sessionsKey)
            const priorItems = priorSessions?.status === 'success'
                ? priorSessions.data.flatMap(session => session.NowPlayingItem ? [session.NowPlayingItem] : [])
                : []
            void resolveJellyfinSeries(rawItems, readParentItem, signal, priorItems, 8, undefined, seriesBatch).then(resolved => {
                if (signal.aborted || resolved === rawItems) return
                // A late enrichment never overwrites a newer poll.
                const latest = mediaQueries.getQueryData<JellyfinMediaReads['sessions']>(sessionsKey)
                if (latest?.status !== 'success' || latest.checkedAt !== read.checkedAt) return
                const byId = new Map(resolved.map(item => [item.Id, item]))
                const next: JellyfinMediaReads['sessions'] = {
                    status: 'success',
                    checkedAt: latest.checkedAt,
                    data: latest.data.map((session): JellyfinSession => ({ ...session, NowPlayingItem: byId.get(session.NowPlayingItem?.Id) || session.NowPlayingItem })),
                }
                mediaQueries.setQueryData<JellyfinMediaReads['sessions']>(sessionsKey, next)
            }).catch(() => { /* session identity enrichment is optional */ })
            return read
        },
    })), combine }, mediaQueries)
    // Session polls update live playback independently of the library/archive.
    // Keep the played union stable until one of its own inputs changes.
    const composeMemoRef = useRef<ReturnType<typeof createPlayedComposeMemo> | null>(null)
    if (!composeMemoRef.current) composeMemoRef.current = createPlayedComposeMemo()
    const stableReadsRef = useRef<Map<string, StableLibraryReads> | null>(null)
    if (!stableReadsRef.current) stableReadsRef.current = new Map()
    const stableReads = stableReadsRef.current
    const composed = useMemo(() => {
        const diagnostics: PlayedComposeTrace[] = []
        const composeMemo = composeMemoRef.current!
        const entries = jobs.map((job, i) => {
            // A restored observation only stands in for a read that is still on
            // its way: once the live result (success OR failure per read) or a
            // query-level error arrives, it replaces the placeholder, so API
            // uncertainty stays honest and no error is ever masked by old data.
            const observation = hydration.reads.get(restorationKeyForJob(job))
            const restored = !library.errors[i] && (!library.data[i] || library.data[i].played?.status === 'waiting') ? observation : undefined
            const keyOf = parentSeriesKeys(job, job.connection.mediaServer!.userId)
            const goodKey = restorationKeyForJob(job)
            // The head and archive settle independently. The archive stays on its
            // last complete listing (settled, else persisted) while its own walk is
            // pending, partial or failed; only a settled live walk replaces it.
            // Known parent ids apply synchronously, so a republished raw read keeps
            // the identity an earlier lookup (or the settled archive) established.
            const settledArchive = getSettledArchive(archiveScopeKey(job))
            const liveHead = library.data[i]?.played
            const liveArchive = archive.data[i]
            const lastGood = lastGoodPlayed.get(goodKey)
            const archiveOptional = !archiveEnabled && !headSortRejected(library.data[i]?.played)
            // Compose keyed on content identities, not read objects: a probe
            // reuses the previous head data and a no-op poll reuses the settled
            // archive, so the memo hits and no consumer re-projects history.
            const composeInputs = [
                liveHead?.status === 'success' ? liveHead.data : liveHead?.status,
                restored?.played?.status === 'success' ? restored.played.data : restored?.played?.status,
                liveArchive?.status === 'success' ? liveArchive.data : liveArchive?.status,
                archive.errors[i],
                archive.fetching[i] === true,
                !!library.data[i],
                settledArchive,
                observation?.archive,
                lastGood,
                archiveOptional,
            ]
            const composedNow = composeMemo(goodKey, composeInputs, () => composeJobPlayed({
                liveHead,
                restoredHead: restored?.played,
                liveArchive,
                archiveErrored: archive.errors[i],
                archiveFetching: archive.fetching[i] === true,
                libraryLoaded: !!library.data[i],
                settledArchive,
                restoredArchive: observation?.archive,
                lastGood,
                waiting,
                known: read => withKnownParents(read, keyOf),
                archiveOptional,
            }))
            // Content-signature gate: a poll whose composed content is unchanged
            // keeps the previous read objects (older checkedAt), so projector
            // caches and every derived history identity survive it; a real
            // change adopts the fresh objects immediately. The cache is keyed
            // by the same subject-scoped key as the compose memo, so it never
            // crosses accounts, vault epochs, users or servers.
            const stable = stableReads.get(goodKey)
            const played = stableRead(stable?.played, composedNow.played)
            const historyPlayed = composedNow.historyPlayed === composedNow.played ? played : stableRead(stable?.historyPlayed, composedNow.historyPlayed)
            const resume = stableRead(stable?.resume, withKnownParents(library.data[i]?.resume || restored?.resume || waiting, keyOf))
            setBounded(stableReads, goodKey, { resume, played, historyPlayed }, archiveCacheLimit)
            if (played.status === 'success') setBounded(lastGoodPlayed, goodKey, played, archiveCacheLimit)
            diagnostics.push(playedComposeTrace({ connectionId: job.connection.id, played, liveArchive, settledArchive, restoredArchive: observation?.archive }))
            return {
                accountId: job.accountId, connection: job.connection,
                reads: {
                    resume,
                    played,
                } satisfies LibraryReads,
                historyPlayed,
                error: library.errors[i] ? 'Could not unlock this connection. Reconnect to this server and user to restore access.' : '',
            }
        })
        return { entries, diagnostics }
    }, [jobs, library.data, library.errors, archive.data, archive.errors, archive.fetching, hydration, archiveEnabled, stableReads])
    const libraryResults = composed.entries
    // Diagnostics are an external side effect: emitted after commit, once per change.
    useEffect(() => {
        for (const entry of composed.diagnostics) if (dedupeTrace(composeTraceSeen, entry)) trace('jf-media', 'played.compose', entry as unknown as Record<string, unknown>)
    }, [composed])
    const results = useMemo(() => libraryResults.map((result, i) => ({
        ...result,
        reads: { ...result.reads, sessions: sessions.data[i] || waiting } satisfies JellyfinMediaReads,
        error: result.error || (sessions.errors[i] ? 'Could not unlock this connection. Reconnect to this server and user to restore access.' : ''),
    })), [libraryResults, sessions.data, sessions.errors])
    useEffect(() => {
        for (const result of results) {
            const failure = jellyfinConnectionReadFailure(result.reads)
            const connection = result.connection
            if (!failure || connection.status === failure.status && connection.lastError === failure.message) continue
            const session = {
                credentials: connection.credentials.jellyfin, userId: connection.mediaServer!.userId,
                serverId: connection.mediaServer?.serverId, checkedAt: failure.checkedAt, startedAt: failure.startedAt,
            }
            if (!canApplyMediaReadFailure(connection, session)) continue
            void useConnectionStore.getState().updateConnection(result.accountId, connection.id, {
                status: failure.status, lastError: failure.message, lastErrorAt: failure.checkedAt,
            }, session).catch(() => {})
        }
    }, [results])
    // Head/archive reconciliation: when the fresh head stops reconciling with
    // the retained archive (new watches grew the total, deletions or reorders
    // changed the head region), re-walk the archive soon instead of waiting
    // for the cadence — cooldown-bounded so a persistently divergent upstream
    // cannot loop the walk.
    useEffect(() => {
        for (let i = 0; i < jobs.length; i++) {
            const head = library.data[i]?.played
            const full = archive.data[i]
            if (head?.status !== 'success' || full?.status !== 'success' || full.data.inProgress || archive.fetching[i]) continue
            const key = restorationKeyForJob(jobs[i])
            const now = Date.now()
            const decision = archiveRewalkDue({ head: head.data, archive: full.data, archiveCheckedAt: full.checkedAt, prior: archiveReconcileAt.get(key), now })
            if (!decision.due) continue
            archiveReconcileAt.set(key, { at: now, signature: decision.signature, archiveCheckedAt: full.checkedAt })
            void mediaQueries.invalidateQueries({ queryKey: [...jobs[i].queryKey, 'archive'] })
        }
    }, [jobs, library.data, archive.data, archive.fetching])
    const refresh = useCallback(() => {
        for (const job of jobs) {
            archiveForceRefreshAt.set(archiveScopeKey(job), Date.now())
            forceFullHeadAt.set(headScopeKey(job), Date.now())
            void mediaQueries.invalidateQueries({ queryKey: job.queryKey })
        }
    }, [jobs])
    const busy = jobs.some((_, i) => library.fetching[i] || sessions.fetching[i] || archive.fetching[i])
    // Media reads count as initial-loading until the fresh fetch resolves OR
    // the persisted observation hydration for this vault epoch settles, so
    // consumers can gate on it instead of flashing another platform's title.
    const hydrationPending = jobs.some(job => hydration.epoch !== vaultEpoch || !hydration.completed.has(restorationKeyForJob(job)))
    const initialLoading = jobs.some((_, i) => (library.pending[i] && library.fetching[i]) || (sessions.pending[i] && sessions.fetching[i])) || hydrationPending
    return { results, refresh, busy, initialLoading }
}
