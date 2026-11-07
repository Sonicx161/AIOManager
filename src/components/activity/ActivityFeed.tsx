
import { ActivityItem } from '@/types/activity'
import { isToday, isYesterday, format } from 'date-fns'
import { Activity, ArrowUp } from 'lucide-react'
import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { TabsTrigger } from '@/components/ui/tabs'
import { WorkspaceTabs } from '@/components/ui/workspace-tabs'
import { ActivityEmptyState } from '@/components/common/PageEmptyStates'
import { activityNowStatuses } from '@/lib/jellyfin/activity'
import { buildRuntimeIndex, msToHours } from '@/lib/watch-hours'
import { activityHeaderHoursCached } from '@/lib/activity-hours'
import {
    buildFeedRows,
    buildItemOrder,
    detectGridColumns,
    keepNowStatusIdentity,
    GRID_BREAKPOINT_COLUMNS,
    resolveFocusTarget,
    SAVED_GROUP_DATE,
} from './feed-rows'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { PullToRefreshIndicator } from './PullToRefreshIndicator'
import { ActivityDateHeader, ActivityItemSlot, VirtualActivityList } from './VirtualActivityList'

const INITIAL_VISIBLE_COUNT = 60
const VISIBLE_COUNT_INCREMENT = 40
const EMPTY_SELECTED_ITEMS = new Set<string>()
const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
const ACTIVITY_TAB_LABELS: Record<string, string> = {
    all: 'All Activity',
    now: 'Recent',
    movies: 'Movies',
    series: 'Series',
}

interface ActivityFeedProps {
    history: ActivityItem[]
    allHistory?: ActivityItem[]
    /** Raw watch rows (no backfill) the header hours are computed over, same as Metrics. */
    hoursSource?: ActivityItem[]
    /** Minutes folded out of the event log, added only when the whole feed is in view. */
    rollupMinutes?: number
    currentActivity?: ActivityItem[]
    viewMode?: 'grid' | 'list'
    /** Row ids in the viewer/search scope; credit is computed over these before the feed's tab and window apply. */
    hoursScope?: ReadonlySet<string>
    onToggleSelect?: (id: string | string[]) => void
    onDelete?: (id: string | string[], removeFromLibrary: boolean) => void
    onOpenDetail?: (item: ActivityItem) => void
    selectedItems?: Set<string>
    isBulkMode?: boolean
    /** Imported saved watch state (no watch dates): joined into the same bounded row
     *  model as an undated trailing group, so it reveals, keyboard-navigates and
     *  selects through the exact same windowing as dated rows. */
    importedSummaries?: ActivityItem[]
    /** History is still loading for the first time: counts show a placeholder, never partial numbers. */
    settling?: boolean
    /** A refresh is running over an already settled feed: the header keeps its last numbers. */
    refreshing?: boolean
    /** Page-level filters (viewer, period, search) that the header numbers depend on. */
    filterKey?: string
    canonicalConnections?: ReadonlyMap<string, string | undefined>
    /** The page's own refresh; enables phone pull-to-refresh when provided. */
    onRefresh?: () => unknown
}

export function ActivityFeed({
    history,
    allHistory = history,
    hoursSource = allHistory,
    rollupMinutes = 0,
    currentActivity,
    viewMode = 'grid',
    hoursScope,
    onToggleSelect,
    onDelete,
    onOpenDetail,
    selectedItems,
    isBulkMode = false,
    importedSummaries = [],
    settling = false,
    refreshing = false,
    filterKey = '',
    canonicalConnections,
    onRefresh,
}: ActivityFeedProps) {
    const safeSelectedItems = selectedItems ?? EMPTY_SELECTED_ITEMS
    const phone = usePhoneViewport()
    const pull = usePullToRefresh({ enabled: phone && !!onRefresh, onRefresh })
    const [activeTab, setActiveTab] = useState("all")
    const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
    const [showScrollTop, setShowScrollTop] = useState(false)
    const [now, setNow] = useState(Date.now)
    const [columns, setColumns] = useState(2)
    const [focusedId, setFocusedId] = useState<string | null>(null)
    useEffect(() => {
        const update = () => { if (!document.hidden) setNow(Date.now()) }
        const timer = setInterval(update, 30_000)
        document.addEventListener('visibilitychange', update)
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update) }
    }, [])
    const nowStatusesRef = useRef<ReturnType<typeof activityNowStatuses> | undefined>(undefined)
    const nowStatuses = useMemo(() => {
        const next = keepNowStatusIdentity(nowStatusesRef.current, activityNowStatuses(allHistory, now, currentActivity))
        nowStatusesRef.current = next
        return next
    }, [allHistory, now, currentActivity])

    useEffect(() => {
        setVisibleCount(INITIAL_VISIBLE_COUNT)
    }, [activeTab])

    // Grid column count mirrors the Tailwind viewport breakpoints used by the
    // card grid, so row chunking follows the responsive layout exactly.
    useEffect(() => {
        const update = () => setColumns(detectGridColumns(query => window.matchMedia(query).matches))
        update()
        const watchers = GRID_BREAKPOINT_COLUMNS.map(bp => window.matchMedia(`(min-width: ${bp.minWidth}px)`))
        watchers.forEach(w => w.addEventListener('change', update))
        return () => watchers.forEach(w => w.removeEventListener('change', update))
    }, [])

    useEffect(() => {
        let ticking = false
        const handleScroll = () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    setShowScrollTop(window.scrollY > 400)
                    ticking = false
                })
                ticking = true
            }
        }
        window.addEventListener('scroll', handleScroll, { passive: true })
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    const scrollToTop = () => {
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    // Undated saved state joins the SAME row model: it sorts after every dated row,
    // forms its own trailing group, and is revealed through the same visibleCount
    // window, keyboard order and selection set as dated rows.
    const combinedHistory = useMemo(
        () => (importedSummaries.length > 0 ? [...history, ...importedSummaries] : history),
        [history, importedSummaries],
    )

    const filteredHistory = useMemo(() => {
        let filtered = combinedHistory

        if (activeTab === 'movies') filtered = filtered.filter(h => h.type === 'movie')
        else if (activeTab === 'series') filtered = filtered.filter(h => h.type === 'series' || h.type === 'anime' || h.type === 'episode')
        else if (activeTab === 'now') {
            filtered = filtered.filter(h => nowStatuses.has(h.id))
        }

        return filtered
    }, [combinedHistory, activeTab, nowStatuses])

    // Long-history windowing model: exactly `visibleCount` items revealed (cut at
    // item boundaries, never whole date groups), decomposed into rows the
    // virtualizer can window when the feed grows long.
    const feedModel = useMemo(
        () => buildFeedRows(filteredHistory, visibleCount, { viewMode, columns, nowStatuses }),
        [filteredHistory, visibleCount, viewMode, columns, nowStatuses],
    )
    const hasMore = feedModel.visibleItemCount < filteredHistory.length
    const itemOrder = useMemo(() => buildItemOrder(feedModel.rows), [feedModel])

    const runtimeIndex = useMemo(() => buildRuntimeIndex(hoursSource), [hoursSource])
    // Stable identity for the visible-id set (rebuilt only when the filtered feed
    // changes) so the cached header-hours computation can hit across feed remounts.
    const visibleIdsRef = useRef<{ source: typeof filteredHistory; ids: Set<string> } | null>(null)
    if (!visibleIdsRef.current || visibleIdsRef.current.source !== filteredHistory) {
        const ids = new Set<string>()
        for (const item of filteredHistory) ids.add(item.id)
        visibleIdsRef.current = { source: filteredHistory, ids }
    }
    const visibleIds = visibleIdsRef.current.ids
    const headerHours = useMemo(() => {
        const { totalMs, todayMs, yesterdayMs } = activityHeaderHoursCached(hoursSource, runtimeIndex, canonicalConnections, Date.now(), hoursScope, visibleIds)
        return {
            total: msToHours(totalMs + (activeTab === 'all' ? rollupMinutes * 60000 : 0)),
            today: Math.round(todayMs / 360000) / 10,
            trend: todayMs >= yesterdayMs ? 'up' as const : 'down' as const,
        }
    }, [visibleIds, hoursSource, runtimeIndex, canonicalConnections, hoursScope, activeTab, rollupMinutes])
    const filteredWatchHours = headerHours.total
    const todayHours = headerHours.today
    const todayTrend = headerHours.trend
    const tabCounts = useMemo(() => {
        let now = 0
        let movies = 0
        let series = 0

        for (const item of combinedHistory) {
            if (nowStatuses.has(item.id)) now++
            if (item.type === 'movie') movies++
            if (item.type === 'series' || item.type === 'anime' || item.type === 'episode') series++
        }

        return {
            all: combinedHistory.length,
            now,
            movies,
            series,
        }
    }, [combinedHistory, nowStatuses])

    // Header numbers only change when the feed has settled or the user changes a filter.
    // During a refresh over a settled feed they keep their last values instead of flickering.
    const liveStats = { tabCounts, showing: feedModel.visibleItemCount, total: filteredHistory.length, hours: filteredWatchHours }
    const statsKey = `${filterKey}|${activeTab}`
    const frozenStatsRef = useRef<{ key: string; stats: typeof liveStats } | null>(null)
    if (!refreshing || frozenStatsRef.current === null || frozenStatsRef.current.key !== statsKey) {
        frozenStatsRef.current = { key: statsKey, stats: liveStats }
    }
    const stats = frozenStatsRef.current.stats

    const formatDateHeader = useCallback((dateStr: string) => {
        if (dateStr === 'Unknown Date' || dateStr === SAVED_GROUP_DATE) return dateStr
        const date = new Date(dateStr)
        if (isToday(date)) return 'Today'
        if (isYesterday(date)) return 'Yesterday'
        return format(date, 'MMMM d, yyyy')
    }, [])

    const sentinelRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (!hasMore || !sentinelRef.current) return
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    setVisibleCount(c => c + VISIBLE_COUNT_INCREMENT)
                }
            },
            { threshold: 0.1 }
        )
        observer.observe(sentinelRef.current)
        return () => observer.disconnect()
    }, [hasMore, feedModel.visibleItemCount])

    // ---- keyboard / focus ------------------------------------------------------

    // The virtualizer lives in VirtualActivityList; the shell routes keyboard
    // jumps into it so arrow navigation works the same in plain and windowed mode.
    const scrollToRowRef = useRef<((rowIndex: number) => void) | null>(null)
    const bindScrollToRow = useCallback((fn: ((rowIndex: number) => void) | null) => { scrollToRowRef.current = fn }, [])

    const focusItem = useCallback((id: string) => {
        const escaped = window.CSS?.escape?.(id) ?? id
        const mount = document.querySelector(`[data-activity-item="${escaped}"]`)
        const focusMounted = (holder: Element) => {
            (holder.querySelector('[role="button"]') as HTMLElement | null)?.focus()
        }
        if (mount) {
            focusMounted(mount)
            return
        }
        const rowIndex = feedModel.itemIdToRowIndex.get(id)
        if (rowIndex == null) return
        scrollToRowRef.current?.(rowIndex)
        let tries = 0
        const poll = () => {
            const holder = document.querySelector(`[data-activity-item="${escaped}"]`)
            if (holder) {
                focusMounted(holder)
                return
            }
            if (++tries < 12) requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }, [feedModel])

    const handleFocusCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const holder = (event.target as HTMLElement).closest?.('[data-activity-item]')
        setFocusedId(holder ? holder.getAttribute('data-activity-item') : null)
    }, [])

    const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as HTMLElement | null
        if (!next?.closest?.('[data-activity-item]')) setFocusedId(null)
    }, [])

    const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const holder = (event.target as HTMLElement).closest?.('[data-activity-item]')
        if (!holder) return
        const id = holder.getAttribute('data-activity-item')
        if (!id) return
        event.preventDefault()
        const step = viewMode === 'list' ? 1 : columns
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? step : -step
        const nextId = resolveFocusTarget(itemOrder, id, delta)
        if (nextId) focusItem(nextId)
    }, [columns, viewMode, itemOrder, focusItem])

    // ---- rendering -------------------------------------------------------------

    const cardSlot = {
        nowStatuses,
        viewMode: viewMode as 'grid' | 'list',
        safeSelectedItems,
        isBulkMode,
        onToggleSelect,
        onDelete,
        onOpenDetail,
    }

    const renderEmptyState = () => (
        <ActivityEmptyState
            filtered={combinedHistory.length > 0 && filteredHistory.length === 0}
            totalItems={combinedHistory.length}
            activeFilterLabel={ACTIVITY_TAB_LABELS[activeTab]}
            onShowAll={combinedHistory.length > 0 ? () => setActiveTab('all') : undefined}
        />
    )

    const renderFeedContent = () => {
        if (filteredHistory.length === 0) return renderEmptyState()

        const body = feedModel.shouldVirtualize
            ? (
                <VirtualActivityList
                    rows={feedModel.rows}
                    groupAnchors={feedModel.groupAnchors}
                    columns={viewMode === 'list' ? 1 : columns}
                    focusedId={focusedId}
                    itemIdToRowIndex={feedModel.itemIdToRowIndex}
                    formatDateHeader={formatDateHeader}
                    bindScrollToRow={bindScrollToRow}
                    {...cardSlot}
                />
            )
            : (
                <div className="space-y-4">
                    {feedModel.visibleGroups.map(({ date, dateId, items, watchCount }) => (
                        <section
                            key={date}
                            id={dateId ? `activity-date-${dateId}` : undefined}
                            data-theme-part="card"
                            className="space-y-3 rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm"
                        >
                            <ActivityDateHeader date={date} watchCount={watchCount} formatDateHeader={formatDateHeader} />
                            <div className={viewMode === 'grid' ? GRID_CLASSES : 'space-y-3'}>
                                {items.map((item) => (
                                    <ActivityItemSlot key={item.id} entry={item} slot={cardSlot} />
                                ))}
                            </div>
                        </section>
                    ))}
                </div>
            )

        return (
            <div className="space-y-4 pb-20"
                onFocusCapture={handleFocusCapture}
                onBlurCapture={handleBlurCapture}
                onKeyDownCapture={handleKeyDownCapture}
            >
                {body}

                {hasMore && (
                    <div ref={sentinelRef} className="py-12 flex justify-center w-full">
                        <div className="flex items-center gap-2 text-muted-foreground animate-pulse">
                            <Activity className="h-4 w-4" />
                            <span className="text-sm font-medium">Loading history...</span>
                        </div>
                    </div>
                )}
            </div>
        )
    }

    const renderTabCount = (count: number) => (
        <span data-theme-part="badge" className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-lg border border-border/35 bg-background/70 px-1.5 text-xs font-semibold tabular-nums text-muted-foreground">
            {settling ? <span aria-hidden className="animate-pulse">...</span> : count.toLocaleString()}
        </span>
    )

    return (
        <div className="space-y-6">
            <PullToRefreshIndicator distance={pull.distance} phase={pull.phase} refreshing={pull.refreshing} />
            <WorkspaceTabs label="Activity history filters" value={activeTab} panelValue={activeTab} onValueChange={setActiveTab} className="w-full" tabs={<>
                        <TabsTrigger value="all">All Activity {renderTabCount(stats.tabCounts.all)}</TabsTrigger>
                        <TabsTrigger value="now">Recent {renderTabCount(stats.tabCounts.now)}</TabsTrigger>
                        <TabsTrigger value="movies">Movies {renderTabCount(stats.tabCounts.movies)}</TabsTrigger>
                        <TabsTrigger value="series">Series {renderTabCount(stats.tabCounts.series)}</TabsTrigger>
            </>} actions={
                    <div data-theme-part="badge" className="flex max-w-full flex-nowrap items-center gap-x-1.5 gap-y-1 overflow-x-auto rounded-xl border border-border/40 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm">
                        {settling ? (
                            <span className="animate-pulse opacity-70">Loading history...</span>
                        ) : (
                            <>
                                <span className="opacity-70">Showing</span>
                                <span className="font-semibold tabular-nums text-foreground">{stats.showing.toLocaleString()}</span>
                                <span className="opacity-50">of</span>
                                <span className="font-semibold tabular-nums text-foreground">{stats.total.toLocaleString()}</span>
                                <span className="h-3.5 w-px bg-border/60" />
                                <span className="tabular-nums text-foreground">{stats.hours.toLocaleString()}h total</span>
                            </>
                        )}
                        {todayHours > 0 && (
                            <>
                                <span className="h-3.5 w-px bg-border/60" />
                                <span className={todayTrend === 'up' ? 'text-success' : 'text-warning'}>
                                    Today <span className="font-semibold tabular-nums">{todayTrend === 'up' ? '↑' : '↓'}{todayHours}h</span>
                                </span>
                            </>
                        )}
                    </div>
            }>
                {renderFeedContent()}
            </WorkspaceTabs>

            <div className={`fixed bottom-24 right-5 md:bottom-8 md:right-8 z-40 transition-[transform,opacity,box-shadow] duration-300 ${showScrollTop ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}>
                <Button
                    size="icon"
                    variant="outline"
                    className="h-10 w-10 rounded-full shadow-lg md:h-11 md:w-11"
                    onClick={scrollToTop}
                >
                    <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
                </Button>
            </div>
        </div>
    )
}
