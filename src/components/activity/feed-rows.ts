import type { ActivityItem } from '../../types/activity'
import type { ActivityNowStatus } from '../../lib/jellyfin/activity'
import { localTimeZoneKey } from '../../lib/local-time-token.ts'
import { createWorkspaceResetSubscription } from '../../lib/workspace-reset-subscription.ts'
import { isPlausibleWatchMs } from '../../lib/watch-time.ts'

// Pure row-model helpers for the ActivityFeed long-history windowing.
// The component layers @tanstack/react-virtual on top of this model.

export type FeedViewMode = 'grid' | 'list'

export type NowStatusMap = ReadonlyMap<string, ActivityNowStatus>

/**
 * Presentation bucket for imported saved watch state (rows with `importedSavedState`):
 * they carry no watch date, so they never join a calendar-day group. The bucket sorts
 * after every dated group and exposes no `activity-date-*` anchor.
 */
export const SAVED_GROUP_DATE = 'Saved watch history'

export interface DateGroup {
    date: string
    dateId: string
    items: ActivityItem[]
    watchCount: number
}

export type FeedRow =
    | { kind: 'section'; key: string; date: string; dateId: string; items: ActivityItem[]; watchCount: number }
    | { kind: 'header'; key: string; date: string; dateId: string; watchCount: number }
    | { kind: 'cards'; key: string; date: string; items: ActivityItem[]; first: boolean; last: boolean }

export interface BuildFeedRowsOptions {
    viewMode: FeedViewMode
    /** Grid column count; list mode always forces 1 regardless of this value. */
    columns: number
    /** Groups spanning at most this many card lines render as one whole section row. Default 3. */
    smallGroupRows?: number
    /** Total row budget above which the feed switches to windowed rendering. Default 60. */
    virtualizeThreshold?: number
    /** Revealed-item budget above which the feed switches to windowed rendering, even
     *  when the row count is still small (wide grids pack many cards per row). Default 120. */
    virtualizeItemThreshold?: number
    /** NOW statuses; within each calendar day, NOW items sort ahead of the rest. */
    nowStatuses?: NowStatusMap
}

export interface FeedRowsResult {
    rows: FeedRow[]
    totalRows: number
    shouldVirtualize: boolean
    /** Item id → index of the row that renders it (cards rows only). */
    itemIdToRowIndex: Map<string, number>
    /** One entry per date group: where its `activity-date-<dateId>` anchor belongs. */
    groupAnchors: Array<{ dateId: string; rowIndex: number; key: string }>
    /** How many items are actually revealed (≤ visibleCount). */
    visibleItemCount: number
    /** Groups of the revealed slice (plain-rendering path); watchCount is the FULL day total. */
    visibleGroups: DateGroup[]
}

/** Returns `prev` while `next` holds the same id:status pairs, so memo dependencies stay put across ticks. */
export function keepNowStatusIdentity<T extends NowStatusMap>(prev: T | undefined, next: T): T {
    if (!prev || prev.size !== next.size) return next
    for (const [id, status] of next) if (prev.get(id) !== status) return next
    return prev
}

function nowTier(item: ActivityItem, nowStatuses?: NowStatusMap): number {
    const status = nowStatuses?.get(item.id)
    return status === 'playing' ? 0 : status === 'recent' ? 1 : 2
}

/** The row's parsed watch date, or null when it is invalid or a pre-1995 placeholder. */
function plausibleDay(timestamp: ActivityItem['timestamp']): Date | null {
    const d = new Date(timestamp)
    return isPlausibleWatchMs(d.getTime()) ? d : null
}

function dayStart(timestamp: ActivityItem['timestamp']): number {
    const d = plausibleDay(timestamp)
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : -Infinity
}

function compareNewestFirst(a: ActivityItem, b: ActivityItem, nowStatuses?: NowStatusMap): number {
    // Undated saved state always sorts after dated rows (including invalid
    // timestamps) so it can only ever form the trailing group.
    const savedA = a.importedSavedState === true
    const savedB = b.importedSavedState === true
    if (savedA !== savedB) return savedA ? 1 : -1
    if (nowStatuses && nowStatuses.size > 0) {
        const dayA = dayStart(a.timestamp)
        const dayB = dayStart(b.timestamp)
        if (dayA !== dayB) return dayB > dayA ? 1 : -1
        const tier = nowTier(a, nowStatuses) - nowTier(b, nowStatuses)
        if (tier !== 0) return tier
    }
    const ta = new Date(a.timestamp).getTime()
    const tb = new Date(b.timestamp).getTime()
    return (isNaN(tb) ? -Infinity : tb) - (isNaN(ta) ? -Infinity : ta)
}

// The comparator reads exactly (importedSavedState, timestamp, id-tier via the
// shared statuses map), so a cached key per item object is a complete summary.
// The overlay replaces items instead of mutating them, so a changed item is a
// new object and always rekeys. Keys carry no day component, so the runtime
// zone is not part of this cache.
interface FeedSortKey { saved: boolean; ts: number }
let sortKeyCache = new WeakMap<ActivityItem, FeedSortKey>()

function feedSortKey(item: ActivityItem): FeedSortKey {
    const cached = sortKeyCache.get(item)
    if (cached) return cached
    const time = new Date(item.timestamp).getTime()
    const key = { saved: item.importedSavedState === true, ts: isNaN(time) ? -Infinity : time }
    sortKeyCache.set(item, key)
    return key
}

// Sorting and grouping are pure per (items, nowStatuses, zone) triple, and the
// feed asks for them on every reveal increment while the inputs hold still.
// The status-variant slot is BOUNDED to the latest status map plus the
// status-free order: live playback can mint a new status map on every poll
// transition, and retaining one sorted array per transition is unbounded.
// The zone is part of the key because the comparator partitions by local
// calendar day. Callers never mutate the returned array.
interface SortedFeedEntry {
    zone: string
    slots: number
    free?: ActivityItem[]
    lastStatuses?: NowStatusMap
    lastSorted?: ActivityItem[]
}
let sortedFeedCache = new WeakMap<ActivityItem[], SortedFeedEntry>()
// One-step order reuse: the metadata overlay republishes the feed with a few
// items replaced by equal-key copies (new name/poster, same id and sort key).
// Re-sorting that is wasted work; remapping the previous sorted order through
// the replacements is exact, because equal keys at equal positions leave every
// pairwise comparator result unchanged. The zone must match too: equal-key
// reuse only proves the old order correct for the zone it was computed in.
let lastSortedFeed: { items: ActivityItem[]; statuses: NowStatusMap | undefined; sorted: ActivityItem[]; zone: string } | null = null

function sortFeedItemsFresh(items: ActivityItem[], nowStatuses?: NowStatusMap): ActivityItem[] {
    return [...items].sort((a, b) => compareNewestFirst(a, b, nowStatuses))
}

function sortedFeedOrderReusable(
    items: ActivityItem[],
    prev: ActivityItem[],
    statuses: NowStatusMap | undefined,
): boolean {
    if (prev.length !== items.length) return false
    for (let i = 0; i < items.length; i++) {
        const a = items[i]
        const b = prev[i]
        if (a === b) continue
        if (a.id !== b.id) return false
        const ka = feedSortKey(a)
        const kb = feedSortKey(b)
        if (ka.saved !== kb.saved || ka.ts !== kb.ts) return false
        if (statuses && statuses.size > 0 && nowTier(a, statuses) !== nowTier(b, statuses)) return false
    }
    return true
}

export function sortFeedItems(items: ActivityItem[], nowStatuses?: NowStatusMap): ActivityItem[] {
    // The workspace-release subscription below activates on this first cache
    // use: importing or resetting the module without touching a cache
    // (resetAllStores) must not install a listener.
    workspaceSubscription.ensure()
    const zone = localTimeZoneKey()
    let entry = sortedFeedCache.get(items)
    if (!entry || entry.zone !== zone) {
        entry = { zone, slots: 0 }
        sortedFeedCache.set(items, entry)
    }
    if (nowStatuses === undefined && entry.free) return entry.free
    if (nowStatuses !== undefined && entry.lastStatuses === nowStatuses && entry.lastSorted) return entry.lastSorted

    let sorted: ActivityItem[] | null = null
    const last = lastSortedFeed
    if (last && last.zone === zone && last.statuses === nowStatuses && sortedFeedOrderReusable(items, last.items, nowStatuses)) {
        // Same ids in the same positions with equal sort keys: carry the previous
        // order over the current item objects. Only replaced positions need remapping.
        const replacementsById = new Map<string, ActivityItem>()
        for (let i = 0; i < items.length; i++) {
            if (items[i] !== last.items[i]) replacementsById.set(items[i].id, items[i])
        }
        sorted = replacementsById.size === 0
            ? last.sorted
            : last.sorted.map(prev => replacementsById.get(prev.id) ?? prev)
    }
    if (!sorted) sorted = sortFeedItemsFresh(items, nowStatuses)

    if (nowStatuses === undefined) {
        if (!entry.free) entry.slots++
        entry.free = sorted
    } else {
        if (!entry.lastSorted) entry.slots++
        entry.lastStatuses = nowStatuses
        entry.lastSorted = sorted
    }
    lastSortedFeed = { items, statuses: nowStatuses, sorted, zone }
    return sorted
}

/** Same grouping semantics the feed always had: newest-first, one bucket per calendar day, invalid timestamps last; undated saved state gets its own explicit trailing bucket instead of borrowing the observation-time day. */
export function groupByDate(items: ActivityItem[], nowStatuses?: NowStatusMap): DateGroup[] {
    return groupSortedByDate(sortFeedItems(items, nowStatuses), localTimeZoneKey())
}

/** Group already-sorted items without re-sorting (a sorted prefix stays sorted). */
// Calendar-day strings are pure per (item, zone); the overlay republishes the
// feed with replaced copies, so a WeakMap keeps grouping O(n) cheap lookups.
// A runtime zone switch invalidates every day key, so the zone rides the entry.
interface DayKeyEntry { zone: string; key: string; dateId: string }
let dayKeyCache = new WeakMap<ActivityItem, DayKeyEntry>()
let fullDayCountsCache = new WeakMap<ActivityItem[], { zone: string; counts: Map<string, number> }>()

// Day counts depend only on each row's (id, timestamp, importedSavedState) within
// one zone; copies that keep those equal produce identical counts, so the previous
// map is reusable only while the zone holds.
let lastDayCounts: { items: ActivityItem[]; counts: Map<string, number>; zone: string } | null = null

// One parse feeds both the group key and the anchor id; WebKit reparses year 0 keys as 1900+.
function dayKeyOf(item: ActivityItem, zone: string): DayKeyEntry {
    const cached = dayKeyCache.get(item)
    if (cached && cached.zone === zone) return cached
    let entry: DayKeyEntry
    if (item.importedSavedState === true) {
        entry = { zone, key: SAVED_GROUP_DATE, dateId: '' }
    } else {
        const date = plausibleDay(item.timestamp)
        entry = date
            ? { zone, key: date.toDateString(), dateId: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
            : { zone, key: 'Unknown Date', dateId: '' }
    }
    dayKeyCache.set(item, entry)
    return entry
}

// Day-count equality check for the reuse path: copies that keep (id,
// importedSavedState, timestamp) equal produce identical counts within a zone.
function dayCountsReusable(items: ActivityItem[], prev: ActivityItem[]): boolean {
    if (prev.length !== items.length) return false
    for (let i = 0; i < items.length; i++) {
        const a = items[i]
        const b = prev[i]
        if (a === b) continue
        if (a.id !== b.id || a.importedSavedState !== b.importedSavedState) return false
        const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime()
        const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime()
        if (isNaN(ta) !== isNaN(tb) || (!isNaN(ta) && ta !== tb)) return false
    }
    return true
}

function groupSortedByDate(sorted: ActivityItem[], zone: string): DateGroup[] {
    const dates: string[] = []
    const itemsByDate: Record<string, ActivityItem[]> = {}
    const dateIdByKey = new Map<string, string>()

    for (const item of sorted) {
        const { key: dateStr, dateId } = dayKeyOf(item, zone)
        if (!itemsByDate[dateStr]) {
            itemsByDate[dateStr] = []
            dates.push(dateStr)
            dateIdByKey.set(dateStr, dateId)
        }
        itemsByDate[dateStr].push(item)
    }

    return dates.map(date => ({ date, dateId: dateIdByKey.get(date) ?? '', items: itemsByDate[date], watchCount: itemsByDate[date].length }))
}

/**
 * Slice-first row model: exactly `visibleCount` items are revealed (item-boundary
 * cut, mid-group allowed), then grouped and decomposed into windowable rows.
 * Small groups stay a single `section` row so short histories keep the exact
 * DOM they always had; large groups become a header row plus one row per card
 * line so same-day outliers can be windowed instead of mounted wholesale.
 * `watchCount` on headers/sections reports the FULL day total (pre-slice), so
 * date chips never understate a day that is still being revealed.
 */
export function buildFeedRows(items: ActivityItem[], visibleCount: number, options: BuildFeedRowsOptions): FeedRowsResult {
    const columns = options.viewMode === 'list' ? 1 : Math.max(1, Math.round(options.columns))
    const smallGroupRows = options.smallGroupRows ?? 3
    // Window early: the plain-rendered path mounts every revealed card at once,
    // and on DPR-3 phones each card decodes its poster at intrinsic size, so a
    // 60-to-120-card reveal burst is the feed's worst memory moment. Windowed
    // rendering produces the same section markup with a bounded mounted range.
    const virtualizeThreshold = options.virtualizeThreshold ?? 24
    const virtualizeItemThreshold = options.virtualizeItemThreshold ?? 48

    const nowStatuses = options.nowStatuses
    const sorted = sortFeedItems(items, nowStatuses)
    const visibleItemCount = Math.max(0, Math.min(visibleCount, sorted.length))
    const sliced = visibleItemCount === sorted.length ? sorted : sorted.slice(0, visibleItemCount)

    // A slice of the sorted array is already in feed order; group it without re-sorting.
    const zone = localTimeZoneKey()
    const groups = groupSortedByDate(sliced, zone)
    let fullDayCounts: Map<string, number>
    const fullDayCountsCacheHit = fullDayCountsCache.get(items)
    if (fullDayCountsCacheHit && fullDayCountsCacheHit.zone === zone) {
        fullDayCounts = fullDayCountsCacheHit.counts
    } else if (
        lastDayCounts && lastDayCounts.zone === zone && lastDayCounts.items.length === items.length
        && dayCountsReusable(items, lastDayCounts.items)
    ) {
        // Same rows by id with unchanged day keys (the overlay's replaced copies):
        // the full-day totals are identical, so reuse the previous counts map.
        fullDayCounts = lastDayCounts.counts
        fullDayCountsCache.set(items, { zone, counts: fullDayCounts })
    } else {
        fullDayCounts = new Map(groupByDate(items).map(g => [g.date, g.watchCount]))
        fullDayCountsCache.set(items, { zone, counts: fullDayCounts })
    }
    lastDayCounts = { items, counts: fullDayCounts, zone }

    const rows: FeedRow[] = []
    const groupAnchors: FeedRowsResult['groupAnchors'] = []
    const itemIdToRowIndex = new Map<string, number>()

    for (const group of groups) {
        const lines = Math.ceil(group.items.length / columns)
        const watchCount = fullDayCounts.get(group.date) ?? group.items.length

        if (lines <= smallGroupRows) {
            const rowIndex = rows.length
            groupAnchors.push({ dateId: group.dateId, rowIndex, key: `s:${group.date}` })
            rows.push({ kind: 'section', key: `s:${group.date}`, date: group.date, dateId: group.dateId, items: group.items, watchCount })
            // Section items need row indices too: focus pinning and keyboard
            // jumps to unmounted cards rely on the map for every visible item.
            for (const entry of group.items) itemIdToRowIndex.set(entry.id, rowIndex)
            continue
        }

        groupAnchors.push({ dateId: group.dateId, rowIndex: rows.length, key: `h:${group.date}` })
        rows.push({ kind: 'header', key: `h:${group.date}`, date: group.date, dateId: group.dateId, watchCount })

        for (let line = 0; line < lines; line++) {
            const chunk = group.items.slice(line * columns, line * columns + columns)
            const rowIndex = rows.length
            rows.push({ kind: 'cards', key: `c:${group.date}:${line}`, date: group.date, items: chunk, first: line === 0, last: line === lines - 1 })
            for (const entry of chunk) itemIdToRowIndex.set(entry.id, rowIndex)
        }
    }

    return {
        rows,
        totalRows: rows.length,
        shouldVirtualize: rows.length > virtualizeThreshold || visibleItemCount > virtualizeItemThreshold,
        itemIdToRowIndex,
        groupAnchors,
        visibleItemCount,
        visibleGroups: groups.map(group => ({ ...group, watchCount: fullDayCounts.get(group.date) ?? group.watchCount })),
    }
}

/** Visual item order across all rows (matches the revealed sort order). */
export function buildItemOrder(rows: FeedRow[]): string[] {
    const order: string[] = []
    for (const row of rows) {
        if (row.kind === 'header') continue
        for (const entry of row.items) order.push(entry.id)
    }
    return order
}

/** Linear focus movement along the visual item order; null at the ends. */
export function resolveFocusTarget(order: string[], currentId: string, delta: number): string | null {
    const index = order.indexOf(currentId)
    if (index < 0) return null
    const next = index + delta
    if (next < 0 || next >= order.length) return null
    return order[next]
}

/** Tailwind default viewport breakpoints used by the feed grid (grid-cols-2 sm:3 md:4 lg:5 xl:6). */
export const GRID_BREAKPOINT_COLUMNS: ReadonlyArray<{ minWidth: number; columns: number }> = [
    { minWidth: 1280, columns: 6 },
    { minWidth: 1024, columns: 5 },
    { minWidth: 768, columns: 4 },
    { minWidth: 640, columns: 3 },
]

/**
 * Release every module-level cache root this module owns. Invoked on sign-out
 * and workspace switch (store-coordinator) so a previous workspace's feed rows
 * and sorted orders are never retained until the next Activity visit.
 */
export function resetActivityRowCaches(): void {
    sortedFeedCache = new WeakMap()
    dayKeyCache = new WeakMap()
    fullDayCountsCache = new WeakMap()
    sortKeyCache = new WeakMap()
    lastSortedFeed = null
    lastDayCounts = null
    workspaceSubscription.release()
}

// Namespace transitions (login, session expiry, the sync-store reset) switch
// persistence directly and never run the store-coordinator reset, so this
// subscription is what releases the previous workspace's roots on every
// actual transition; explicit logout still goes through resetAllStores. It
// activates on the first cache use, is released by the reset above, and its
// HMR dispose keeps superseded module generations from stacking listeners.
const workspaceSubscription = createWorkspaceResetSubscription(resetActivityRowCaches, import.meta.hot)

/** Cache-shape introspection for tests: the latest feed's retained variant slots. */
export function activityRowCacheStatsForTests(): { lastFeedStatusSlots: number } {
    return { lastFeedStatusSlots: lastSortedFeed && sortedFeedCache.get(lastSortedFeed.items) ? (sortedFeedCache.get(lastSortedFeed.items) as SortedFeedEntry).slots : 0 }
}

export function detectGridColumns(matches: (query: string) => boolean, fallback = 2): number {
    for (const breakpoint of GRID_BREAKPOINT_COLUMNS) {
        if (matches(`(min-width: ${breakpoint.minWidth}px)`)) return breakpoint.columns
    }
    return fallback
}

const GRID_GAP = 16
const LIST_SPACING = 12
const LIST_CARD_HEIGHT = 134
const GRID_META_HEIGHT = 40

/** Best-effort row size estimates; runtime measurement corrects them after mount. */
export function estimateRowHeight(
    row: FeedRow,
    context: { viewMode: FeedViewMode; columns: number; containerWidth: number },
): number {
    const columns = context.viewMode === 'list' ? 1 : Math.max(1, context.columns)
    const width = Math.max(120, context.containerWidth)
    const columnWidth = (width - (columns - 1) * GRID_GAP) / columns
    const gridLine = columnWidth * 1.5 + GRID_META_HEIGHT

    if (row.kind === 'header') return 20 + 12
    if (row.kind === 'cards') {
        if (context.viewMode === 'list') return LIST_CARD_HEIGHT + LIST_SPACING
        return gridLine + (row.first ? LIST_SPACING : GRID_GAP)
    }
    const lines = Math.ceil(row.items.length / columns)
    const body = context.viewMode === 'list'
        ? lines * LIST_CARD_HEIGHT + (lines - 1) * LIST_SPACING
        : lines * gridLine + (lines - 1) * GRID_GAP
    return 24 + 20 + 12 + body
}

export function findRowIndexByKey(rows: FeedRow[], key: string): number {
    return rows.findIndex(row => row.key === key)
}
