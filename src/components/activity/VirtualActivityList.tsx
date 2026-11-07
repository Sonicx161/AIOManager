import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from '@tanstack/react-virtual'
import { Activity, Bookmark } from 'lucide-react'
import { StatusChip } from '@/components/ui/status-chip'
import { cn } from '@/lib/utils'
import { ActivityItemCard } from './ActivityItemCard'
import type { ActivityNowStatus } from '@/lib/jellyfin/activity'
import type { ActivityItem } from '@/types/activity'
import { estimateRowHeight, SAVED_GROUP_DATE, type FeedRow, type FeedViewMode } from './feed-rows'

// Windowed rendering for the ActivityFeed long-history tail (T3-inspired):
// bounded mounted rows with overscan, the focused row stays mounted while it
// holds focus, and reading position survives fresh records prepending to the
// head. Row geometry comes from feed-rows.ts; @tanstack/react-virtual supplies
// the window scroller machinery.

const OVERSCAN_ROWS = 6
/** Rows of extra runway kept mounted on both sides of the viewport. */
const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'

export interface ActivityCardSlotProps {
    nowStatuses: Map<string, ActivityNowStatus>
    viewMode: FeedViewMode
    safeSelectedItems: Set<string>
    isBulkMode: boolean
    onToggleSelect?: (id: string | string[]) => void
    onDelete?: (id: string | string[], removeFromLibrary: boolean) => void
    onOpenDetail?: (item: ActivityItem) => void
}

/** The date header shared by whole sections and windowed header rows. */
export function ActivityDateHeader({ date, watchCount, formatDateHeader }: {
    date: string
    watchCount: number
    formatDateHeader: (dateStr: string) => string
}) {
    // The saved-state group has no watch date to format: it is titled by what it
    // is, counts titles instead of watches, and says the dates are unavailable.
    const isSavedGroup = date === SAVED_GROUP_DATE
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
                {isSavedGroup ? (
                    <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                    <Activity className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-sm font-semibold">{formatDateHeader(date)}</span>
                {isSavedGroup && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground/70">Watch dates unavailable</span>
                )}
            </div>
            <StatusChip variant="muted" className="shrink-0 rounded-lg bg-background/70 px-2 tabular-nums">
                {isSavedGroup
                    ? `${watchCount} ${watchCount === 1 ? 'title' : 'titles'}`
                    : `${watchCount} ${watchCount === 1 ? 'watch' : 'watches'}`}
            </StatusChip>
        </div>
    )
}

/** Card plus the wrapper that carries the item id for focus/keyboard handling. */
export function ActivityItemSlot({ entry, slot }: { entry: ActivityItem; slot: ActivityCardSlotProps }) {
    return (
        <div data-activity-item={entry.id} className="min-w-0">
            <ActivityItemCard
                entry={entry}
                nowStatus={slot.nowStatuses.get(entry.id)}
                viewMode={slot.viewMode}
                isSelected={slot.safeSelectedItems.has(entry.id)}
                isBulkMode={slot.isBulkMode}
                onToggleSelect={slot.onToggleSelect}
                onDelete={slot.onDelete}
                onOpenDetail={slot.onOpenDetail}
            />
        </div>
    )
}

interface VirtualActivityListProps extends ActivityCardSlotProps {
    rows: FeedRow[]
    groupAnchors: Array<{ dateId: string; rowIndex: number; key: string }>
    /** Effective grid columns (1 in list mode). */
    columns: number
    focusedId: string | null
    itemIdToRowIndex: Map<string, number>
    formatDateHeader: (dateStr: string) => string
    /** Parent routes keyboard-driven jumps through the virtualizer. */
    bindScrollToRow: (fn: ((rowIndex: number) => void) | null) => void
}

export function VirtualActivityList({
    rows,
    groupAnchors,
    columns,
    focusedId,
    itemIdToRowIndex,
    formatDateHeader,
    bindScrollToRow,
    ...slot
}: VirtualActivityListProps) {
    const listRef = useRef<HTMLDivElement | null>(null)
    const [listOffset, setListOffset] = useState(0)
    const [containerWidth, setContainerWidth] = useState(0)

    const estimateSize = useCallback(
        (index: number) => estimateRowHeight(rows[index], { viewMode: slot.viewMode, columns, containerWidth }),
        [rows, slot.viewMode, columns, containerWidth],
    )

    const focusedRowIndex = focusedId != null ? itemIdToRowIndex.get(focusedId) : undefined
    const rangeExtractor = useCallback(
        (range: Range) => {
            const next = defaultRangeExtractor(range)
            // Keep the focused card's row mounted even when it scrolls out of the
            // windowed range, so keyboard focus never unmounts under the user.
            if (focusedRowIndex != null && focusedRowIndex < rows.length && !next.includes(focusedRowIndex)) {
                next.push(focusedRowIndex)
            }
            return next
        },
        [focusedRowIndex, rows.length],
    )

    const virtualizer = useWindowVirtualizer({
        count: rows.length,
        estimateSize,
        overscan: OVERSCAN_ROWS,
        scrollMargin: listOffset,
        getItemKey: (index) => rows[index].key,
        rangeExtractor,
    })

    useEffect(() => {
        bindScrollToRow((rowIndex: number) => virtualizer.scrollToIndex(rowIndex, { align: 'center' }))
        return () => bindScrollToRow(null)
    }, [bindScrollToRow, virtualizer])

    // The list's document offset (scrollMargin) and width drive offsets/estimates;
    // re-measure on mount, layout-affecting changes, and viewport resizes.
    useEffect(() => {
        let raf = 0
        const remeasure = () => {
            cancelAnimationFrame(raf)
            raf = requestAnimationFrame(() => {
                const el = listRef.current
                if (!el) return
                const rect = el.getBoundingClientRect()
                setListOffset(rect.top + window.scrollY)
                setContainerWidth(rect.width)
            })
        }
        remeasure()
        window.addEventListener('resize', remeasure)
        return () => {
            window.removeEventListener('resize', remeasure)
            cancelAnimationFrame(raf)
        }
    }, [slot.viewMode, columns])

    // Reading anchor: the first mounted card crossing the viewport top, plus its
    // offset from the viewport top. Captured continuously while the page scrolls.
    // Anchoring on a real DOM element (not virtualizer starts) keeps the restore
    // exact even when rows above the reader were never measured and only have
    // size estimates — prepended head rows shift estimate-based starts by the
    // wrong amount and would drift the reading position.
    const anchorRef = useRef<{ itemId: string; viewportTop: number } | null>(null)
    useEffect(() => {
        let raf = 0
        const capture = () => {
            cancelAnimationFrame(raf)
            raf = requestAnimationFrame(() => {
                // Mounted rows are ordered; rows clearly above the viewport top are
                // skipped arithmetically, borderline rows are confirmed with one row
                // read, and only the crossing row's cards are measured. Falls back
                // to scanning every mounted card when no row matches, so the anchor
                // stays exact.
                const scrollY = window.scrollY
                const items = virtualizer.getVirtualItems()
                let start = 0
                while (start < items.length && items[start].start - scrollY + items[start].size < -200) start++
                for (let i = start; i < items.length; i++) {
                    const rowEl = listRef.current?.querySelector(`[data-index="${items[i].index}"]`)
                    if (!rowEl) break
                    if (rowEl.getBoundingClientRect().bottom <= 1) continue
                    const holders = rowEl.querySelectorAll('[data-activity-item]')
                    let found = false
                    for (const el of holders) {
                        const rect = (el as HTMLElement).getBoundingClientRect()
                        if (rect.bottom > 1) {
                            anchorRef.current = { itemId: el.getAttribute('data-activity-item') ?? '', viewportTop: rect.top }
                            found = true
                            break
                        }
                    }
                    if (found) return
                }
                const holders = listRef.current?.querySelectorAll('[data-activity-item]')
                if (!holders) return
                for (const el of holders) {
                    const rect = (el as HTMLElement).getBoundingClientRect()
                    if (rect.bottom > 1) {
                        anchorRef.current = { itemId: el.getAttribute('data-activity-item') ?? '', viewportTop: rect.top }
                        break
                    }
                }
            })
        }
        capture()
        window.addEventListener('scroll', capture, { passive: true })
        return () => {
            window.removeEventListener('scroll', capture)
            cancelAnimationFrame(raf)
        }
    }, [virtualizer])

    // Anchor restore: when fresh records prepend rows above the reader (or any
    // rebuild shifts the anchor card), put it back at the same viewport position
    // using its current rendered position. Near the feed top we do nothing so
    // new head content shows up naturally.
    useLayoutEffect(() => {
        const anchor = anchorRef.current
        if (!anchor?.itemId) return
        if (window.scrollY < listOffset + 64) return
        const selector = `[data-activity-item="${anchor.itemId.replace(/[\\"]/g, '\\$&')}"]`

        const apply = () => {
            const el = listRef.current?.querySelector(selector)
            if (!el) return false
            const docTop = el.getBoundingClientRect().top + window.scrollY
            const target = Math.max(0, docTop - anchor.viewportTop)
            if (Math.abs(target - window.scrollY) >= 1) {
                window.scrollTo({ top: target, behavior: 'auto' })
                return true
            }
            return false
        }

        apply()
        // Post-measurement passes absorb lazy row measurement settling: rows
        // above the viewport can still be size estimates, so their measured
        // sizes keep shifting everything below for a few frames.
        let passes = 0
        let raf = 0
        const correct = () => {
            apply()
            if (++passes < 6) raf = requestAnimationFrame(correct)
        }
        raf = requestAnimationFrame(correct)
        return () => cancelAnimationFrame(raf)
    }, [rows, listOffset, virtualizer])

    const virtualItems = virtualizer.getVirtualItems()
    const scrollMargin = virtualizer.options.scrollMargin

    const renderCards = (items: ActivityItem[]) => items.map(entry => (
        <ActivityItemSlot key={entry.id} entry={entry} slot={{ ...slot }} />
    ))

    const renderRow = (row: FeedRow) => {
        if (row.kind === 'section') {
            return (
                <section data-theme-part="card" className="space-y-3 rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm">
                    <ActivityDateHeader date={row.date} watchCount={row.watchCount} formatDateHeader={formatDateHeader} />
                    <div className={slot.viewMode === 'grid' ? GRID_CLASSES : 'space-y-3'}>
                        {renderCards(row.items)}
                    </div>
                </section>
            )
        }
        if (row.kind === 'header') {
            return (
                <div data-theme-part="card" className="rounded-t-2xl border border-b-0 border-border/40 bg-card/50 px-3 pt-3 shadow-sm">
                    <ActivityDateHeader date={row.date} watchCount={row.watchCount} formatDateHeader={formatDateHeader} />
                </div>
            )
        }
        // One visual line of a big group. Side borders continue across rows so the
        // group still reads as one section card; spacing lives in row padding.
        return (
            <div
                data-theme-part="card"
                className={cn(
                    'border-x border-border/40 bg-card/50 px-3',
                    slot.viewMode === 'grid' ? cn(GRID_CLASSES, row.first ? 'pt-3' : 'pt-4') : 'pt-3',
                    row.last && 'rounded-b-2xl border-b border-border/40 pb-3 shadow-sm',
                )}
            >
                {renderCards(row.items)}
            </div>
        )
    }

    // Zero-size anchors keep `activity-date-*` ids resolvable for every group,
    // including ones whose rows are currently unmounted.
    const anchorOffset = (rowIndex: number) => {
        const cached = virtualizer.measurementsCache[rowIndex]?.start
        if (cached != null) return cached
        let sum = 0
        for (let i = 0; i < rowIndex; i++) sum += estimateSize(i)
        return sum
    }

    return (
        <div ref={listRef} data-activity-virtual-list style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
            {groupAnchors.filter(anchor => anchor.dateId).map(anchor => (
                <div
                    key={`anchor-${anchor.key}`}
                    id={`activity-date-${anchor.dateId}`}
                    data-activity-anchor={anchor.dateId}
                    aria-hidden="true"
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 0, transform: `translateY(${anchorOffset(anchor.rowIndex) - scrollMargin}px)` }}
                />
            ))}
            {virtualItems.map(virtualRow => (
                <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                >
                    {renderRow(rows[virtualRow.index])}
                </div>
            ))}
        </div>
    )
}
