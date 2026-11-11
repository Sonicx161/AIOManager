import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import type { ActivityItem } from '@/types/activity'
import type { EventRollups } from '@/lib/watch-event-rollups'
import { cumulativeWatchKey } from '@/lib/activity-utils'
import { buildRuntimeIndex, mediaResumePositionMs, runtimeIndexFingerprint, type RuntimeIndex } from '@/lib/watch-hours'
import { createIsolatedItemsFingerprintMemo, createItemsFingerprintMemo } from '@/lib/metrics-fingerprint'
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

export { workerSupersedeAction, type WorkerSupersedeAction } from '@/lib/metrics-fingerprint'

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
        for (const day of days) mix(day)
    }

    return `${byMonthKeys.length}-${hash >>> 0}`
}

// Data identity of the whole viewer history, independent of viewer/period
// selection: rows hashed through the real worker transform in a memo isolated
// from the result-key cache, plus canonical attribution and all rollup days.
const sourceIdentityMemo = createIsolatedItemsFingerprintMemo()

export function createMetricsSourceIdentity(
    history: ReadonlyArray<ActivityItem>,
    rollups: MetricsRollupInput | undefined,
    canonical: ReadonlyMap<string, string | undefined> | undefined,
): string {
    const mapped = history.map(item => toMetricsWorkerItem(item, canonical))
    return `${sourceIdentityMemo(history, mapped, canonical, null)}|${rollups ? createRollupsFingerprint(rollups) : ''}`
}

export interface MetricsWorkerOptions {
    /** Viewer and period selection the items were scoped by; part of the cache key. */
    filterKey?: string
    /** Period cutoff (ms). Items are the viewer's full scope; earlier rows only seed counter credit. */
    periodStart?: number | null
    /** Unfiltered history that title runtimes are taken from, so every period agrees. */
    runtimeSource?: ReadonlyArray<Pick<ActivityItem, 'itemId' | 'duration'>>
    /** Selection-independent identity of the source data (full history, canonical attribution, rollups). */
    sourceIdentity?: string
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

/**
 * Whether a freshly settled worker result may be committed to the screen. A result
 * computed for the current session/workspace commits even when its key is no longer
 * current — the page marks it refreshing while newer data is queued — so sustained
 * live churn always shows visible progress instead of an empty view. A result from
 * another scope never commits (the caller only sees results of the current scope).
 */
export function metricsCommitGate(latest: MetricsResult | null | undefined, dataSettled: boolean): boolean {
    return !!latest && dataSettled
}
interface PendingJob { reqId: number; scope: string; key: string; fullKey: string }

/** A whole request as one coherent unit: identity plus the exact payload to compute. */
interface PendingRequestSnapshot {
    scope: string
    key: string
    fullKey: string
    dataKey: string
    items: MetricsWorkerItem[]
    periodStart: number | null
    rollups: MetricsRollupInput | undefined
    runtimes: RuntimeIndex
}

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
    // Supersession identity: selection-independent source data (full history
    // through the real transform, canonical attribution, rollups, runtime index)
    // plus the session scope. Viewer and period selection stay out of it, so a
    // selection change never discards in-flight work while a data change does.
    const runtimeFullFingerprint = runtimeIndexFingerprint(runtimeIndex)
    const dataKey = options?.sourceIdentity
        ? `${scope}\u0000${options.sourceIdentity}|${runtimeFullFingerprint}`
        : `${scope}\u0000${itemsFingerprint}|${rollupsFingerprint}|${runtimeFullFingerprint}`
    const [scoped, setScoped] = useState<ScopedResult | null>(() => {
        const hit = resultKey ? metricsResultCache.get(scope, resultKey) : undefined
        return hit ? { scope, key: resultKey, value: hit } : null
    })
    const [isComputing, setIsComputing] = useState(false)
    const workerRef = useRef<Worker | null>(null)
    const pendingRef = useRef<PendingJob[]>([])
    const deferredRef = useRef<PendingRequestSnapshot | null>(null)
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const lastKeyRef = useRef('')
    // The scope the reply handler publishes for. Idle workers survive scope
    // transitions (they are reused across mounts), so the handler must read the
    // CURRENT scope from committed state instead of the closure it was created
    // in — otherwise a new scope's results are rejected forever.
    const scopeRef = useRef(scope)

    // A result from another session is never returned, even for the render in which the scope changed.
    const results = pickScopedResult(scoped, scope)
    // True only when the result on hand was computed for exactly the current inputs.
    const isCurrent = !!scoped && scoped.scope === scope && scoped.key === resultKey

    useEffect(() => {
        bindMetricsCacheInvalidation()
        // Unmount cleanup lives here and only here: terminating an in-flight run
        // belongs to unmount (and to scope switches, worker errors and the
        // timeout — all handled in the request effect below). The request effect
        // itself must not clean up on dependency changes: a dep change while a
        // run is in flight is exactly the live-churn case, and a cleanup here
        // would terminate the busy worker per publication (the treadmill).
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current)
            timeoutRef.current = null
            if (workerRef.current) {
                if (releaseWorkerAction(pendingRef.current.length) === 'terminate') workerRef.current.terminate()
                else parkMetricsWorker(workerRef.current)
            }
            workerRef.current = null
            pendingRef.current = []
            deferredRef.current = null
            lastKeyRef.current = ''
        }
    }, [])

    useEffect(() => {
        // Committed scope for the reply handler (see scopeRef above).
        scopeRef.current = scope
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
        // NOTE: no cleanup on this effect, and none has ever existed here — the
        // treadmill on beta 479a9bd0 and 1cf94767 was the supersede path itself:
        // a data change while a run is in flight terminated the busy worker
        // (beta: immediately per publication; 1cf94767: after a 2.5 s stability
        // window), so live churn restarted the full compute per change. With no
        // cleanup, a dependency change now only reaches the hold path below.
        // Unmount termination lives in the mount effect above; scope switches,
        // errors and the timeout terminate below, explicitly.

        if (workerItems.length === 0) {
            dropWorker()
            deferredRef.current = null
            lastKeyRef.current = ''
            setScoped({ scope, key: resultKey, value: createEmptyMetricsResult() })
            setIsComputing(false)
            return
        }

        const fullKey = `${scope}\u0002${resultKey}`
        if (fullKey === lastKeyRef.current) return
        lastKeyRef.current = fullKey

        // One coherent request snapshot: key, scope, data identity and payload are
        // captured together from committed render state, so a drained held
        // selection can never pair its key with a newer render's payload.
        const snapshot: PendingRequestSnapshot = { scope, key: resultKey, fullKey, dataKey, items: workerItems, periodStart, rollups, runtimes: runtimeSubset.runtimes }

        // A run in flight is never terminated because newer data arrived: killing
        // it restarted the full compute each time (terminate + fresh full-history
        // clone + worker rebuild per publication — the live-churn path that left
        // iOS holding dead worker memory until it jetsammed the tab, and that
        // could starve the page of any finished result forever). The newest
        // snapshot is held instead — at most one in-flight run plus one held
        // snapshot exist, intermediate snapshots never reach postMessage — and
        // when the run finishes its result is published for the current scope
        // (marked refreshing by the page) before the held snapshot starts.
        // Termination is kept only for a scope switch (another workspace/session
        // must never inherit in-flight work), unmount, worker errors and the
        // existing timeout.
        const busyJob = pendingRef.current[0]
        if (workerRef.current && busyJob && busyJob.scope !== scope) {
            // The session/workspace switched: the in-flight run belongs to the
            // previous scope and can never be shown again, and neither can the
            // held snapshot from that scope — discard both, or the new scope
            // would end up running the old scope's work.
            dropWorker()
            deferredRef.current = null
        } else if (workerRef.current && busyJob) {
            deferredRef.current = snapshot
            return
        }

        const cached = metricsResultCache.get(scope, resultKey)
        if (cached) {
            // Idle cached switch: show the stored result without a post. (A cached
            // result behind an in-flight run takes the hold path above; the drain
            // serves it without recompute.)
            deferredRef.current = null
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
                const held = deferredRef.current
                deferredRef.current = null
                if (held && held.scope === scopeRef.current) {
                    // The newest request never ran: restart it with its own
                    // snapshot so the current view keeps computing. If it fails
                    // again, deferredRef is already cleared and the error then
                    // publishes under that held key. A held snapshot from another
                    // scope (a session switched mid-flight) is discarded here —
                    // the failing run was this scope's, so this scope gets its
                    // own error instead of another scope's stale work.
                    ensureWorker()
                    lastKeyRef.current = held.fullKey
                    postSnapshot(held)
                } else {
                    setIsComputing(false)
                    if (failed && failed.scope === scopeRef.current) setScoped({ scope: failed.scope, key: failed.key, value: { _error: true, _message: `Metrics calculation timed out after ${METRICS_WORKER_TIMEOUT_MS / 1000}s.` } as MetricsResult })
                }
            }, METRICS_WORKER_TIMEOUT_MS)
        }

        const postSnapshot = (snap: PendingRequestSnapshot) => {
            const reqId = ++metricsRequestSeq
            pendingRef.current.push({ reqId, scope: snap.scope, key: snap.key, fullKey: snap.fullKey })
            armTimeout()
            setIsComputing(true)
            workerRef.current?.postMessage({ reqId, items: snap.items, periodStart: snap.periodStart, rollups: snap.rollups, runtimes: snap.runtimes })
        }

        const ensureWorker = () => {
            if (workerRef.current) return
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
                // A null result (empty in-period rows) flows to the cache/screen
                // exactly as before; it keeps the skeleton edge behavior unchanged.
                const result = ((e.data as { result?: MetricsResult | null }).result ?? null) as MetricsResult
                metricsResultCache.put(job.scope, job.key, result)
                // Publish first for visible progress: a result computed for the
                // CURRENT session/workspace is shown even when newer data is
                // already queued (the page marks it refreshing while its key is
                // not the current one). A result from another scope is never shown.
                if (job.scope === scopeRef.current) {
                    setScoped({ scope: job.scope, key: job.key, value: result })
                    setIsComputing(false)
                }
                // Then start the newest held snapshot, if any — but only if it
                // belongs to the current scope (a scope switch discards held
                // work, so a stale-scope snapshot never runs here). A held
                // snapshot that is already cached is served without a recompute.
                const deferred = deferredRef.current
                if (pendingRef.current.length === 0 && deferred) {
                    deferredRef.current = null
                    if (deferred.scope !== scopeRef.current) {
                        setIsComputing(false)
                    } else {
                        const hit = metricsResultCache.get(deferred.scope, deferred.key)
                        if (hit) {
                            setScoped({ scope: deferred.scope, key: deferred.key, value: hit })
                            setIsComputing(false)
                        } else {
                            postSnapshot(deferred)
                        }
                    }
                } else {
                    armTimeout()
                }
            }
            worker.onerror = (e) => {
                if (workerRef.current !== worker) return
                if (import.meta.env.DEV) console.error('[useMetricsWorker] Worker error:', e)
                const failed = pendingRef.current[pendingRef.current.length - 1]
                dropWorker()
                lastKeyRef.current = ''
                const held = deferredRef.current
                deferredRef.current = null
                if (held && held.scope === scopeRef.current) {
                    // Resume the newest request of the CURRENT scope with its own
                    // snapshot; if it errors again, deferredRef is already cleared
                    // and the next failure publishes under that held key. A held
                    // snapshot from another scope is discarded — this scope gets
                    // its own error instead of another scope's stale work.
                    ensureWorker()
                    lastKeyRef.current = held.fullKey
                    postSnapshot(held)
                } else {
                    setIsComputing(false)
                    if (failed && failed.scope === scopeRef.current) setScoped({ scope: failed.scope, key: failed.key, value: { _error: true, _message: 'Metrics worker crashed.' } as MetricsResult })
                }
            }
        }

        ensureWorker()
        postSnapshot(snapshot)
        // rollups and runtimes ride the posted snapshot only; their fingerprints already gate reruns
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workerItems, periodStart, rollupsFingerprint, scope, resultKey, dataKey])

    return { results, isComputing, isCurrent, scope }
}
