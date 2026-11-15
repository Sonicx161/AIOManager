import { create } from 'zustand'
import localforage from 'localforage'
import { WatchEvent, SnapshotItem, LibraryItem } from '@/types/activity'
import { Account } from '@/types/account'
import { getSeasonEpisode, isActuallyWatched, isDatelessSavedWatchState, isResumeDismissal, getLocalDayKey, getEpisodeIdentity, watchContextKey, parseScopedAccountId, tombstoneReplayProven } from '@/lib/activity-utils'
import { scopeIndexesFor, reuseScopePartitionedIndexes, stremioTimeOf } from '@/lib/watch-event-indexes'
import { isPlausibleWatchMs, plausibleWatchEventTs } from '@/lib/watch-time'
import { MIN_EVENTS_GLOBAL, hasSeriesEventIdentity } from '@/lib/watch-event-cap'
import { decodeStremioVisibleIndices, hasNoVisibleWatchedBits } from '@/lib/watched-bitfield'
import { mapConcurrent } from '@/lib/concurrency'
import { getCachedResolvedSeriesVideos, resolveSeriesVideos } from '@/lib/stremio-series-resolver'
import { evictLegacyExternalEvents } from '@/lib/external-watch-events'
import { EventRollups, emptyRollups, capWatchEventsWithRollups, mergeRollups } from '@/lib/watch-event-rollups'
import { isIdentityDeleted, isSyntheticBackfillEvent, mergeBackfillDuplicates, mergeBackfillEvent, mergeWatchEventsById } from '@/lib/event-tombstones'
import { aliasIdentityKeys, aliasDeletedAt, canonicalEpisodeIdentity } from '@/lib/activity-id-alias'
import { createBackfillProcessed } from './backfill-processed.ts'

const STORAGE_KEY = 'aio_watch_events_v2'

/** Own-bit results per item; pending lists items whose bit is unknown only because the episode list was not cached. */
export type OwnEpisodeBits = Map<string, boolean> & { pending?: ReadonlySet<string> }

const backfillProcessed = createBackfillProcessed()
type TrustedBackfill = { scope: string; show: string; watched: string; ids: string[]; confirmedAt: number }
const trustedBackfills = new Map<string, TrustedBackfill>()
const backfillRetries = new Map<string, { watched: string; at: number }>()
const TRUSTED_BACKFILL_CAP = 2048
const TRUSTED_BACKFILL_BYTES = 8 * 1024 * 1024
const BACKFILL_RETRY_MS = 60 * 60 * 1000

const syntheticEventsByArray = new WeakMap<WatchEvent[], Map<string, Map<string, WatchEvent[]>>>()

function syntheticEventsByScope(events: WatchEvent[]) {
    const cached = syntheticEventsByArray.get(events)
    if (cached) return cached
    const scopes = new Map<string, Map<string, WatchEvent[]>>()
    for (const event of events) {
        if (!isSyntheticBackfillEvent(event)) continue
        const scope = eventScopeKey(event)
        let shows = scopes.get(scope)
        if (!shows) scopes.set(scope, shows = new Map())
        let entries = shows.get(event.itemId)
        if (!entries) shows.set(event.itemId, entries = [])
        entries.push(event)
    }
    syntheticEventsByArray.set(events, scopes)
    return scopes
}

function rememberTrustedBackfill(key: string, value: TrustedBackfill) {
    trustedBackfills.delete(key)
    trustedBackfills.set(key, value)
    let bytes = 0
    for (const [k, v] of trustedBackfills) bytes += (k.length + v.scope.length + v.show.length + v.watched.length + v.ids.reduce((n, id) => n + id.length, 0)) * 2 + 128
    while (trustedBackfills.size > TRUSTED_BACKFILL_CAP || bytes > TRUSTED_BACKFILL_BYTES) {
        const oldest = trustedBackfills.entries().next().value
        if (!oldest) break
        const [k, v] = oldest
        bytes -= (k.length + v.scope.length + v.show.length + v.watched.length + v.ids.reduce((n, id) => n + id.length, 0)) * 2 + 128
        trustedBackfills.delete(k)
    }
}

function rememberBackfillRetry(key: string, watched: string, at: number) {
    backfillRetries.delete(key)
    backfillRetries.set(key, { watched, at })
    while (backfillRetries.size > TRUSTED_BACKFILL_CAP) backfillRetries.delete(backfillRetries.keys().next().value!)
}
const backfillRevisions = new Map<string, number>()
let backfillRevision = 0

// Snapshot: { [accountId]: { [itemId]: SnapshotItem } }
type Snapshot = Record<string, Record<string, SnapshotItem>>

function isSeriesItem(item: LibraryItem): boolean {
    return item.type === 'series' || item.type === 'anime' || item.type === 'episode'
}

// Series: the watched bitfield (marks on other episodes). Movies: the watched flag and count.
function watchMarkOf(item: LibraryItem): string {
    const s = item.state || {}
    const raw = isSeriesItem(item) ? String(s.watched || '') : `${s.flaggedWatched ?? 0}|${s.timesWatched ?? 0}`
    let hash = 0x811c9dc5
    for (let i = 0; i < raw.length; i++) hash = Math.imul(hash ^ raw.charCodeAt(i), 0x01000193)
    return (hash >>> 0).toString(36)
}

/**
 * Whether a same-episode library write is a real watch of that episode. Stremio keeps
 * video_id on the last played episode when others are marked watched (e.g. synced from
 * another app), and every such write bumps _mtime and lastWatched; those are not plays.
 * An unknown prior is never evidence: a baseline rebuilt from server rows records nothing
 * until a local baseline exists. Otherwise the evidence is the resume position moving; or,
 * with known marks, watch time gained while the marks stayed the same, or this episode's
 * own watched bit turning on (decoded against the series' episode list) as its own time
 * grew. A bit left unknown only because the episode list was not cached (well-formed
 * marks, list missing) does not block that: with own time grown, a known-off or cache-pending
 * prior counts, so a finish between polls is never dropped. A prior unknown for any other
 * reason (malformed marks) stays no evidence. An older local baseline without marks needs
 * watch time gained with lastWatched past it for a series; for a movie any change counts.
 */
function isSameEpisodeWatch(item: LibraryItem, prior: SnapshotItem, watchedDelta: number, ownBit: boolean | undefined): boolean {
    if (prior.fromServer) return false
    if ((item.state?.timeOffset || 0) !== (prior.timeOffset || 0)) return true
    if (prior.watchMark === undefined) {
        if (!isSeriesItem(item)) return true
        return watchedDelta > 0 && (stremioTimeOf(item.state?.lastWatched) ?? 0) > prior.mtime
    }
    const marksChanged = prior.watchMark !== watchMarkOf(item)
    if (!isSeriesItem(item)) return watchedDelta > 0 || marksChanged
    if (!marksChanged) return watchedDelta > 0
    const ownTimeGained = (item.state?.timeWatched || 0) > (prior.timeWatched || 0)
    const priorUsable = prior.ownBit === false || (prior.ownBit === undefined && prior.ownBitPending === true)
    if (!ownTimeGained || !priorUsable) return false
    return ownBit === true || ownBit === undefined
}

function sanitizeSeason(s: number | undefined | null): number | undefined {
    if (s == null) return undefined
    return s > 0 && s <= 100 ? s : undefined
}

function getSeasonEpisodeForVideoId(item: LibraryItem, videoId: string): { season?: number; episode?: number } {
    const { season, episode } = getSeasonEpisode({
        ...item,
        state: {
            ...(item.state || {}),
            video_id: videoId
        }
    })
    return { season: sanitizeSeason(season), episode }
}

interface WatchEventState {
    events: WatchEvent[]
    snapshot: Snapshot
    /** Which connection produced each bare-account snapshot (canonical identity guard). */
    snapshotOwners: Record<string, string>
    deletedEventKeys: Record<string, number>
    rollups: EventRollups
    initialized: boolean

    initialize: (events: WatchEvent[], snapshot: Snapshot, deletedEventKeys?: Record<string, number>, rollups?: EventRollups, snapshotOwners?: Record<string, string>) => void
    load: () => Promise<void>

    removeEvents: (items: Array<{ accountId: string; sourceConnectionId?: string; itemId: string; uniqueItemId?: string; season?: number; episode?: number; type: string }>) => void

    patchSnapshot: (accountId: string, itemId: string, patch: Partial<SnapshotItem>, options?: { contextKey?: string }) => void

    /**
     * Canonical re-point migration (stable-origin model): the demoted login's bare-account
     * state moves to its own `accountId::demotedId` scope, and the PROMOTED login's
     * existing secondary scope (it has one whenever it was bound before promotion) is
     * adopted into the bare scope — events retain their connection stamp while their
     * identity scope changes, tombstones follow, and the promoted login's snapshot becomes the
     * canonical baseline. Historical event ids are never rewritten. Idempotent.
     */
    migrateCanonicalScope: (accountId: string, previousCanonicalId: string, promotedConnectionId?: string) => void

    diffAndRecord: (
        accountId: string,
        items: LibraryItem[],
        account: Account,
        accounts: Account[],
        options?: { contextKey?: string; sourceConnectionId?: string; ownerConnectionId?: string; ownBits?: OwnEpisodeBits }
    ) => WatchEvent[]

    /** Whether each changed series item's own current episode is marked in its watched bitfield (offline data only). */
    resolveOwnEpisodeBits: (items: LibraryItem[], contextKey?: string) => Promise<OwnEpisodeBits>

    mergeServerEvents: (serverEvents: ServerActivityEvent[]) => void
    /** Re-applies tombstones (events and pinned baselines) after new id aliases make more of them match. */
    reapplyTombstones: () => void

    mergeExternalWatchEvents: (accountId: string, platform: string, items: ExternalWatchItem[], options?: { sourceConnectionId?: string }) => void

    recordBackfillEpisodes: (accountId: string, items: LibraryItem[], options?: { contextKey?: string; sourceConnectionId?: string; ownerConnectionId?: string; authKey?: string; completeLibrary?: boolean; libraryIds?: string[] }) => Promise<number>

    export: () => { events: WatchEvent[]; snapshot: Snapshot; deletedEvents: Record<string, number>; rollups: EventRollups }
    reset: () => void
}

export interface ServerActivityEvent {
    id: string
    accountId: string
    accountName: string
    itemId: string
    uniqueItemId: string
    name: string
    type: string
    poster: string
    season: number | null
    episode: number | null
    videoId: string | null
    eventType: string
    timestamp: number
    duration: number
    progress: number
    watched: number
    timesWatched: number
    isInProgress: boolean
    overallTimeWatched: number
}

export interface ExternalWatchItem {
    itemId: string
    video_id?: string
    type: string
    season?: number
    episode?: number
    name: string
    poster?: string
    duration?: number
    progress?: number
    timestamp: number
    /** No real watch date behind this row (undated external import): the timestamp is the sync observation. */
    backfill?: boolean
}

// The server stores Stremio's completion flag in `watched` (0/1), not a duration.
function isWatchedFlag(se: ServerActivityEvent): boolean {
    const watched = Number(se.watched) || 0
    return watched > 0 && watched <= 1
}

function serverTimeWatched(se: ServerActivityEvent): number {
    if (se.progress > 0) return se.progress
    if (isWatchedFlag(se)) return se.duration > 0 ? se.duration : 0
    return Number(se.watched) || 0
}

const sameEventTs = (a: number, b: number) => a === b || (a !== a && b !== b)

function collapseDayDuplicates(events: WatchEvent[]): WatchEvent[] {    const byKey = new Map<string, WatchEvent>()
    for (const e of events) {
        const ek = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
        const key = `${eventScopeKey(e)}:${ek}:${getLocalDayKey(e.event_ts)}`
        const existing = byKey.get(key)
        if (
            !existing ||
            e.event_ts > existing.event_ts ||
            (e.event_ts === existing.event_ts && e.detected_ts > existing.detected_ts)
        ) {
            byKey.set(key, e)
        }
    }
    return byKey.size === events.length ? events : Array.from(byKey.values()).sort((a, b) => b.event_ts - a.event_ts)
}

const PERSIST_DEBOUNCE_MS = 300
let _persistTimer: ReturnType<typeof setTimeout> | null = null
let _pendingDeleted: Record<string, number> | null = null

async function persistWatchEventsNow() {
    _persistTimer = null
    const { events, snapshot, snapshotOwners, rollups } = useWatchEventStore.getState()
    const deleted = _pendingDeleted
    _pendingDeleted = null
    try {
        await localforage.setItem(STORAGE_KEY, { events, snapshot, snapshotOwners, rollups, backfillProcessed: backfillProcessed.export(), trustedBackfills: Array.from(trustedBackfills), backfillRetries: Array.from(backfillRetries) })
    } catch (e) {
        if (import.meta.env.DEV) console.error('[watchEventStore] persist failed:', e)
    }
    if (deleted) {
        try {
            await localforage.setItem(DELETED_EVENTS_KEY, deleted)
        } catch (e) {
            if (import.meta.env.DEV) console.error('[watchEventStore] persist tombstones failed:', e)
        }
    }
}

function persistWatchEvents() {
    if (_persistTimer !== null) return
    _persistTimer = setTimeout(persistWatchEventsNow, PERSIST_DEBOUNCE_MS)
}

function cancelPendingPersist() {
    if (_persistTimer !== null) {
        clearTimeout(_persistTimer)
        _persistTimer = null
    }
    _pendingDeleted = null
}

if (typeof window !== 'undefined') {
    const flushPersist = () => {
        if (_persistTimer !== null) {
            clearTimeout(_persistTimer)
            _persistTimer = null
            void persistWatchEventsNow()
        }
    }
    window.addEventListener('pagehide', flushPersist)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPersist()
    })
}

const DELETED_EVENTS_KEY = 'aio_watch_events_deleted_v1'
// Tombstones are absolute per identity and may only be evicted by the cap below; an aged-out
// timestamp must never resurrect a deleted episode (a surviving event pins its key instead).
const DELETED_EVENTS_CAP = 10000

/**
 * Identity scope of an event: the frozen scopeKey when set (canonical events carry
 * attribution for exact-origin routing but KEEP the bare identity scope so legacy
 * tombstones and server-merged rows continue to match), else derived from the
 * connection attribution.
 */
function eventScopeKey(e: { accountId: string; sourceConnectionId?: string; scopeKey?: string }): string {
    return e.scopeKey ?? watchContextKey(e.accountId, e.sourceConnectionId)
}

export function watchEventIdentityKey(e: { accountId: string; sourceConnectionId?: string; scopeKey?: string; itemId: string; video_id?: string; season?: number; episode?: number; type: string }): string {
    return `${eventScopeKey(e)}:${getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)}`
}

function isEventTombstoned(e: WatchEvent, deleted: Record<string, number>): boolean {
    if (isSyntheticBackfillEvent(e) && isIdentityDeleted(`bfid:${e.id}`, deleted, e.bfConfirmedAt ?? 0)) return true
    if (isIdentityDeleted(watchEventIdentityKey(e), deleted, e.event_ts)) return true
    if (!e.itemId.startsWith('tt') && !e.itemId.startsWith('tmdb:')) return false
    return aliasIdentityKeys(eventScopeKey(e), e.itemId, e.video_id, e.season, e.episode, e.type)
        .some(key => isIdentityDeleted(key, deleted, e.event_ts))
}

export function filterTombstonedEvents(events: WatchEvent[], deleted: Record<string, number> | undefined): WatchEvent[] {
    if (!deleted || Object.keys(deleted).length === 0) return events
    return events.filter(e => !isEventTombstoned(e, deleted))
}

// Tombstone time of one play's identity, the single lookup every admission path uses; it
// looks through a known tmdb:/IMDb alias in both directions.
function identityDeletedAt(scope: string, itemId: string, videoId: string | undefined, season: number | undefined, episode: number | undefined, type: string, deleted: Record<string, number>): number | undefined {
    return aliasDeletedAt(deleted, scope, itemId, videoId, season, episode, type)
}

// A deleted episode stays deleted until per-identity replay proof: the episode's own
// resume position moved from a known baseline after the delete (tombstoneReplayProven).
// An unknown prior (first sighting, an episode change, a baseline rebuilt from server
// rows) is never evidence, so marks on other episodes can never re-seed it.
function tombstoneHolds(item: LibraryItem, deletedAt: number | undefined, priorOffset?: number): boolean {
    if (deletedAt === undefined) return false
    return !tombstoneReplayProven({
        deletedAt,
        offset: item.state?.timeOffset || 0,
        priorOffset,
        lastWatched: stremioTimeOf(item.state?.lastWatched) ?? 0,
    })
}

// Baselines a pre-fix build advanced past a delete (or rebuilt from a deleted row) are pinned
// at the delete time; the next diff then needs real playback of that episode to record it.
function pinTombstonedBaselines(snapshot: Snapshot, deleted: Record<string, number>): Snapshot {
    if (Object.keys(deleted).length === 0) return snapshot
    let next = snapshot
    for (const [ctx, items] of Object.entries(snapshot)) {
        let pinned: Record<string, SnapshotItem> | null = null
        for (const [itemId, entry] of Object.entries(items || {})) {
            const deletedAt = Math.min(
                identityDeletedAt(ctx, itemId, entry.video_id, entry.season, entry.episode, 'movie', deleted) ?? Infinity,
                identityDeletedAt(ctx, itemId, entry.video_id, entry.season, entry.episode, 'series', deleted) ?? Infinity,
            )
            if (!(entry.mtime > deletedAt)) continue
            pinned ??= { ...items }
            pinned[itemId] = { ...entry, mtime: deletedAt }
        }
        if (!pinned) continue
        if (next === snapshot) next = { ...snapshot }
        next[ctx] = pinned
    }
    return next
}

function capDeletedEvents(deleted: Record<string, number>, survivingEvents: WatchEvent[]): Record<string, number> {
    const entries = Object.entries(deleted)
    if (entries.length <= DELETED_EVENTS_CAP) return deleted
    const survivingKeys = new Set(survivingEvents.map(watchEventIdentityKey))
    const kept = entries
    const evictable = kept.filter(([key]) => !survivingKeys.has(key))
    const pinned = kept.filter(([key]) => survivingKeys.has(key))
    evictable.sort((a, b) => Number(a[0].startsWith('bfid:')) - Number(b[0].startsWith('bfid:')) || b[1] - a[1])
    const room = Math.max(0, DELETED_EVENTS_CAP - pinned.length)
    return Object.fromEntries([...pinned, ...evictable.slice(0, room)])
}

async function persistDeletedEvents(deleted: Record<string, number>) {
    _pendingDeleted = deleted
    persistWatchEvents()
}

export const useWatchEventStore = create<WatchEventState>((set, get) => ({
    events: [],
    snapshot: {},
    snapshotOwners: {},
    deletedEventKeys: {},
    rollups: emptyRollups(),
    initialized: false,

    initialize: (events, snapshot, deletedEventKeys, incomingRollups, snapshotOwners) => {
        const cleaned = events.filter(e => {
            const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
            if (isSeries && e.season != null && e.season > 100) return false
            return hasSeriesEventIdentity(e)
        })
        const deleted = deletedEventKeys ?? get().deletedEventKeys
        const alive = collapseDayDuplicates(filterTombstonedEvents(mergeBackfillDuplicates(cleaned), deleted))
        const { kept: capped, rollups: folded } = capWatchEventsWithRollups(alive, get().rollups)
        const rollups = incomingRollups ? mergeRollups(folded, incomingRollups) : folded
        set({ events: capped, snapshot: pinTombstonedBaselines(snapshot, deleted), snapshotOwners: snapshotOwners ?? get().snapshotOwners, rollups, deletedEventKeys: deleted, initialized: true })
        persistWatchEvents()
        if (deletedEventKeys) persistDeletedEvents(deleted)
    },

    load: async () => {
        const state = get()
        if (state.initialized) return
        try {
            // Beta candidates briefly persisted {deleted, pinned}; reads tolerate that
            // shape so their tombstones survive, writes use the shipped flat map.
            const storedDeleted = await localforage.getItem<unknown>(DELETED_EVENTS_KEY)
            let deleted: Record<string, number> = {}
            if (storedDeleted && typeof storedDeleted === 'object' && !Array.isArray(storedDeleted)) {
                const inner = (storedDeleted as { deleted?: unknown }).deleted
                deleted = (inner && typeof inner === 'object' && !Array.isArray(inner)
                    ? inner
                    : storedDeleted) as Record<string, number>
            }
            const stored = await localforage.getItem<{ events: WatchEvent[]; snapshot: Snapshot; snapshotOwners?: Record<string, string>; rollups?: EventRollups; backfillProcessed?: Record<string, string>; trustedBackfills?: Array<[string, TrustedBackfill]>; backfillRetries?: Array<[string, { watched: string; at: number }]> }>(STORAGE_KEY)
            if (stored && stored.events) {
                backfillProcessed.load(stored.backfillProcessed || {})
                for (const entry of (Array.isArray(stored.trustedBackfills) ? stored.trustedBackfills.slice(-TRUSTED_BACKFILL_CAP) : [])) {
                    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
                    const v = entry[1]
                    if (!v || typeof v.scope !== 'string' || typeof v.show !== 'string' || typeof v.watched !== 'string' || !Array.isArray(v.ids) || v.ids.length > 10000 || !v.ids.every(id => typeof id === 'string') || !Number.isFinite(v.confirmedAt)) continue
                    rememberTrustedBackfill(entry[0], v)
                }
                for (const entry of (Array.isArray(stored.backfillRetries) ? stored.backfillRetries.slice(-TRUSTED_BACKFILL_CAP) : [])) if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1].watched === 'string' && Number.isFinite(entry[1].at)) rememberBackfillRetry(entry[0], entry[1].watched, entry[1].at)
                const cleaned = stored.events.filter(e => {
                    const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
                    if (isSeries && e.season != null && e.season > 100) return false
                    return hasSeriesEventIdentity(e)
                }).map(e => {
                    // JSON stores NaN as null.
                    const ts = plausibleWatchEventTs(e.event_ts)
                    return ts === e.event_ts ? e : { ...e, event_ts: ts }
                })
                const collapsed = collapseDayDuplicates(filterTombstonedEvents(mergeBackfillDuplicates(cleaned), deleted))
                const rollups = stored.rollups ? { ...emptyRollups(), ...stored.rollups } : get().rollups
                const snapshot = pinTombstonedBaselines(stored.snapshot || {}, deleted)
                set({ events: collapsed, snapshot, snapshotOwners: stored.snapshotOwners || {}, rollups, deletedEventKeys: deleted, initialized: true })
                if (collapsed.length !== stored.events.length || snapshot !== stored.snapshot) persistWatchEvents()
            } else {
                set({ deletedEventKeys: deleted, initialized: true })
            }
        } catch (e) {
            if (import.meta.env.DEV) console.error('[watchEventStore] load failed:', e)
            set({ initialized: true })
        }
    },

    removeEvents: (items) => {
        if (!items || items.length === 0) return
        const state = get()
        const now = Date.now()
        const deleted = { ...state.deletedEventKeys }
        const targetKeys = new Set<string>()
        for (const it of items) {
            for (const key of aliasIdentityKeys(watchContextKey(it.accountId, it.sourceConnectionId), it.itemId, it.uniqueItemId, it.season, it.episode, it.type)) {
                deleted[key] = now
                targetKeys.add(key)
            }
        }
        // Mirror the drop onto the server's activity rows, fire-and-forget: every stored
        // event carrying a just-tombstoned identity is deleted by its (server-assigned) id.
        // Server events merged earlier keep their evt_… ids locally, so this reaches exactly
        // the rows that exist; anything missed re-merges on the next pull and stays hidden
        // behind the absolute tombstone.
        const serverEventIds = state.events
            .filter(e => targetKeys.has(watchEventIdentityKey(e)))
            .map(e => e.id)
        const capped = capDeletedEvents(deleted, state.events)
        const events = filterTombstonedEvents(state.events, capped)
        set({ events, deletedEventKeys: capped })
        persistWatchEvents()
        persistDeletedEvents(capped)
        // F3: the tombstone is durable only once the cloud carries it; an abrupt session
        // end before the periodic push would resurrect the delete on the next sign-in.
        // syncToRemote(true) is the existing coalesced path: sliding 1500ms debounce, so a
        // batch or consecutive deletes still send exactly one wire push.
        void import('@/store/syncStore')
            .then(m => m.useSyncStore.getState().syncToRemote(true))
            .catch(() => { })
        if (serverEventIds.length > 0) {
            void import('@/lib/activity-server')
                .then(m => m.deleteServerActivityEvents(serverEventIds))
                .catch(() => { })
        }
    },

    // Syncs the differencer after a self-inflicted row rewrite (per-episode delete); without it,
    // the next diff infers a phantom watch for the repointed anchor. options.contextKey targets
    // a specific connection's snapshot when the rewrite landed on a secondary login.
    patchSnapshot: (accountId, itemId, patch, options) => {
        const state = get()
        const ctx = options?.contextKey ?? accountId
        const current = state.snapshot[ctx]?.[itemId]
        if (!current) return
        set({
            snapshot: {
                ...state.snapshot,
                [ctx]: { ...(state.snapshot[ctx] || {}), [itemId]: { ...current, ...patch } },
            },
        })
        persistWatchEvents()
    },

    migrateCanonicalScope: (accountId, previousCanonicalId, promotedConnectionId) => {
        const state = get()
        const demotedScope = `${accountId}::${previousCanonicalId}`
        const snapshot = { ...state.snapshot }
        if (snapshot[accountId]) {
            // The demoted login owns the bare baseline; an existing demoted scope (it was a
            // secondary before) wins, and the bare copy is retired either way.
            if (!snapshot[demotedScope]) snapshot[demotedScope] = snapshot[accountId]
            delete snapshot[accountId]
        }
        if (promotedConnectionId) {
            // The promoted login's secondary scope becomes the canonical bare baseline.
            const promotedScope = `${accountId}::${promotedConnectionId}`
            if (snapshot[promotedScope]) {
                if (!snapshot[accountId]) snapshot[accountId] = snapshot[promotedScope]
                delete snapshot[promotedScope]
            }
        }
        // Scope migration (frozen-scope aware): canonical-era events live under the BARE
        // scope whether or not they already carry attribution — identify them by their
        // identity scope (eventScopeKey), not by the attribution field. Demoted: scope
        // becomes `accountId::demoted`, attribution names the demoted login (kept when
        // already present, stamped when legacy). Promoted: the login KEEPS its
        // sourceConnectionId identity but its scope becomes bare, matching the canonical
        // shape new events are created with. Ids are never rewritten.
        let touchedEvents = false
        const promotedScopeKey = promotedConnectionId ? `${accountId}::${promotedConnectionId}` : null
        const events = state.events.map(e => {
            if (e.accountId !== accountId) return e
            const scope = eventScopeKey(e)
            if (scope === accountId) {
                touchedEvents = true
                return { ...e, sourceConnectionId: previousCanonicalId, scopeKey: demotedScope }
            }
            if (promotedScopeKey && scope === promotedScopeKey) {
                touchedEvents = true
                return { ...e, scopeKey: accountId }
            }
            return e
        })
        // Tombstones guarding those events follow the same identity changes, or deleted
        // episodes would resurrect on the next server pull.
        const deleted = { ...state.deletedEventKeys }
        const barePrefix = `${accountId}:`
        const scopedPrefix = `${accountId}::`
        const promotedPrefix = `${accountId}::${promotedConnectionId ?? ''}:`
        for (const key of Object.keys(deleted)) {
            if (promotedConnectionId && key.startsWith(promotedPrefix)) {
                const rest = key.slice(promotedPrefix.length)
                const moved = `${barePrefix}${rest}`
                if (!(moved in deleted)) deleted[moved] = deleted[key]
                delete deleted[key]
                continue
            }
            if (key.startsWith(scopedPrefix) || !key.startsWith(barePrefix)) continue
            const rest = key.slice(barePrefix.length)
            const moved = `${demotedScope}:${rest}`
            if (!(moved in deleted)) deleted[moved] = deleted[key]
            delete deleted[key]
        }
        const owners = { ...state.snapshotOwners }
        delete owners[accountId]
        set({ snapshot, ...(touchedEvents ? { events } : {}), deletedEventKeys: deleted, snapshotOwners: owners })
        persistWatchEvents()
        persistDeletedEvents(deleted)
    },

    resolveOwnEpisodeBits: async (items, contextKey) => {
        const bits = new Map<string, boolean>()
        const cachePending = new Set<string>()
        const baseline = contextKey ? get().snapshot[contextKey] || {} : undefined
        const pending = items.filter(item => {
            if (!isSeriesItem(item) || !item._id || !item.state?.video_id) return false
            const prior = baseline?.[item._id]
            return !prior || (stremioTimeOf(item._mtime) ?? 0) > prior.mtime
        })
        await mapConcurrent(pending, 6, async item => {
            const videoId = item.state?.video_id
            const watched = item.state?.watched
            // No bitfield, or a readable one with every bit clear: this episode is known unmarked.
            if (!watched || await hasNoVisibleWatchedBits(watched)) { bits.set(item._id, false); return }
            const videos = getCachedResolvedSeriesVideos(contextKey || '', item.type || 'series', item._id)
            if (!videos) {
                if (await decodeStremioVisibleIndices(watched, []) !== null) cachePending.add(item._id)
                return
            }
            const resolved = await decodeStremioVisibleIndices(watched, videos)
            if (resolved !== null) bits.set(item._id, resolved.some(index => videos[index]?.id === videoId))
        })
        return Object.assign(bits, { pending: cachePending })
    },

    diffAndRecord: (accountId, items, _account, _accounts, options) => {
        const now = Date.now()
        let state = get()
        // Canonical/legacy diffs keep the bare accountId scope (every pre-multiplicity
        // snapshot, event id and tombstone stays valid); a secondary login diffs under
        // its own context so its history never collides with the canonical login's.
        const ctx = options?.contextKey ?? accountId
        // A canonical change can also arrive through cloud sync, bypassing the local
        // connection action. Migrate the prior owner's history before diffing its peer.
        const priorOwner = state.snapshotOwners[accountId]
        if (ctx === accountId && options?.ownerConnectionId && priorOwner && priorOwner !== options.ownerConnectionId) {
            get().migrateCanonicalScope(accountId, priorOwner, options.ownerConnectionId)
            state = get()
        }
        // Attribution for every event this diff creates: a secondary login stamps its own
        // connection; the CANONICAL login stamps its owner connection while the identity
        // scope stays bare (scopeKey) so legacy tombstones and server-merged rows match.
        const eventAttribution = options?.sourceConnectionId || options?.ownerConnectionId
            ? { sourceConnectionId: options.sourceConnectionId ?? options.ownerConnectionId, scopeKey: ctx }
            : {}
        const accountSnapshot = state.snapshot[ctx] || {}
        // Adopt the owner even when a migrated baseline already matches every item.
        // Otherwise an unchanged first scan after promotion leaves ownership unknown,
        // preventing detection of a later primary change arriving through cloud sync.
        const ownerChanged = Boolean(options?.ownerConnectionId && ctx === accountId
            && state.snapshotOwners[accountId] !== options.ownerConnectionId)
        const newEvents: WatchEvent[] = []
        const updatedSnapshot = { ...accountSnapshot }
        // Seed indexes come from the shared per-array cache. Sessions and merge
        // candidates are scoped to THIS login (their keys are scope-prefixed), but
        // id suppression is GLOBAL: canonical migration rewrites an event's scopeKey
        // while keeping its historical id, so a bare-scope id can live under another
        // scope's partition and must still suppress a duplicate here — the seed's id
        // set is the whole array's, exactly like the full-array index it replaces.
        // Private copies: the item loop below adds freshly seeded events into them,
        // and clones keep concurrent sibling logins from observing each other's
        // in-flight seeds.
        const seedIndexes = scopeIndexesFor(state.events, ctx)
        const existingEventIds = seedIndexes.ids
        const existingSessionEvents = seedIndexes.sessions
        let snapshotChanged = false

        const setSnapshotItem = (itemId: string, next: SnapshotItem) => {
            const current = updatedSnapshot[itemId]
            if (
                !current ||
                current.mtime !== next.mtime ||
                current.video_id !== next.video_id ||
                current.overallTimeWatched !== next.overallTimeWatched ||
                current.timeWatched !== next.timeWatched ||
                (current.duration || 0) !== (next.duration || 0) ||
                current.season !== next.season ||
                current.episode !== next.episode ||
                current.watchMark !== next.watchMark ||
                current.ownBit !== next.ownBit ||
                current.ownBitPending !== next.ownBitPending
            ) {
                snapshotChanged = true
            }
            updatedSnapshot[itemId] = next
        }

        const preserveSnapshotEvent = (item: LibraryItem, prior: SnapshotItem) => {
            if (!isSeriesItem(item) || !prior.mtime) return

            const { season: priorSeason, episode: priorEpisode } = getSeasonEpisodeForVideoId(item, prior.video_id)
            const season = sanitizeSeason(prior.season ?? priorSeason)
            const episode = prior.episode ?? priorEpisode
            if (season == null && episode == null && (!prior.video_id || prior.video_id === item._id)) return

            const episodeKey = getEpisodeIdentity(item._id, prior.video_id, season, episode, item.type || 'other')
            const sessionKey = `${ctx}:${episodeKey}:${getLocalDayKey(prior.mtime)}`
            if (existingSessionEvents.has(sessionKey)) return

            const eventId = `${ctx}:${prior.video_id}:${prior.mtime}`
            if (existingEventIds.has(eventId)) return

            const watched = prior.timeWatched || 0
            const event: WatchEvent = {
                id: eventId,
                accountId,
                itemId: item._id,
                video_id: prior.video_id,
                event_ts: prior.mtime,
                detected_ts: now,
                name: item.name || 'Unknown',
                type: item.type || 'other',
                poster: item.poster || '',
                time_watched: watched,
                time_watched_delta: watched > 0 ? watched : undefined,
                duration: prior.duration || item.state?.duration || 0,
                season,
                episode,
                ...eventAttribution,
            }

            newEvents.push(event)
            existingEventIds.add(eventId)
            existingSessionEvents.set(sessionKey, event)
        }

        for (const item of items) {
            if (!item._id) continue

            const mtime = stremioTimeOf(item._mtime) ?? 0
            if (!mtime) continue

            const video_id = item.state?.video_id || item._id
            const prior = accountSnapshot[item._id]

            if (item.removed && !prior) continue

            if (item.removed) {
                setSnapshotItem(item._id, { mtime, video_id, overallTimeWatched: 0, timeWatched: 0, timeOffset: 0, duration: 0 })
                continue
            }

            // If no prior snapshot entry AND _ctime exists, seed a "first watched" event.
            // This gives retroactive history for the entire existing library on first run.
            if (!prior) {
                if (!isActuallyWatched(item)) {
                    setSnapshotItem(item._id, { mtime, video_id, overallTimeWatched: 0, timeWatched: 0, timeOffset: 0, watchMark: watchMarkOf(item) })
                    continue
                }
                // Imported saved watch state (bitfield aggregates, flagged-only movies) has no
                // watch dates: seeding from the import mtime would fabricate a dated watch.
                // Skip the seed; the shared snapshot below still lands so the row stays
                // live-only (imported-saved surfaces) and normal diffing resumes the moment
                // it gains real anchors. Per-episode history comes from recordBackfillEpisodes.
                const datelessSaved = isDatelessSavedWatchState(item)
                const isSeries = isSeriesItem(item)
                const seedDismissed = isResumeDismissal(item)
                const seedLastWatched = stremioTimeOf(item.state?.lastWatched) ?? 0
                const hasVideoId = !!(item.state?.video_id && item.state.video_id.trim() !== '')
                const { season: seedSeason, episode: seedEpisode } = getSeasonEpisode(item)
                const seedDeletedAt = identityDeletedAt(ctx, item._id, video_id, sanitizeSeason(seedSeason), seedEpisode, item.type || 'other', get().deletedEventKeys)
                const seedDeleted = tombstoneHolds(item, seedDeletedAt)
                if (!datelessSaved && (!isSeries || hasVideoId) && !seedDeleted) {
                    const seedTs = Math.max(
                        stremioTimeOf(item._ctime) ?? 0,
                        seedLastWatched,
                        seedDismissed ? 0 : mtime
                    )
                    if (seedTs > 0) {
                        const seedId = `${ctx}:${video_id}:${seedTs}`
                        if (!existingEventIds.has(seedId)) {
                            newEvents.push({
                                id: seedId,
                                accountId,
                                itemId: item._id,
                                video_id,
                                event_ts: seedTs,
                                detected_ts: now,
                                name: item.name || 'Unknown',
                                type: item.type || 'other',
                                poster: item.poster || '',
                                time_watched: item.state?.timeWatched || 0,
                                time_watched_delta: item.state?.overallTimeWatched || 0,
                                duration: item.state?.duration || 0,
                                season: sanitizeSeason(seedSeason),
                                episode: seedEpisode,
                                ...eventAttribution,
                            })
                            existingEventIds.add(seedId)
                        }
                    }
                }
                setSnapshotItem(item._id, {
                    // A held tombstone pins the baseline at or before the delete so the preserve
                    // path can never date a copy after it.
                    mtime: seedDeleted ? Math.min(mtime, seedDeletedAt as number) : seedDismissed ? seedLastWatched : mtime, video_id,
                    overallTimeWatched: item.state?.overallTimeWatched || 0,
                    timeWatched: item.state?.timeWatched || 0,
                    timeOffset: item.state?.timeOffset || 0,
                    duration: item.state?.duration || 0,
                    season: sanitizeSeason(seedSeason),
                    episode: seedEpisode,
                    watchMark: watchMarkOf(item),
                    ownBit: options?.ownBits?.get(item._id),
                    ownBitPending: options?.ownBits?.pending?.has(item._id) || undefined,
                })
                continue
            }


            const mtimeChanged = mtime > prior.mtime
            const { season: rawCurrentSeason, episode: currentEpisode } = getSeasonEpisode(item)
            const currentSeason = sanitizeSeason(rawCurrentSeason)
            const episodeAdvanced = video_id !== prior.video_id ||
                currentSeason !== prior.season ||
                currentEpisode !== prior.episode

            // Imported saved watch state (bitfield aggregates, flagged-only movies) never
            // produces diff events: preserve/mtime paths would fabricate dated watches from
            // the import mtime (and a bare-identity event would displace the live-only saved
            // summary). Per-episode history for these rows comes exclusively from
            // recordBackfillEpisodes; the moment a row gains real anchors (resume, dates) it
            // stops being dateless and normal diffing resumes against this snapshot.
            const datelessSaved = isDatelessSavedWatchState(item)

            if (!datelessSaved && isActuallyWatched(item) && (episodeAdvanced || !mtimeChanged)) {
                preserveSnapshotEvent(item, prior)
            }

            const dismissed = !datelessSaved && !episodeAdvanced && mtimeChanged && isResumeDismissal(item, prior)
            const currentOverall = item.state?.overallTimeWatched || 0
            const delta = Math.max(0, currentOverall - (prior.overallTimeWatched || 0))
            const currentTW = item.state?.timeWatched || 0
            const deltaTW = Math.max(0, currentTW - (prior.timeWatched || 0))
            const watchedDelta = delta || deltaTW
            const anchorDeletedAt = identityDeletedAt(ctx, item._id, video_id, currentSeason, currentEpisode, item.type || 'other', get().deletedEventKeys)
            const deletedAnchor = !datelessSaved && !dismissed && (mtimeChanged || episodeAdvanced)
                && tombstoneHolds(item, anchorDeletedAt, episodeAdvanced || prior.fromServer ? undefined : prior.timeOffset)
            // A write that is not a play of this episode refreshes the baseline but keeps its
            // mtime, so the preserve path never turns the write time into a watch either.
            const notAPlay = !datelessSaved && !dismissed && !episodeAdvanced && mtimeChanged && !isSameEpisodeWatch(item, prior, watchedDelta, options?.ownBits?.get(item._id))

            if (!datelessSaved && !dismissed && !deletedAnchor && !notAPlay && (mtimeChanged || episodeAdvanced) && isActuallyWatched(item)) {
                const episodeKey = getEpisodeIdentity(item._id, video_id, currentSeason, currentEpisode, item.type || 'other')
                const sessionKey = `${ctx}:${episodeKey}:${getLocalDayKey(mtime)}`
                const mergeCandidate = !episodeAdvanced
                    ? existingSessionEvents.get(sessionKey)
                    : undefined

                if (mergeCandidate) {
                    const mergedEvent = {
                        ...mergeCandidate,
                        ...(mergeCandidate.id.startsWith('bf:') ? { backfill: false } : {}),
                        event_ts: Math.max(mergeCandidate.event_ts, mtime),
                        detected_ts: now,
                        name: item.name || mergeCandidate.name || 'Unknown',
                        type: item.type || mergeCandidate.type || 'other',
                        poster: item.poster || mergeCandidate.poster || '',
                        time_watched: Math.max(mergeCandidate.time_watched || 0, currentTW),
                        time_watched_delta: Math.max(mergeCandidate.time_watched_delta || 0, watchedDelta),
                        duration: item.state?.duration || mergeCandidate.duration || 0,
                        season: currentSeason,
                        episode: currentEpisode,
                    }
                    newEvents.push(mergedEvent)
                    existingEventIds.add(mergeCandidate.id)
                    existingSessionEvents.set(sessionKey, mergedEvent)
                } else {
                    const eventId = `${ctx}:${video_id}:${mtime}`
                    if (!existingEventIds.has(eventId)) {
                        newEvents.push({
                            id: eventId,
                            accountId,
                            itemId: item._id,
                            video_id,
                            event_ts: mtime,
                            detected_ts: now,
                            name: item.name || 'Unknown',
                            type: item.type || 'other',
                            poster: item.poster || '',
                            time_watched: currentTW,
                            time_watched_delta: watchedDelta,
                            duration: item.state?.duration || 0,
                            season: currentSeason,
                            episode: currentEpisode,
                            ...eventAttribution,
                        })
                        existingEventIds.add(eventId)
                    }
                }
            }

            // A dismissal leaves the baseline untouched: advancing it would let the next
            // scan preserve the dismissal mtime as a watch, and a later real watch still
            // diffs against the true last-watched state.
            if (!dismissed && (mtimeChanged || episodeAdvanced)) {
                setSnapshotItem(item._id, {
                    mtime: deletedAnchor ? Math.min(prior.mtime, anchorDeletedAt as number) : notAPlay ? prior.mtime : mtime, video_id,
                    overallTimeWatched: item.state?.overallTimeWatched || 0,
                    timeWatched: item.state?.timeWatched || 0,
                    timeOffset: item.state?.timeOffset || 0,
                    duration: item.state?.duration || 0,
                    season: currentSeason,
                    episode: currentEpisode,
                    watchMark: watchMarkOf(item),
                    ownBit: options?.ownBits?.get(item._id),
                    // A refresh that was not a play keeps the old baseline; it may not turn an
                    // unknown-for-another-reason prior (malformed marks) into a cache-pending one.
                    ownBitPending: notAPlay && prior.ownBit === undefined && prior.ownBitPending !== true
                        ? undefined
                        : options?.ownBits?.pending?.has(item._id) || undefined,
                })
            }
        }

        if (newEvents.length === 0 && !snapshotChanged && !ownerChanged) {
            return []
        }

        const merged = [...state.events, ...newEvents]
        const deduped = mergeWatchEventsById(merged)
        const sorted = deduped.sort((a, b) => b.event_ts - a.event_ts)
        const alive = filterTombstonedEvents(sorted, get().deletedEventKeys)
        // Under the global floor the cap provably cannot evict
        // (globalCapFor(accountCount) >= MIN_EVENTS_GLOBAL >= alive.length ⇒
        // capWatchEvents returns the array unchanged and rollups stay as-is),
        // so skip its account-count scan entirely.
        const { kept: capped, rollups } = alive.length > MIN_EVENTS_GLOBAL
            ? capWatchEventsWithRollups(alive, state.rollups)
            : { kept: alive, rollups: state.rollups }

        const nextSnapshot = {
            ...state.snapshot,
            [ctx]: { ...accountSnapshot, ...updatedSnapshot },
        }

        // Populate before publishing so synchronous subscribers share this index too.
        reuseScopePartitionedIndexes(state.events, capped)
        set({
            events: capped,
            snapshot: nextSnapshot,
            // Record which login owns the bare-account baseline so a later canonical
            // switch detects the identity change and resets instead of cross-diffing.
            ...(options?.ownerConnectionId && ctx === accountId
                ? { snapshotOwners: { ...state.snapshotOwners, [accountId]: options.ownerConnectionId } }
                : {}),
            rollups,
        })

        persistWatchEvents()
        return newEvents
    },

    // Backfill complete per-episode history from Stremio's watched-bitfield for tt series. Fills
    // gaps the live video_id sampling misses (binges / batched device syncs). Events are marked
    // backfill (synthetic timestamp -> excluded from time-based Replay stats) and deduped against
    // any existing event for the same episode, so real watch data always wins and nothing double-counts.
    // When the checksum-verified bitfield covers an episode that already has real events, those
    // events are kept verbatim (dates, times, progress, ids, scope) and only receive the positive
    // per-episode confirmation flag: the bitfield is authoritative "watched to the end" evidence,
    // so an old partial stop the bitfield confirms counts as watched, while partials outside the
    // bitfield stay partial. No duplicate backfill event and no fabricated chronology.
    recordBackfillEpisodes: async (accountId, items, options) => {
        const ctx = options?.contextKey ?? accountId
        const eventAttribution = options?.sourceConnectionId || options?.ownerConnectionId
            ? { sourceConnectionId: options.sourceConnectionId ?? options.ownerConnectionId, scopeKey: ctx }
            : {}
        const now = Date.now()
        const newEvents: WatchEvent[] = []
        // Bitfield-confirmed identities already covered by real events in this exact scope:
        // their events get flaggedWatched stamped below instead of a duplicate recovery.
        const confirmedExistingIdentities = new Set<string>()
        const staleIds = new Set<string>()
        const confirmedBfIds = new Set<string>()
        let processedChanged = false

        const keyOf = (item: LibraryItem) => JSON.stringify([ctx, options?.sourceConnectionId || options?.ownerConnectionId || '', item.type || 'series', item._id])
        if (options?.completeLibrary && backfillProcessed.prune(ctx, new Set(options.libraryIds ?? items.map(item => item._id)))) processedChanged = true
        const revisions = new Map<string, number>()
        const candidates = items.filter(item => {
            if (!item._id || !isSeriesItem(item)) return false
            const key = keyOf(item)
            const revision = ++backfillRevision
            backfillRevisions.set(key, revision)
            revisions.set(key, revision)
            if (!item.state?.watched || !options?.authKey) return false
            const retry = backfillRetries.get(key)
            if (retry?.watched === item.state.watched) return now >= retry.at && now - retry.at >= BACKFILL_RETRY_MS
            if (backfillProcessed.get(key) !== item.state.watched) return true
            const trusted = trustedBackfills.get(key)
            return trusted?.watched !== item.state.watched

        })
        const current = (item: LibraryItem) => backfillRevisions.get(keyOf(item)) === revisions.get(keyOf(item))
        const results = await mapConcurrent(candidates, 100, item =>
            resolveSeriesVideos(options!.authKey!, ctx, item.type || 'series', item._id))

        const decoded = await Promise.all(results.map((result, index) => result.kind === 'list'
            ? decodeStremioVisibleIndices(candidates[index].state?.watched, result.videos) : null))
        for (const [index, item] of candidates.entries()) {
            if (!current(item)) continue
            const key = keyOf(item)
            const result = results[index]
            const indices = decoded[index]
            const trusted = result.kind === 'list' && result.writeGrade && result.fetchedAt <= Date.now() && Date.now() - result.fetchedAt <= 300000 && indices !== null
            if (trusted && result.kind === 'list' && indices !== null) {
                rememberTrustedBackfill(key, { scope: ctx, show: item._id, watched: item.state!.watched!, ids: indices.map(i => result.videos[i].id), confirmedAt: Date.now() })
                backfillRetries.delete(key)
            } else rememberBackfillRetry(key, item.state!.watched!, Date.now())
            processedChanged = true
        }
        const itemByKey = new Map(items.filter(item => item._id && isSeriesItem(item)).map(item => [keyOf(item), item]))
        const attempted = new Map(candidates.map((item, index) => [keyOf(item), index]))
        const trustedByShow = new Map<string, { ids: Set<string>; confirmedAt: number }>()
        for (const [key, checkpoint] of trustedBackfills) {
            const item = itemByKey.get(key)
            const index = attempted.get(key)
            if (!options?.authKey || checkpoint.scope !== ctx || !item || !current(item) || item.state?.watched !== checkpoint.watched) continue
            if (backfillRetries.get(key)?.watched === item.state.watched) continue
            if (index !== undefined && (results[index].kind !== 'list' || !results[index].writeGrade || decoded[index] === null)) continue
            trustedByShow.set(checkpoint.show, { ids: new Set(checkpoint.ids), confirmedAt: checkpoint.confirmedAt })
        }
        const currentEvents = get().events
        const shows = syntheticEventsByScope(currentEvents).get(ctx)
        if (shows) for (const [show, checkpoint] of trustedByShow) {
            for (const event of shows.get(show) || []) {
                if (!checkpoint.ids.has(event.video_id || '') && (event.bfConfirmedAt ?? 0) <= checkpoint.confirmedAt) staleIds.add(event.id)
            }
        }
        if (candidates.length === 0 && staleIds.size === 0) {
            for (const [key, revision] of revisions) if (backfillRevisions.get(key) === revision) backfillRevisions.delete(key)
            if (processedChanged) persistWatchEvents()
            return 0
        }
        const seedIndexes = scopeIndexesFor(staleIds.size ? currentEvents.filter(event => !staleIds.has(event.id) || !isSyntheticBackfillEvent(event)) : currentEvents, ctx)
        const existingIds = seedIndexes.ids
        const realBackfillIds = new Set(currentEvents.filter(event => event.id.startsWith('bf:') && !isSyntheticBackfillEvent(event)).map(event => event.id))
        const existingIdentities = seedIndexes.identities

        for (const [index, item] of candidates.entries()) {
            const seriesId = item._id
            const guardKey = keyOf(item)
            if (!current(item)) continue
            const result = results[index]
            if (result.kind !== 'list') continue
            const indices = decoded[index]
            if (indices === null) continue
            const episodes = indices.map(index => {
                const video = result.videos[index]
                return { videoId: video.id, season: video.season, episode: video.episode }
            })
            const pendingConfirmation = result.writeGrade && episodes.some(ep => {
                const marker = get().deletedEventKeys[`bfid:bf:${ctx}:${ep.videoId}`]
                return !realBackfillIds.has(`bf:${ctx}:${ep.videoId}`) && marker !== undefined && marker >= Date.now()
            })
            if (pendingConfirmation) backfillProcessed.delete(guardKey)
            else backfillProcessed.set(guardKey, item.state!.watched!)
            processedChanged = true
            const ts = stremioTimeOf(item.state?.lastWatched) || 0
            const trusted = result.writeGrade && result.fetchedAt <= Date.now() && Date.now() - result.fetchedAt <= 300000

            for (const ep of episodes) {
                const season = ep.season ?? undefined
                const episode = ep.episode ?? undefined
                const identity = getEpisodeIdentity(seriesId, ep.videoId, season, episode, item.type || 'series')
                const id = `bf:${ctx}:${ep.videoId}`
                if (trusted && existingIds.has(id)) confirmedBfIds.add(id)
                if (existingIdentities.has(identity)) {
                    // Real event(s) already cover this episode: collect the identity so the
                    // merge below stamps the confirmation flag on the events that exist NOW
                    // (concurrent updates are re-read there and never overwritten).
                    confirmedExistingIdentities.add(identity)
                    continue
                }
                // The bitfield carries no per-episode date, so it can never prove a re-watch after a delete.
                if (identityDeletedAt(ctx, seriesId, ep.videoId, season, episode, item.type || 'series', get().deletedEventKeys) !== undefined) continue
                if (existingIds.has(id) || (!trusted && (get().deletedEventKeys[`bfid:${id}`] !== undefined || (trustedByShow.has(seriesId) && !trustedByShow.get(seriesId)!.ids.has(ep.videoId))))) continue

                newEvents.push({
                    id,
                    accountId,
                    itemId: seriesId,
                    video_id: ep.videoId,
                    event_ts: ts,
                    detected_ts: now,
                    name: item.name || 'Unknown',
                    type: item.type || 'series',
                    poster: item.poster || '',
                    time_watched: 0,
                    duration: 0,
                    season,
                    episode,
                    backfill: true,
                    ...(trusted ? { bfConfirmedAt: Date.now() } : {}),
                    ...eventAttribution,
                })
                existingIdentities.add(identity)
                existingIds.add(id)
            }
        }

        for (const [key, revision] of revisions) {
            if (backfillRevisions.get(key) === revision) backfillRevisions.delete(key)
        }

        // Stamp the positive confirmation on the covering events as they exist NOW (post-await
        // re-read, so concurrent field updates always win theirs). Only the exact scope is
        // touched, backfill recoveries are skipped (already counted as watched), and every
        // other field — including detected_ts — is preserved: the flag is the only change.
        const cur = get()
        let flaggedCount = 0
        const baseEvents = confirmedExistingIdentities.size > 0 || confirmedBfIds.size > 0 ? cur.events.map(e => {
            if (confirmedBfIds.has(e.id)) {
                const confirmedAt = Date.now()
                if ((e.bfConfirmedAt ?? 0) >= confirmedAt) return e
                flaggedCount++
                return { ...e, bfConfirmedAt: confirmedAt }
            }
            if (e.backfill || (e.flaggedWatched ?? 0) > 0) return e
            if (eventScopeKey(e) !== ctx) return e
            const identity = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
            if (!confirmedExistingIdentities.has(identity)) return e
            flaggedCount++
            return { ...e, flaggedWatched: 1 }
        }) : cur.events

        const deleted = { ...cur.deletedEventKeys }
        for (const id of staleIds) deleted[`bfid:${id}`] = Math.max(deleted[`bfid:${id}`] ?? 0, Date.now())
        const cappedDeleted = capDeletedEvents(deleted, baseEvents)
        if (newEvents.length === 0 && flaggedCount === 0 && staleIds.size === 0) {
            if (processedChanged) persistWatchEvents()
            return 0
        }

        const merged = [...baseEvents.filter(event => !staleIds.has(event.id) || !isSyntheticBackfillEvent(event)), ...newEvents]
        const deduped = mergeWatchEventsById(merged)
        const sorted = deduped.sort((a, b) => b.event_ts - a.event_ts)
        const { kept: capped, rollups } = capWatchEventsWithRollups(
            filterTombstonedEvents(sorted, cappedDeleted),
            cur.rollups
        )
        reuseScopePartitionedIndexes(cur.events, capped)
        set({ events: capped, rollups, deletedEventKeys: cappedDeleted })
        if (staleIds.size) persistDeletedEvents(cappedDeleted)
        persistWatchEvents()
        // Callers treat >0 as "state changed": annotations alone must still persist,
        // so the count includes stamped flags, not just new recoveries.
        return newEvents.length + flaggedCount + staleIds.size
    },

    export: () => ({
        events: get().events,
        snapshot: get().snapshot,
        snapshotOwners: get().snapshotOwners,
        deletedEvents: get().deletedEventKeys,
        rollups: get().rollups,
    }),

    reset: () => {
        cancelPendingPersist()
        // Deletes are durable: reset clears watch data but NEVER the tombstones; wiping
        // them would resurrect every deleted event on the next pull.
        const deleted = get().deletedEventKeys
        backfillProcessed.clear()
        trustedBackfills.clear()
        backfillRetries.clear()
        set({ events: [], snapshot: {}, snapshotOwners: {}, deletedEventKeys: deleted, rollups: emptyRollups(), initialized: false })
        localforage.removeItem(STORAGE_KEY).catch(() => {})
        if (Object.keys(deleted).length > 0) persistDeletedEvents(deleted)
    },

    reapplyTombstones: () => {
        const state = get()
        const events = filterTombstonedEvents(state.events, state.deletedEventKeys)
        const snapshot = pinTombstonedBaselines(state.snapshot, state.deletedEventKeys)
        if (events.length === state.events.length && snapshot === state.snapshot) return
        set({ events, snapshot })
        persistWatchEvents()
    },

    mergeServerEvents: (serverEvents) => {
        if (!serverEvents || serverEvents.length === 0) return
        const state = get()
        const now = Date.now()
        const eventsById = new Map(state.events.map(e => [e.id, e]))
        const localDayKeys = new Set<string>()
        for (const e of state.events) {
            const ek = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
            localDayKeys.add(`${eventScopeKey(e)}:${ek}:${getLocalDayKey(e.event_ts)}`)
        }
        const newEvents: WatchEvent[] = []
        let changed = false

        for (const se of serverEvents) {
            if (se.season != null && se.season > 100) continue
            // Server rows for secondary Stremio logins carry the scoped account id
            // `${accountId}::${connectionId}`; split it back so the stored event keeps the
            // REAL account (display, filters) plus the exact originating connection.
            const { accountId, sourceConnectionId } = parseScopedAccountId(se.accountId)
            const video_id = se.videoId || se.uniqueItemId || se.itemId
            const event_ts = plausibleWatchEventTs(se.timestamp)
            const event: WatchEvent = {
                id: se.id,
                accountId,
                itemId: se.itemId,
                video_id,
                event_ts,
                detected_ts: now,
                name: se.name || 'Unknown',
                type: se.type || 'other',
                poster: se.poster || '',
                time_watched: serverTimeWatched(se),
                time_watched_delta: undefined,
                duration: se.duration || 0,
                season: se.season ?? undefined,
                episode: se.episode ?? undefined,
                timesWatched: (se as { timesWatched?: number }).timesWatched,
                // Stamped only when set: the server row's watched bit is not evidence to clear
                // a checksum-verified per-episode flag already stamped on the event.
                ...(isWatchedFlag(se) ? { flaggedWatched: 1 } : {}),
                ...(se.overallTimeWatched != null ? { overall_time_watched: Number(se.overallTimeWatched) } : {}),
                scopeKey: se.accountId,
                ...(sourceConnectionId ? { sourceConnectionId } : {}),
            }

            if (isEventTombstoned(event, state.deletedEventKeys)) continue

            const existingEvent = eventsById.get(se.id)
            if (existingEvent) {
                const mergedEvent = mergeBackfillEvent(existingEvent, { ...existingEvent, ...event })
                if (!isPlausibleWatchMs(mergedEvent.event_ts)) {
                    mergedEvent.event_ts = isPlausibleWatchMs(existingEvent.event_ts) ? existingEvent.event_ts : NaN
                }
                if (
                    existingEvent.video_id !== mergedEvent.video_id ||
                    existingEvent.time_watched !== mergedEvent.time_watched ||
                    existingEvent.flaggedWatched !== mergedEvent.flaggedWatched ||
                    existingEvent.duration !== mergedEvent.duration ||
                    existingEvent.season !== mergedEvent.season ||
                    existingEvent.episode !== mergedEvent.episode ||
                    existingEvent.sourceConnectionId !== mergedEvent.sourceConnectionId ||
                    existingEvent.scopeKey !== mergedEvent.scopeKey ||
                    !sameEventTs(existingEvent.event_ts, mergedEvent.event_ts) ||
                    existingEvent.overall_time_watched !== mergedEvent.overall_time_watched
                ) {
                    eventsById.set(se.id, mergedEvent)
                    changed = true
                }
                continue
            }

            const ek = getEpisodeIdentity(se.itemId, video_id, event.season, event.episode, event.type)
            const dayKey = `${watchContextKey(accountId, sourceConnectionId)}:${ek}:${getLocalDayKey(event_ts)}`
            if (localDayKeys.has(dayKey)) continue

            newEvents.push(event)
            eventsById.set(se.id, event)
            localDayKeys.add(dayKey)
            changed = true
        }

        if (newEvents.length === 0 && !changed) return

        const sorted = Array.from(eventsById.values()).sort((a, b) => b.event_ts - a.event_ts)
        const alive = filterTombstonedEvents(sorted, get().deletedEventKeys)
        const { kept: capped, rollups } = capWatchEventsWithRollups(alive, state.rollups)
        const newSnapshot = { ...state.snapshot }
        const snapshotAcc = new Map<string, Record<string, SnapshotItem>>()
        for (const e of alive) {
            if (!Number.isFinite(e.event_ts)) continue
            const ctx = eventScopeKey(e)
            let acc = snapshotAcc.get(ctx)
            if (!acc) {
                acc = { ...(newSnapshot[ctx] || {}) }
                snapshotAcc.set(ctx, acc)
            }
            const existing = acc[e.itemId]
            if (existing && e.event_ts >= existing.mtime && existing.video_id === (e.video_id || e.itemId)) {
                // Same episode: the local marks and times stay; server rows carry neither.
                acc[e.itemId] = { ...existing, mtime: e.event_ts }
            } else if (!existing || e.event_ts >= existing.mtime) {
                acc[e.itemId] = {
                    mtime: e.event_ts,
                    video_id: e.video_id || e.itemId,
                    overallTimeWatched: e.time_watched || 0,
                    timeWatched: e.time_watched || 0,
                    timeOffset: e.time_watched_delta || 0,
                    duration: e.duration || 0,
                    season: e.season,
                    episode: e.episode,
                    fromServer: true,
                } as SnapshotItem
            }
        }
        for (const [ctx, acc] of snapshotAcc) newSnapshot[ctx] = acc

        set({ events: capped, snapshot: newSnapshot, rollups })
        persistWatchEvents()
    },

    mergeExternalWatchEvents: (accountId, platform, items, options) => {
        if (!items || items.length === 0) return
        const state = get()
        const now = Date.now()
        const ctx = watchContextKey(accountId, options?.sourceConnectionId)
        const eventAttribution = options?.sourceConnectionId ? { sourceConnectionId: options.sourceConnectionId, scopeKey: ctx } : {}
        const eventsById = new Map(state.events.map(e => [e.id, e]))
        const sessionKeys = new Set<string>()
        for (const e of state.events) {
            const ek = canonicalEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
            sessionKeys.add(`${eventScopeKey(e)}:${ek}:${getLocalDayKey(e.event_ts)}`)
        }
        const incomingEventIds = new Set<string>()
        const incomingDayVideoKeys = new Set<string>()
        let changed = false

        for (const item of items) {
            const video_id = item.video_id || item.itemId
            const episodeKey = getEpisodeIdentity(item.itemId, video_id, item.season, item.episode, item.type)
            const dayKey = getLocalDayKey(item.timestamp)
            const sessionKey = `${ctx}:${canonicalEpisodeIdentity(item.itemId, video_id, item.season, item.episode, item.type)}:${dayKey}`
            const eventId = `ext:${platform}:${ctx}:${episodeKey}:${dayKey}`
            incomingEventIds.add(eventId)
            incomingDayVideoKeys.add(`${dayKey}:${video_id}`)

            const duration = item.duration || 0
            const progress = item.progress ?? 0
            const timeWatched = duration > 0 ? Math.round(duration * (progress / 100)) : 0

            const existing = eventsById.get(eventId)
            if (existing) {
                const newDuration = Math.max(existing.duration || 0, duration)
                const newTimeWatched = Math.max(existing.time_watched || 0, timeWatched)
                if (newDuration !== existing.duration || newTimeWatched !== existing.time_watched) {
                    eventsById.set(eventId, {
                        ...existing,
                        duration: newDuration,
                        time_watched: newTimeWatched,
                        name: item.name || existing.name,
                        poster: item.poster || existing.poster,
                        season: item.season ?? existing.season,
                        episode: item.episode ?? existing.episode,
                        detected_ts: now,
                    })
                    changed = true
                }
                continue
            }

            if (sessionKeys.has(sessionKey)) continue

            const event: WatchEvent = {
                id: eventId,
                accountId,
                itemId: item.itemId,
                video_id,
                event_ts: item.timestamp,
                detected_ts: now,
                name: item.name || 'Unknown',
                type: item.type || 'other',
                poster: item.poster || '',
                time_watched: timeWatched,
                duration,
                season: item.season,
                episode: item.episode,
                source: platform,
                ...(item.backfill ? { backfill: true } : {}),
                ...eventAttribution,
            }
            eventsById.set(eventId, event)
            sessionKeys.add(sessionKey)
            changed = true
        }

        const surviving = evictLegacyExternalEvents(
            Array.from(eventsById.values()),
            { platform, accountId, sourceConnectionId: options?.sourceConnectionId, incomingEventIds, incomingDayVideoKeys },
            e => getLocalDayKey(e.event_ts),
        )
        if (surviving.length !== eventsById.size) changed = true

        if (!changed) return

        const sorted = surviving.sort((a, b) => b.event_ts - a.event_ts)
        const { kept: capped, rollups } = capWatchEventsWithRollups(
            filterTombstonedEvents(sorted, state.deletedEventKeys),
            state.rollups
        )
        set({ events: capped, rollups })
        persistWatchEvents()
    },
}))
