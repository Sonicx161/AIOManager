import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import type { ActivityItem } from '@/types/activity'
import type { EventRollups } from '@/lib/watch-event-rollups'
import { cumulativeWatchKey } from '@/lib/activity-utils'
import { buildRuntimeIndex, mediaResumePositionMs, type RuntimeIndex } from '@/lib/watch-hours'
import { createItemsFingerprintMemo } from '@/lib/metrics-fingerprint'
import { useSyncStore } from '@/store/syncStore'
import { useAuthStore } from '@/store/authStore'
import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'

/** The only row fields the metrics worker reads or the page renders from its results. */
export type MetricsWorkerItem = Pick<ActivityItem,
    'id' | 'name' | 'type' | 'timestamp' | 'watched' | 'overallTimeWatched' | 'accountId' | 'accountName'
    | 'progress' | 'itemId' | 'poster' | 'season' | 'episode' | 'backfill' | 'importedSavedState' | 'duration'
> & { counterKey: string; mediaServer: boolean; mediaPlayed: boolean; mediaPositionMs: number }

export function toMetricsWorkerItem(item: ActivityItem, canonical?: ReadonlyMap<string, string | undefined>): MetricsWorkerItem {
    const mediaPlayed = !!item.mediaObservation && (item.mediaObservation.kind === 'played' || (item.flaggedWatched ?? 0) > 0)
    return {
        id: item.id,
        name: item.name,
        type: item.type,
        timestamp: item.timestamp,
        watched: item.watched,
        overallTimeWatched: item.overallTimeWatched,
        accountId: item.accountId,
        accountName: item.accountName,
        progress: item.progress,
        itemId: item.itemId,
        poster: item.poster,
        season: item.season,
        episode: item.episode,
        backfill: item.backfill,
        importedSavedState: item.importedSavedState,
        duration: item.duration,
        counterKey: cumulativeWatchKey(item, canonical),
        mediaServer: !!item.mediaObservation,
        mediaPlayed,
        mediaPositionMs: mediaPlayed ? 0 : mediaResumePositionMs(item),
    }
}

interface UserStatsEntry {
    id: string
    name: string
    currentStreak: number
    bestStreak: number
    count: number
    duration: number
    recentHistory: MetricsWorkerItem[]
    bingeDuration: number
    bingeItems: MetricsWorkerItem[]
    avatarChar: string
    rank?: number
}

interface AwardEntry {
    id: string
    name: string
    count: number
}

interface CompletionEntry {
    id: string
    name: string
    rate: number
    finishes: number
}

interface SharedUniverseEntry {
    item: MetricsWorkerItem
    count: number
    accounts: { id: string; name: string; count: number; firstWatched: Date }[]
    firstSeen: Date
    lastSeen: Date
}

interface VelocityEntry {
    item: MetricsWorkerItem
    days: number
    episodes: number
    velocity: number
}

interface PersonaBadge {
    type: string
    icon: string
    color: string
}

interface PersonaEntry {
    id: string
    name: string
    badges: PersonaBadge[]
}

interface TraitMeta {
    label: string
    icon: string
    color: string
}

interface TraitEntry {
    id: string
    name: string
    chronotype: TraitMeta
    formatLoyalty: TraitMeta
}

interface FranchiseEntry {
    name: string
    count: number
}

interface TopAllTimeEntry {
    count: number
    item: MetricsWorkerItem
    shared: boolean
}

export interface MetricsResult {
    totalItems: number
    totalHours: number
    estimatedHours: number
    leaderboard: UserStatsEntry[]
    bingeMasters: UserStatsEntry[]
    streakMasters: UserStatsEntry[]
    topTrending: MetricsWorkerItem[]
    topAllTime: TopAllTimeEntry[]
    funnel: { started: number; engaged: number; finished: number }
    abandonedSeries: MetricsWorkerItem[]
    abandonedMovies: MetricsWorkerItem[]
    awards: { midnightSnackers: AwardEntry[]; weekendWarriors: AwardEntry[]; completionChampions: CompletionEntry[] }
    itemsByHour: number[]
    sharedUniverse: SharedUniverseEntry[]
    contentVelocity: VelocityEntry[]
    typeCounts: { movie: number; series: number; other: number }
    seriesLoyalty: number
    userPersonas: PersonaEntry[]
    userTraits: TraitEntry[]
    franchiseFocus: FranchiseEntry[]
    rareFinds: MetricsWorkerItem[]
    streakMap: number[]
    topPilot: UserStatsEntry | null
    theLoop: TopAllTimeEntry | null
    maxActivityHour: number
    weekOverWeek: number
    thisWeekCount: number
    lastWeekCount: number
    firstWatch: { item: MetricsWorkerItem; date: Date } | null
    dailyActivity: Record<string, number>
    sessionDepths: { label: string; count: number }[]
    weeklyRhythm: number[]
    comebackTitles: { name: string; gap: number; poster: string }[]
    dropOffAvg: number
    _error?: boolean
    _message?: string
}

const METRICS_WORKER_TIMEOUT_MS = 30000
const METRICS_CACHE_MAX_ENTRIES = 3
const METRICS_CACHE_TTL_MS = 10 * 60_000

export type MetricsViewState = 'skeleton' | 'error' | 'ready'

/** Skeletons only when there is nothing valid to show; a recompute keeps the previous stats on screen. */
export function metricsViewState(stats: MetricsResult | null, isComputing: boolean): MetricsViewState {
    if (!stats) return 'skeleton'
    if (stats._error) return isComputing ? 'skeleton' : 'error'
    return 'ready'
}

const vaultKeyEpochs = new WeakMap<object, number>()
let nextVaultKeyEpoch = 1

/** Identity of the signed-in session a result belongs to; any change makes cached numbers unreachable. */
export function metricsCacheScope(session: { workspaceId: string; authId: string; authenticated: boolean; vaultKey: object | null }): string {
    let epoch = 0
    if (session.vaultKey) {
        epoch = vaultKeyEpochs.get(session.vaultKey) ?? nextVaultKeyEpoch++
        vaultKeyEpochs.set(session.vaultKey, epoch)
    }
    return [session.workspaceId, session.authId, session.authenticated ? 1 : 0, epoch].join('\u0000')
}

function localDayKey(time: number): string {
    const d = new Date(time)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Small LRU bound to one session scope. Reads from another scope reset it; writes from another scope are dropped. */
export function createMetricsResultCache(maxEntries = METRICS_CACHE_MAX_ENTRIES, ttlMs = METRICS_CACHE_TTL_MS) {
    let scope = ''
    const entries = new Map<string, { value: MetricsResult; at: number }>()
    return {
        get(forScope: string, key: string, now = Date.now()): MetricsResult | undefined {
            if (forScope !== scope) {
                scope = forScope
                entries.clear()
                return undefined
            }
            const hit = entries.get(key)
            if (!hit) return undefined
            // Results are relative to "now" (weekly counts, trending, streaks): bound age and day.
            if (now - hit.at > ttlMs || localDayKey(hit.at) !== localDayKey(now)) {
                entries.delete(key)
                return undefined
            }
            entries.delete(key)
            entries.set(key, hit)
            return hit.value
        },
        put(forScope: string, key: string, value: MetricsResult, now = Date.now()): void {
            if (forScope !== scope || value._error) return
            entries.delete(key)
            entries.set(key, { value, at: now })
            while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string)
        },
        clear(): void {
            entries.clear()
        },
        get size(): number {
            return entries.size
        },
    }
}

const metricsResultCache = createMetricsResultCache()
let cacheInvalidationBound = false

function bindMetricsCacheInvalidation() {
    if (cacheInvalidationBound) return
    cacheInvalidationBound = true
    useSyncStore.subscribe((state, prev) => {
        if (state.auth.id !== prev.auth.id || state.auth.isAuthenticated !== prev.auth.isAuthenticated) metricsResultCache.clear()
    })
    useAuthStore.subscribe((state, prev) => {
        if (state.encryptionKey !== prev.encryptionKey) metricsResultCache.clear()
    })
    subscribeWorkspaceChanges(() => metricsResultCache.clear())
}

function createEmptyMetricsResult(): MetricsResult {
    return {
        totalItems: 0,
        totalHours: 0,
        estimatedHours: 0,
        leaderboard: [],
        bingeMasters: [],
        streakMasters: [],
        topTrending: [],
        topAllTime: [],
        funnel: { started: 0, engaged: 0, finished: 0 },
        abandonedSeries: [],
        abandonedMovies: [],
        awards: { midnightSnackers: [], weekendWarriors: [], completionChampions: [] },
        itemsByHour: new Array(24).fill(0),
        sharedUniverse: [],
        contentVelocity: [],
        typeCounts: { movie: 0, series: 0, other: 0 },
        seriesLoyalty: 0,
        userPersonas: [],
        userTraits: [],
        franchiseFocus: [],
        rareFinds: [],
        streakMap: new Array(30).fill(0),
        topPilot: null,
        theLoop: null,
        maxActivityHour: 0,
        weekOverWeek: 0,
        thisWeekCount: 0,
        lastWeekCount: 0,
        firstWatch: null,
        dailyActivity: {},
        sessionDepths: [],
        weeklyRhythm: new Array(7).fill(0),
        comebackTitles: [],
        dropOffAvg: 0,
    }
}

function createMetricsWorker(): Worker {
    if (import.meta.env.DEV) console.log('[useMetricsWorker] Initializing worker...')
    return new Worker(
        new URL('../workers/metricsWorker.ts', import.meta.url),
        { type: 'module' }
    )
}

// Workers cost a fresh module evaluation per instance, so an idle unmount parks
// its worker here for the next mount instead of terminating it. At most one park.
let parkedMetricsWorker: Worker | null = null

function takeMetricsWorker(): Worker {
    const parked = parkedMetricsWorker
    parkedMetricsWorker = null
    return parked ?? createMetricsWorker()
}

function parkMetricsWorker(worker: Worker): void {
    if (parkedMetricsWorker && parkedMetricsWorker !== worker) parkedMetricsWorker.terminate()
    parkedMetricsWorker = worker
}

// A worker with requests still in flight must never be parked: its stale replies
// would answer a future request (FIFO slot theft) and land in the result cache
// under the wrong key. In-flight means terminate.
export function releaseWorkerAction(pendingCount: number): 'terminate' | 'park' {
    return pendingCount > 0 ? 'terminate' : 'park'
}

// Replies carry the request id they belong to. A reply whose id is not pending
// (straggler from a terminated session, superseded request) must be dropped
// instead of consuming the next FIFO slot.
export function findPendingReplyIndex(pending: ReadonlyArray<{ reqId: number }>, reqId: unknown): number {
    if (typeof reqId !== 'number') return -1
    return pending.findIndex(job => job.reqId === reqId)
}

function getTimestampMs(value: MetricsWorkerItem['timestamp']): number {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
    return Number.isFinite(time) ? time : 0
}

const isSeriesKind = (type: string) => type === 'series' || type === 'anime' || type === 'episode'

/**
 * Rows the worker needs for a period: every in-period row, plus for each cumulative counter
 * the one earlier row that holds its highest value (the baseline later growth is measured
 * from). Other earlier rows never change in-period credit, so they are not sent.
 */
export function selectMetricsRows(
    items: ReadonlyArray<ActivityItem>,
    periodStart: number | null | undefined,
    canonical?: ReadonlyMap<string, string | undefined>,
): ActivityItem[] {
    if (periodStart == null) return items as ActivityItem[]
    const keep = new Uint8Array(items.length)
    const baselines = new Map<string, { index: number; value: number }>()
    let periodRows = 0
    items.forEach((item, index) => {
        const time = getTimestampMs(item.timestamp)
        if (time >= periodStart) {
            keep[index] = 1
            periodRows++
            return
        }
        const value = item.overallTimeWatched
        if (!value || value <= 0 || !isSeriesKind(item.type) || item.mediaObservation || item.backfill || item.importedSavedState) return
        const key = cumulativeWatchKey(item, canonical)
        const best = baselines.get(key)
        if (!best || value > best.value) baselines.set(key, { index, value })
    })
    if (periodRows === 0) return []
    for (const { index } of baselines.values()) keep[index] = 1
    return items.filter((_, index) => keep[index] === 1)
}

// The gate fingerprint lives in '@/lib/metrics-fingerprint' (import-free, testable).

export type MetricsRollupInput = Pick<EventRollups, 'byMonth' | 'daysByAccount'>

function createRollupsFingerprint(rollups: MetricsRollupInput): string {
    let hash = 2166136261

    const mix = (value: unknown) => {
        const text = String(value ?? '')
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
        }
        hash ^= 31
        hash = Math.imul(hash, 16777619)
    }

    const byMonthKeys = Object.keys(rollups.byMonth)
    for (const key of byMonthKeys) {
        mix(key)
        mix(rollups.byMonth[key].count)
        mix(rollups.byMonth[key].minutes)
    }
    for (const [accountId, days] of Object.entries(rollups.daysByAccount)) {
        mix(accountId)
        mix(days.length)
        if (days.length > 0) mix(days[0])
    }

    return `${byMonthKeys.length}-${hash >>> 0}`
}

export interface MetricsWorkerOptions {
    /** Viewer and period selection the items were scoped by; part of the cache key. */
    filterKey?: string
    /** Period cutoff (ms). Items are the viewer's full scope; earlier rows only seed counter credit. */
    periodStart?: number | null
    /** Unfiltered history that title runtimes are taken from, so every period agrees. */
    runtimeSource?: ReadonlyArray<Pick<ActivityItem, 'itemId' | 'duration'>>
}

interface ScopedResult { scope: string; key: string; value: MetricsResult }

/** Runtimes for just the titles in play, with a stable fingerprint for the result cache. */
export function subsetRuntimeIndex(index: RuntimeIndex, itemIds: Iterable<string>): { runtimes: RuntimeIndex; fingerprint: string } {
    const typical = new Map<string, number>()
    const longest = new Map<string, number>()
    let hash = 2166136261
    const mix = (text: string) => {
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i)
            hash = Math.imul(hash, 16777619)
        }
    }
    for (const itemId of new Set(itemIds)) {
        const t = index.typical.get(itemId)
        const l = index.longest.get(itemId)
        if (t === undefined && l === undefined) continue
        if (t !== undefined) typical.set(itemId, t)
        if (l !== undefined) longest.set(itemId, l)
        mix(`${itemId}:${t}:${l};`)
    }
    return { runtimes: { typical, longest }, fingerprint: String(hash >>> 0) }
}

export function pickScopedResult(scoped: ScopedResult | null, scope: string): MetricsResult | null {
    return scoped && scoped.scope === scope ? scoped.value : null
}
interface PendingJob { reqId: number; scope: string; key: string; fullKey: string }

// Request ids are unique per app session so a reply can always be matched to its
// request, even across parked-worker handovers.
let metricsRequestSeq = 0

export function useMetricsWorker(items: ActivityItem[], rollups?: MetricsRollupInput, canonicalConnections?: ReadonlyMap<string, string | undefined>, options?: MetricsWorkerOptions) {
    const filterKey = options?.filterKey ?? ''
    const runtimeSource = options?.runtimeSource
    const periodStart = options?.periodStart ?? null
    const authId = useSyncStore(s => s.auth.id)
    const authenticated = useSyncStore(s => s.auth.isAuthenticated)
    const vaultKey = useAuthStore(s => s.encryptionKey)
    const workspaceId = useSyncExternalStore(subscribeWorkspaceChanges, getActiveWorkspaceId, () => '')
    const scope = metricsCacheScope({ workspaceId, authId, authenticated, vaultKey })
    const rollupsFingerprint = useMemo(() => (rollups ? createRollupsFingerprint(rollups) : ''), [rollups])
    // Post only what the worker reads; whole rows would also clone genres, saved-episode
    // summaries and media observations. The gate fingerprint is derived from the same
    // pass, memoized per source row, so filter/period switches skip re-hashing fields.
    const { workerItems, itemsFingerprint } = useMemo(
        () => {
            const rows = selectMetricsRows(items, periodStart, canonicalConnections)
            const mapped = rows.map(item => toMetricsWorkerItem(item, canonicalConnections))
            return {
                workerItems: mapped,
                itemsFingerprint: createItemsFingerprintMemo(rows, mapped, canonicalConnections, periodStart),
            }
        },
        [items, periodStart, canonicalConnections]
    )
    const runtimeIndex = useMemo(() => buildRuntimeIndex(runtimeSource ?? items), [runtimeSource, items])
    const runtimeSubset = useMemo(() => subsetRuntimeIndex(runtimeIndex, workerItems.map(item => item.itemId)), [runtimeIndex, workerItems])
    const resultKey = useMemo(
        () => (workerItems.length === 0 ? '' : `${filterKey}\u0001${itemsFingerprint}|${rollupsFingerprint}|${runtimeSubset.fingerprint}`),
        [workerItems, filterKey, itemsFingerprint, rollupsFingerprint, runtimeSubset]
    )
    const [scoped, setScoped] = useState<ScopedResult | null>(() => {
        const hit = resultKey ? metricsResultCache.get(scope, resultKey) : undefined
        return hit ? { scope, key: resultKey, value: hit } : null
    })
    const [isComputing, setIsComputing] = useState(false)
    const workerRef = useRef<Worker | null>(null)
    const pendingRef = useRef<PendingJob[]>([])
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const lastKeyRef = useRef('')
    const rollupsRef = useRef(rollups)
    rollupsRef.current = rollups
    const runtimesRef = useRef(runtimeSubset.runtimes)
    runtimesRef.current = runtimeSubset.runtimes

    // A result from another session is never returned, even for the render in which the scope changed.
    const results = pickScopedResult(scoped, scope)
    // True only when the result on hand was computed for exactly the current inputs.
    const isCurrent = !!scoped && scoped.scope === scope && scoped.key === resultKey

    useEffect(() => {
        bindMetricsCacheInvalidation()
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            timeoutRef.current = null
            // In-flight unmount: terminate, never park (a parked straggler reply
            // would be mis-matched by the next mount's request).
            if (workerRef.current) {
                if (releaseWorkerAction(pendingRef.current.length) === 'terminate') workerRef.current.terminate()
                else parkMetricsWorker(workerRef.current)
            }
            workerRef.current = null
            pendingRef.current = []
            lastKeyRef.current = ''
        }
    }, [])

    useEffect(() => {
        const dropWorker = () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            timeoutRef.current = null
            if (workerRef.current) {
                if (releaseWorkerAction(pendingRef.current.length) === 'terminate') workerRef.current.terminate()
                else parkMetricsWorker(workerRef.current)
            }
            workerRef.current = null
            pendingRef.current = []
        }

        if (workerItems.length === 0) {
            dropWorker()
            lastKeyRef.current = ''
            setScoped({ scope, key: resultKey, value: createEmptyMetricsResult() })
            setIsComputing(false)
            return
        }

        const fullKey = `${scope}\u0002${resultKey}`
        if (fullKey === lastKeyRef.current) return
        lastKeyRef.current = fullKey

        const cached = metricsResultCache.get(scope, resultKey)
        if (cached) {
            // Responses still in flight belong to other keys; drop them with the worker.
            dropWorker()
            setScoped({ scope, key: resultKey, value: cached })
            setIsComputing(false)
            return
        }

        const armTimeout = () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            timeoutRef.current = pendingRef.current.length === 0 ? null : setTimeout(() => {
                const failed = pendingRef.current[pendingRef.current.length - 1]
                if (import.meta.env.DEV) console.error('[useMetricsWorker] Worker timeout - terminating and restarting')
                dropWorker()
                lastKeyRef.current = ''
                setIsComputing(false)
                if (failed) setScoped({ scope: failed.scope, key: failed.key, value: { _error: true, _message: `Metrics calculation timed out after ${METRICS_WORKER_TIMEOUT_MS / 1000}s.` } as MetricsResult })
            }, METRICS_WORKER_TIMEOUT_MS)
        }

        if (!workerRef.current) {
            const worker = takeMetricsWorker()
            workerRef.current = worker
            worker.onmessage = (e) => {
                if (workerRef.current !== worker) return
                // Match the reply to its request by id. A reply with no pending
                // request is a straggler (parked worker reuse, superseded mount)
                // and must be dropped, never cached or shown.
                const jobIndex = findPendingReplyIndex(pendingRef.current, (e.data as { reqId?: unknown } | null)?.reqId)
                if (jobIndex === -1) return
                const job = pendingRef.current.splice(jobIndex, 1)[0]
                armTimeout()
                // A null result (empty in-period rows) flows to the cache/screen
                // exactly as before; it keeps the skeleton edge behavior unchanged.
                const result = ((e.data as { result?: MetricsResult | null }).result ?? null) as MetricsResult
                metricsResultCache.put(job.scope, job.key, result)
                // Only the newest request may reach the screen; older responses just warm the cache.
                if (job.fullKey !== lastKeyRef.current) return
                setScoped({ scope: job.scope, key: job.key, value: result })
                setIsComputing(false)
            }
            worker.onerror = (e) => {
                if (workerRef.current !== worker) return
                if (import.meta.env.DEV) console.error('[useMetricsWorker] Worker error:', e)
                const failed = pendingRef.current[pendingRef.current.length - 1]
                dropWorker()
                lastKeyRef.current = ''
                setIsComputing(false)
                if (failed) setScoped({ scope: failed.scope, key: failed.key, value: { _error: true, _message: 'Metrics worker crashed.' } as MetricsResult })
            }
        }

        const reqId = ++metricsRequestSeq
        pendingRef.current.push({ reqId, scope, key: resultKey, fullKey })
        armTimeout()
        setIsComputing(true)
        workerRef.current.postMessage({ reqId, items: workerItems, periodStart, rollups: rollupsRef.current, runtimes: runtimesRef.current })
    }, [workerItems, periodStart, rollupsFingerprint, scope, resultKey])

    return { results, isComputing, isCurrent, scope }
}
