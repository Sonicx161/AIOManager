import { create } from 'zustand'
import localforage from 'localforage'
import { WatchEvent, SnapshotItem, LibraryItem } from '@/types/activity'
import { Account } from '@/types/account'
import { getSeasonEpisode, parseStremioDate, isActuallyWatched, getLocalDayKey, getEpisodeIdentity } from '@/lib/activity-utils'
import { decodeWatchedBitfield } from '@/lib/watched-bitfield'
import { resolveWatchedEpisodes, fetchSeriesVideos } from '@/lib/watched-episodes'
import { evictLegacyExternalEvents } from '@/lib/external-watch-events'
import { EventRollups, emptyRollups, capWatchEventsWithRollups, mergeRollups } from '@/lib/watch-event-rollups'
import { isIdentityDeleted } from '@/lib/event-tombstones'

const STORAGE_KEY = 'aio_watch_events_v2'

// Per-session guard: `${accountId}:${seriesId}:${watchedString}` already attempted, so repeated
// library refreshes don't re-decode + re-fetch Cinemeta for unchanged series.
const backfillProcessed = new Set<string>()
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') backfillProcessed.clear()
  })
}

// Snapshot: { [accountId]: { [itemId]: SnapshotItem } }
type Snapshot = Record<string, Record<string, SnapshotItem>>

function isSeriesItem(item: LibraryItem): boolean {
    return item.type === 'series' || item.type === 'anime' || item.type === 'episode'
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
    deletedEventKeys: Record<string, number>
    rollups: EventRollups
    initialized: boolean

    initialize: (events: WatchEvent[], snapshot: Snapshot, deletedEventKeys?: Record<string, number>, rollups?: EventRollups) => void
    load: () => Promise<void>

    removeEvents: (items: Array<{ accountId: string; itemId: string; uniqueItemId?: string; season?: number; episode?: number; type: string }>) => void

    patchSnapshot: (accountId: string, itemId: string, patch: Partial<SnapshotItem>) => void

    diffAndRecord: (
        accountId: string,
        items: LibraryItem[],
        account: Account,
        accounts: Account[]
    ) => WatchEvent[]

    mergeServerEvents: (serverEvents: ServerActivityEvent[]) => void

    mergeExternalWatchEvents: (accountId: string, platform: string, items: ExternalWatchItem[]) => void

    recordBackfillEpisodes: (accountId: string, items: LibraryItem[]) => Promise<number>

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
}

function withFoldedServerIds(winner: WatchEvent, folded: WatchEvent): WatchEvent {
    const ids = new Set([...(winner.serverIds ?? []), folded.id, ...(folded.serverIds ?? [])])
    ids.delete(winner.id)
    if (ids.size === (winner.serverIds?.length ?? 0)) return winner
    return { ...winner, serverIds: Array.from(ids) }
}

function collapseDayDuplicates(events: WatchEvent[]): WatchEvent[] {
    const byKey = new Map<string, WatchEvent>()
    for (const e of events) {
        const ek = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
        const key = `${e.accountId}:${ek}:${getLocalDayKey(e.event_ts)}`
        const existing = byKey.get(key)
        if (!existing) {
            byKey.set(key, e)
            continue
        }
        const [winner, loser] = e.event_ts > existing.event_ts ||
            (e.event_ts === existing.event_ts && e.detected_ts > existing.detected_ts)
            ? [e, existing]
            : [existing, e]
        byKey.set(key, withFoldedServerIds(winner, loser))
    }
    return byKey.size === events.length ? events : Array.from(byKey.values()).sort((a, b) => b.event_ts - a.event_ts)
}

const PERSIST_DEBOUNCE_MS = 300
let _persistTimer: ReturnType<typeof setTimeout> | null = null
let _pendingDeleted: Record<string, number> | null = null

async function persistWatchEventsNow() {
    _persistTimer = null
    const { events, snapshot, rollups } = useWatchEventStore.getState()
    const deleted = _pendingDeleted
    _pendingDeleted = null
    try {
        await localforage.setItem(STORAGE_KEY, { events, snapshot, rollups })
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

export function watchEventIdentityKey(e: { accountId: string; itemId: string; video_id?: string; season?: number; episode?: number; type: string }): string {
    return `${e.accountId}:${getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)}`
}

function isEventTombstoned(e: WatchEvent, deleted: Record<string, number>): boolean {
    return isIdentityDeleted(watchEventIdentityKey(e), deleted, e.event_ts)
}

function filterTombstonedEvents(events: WatchEvent[], deleted: Record<string, number> | undefined): WatchEvent[] {
    if (!deleted || Object.keys(deleted).length === 0) return events
    return events.filter(e => !isEventTombstoned(e, deleted))
}

function capDeletedEvents(deleted: Record<string, number>, survivingEvents: WatchEvent[]): Record<string, number> {
    const entries = Object.entries(deleted)
    if (entries.length <= DELETED_EVENTS_CAP) return deleted
    const survivingKeys = new Set(survivingEvents.map(watchEventIdentityKey))
    const kept = entries
    const evictable = kept.filter(([key]) => !survivingKeys.has(key))
    const pinned = kept.filter(([key]) => survivingKeys.has(key))
    evictable.sort((a, b) => b[1] - a[1])
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
    deletedEventKeys: {},
    rollups: emptyRollups(),
    initialized: false,

    initialize: (events, snapshot, deletedEventKeys, incomingRollups) => {
        const cleaned = events.filter(e => {
            const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
            if (!isSeries) return true
            if (e.season != null && e.season > 100) return false
            if (e.episode != null) return true
            if (e.season != null) return true
            if (e.video_id !== e.itemId) return true
            return false
        })
        const deleted = deletedEventKeys ?? get().deletedEventKeys
        const alive = filterTombstonedEvents(collapseDayDuplicates(cleaned), deleted)
        const { kept: capped, rollups: folded } = capWatchEventsWithRollups(alive, get().rollups)
        const rollups = incomingRollups ? mergeRollups(folded, incomingRollups) : folded
        set({ events: capped, snapshot, rollups, deletedEventKeys: deleted, initialized: true })
        persistWatchEvents()
        if (deletedEventKeys) persistDeletedEvents(deleted)
    },

    load: async () => {
        const state = get()
        if (state.initialized) return
        try {
            const deleted = (await localforage.getItem<Record<string, number>>(DELETED_EVENTS_KEY)) || {}
            const stored = await localforage.getItem<{ events: WatchEvent[]; snapshot: Snapshot; rollups?: EventRollups }>(STORAGE_KEY)
            if (stored && stored.events) {
                const cleaned = stored.events.filter(e => {
                    const isSeries = e.type === 'series' || e.type === 'anime' || e.type === 'episode'
                    if (!isSeries) return true
                    if (e.season != null && e.season > 100) return false
                    if (e.episode != null) return true
                    if (e.season != null) return true
                    if (e.video_id !== e.itemId) return true
                    return false
                })
                const collapsed = filterTombstonedEvents(collapseDayDuplicates(cleaned), deleted)
                const rollups = stored.rollups ? { ...emptyRollups(), ...stored.rollups } : get().rollups
                set({ events: collapsed, snapshot: stored.snapshot || {}, rollups, deletedEventKeys: deleted, initialized: true })
                if (collapsed.length !== stored.events.length) persistWatchEvents()
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
            const key = `${it.accountId}:${getEpisodeIdentity(it.itemId, it.uniqueItemId, it.season, it.episode, it.type)}`
            deleted[key] = now
            targetKeys.add(key)
        }
        // Mirror the drop onto the server's activity rows, fire-and-forget: every stored
        // event carrying a just-tombstoned identity is deleted by its (server-assigned) id.
        // Server events merged earlier keep their evt_… ids locally, so this reaches exactly
        // the rows that exist; anything missed re-merges on the next pull and stays hidden
        // behind the absolute tombstone.
        const serverEventIds = state.events
            .filter(e => targetKeys.has(watchEventIdentityKey(e)))
            .flatMap(e => [e.id, ...(e.serverIds ?? [])])
        const capped = capDeletedEvents(deleted, state.events)
        const events = filterTombstonedEvents(state.events, capped)
        set({ events, deletedEventKeys: capped })
        persistWatchEvents()
        persistDeletedEvents(capped)
        if (serverEventIds.length > 0) {
            void import('@/lib/activity-server')
                .then(m => m.deleteServerActivityEvents(serverEventIds))
                .catch(() => { })
        }
    },

    // Syncs the differencer after a self-inflicted row rewrite (per-episode delete); without it,
    // the next diff infers a phantom watch for the repointed anchor.
    patchSnapshot: (accountId, itemId, patch) => {
        const state = get()
        const current = state.snapshot[accountId]?.[itemId]
        if (!current) return
        set({
            snapshot: {
                ...state.snapshot,
                [accountId]: { ...(state.snapshot[accountId] || {}), [itemId]: { ...current, ...patch } },
            },
        })
        persistWatchEvents()
    },

    diffAndRecord: (accountId, items, _account, _accounts) => {
        const now = Date.now()
        const state = get()
        const accountSnapshot = state.snapshot[accountId] || {}
        const newEvents: WatchEvent[] = []
        const updatedSnapshot = { ...accountSnapshot }
        const existingEventIds = new Set(state.events.map(e => e.id))
        const existingSessionEvents = new Map<string, WatchEvent>()
        let snapshotChanged = false

        for (const event of state.events) {
            const episodeKey = getEpisodeIdentity(event.itemId, event.video_id, event.season, event.episode, event.type)
            const key = `${event.accountId}:${episodeKey}:${getLocalDayKey(event.event_ts)}`
            const existing = existingSessionEvents.get(key)
            if (
                !existing ||
                event.event_ts > existing.event_ts ||
                (event.event_ts === existing.event_ts && event.detected_ts > existing.detected_ts)
            ) {
                existingSessionEvents.set(key, event)
            }
        }

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
                current.episode !== next.episode
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
            const sessionKey = `${accountId}:${episodeKey}:${getLocalDayKey(prior.mtime)}`
            if (existingSessionEvents.has(sessionKey)) return

            const eventId = `${accountId}:${prior.video_id}:${prior.mtime}`
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
            }

            newEvents.push(event)
            existingEventIds.add(eventId)
            existingSessionEvents.set(sessionKey, event)
        }

        for (const item of items) {
            if (!item._id) continue

            const mtimeDate = parseStremioDate(item._mtime)
            const mtime = mtimeDate ? mtimeDate.getTime() : 0
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
                    setSnapshotItem(item._id, { mtime, video_id, overallTimeWatched: 0, timeWatched: 0, timeOffset: 0 })
                    continue
                }
                const isSeries = isSeriesItem(item)
                const hasVideoId = !!(item.state?.video_id && item.state.video_id.trim() !== '')
                if (!isSeries || hasVideoId) {
                    const ctimeDate = parseStremioDate(item._ctime)
                    const lastWatchedDate = parseStremioDate(item.state?.lastWatched)
                    const seedTs = Math.max(
                        ctimeDate?.getTime() ?? 0,
                        lastWatchedDate?.getTime() ?? 0,
                        mtime
                    )
                    if (seedTs > 0) {
                        const seedId = `${accountId}:${video_id}:${seedTs}`
                        if (!existingEventIds.has(seedId)) {
                            const { season, episode } = getSeasonEpisode(item)
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
                                season: sanitizeSeason(season),
                                episode,
                            })
                            existingEventIds.add(seedId)
                        }
                    }
                }
                const { season: seedSeason, episode: seedEpisode } = getSeasonEpisode(item)
                setSnapshotItem(item._id, {
                    mtime, video_id,
                    overallTimeWatched: item.state?.overallTimeWatched || 0,
                    timeWatched: item.state?.timeWatched || 0,
                    timeOffset: item.state?.timeOffset || 0,
                    duration: item.state?.duration || 0,
                    season: sanitizeSeason(seedSeason),
                    episode: seedEpisode,
                })
                continue
            }


            const mtimeChanged = mtime > prior.mtime
            const { season: rawCurrentSeason, episode: currentEpisode } = getSeasonEpisode(item)
            const currentSeason = sanitizeSeason(rawCurrentSeason)
            const episodeAdvanced = video_id !== prior.video_id ||
                currentSeason !== prior.season ||
                currentEpisode !== prior.episode

            if (isActuallyWatched(item) && (episodeAdvanced || !mtimeChanged)) {
                preserveSnapshotEvent(item, prior)
            }

            if ((mtimeChanged || episodeAdvanced) && isActuallyWatched(item)) {
                const currentOverall = item.state?.overallTimeWatched || 0
                const priorOverall = prior.overallTimeWatched || 0
                const delta = Math.max(0, currentOverall - priorOverall)
                const currentTW = item.state?.timeWatched || 0
                const priorTW = prior.timeWatched || 0
                const deltaTW = Math.max(0, currentTW - priorTW)
                const watchedDelta = delta || deltaTW
                const episodeKey = getEpisodeIdentity(item._id, video_id, currentSeason, currentEpisode, item.type || 'other')
                const sessionKey = `${accountId}:${episodeKey}:${getLocalDayKey(mtime)}`
                const mergeCandidate = !episodeAdvanced
                    ? existingSessionEvents.get(sessionKey)
                    : undefined

                if (mergeCandidate) {
                    const mergedEvent = {
                        ...mergeCandidate,
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
                    const eventId = `${accountId}:${video_id}:${mtime}`
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
                        })
                        existingEventIds.add(eventId)
                    }
                }
            }

            if (mtimeChanged || episodeAdvanced) {
                setSnapshotItem(item._id, {
                    mtime, video_id,
                    overallTimeWatched: item.state?.overallTimeWatched || 0,
                    timeWatched: item.state?.timeWatched || 0,
                    timeOffset: item.state?.timeOffset || 0,
                    duration: item.state?.duration || 0,
                    season: currentSeason,
                    episode: currentEpisode,
                })
            }
        }

        if (newEvents.length === 0 && !snapshotChanged) {
            return []
        }

        const merged = [...state.events, ...newEvents]
        const deduped = Array.from(new Map(merged.map(e => [e.id, e])).values())
        const sorted = deduped.sort((a, b) => b.event_ts - a.event_ts)
        const { kept: capped, rollups } = capWatchEventsWithRollups(
            filterTombstonedEvents(sorted, get().deletedEventKeys),
            state.rollups
        )

        const nextSnapshot = {
            ...state.snapshot,
            [accountId]: { ...accountSnapshot, ...updatedSnapshot },
        }

        set({
            events: capped,
            snapshot: nextSnapshot,
            rollups,
        })

        persistWatchEvents()
        return newEvents
    },

    // Backfill complete per-episode history from Stremio's watched-bitfield for tt series. Fills
    // gaps the live video_id sampling misses (binges / batched device syncs). Events are marked
    // backfill (synthetic timestamp -> excluded from time-based Replay stats) and deduped against
    // any existing event for the same episode, so real watch data always wins and nothing double-counts.
    recordBackfillEpisodes: async (accountId, items) => {
        const state = get()
        const existingIdentities = new Set<string>()
        for (const e of state.events) {
            if (e.accountId !== accountId) continue
            existingIdentities.add(getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type))
        }
        const existingIds = new Set(state.events.map(e => e.id))
        const now = Date.now()
        const newEvents: WatchEvent[] = []

        for (const item of items) {
            const seriesId = item._id
            if (!seriesId || !isSeriesItem(item) || !seriesId.startsWith('tt')) continue

            const guardKey = `${accountId}:${seriesId}:${item.state?.watched || ''}`
            if (backfillProcessed.has(guardKey)) continue

            const decoded = await decodeWatchedBitfield(item.state?.watched)
            if (!decoded || decoded.watchedIndices.length === 0) { backfillProcessed.add(guardKey); if (backfillProcessed.size > 2000) backfillProcessed.clear(); continue }
            const videos = await fetchSeriesVideos(seriesId)
            if (!videos) continue // transient (meta fetch failed) -> retry on a later refresh
            const episodes = resolveWatchedEpisodes(decoded, videos)
            if (!episodes) continue // fail-closed checksum did not pass -> retry on a later refresh
            backfillProcessed.add(guardKey)
            if (backfillProcessed.size > 2000) backfillProcessed.clear()

            const lastWatchedTs = parseStremioDate(item.state?.lastWatched)?.getTime()
                || parseStremioDate(item._mtime)?.getTime()
            const ts = lastWatchedTs || now

            for (const ep of episodes) {
                const season = ep.season ?? undefined
                const episode = ep.episode ?? undefined
                const identity = getEpisodeIdentity(seriesId, ep.videoId, season, episode, item.type || 'series')
                if (existingIdentities.has(identity)) continue // real event already covers this episode
                // A fabricated ts would bypass the tombstone gate; tombstoned identities backfill from real dates only.
                if (lastWatchedTs === undefined && isIdentityDeleted(`${accountId}:${identity}`, get().deletedEventKeys)) continue
                const id = `bf:${accountId}:${ep.videoId}`
                if (existingIds.has(id)) continue

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
                })
                existingIdentities.add(identity)
                existingIds.add(id)
            }
        }

        if (newEvents.length === 0) return 0

        const cur = get()
        const merged = [...cur.events, ...newEvents]
        const deduped = Array.from(new Map(merged.map(e => [e.id, e])).values())
        const sorted = deduped.sort((a, b) => b.event_ts - a.event_ts)
        const { kept: capped, rollups } = capWatchEventsWithRollups(
            filterTombstonedEvents(sorted, get().deletedEventKeys),
            cur.rollups
        )
        set({ events: capped, rollups })
        persistWatchEvents()
        return newEvents.length
    },

    export: () => ({
        events: get().events,
        snapshot: get().snapshot,
        deletedEvents: get().deletedEventKeys,
        rollups: get().rollups,
    }),

    reset: () => {
        cancelPendingPersist()
        // Deletes are durable: reset clears watch data but NEVER the tombstones — wiping
        // them would resurrect every deleted event on the next pull.
        const deleted = get().deletedEventKeys
        set({ events: [], snapshot: {}, deletedEventKeys: deleted, rollups: emptyRollups(), initialized: false })
        localforage.removeItem(STORAGE_KEY).catch(() => {})
        if (Object.keys(deleted).length > 0) persistDeletedEvents(deleted)
    },

    mergeServerEvents: (serverEvents) => {
        if (!serverEvents || serverEvents.length === 0) return
        const state = get()
        const now = Date.now()
        const eventsById = new Map(state.events.map(e => [e.id, e]))
        const localDayKeys = new Map<string, string>()
        for (const e of state.events) {
            const ek = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
            localDayKeys.set(`${e.accountId}:${ek}:${getLocalDayKey(e.event_ts)}`, e.id)
        }
        const newEvents: WatchEvent[] = []
        let changed = false

        for (const se of serverEvents) {
            if (se.season != null && se.season > 100) continue
            const video_id = se.videoId || se.uniqueItemId || se.itemId
            const event: WatchEvent = {
                id: se.id,
                accountId: se.accountId,
                itemId: se.itemId,
                video_id,
                event_ts: se.timestamp,
                detected_ts: now,
                name: se.name || 'Unknown',
                type: se.type || 'other',
                poster: se.poster || '',
                time_watched: se.progress || se.watched || 0,
                time_watched_delta: undefined,
                duration: se.duration || 0,
                season: se.season ?? undefined,
                episode: se.episode ?? undefined,
                timesWatched: (se as { timesWatched?: number }).timesWatched,
            }

            const existingEvent = eventsById.get(se.id)
            if (existingEvent) {
                const mergedEvent = { ...existingEvent, ...event }
                if (
                    existingEvent.video_id !== mergedEvent.video_id ||
                    existingEvent.time_watched !== mergedEvent.time_watched ||
                    existingEvent.duration !== mergedEvent.duration ||
                    existingEvent.season !== mergedEvent.season ||
                    existingEvent.episode !== mergedEvent.episode ||
                    existingEvent.event_ts !== mergedEvent.event_ts
                ) {
                    eventsById.set(se.id, mergedEvent)
                    changed = true
                }
                continue
            }

            const ek = getEpisodeIdentity(se.itemId, video_id, event.season, event.episode, event.type)
            const dayKey = `${se.accountId}:${ek}:${getLocalDayKey(se.timestamp)}`
            const coveringId = localDayKeys.get(dayKey)
            if (coveringId !== undefined) {
                const covering = eventsById.get(coveringId)
                if (covering && covering.id !== se.id && !covering.serverIds?.includes(se.id)) {
                    eventsById.set(coveringId, { ...covering, serverIds: [...(covering.serverIds ?? []), se.id] })
                    changed = true
                }
                continue
            }

            newEvents.push(event)
            eventsById.set(se.id, event)
            localDayKeys.set(dayKey, se.id)
            changed = true
        }

        if (newEvents.length === 0 && !changed) return

        const sorted = Array.from(eventsById.values()).sort((a, b) => b.event_ts - a.event_ts)
        const { kept: capped, rollups } = capWatchEventsWithRollups(
            filterTombstonedEvents(sorted, get().deletedEventKeys),
            state.rollups
        )
        const newSnapshot = { ...state.snapshot }
        const snapshotAcc = new Map<string, Record<string, SnapshotItem>>()
        for (const e of sorted) {
            let acc = snapshotAcc.get(e.accountId)
            if (!acc) {
                acc = { ...(newSnapshot[e.accountId] || {}) }
                snapshotAcc.set(e.accountId, acc)
            }
            const existing = acc[e.itemId]
            if (!existing || e.event_ts >= existing.mtime) {
                acc[e.itemId] = {
                    mtime: e.event_ts,
                    video_id: e.video_id || e.itemId,
                    overallTimeWatched: e.time_watched || 0,
                    timeWatched: e.time_watched || 0,
                    timeOffset: e.time_watched_delta || 0,
                    duration: e.duration || 0,
                    season: e.season,
                    episode: e.episode,
                } as SnapshotItem
            }
        }
        for (const [accountId, acc] of snapshotAcc) newSnapshot[accountId] = acc

        set({ events: capped, snapshot: newSnapshot, rollups })
        persistWatchEvents()
    },

    mergeExternalWatchEvents: (accountId, platform, items) => {
        if (!items || items.length === 0) return
        const state = get()
        const now = Date.now()
        const eventsById = new Map(state.events.map(e => [e.id, e]))
        const sessionKeys = new Set<string>()
        for (const e of state.events) {
            const ek = getEpisodeIdentity(e.itemId, e.video_id, e.season, e.episode, e.type)
            sessionKeys.add(`${e.accountId}:${ek}:${getLocalDayKey(e.event_ts)}`)
        }
        const incomingEventIds = new Set<string>()
        const incomingDayVideoKeys = new Set<string>()
        let changed = false

        for (const item of items) {
            const video_id = item.video_id || item.itemId
            const episodeKey = getEpisodeIdentity(item.itemId, video_id, item.season, item.episode, item.type)
            const dayKey = getLocalDayKey(item.timestamp)
            const sessionKey = `${accountId}:${episodeKey}:${dayKey}`
            const eventId = `ext:${platform}:${accountId}:${episodeKey}:${dayKey}`
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
            }
            eventsById.set(eventId, event)
            sessionKeys.add(sessionKey)
            changed = true
        }

        const surviving = evictLegacyExternalEvents(
            Array.from(eventsById.values()),
            { platform, accountId, incomingEventIds, incomingDayVideoKeys },
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
