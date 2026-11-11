import { useEffect, useMemo, useRef } from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { CHART_PALETTE } from '@/lib/chart-colors'
import { CALENDAR_CELL as CELL, CALENDAR_GAP as GAP, weekColumnIntrinsicSize } from '@/components/metrics/calendar-grid'

interface ContributionGraphProps {
    dailyActivity: Record<string, number>
    loading?: boolean
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const RICH_CELL_MAX_WEEKS = 27

function getIntensity(count: number, max: number): number {
    if (count === 0) return 0
    const ratio = count / max
    if (ratio < 0.25) return 1
    if (ratio < 0.5) return 2
    if (ratio < 0.75) return 3
    return 4
}

const INTENSITY_COLORS = [
    'hsl(var(--muted))',
    CHART_PALETTE.blue.text + '33',
    CHART_PALETTE.blue.text + '66',
    CHART_PALETTE.blue.text + '99',
    CHART_PALETTE.blue.text,
]

export function ContributionGraph({ dailyActivity, loading }: ContributionGraphProps) {
    const { weeks, monthBorders, maxVal, total } = useMemo(() => {
        const entries = Object.entries(dailyActivity)
        if (entries.length === 0) return { weeks: [] as { date: string; count: number }[][], monthBorders: [] as { label: string; weekIndex: number }[], maxVal: 0, total: 0 }

        // Span from well-formed local day keys only: a corrupt year-0 import yields a
        // "0-12-31" key that legacy Date parsing turns into year 0 (WebKit) or 2000 (Blink),
        // which once built ~740k cells and froze WebKit phones. Zero-padded keys sort chronologically.
        let minKey: string | null = null
        for (const [d] of entries) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
            const year = Number(d.slice(0, 4))
            if (year < 1900 || year > 2200) continue
            if (minKey === null || d < minKey) minKey = d
        }
        if (minKey === null) return { weeks: [] as { date: string; count: number }[][], monthBorders: [] as { label: string; weekIndex: number }[], maxVal: 0, total: 0 }
        const minDate = new Date(Number(minKey.slice(0, 4)), Number(minKey.slice(5, 7)) - 1, Number(minKey.slice(8, 10)))
        const maxDate = new Date()

        const startSunday = new Date(minDate)
        startSunday.setDate(minDate.getDate() - minDate.getDay())

        const days: { date: string; count: number }[] = []
        const cursor = new Date(startSunday)
        while (cursor <= maxDate) {
            const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
            days.push({ date: key, count: dailyActivity[key] || 0 })
            cursor.setDate(cursor.getDate() + 1)
        }

        const weekChunks: { date: string; count: number }[][] = []
        for (let i = 0; i < days.length; i += 7) {
            weekChunks.push(days.slice(i, i + 7))
        }

        const borders: { label: string; weekIndex: number }[] = []
        let lastMonth = -1
        weekChunks.forEach((week, wi) => {
            const firstDay = week[0]
            if (firstDay) {
                const month = new Date(firstDay.date).getMonth()
                if (month !== lastMonth) {
                    borders.push({ label: MONTH_LABELS[month], weekIndex: wi })
                    lastMonth = month
                }
            }
        })

        return {
            weeks: weekChunks,
            monthBorders: borders,
            maxVal: Math.max(...entries.map(([, c]) => c), 1),
            total: entries.reduce((sum, [, c]) => sum + c, 0),
        }
    }, [dailyActivity])

    // The current date is the right edge of the graph. Open the calendar there
    // instead of at the oldest week, and re-pin when the range changes (period
    // switch, new data), unless the user has scrolled it themselves.
    const scrollRef = useRef<HTMLDivElement>(null)
    const userScrolledRef = useRef(false)
    useEffect(() => {
        const el = scrollRef.current
        if (!el || weeks.length === 0 || userScrolledRef.current) return
        el.scrollLeft = el.scrollWidth
    }, [weeks.length])

    if (loading) {
        return <div className="h-[200px] animate-pulse rounded-xl bg-muted/30" />
    }

    if (weeks.length === 0) {
        return <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">No activity data</div>
    }

    const labelColWidth = 28
    const weekWidth = CELL + GAP
    const gridWidth = weeks.length * weekWidth
    // Long all-time histories can contain many years of empty days. Rendering a
    // Radix tooltip and a Framer Motion controller for every cell makes several
    // thousand live objects on a phone before the user can even scroll this
    // panel. Keep the same cells and values, but use lightweight native titles
    // and static divs beyond half a year. Short ranges retain the richer hover and
    // entrance animation behavior.
    const useLightweightCells = weeks.length > RICH_CELL_MAX_WEEKS
    const intrinsic = weekColumnIntrinsicSize(CELL, GAP)

    return (
        <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-muted/15 p-3">
            <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{total} plays in this period</span>
            </div>
            <div
                ref={scrollRef}
                className="overflow-x-auto"
                onPointerDown={() => { userScrolledRef.current = true }}
                onWheel={() => { userScrolledRef.current = true }}
                onTouchStart={() => { userScrolledRef.current = true }}
            >
                <div style={{ minWidth: `${labelColWidth + gridWidth + 10}px` }}>
                    <div className="relative mb-1" style={{ height: '16px', marginLeft: `${labelColWidth}px` }}>
                        <div className="relative h-4" style={{ width: `${gridWidth}px` }} aria-hidden="true">
                            {monthBorders.map((mb, i) => (
                                <span
                                    key={i}
                                    className="absolute top-0 text-[10px] font-medium text-muted-foreground/70"
                                    style={{ left: `${mb.weekIndex * weekWidth}px` }}
                                >
                                    {mb.label}
                                </span>
                            ))}
                        </div>
                    </div>
                    <div className="flex gap-1">
                        <div className="flex flex-col shrink-0" style={{ width: `${labelColWidth}px` }}>
                            {DAY_LABELS.map((day, i) => (
                                <div key={day} className="flex items-center" style={{ height: `${CELL}px`, marginBottom: `${GAP}px` }}>
                                    {i % 2 === 1 && <span className="text-[9px] text-muted-foreground/60">{day}</span>}
                                </div>
                            ))}
                        </div>
                        <div className="flex" style={{ gap: `${GAP}px` }}>
                            {weeks.map((week, wi) => (
                                // Long all-time ranges render hundreds of week columns that
                                // start scrolled out of view. Off-screen columns keep their
                                // exact size but skip style, layout and paint, so the open
                                // cost stays flat while the calendar looks and scrolls the same.
                                <div
                                    key={wi}
                                    className="flex flex-col"
                                    style={{
                                        gap: `${GAP}px`,
                                        contentVisibility: 'auto',
                                        containIntrinsicSize: `auto ${intrinsic.width}px auto ${intrinsic.height}px`,
                                    }}
                                >
                                    {Array.from({ length: 7 }, (_, di) => {
                                        const day = week[di]
                                        if (!day) return <div key={di} style={{ height: `${CELL}px`, width: `${CELL}px` }} />
                                        const intensity = getIntensity(day.count, maxVal)
                                        const label = day.count > 0 ? `${day.date}: ${day.count} plays` : `${day.date}: no activity`
                                        const cell = useLightweightCells ? (
                                            <div
                                                key={di}
                                                title={label}
                                                aria-hidden="true"
                                                style={{
                                                    height: `${CELL}px`,
                                                    width: `${CELL}px`,
                                                    borderRadius: '2px',
                                                    background: INTENSITY_COLORS[intensity],
                                                }}
                                            />
                                        ) : (
                                            <div
                                                key={di}
                                                // Compositor entrance (fade from 0, zoom from half) with the same
                                                // per-cell stagger: hundreds of JS springs rewrite style every frame.
                                                className="animate-in fade-in zoom-in-50 fill-mode-backwards duration-300 motion-reduce:animate-none"
                                                style={{
                                                    height: `${CELL}px`,
                                                    width: `${CELL}px`,
                                                    borderRadius: '2px',
                                                    background: INTENSITY_COLORS[intensity],
                                                    animationDelay: `${Math.min(wi * 7 + di, 400)}ms`,
                                                }}
                                            />
                                        )
                                        return useLightweightCells ? cell : (
                                            <Tooltip key={di} content={label} delayDuration={100}>
                                                {cell}
                                            </Tooltip>
                                        )
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            <div className="mt-3 flex items-center justify-end gap-1.5">
                <span className="text-[10px] text-muted-foreground/60">Less</span>
                {INTENSITY_COLORS.map((c, i) => (
                    <div key={i} className="h-[10px] w-[10px] rounded-sm" style={{ background: c }} />
                ))}
                <span className="text-[10px] text-muted-foreground/60">More</span>
            </div>
        </div>
    )
}
