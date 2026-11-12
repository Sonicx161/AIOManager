import { useEffect, useRef, useState, memo, createContext, useContext, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, X, Heart, LayoutGrid, GalleryHorizontalEnd } from 'lucide-react'
import { Poster } from '@/components/common/Poster'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { pressable, PRESSABLE_FOCUS } from '@/components/metrics/pressable'
import { cn, maskedInitial } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'

const GridModeContext = createContext(false)

export interface RailWatcher {
    id: string
    avatar?: string
    emoji?: string
    name: string
}

export interface ContentRailCardProps {
    poster?: string
    title: string
    subtitle?: string
    caption?: string
    rank?: number
    itemId?: string
    itemType?: string
    watchers?: RailWatcher[]
    onDismiss?: () => void
    onLove?: () => void
    isLoved?: boolean
    onClick?: () => void
    index?: number
}

export interface ContentRailProps {
    title: string
    titleAccessory?: ReactNode
    subtitle?: string
    icon?: ReactNode
    count?: number
    countLabel?: string
    children: ReactNode
    scrollAmount?: number
    className?: string
    showGridToggle?: boolean
}

export const ContentRailCard = memo(function ContentRailCard({
    poster,
    title,
    subtitle,
    caption,
    rank,
    itemId,
    itemType,
    watchers,
    onDismiss,
    onLove,
    isLoved,
    onClick,
    index = 0,
}: ContentRailCardProps) {
    const isGrid = useContext(GridModeContext)
    const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index * 0.04, 0.4), duration: 0.3 }}
            className={cn(
                'group relative',
                onClick && PRESSABLE_FOCUS,
                onClick ? 'cursor-pointer' : '',
                isGrid ? 'w-full' : 'w-32 shrink-0 sm:w-36'
            )}
            {...(onClick ? pressable(onClick, title) : {})}
        >
            <div data-theme-part="card" className="relative aspect-[2/3] w-full overflow-hidden rounded-2xl border border-[color:var(--chrome-line)] bg-muted shadow-md transition-all duration-200 group-hover:border-primary/40 group-hover:shadow-xl">
                <Poster
                    src={poster}
                    alt={title}
                    itemId={itemId}
                    itemType={itemType}
                    sizes="(min-width: 640px) 152px, 135px"
                    className="media-ring h-full w-full transition-transform duration-300 group-hover:scale-105"
                    loading="lazy"
                />

                {rank !== undefined && (
                    <div data-theme-part="badge" className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-lg bg-black/80 px-1.5 text-xs font-black text-white shadow-md backdrop-blur-sm">
                        {rank}
                    </div>
                )}

                {typeof isLoved === 'boolean' && (
                    <div data-theme-part="badge" className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 backdrop-blur-sm">
                        <Heart className={cn('h-3 w-3', isLoved ? 'fill-red-500 text-red-500' : 'text-white/50')} />
                    </div>
                )}

                {onLove && (
                    <button data-theme-part="button"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onLove() }}
                        className="absolute right-1.5 bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100"
                        aria-label={isLoved ? 'Remove from loved' : 'Add to loved'}
                    >
                        <Heart className={cn('h-3.5 w-3.5 transition-colors', isLoved ? 'fill-red-500 text-red-500' : 'text-white')} />
                    </button>
                )}

                {watchers && watchers.length > 0 && (
                    <div className="absolute bottom-1.5 left-1.5 flex items-center -space-x-1.5">
                        {watchers.slice(0, 3).map(w => (
                            <div data-theme-part="avatar" key={w.id} className="h-5 w-5 rounded-full border border-background overflow-hidden bg-card shadow-sm flex items-center justify-center">
                                {w.avatar ? (
                                    <img src={w.avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                                ) : w.emoji ? (
                                    <span className="text-[9px]">{w.emoji}</span>
                                ) : (
                                    <span className="text-[8px] font-bold text-muted-foreground">{maskedInitial(w.name, privacyLevel) || '?'}</span>
                                )}
                            </div>
                        ))}
                        {watchers.length > 3 && (
                            <div data-theme-part="avatar" className="h-5 w-5 rounded-full border border-background bg-card shadow-sm flex items-center justify-center">
                                <span className="text-[8px] font-bold text-muted-foreground">+{watchers.length - 3}</span>
                            </div>
                        )}
                    </div>
                )}

                {onDismiss && (
                    <div className="absolute right-1.5 top-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                        <button data-theme-part="button"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onDismiss() }}
                            className="flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white shadow-sm backdrop-blur-sm hover:bg-destructive"
                            aria-label="Dismiss"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
            </div>

            <div className="mt-2 w-full px-0.5">
                <Tooltip content={title} side="bottom" delayDuration={400}>
                    <p className="truncate text-xs font-semibold leading-tight text-foreground transition-colors group-hover:text-primary">
                        {title}
                    </p>
                </Tooltip>
                {subtitle && (
                    <p className="truncate text-[11px] text-muted-foreground/70 leading-tight">{subtitle}</p>
                )}
                {caption && (
                    <p className="truncate text-[10px] text-muted-foreground/60 leading-tight">{caption}</p>
                )}
            </div>
        </motion.div>
    )
})

export function ContentRail({
    title,
    titleAccessory,
    subtitle,
    icon,
    count,
    countLabel,
    children,
    scrollAmount = 300,
    className,
    showGridToggle = false,
}: ContentRailProps) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const [gridMode, setGridMode] = useState(false)
    const [fades, setFades] = useState({ left: false, right: false })

    const scroll = (dir: 'left' | 'right') => {
        scrollRef.current?.scrollBy({
            left: dir === 'left' ? -scrollAmount : scrollAmount,
            behavior: 'smooth',
        })
    }

    // Edge fades: only the side with more content beyond it, live on scroll, none when the rail fits.
    useEffect(() => {
        if (gridMode) return
        const row = scrollRef.current
        if (!row) return
        let frame = 0
        const update = () => {
            frame = 0
            const max = row.scrollWidth - row.clientWidth
            if (max <= 2) {
                setFades({ left: false, right: false })
                return
            }
            setFades({ left: row.scrollLeft > 2, right: row.scrollLeft < max - 2 })
        }
        const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
        update()
        row.addEventListener('scroll', onScroll, { passive: true })
        const ro = new ResizeObserver(onScroll)
        ro.observe(row)
        return () => {
            row.removeEventListener('scroll', onScroll)
            if (frame) cancelAnimationFrame(frame)
            ro.disconnect()
        }
    }, [gridMode])

    return (
        <section data-theme-part="panel" className={cn(
            'rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm',
            className,
        )}>
            <div className="flex flex-wrap items-center justify-between gap-y-1">
                <div className="flex min-w-0 items-center gap-2">
                    {icon && <div className="shrink-0 text-primary">{icon}</div>}
                    <div className="min-w-0">
                        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold leading-tight tracking-tight text-foreground"><span className="shrink-0">{title}</span>{titleAccessory}</h3>
                        {subtitle && <p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">{subtitle}</p>}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {typeof count === 'number' && (
                        <span className="text-xs font-medium text-muted-foreground">{count} {countLabel || 'titles'}</span>
                    )}
                    {showGridToggle && (
                        <button data-theme-part="button"
                            type="button"
                            onClick={() => setGridMode(g => !g)}
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/95 opacity-70 shadow-sm transition-all hover:bg-muted hover:opacity-100"
                            aria-label={gridMode ? 'Rail view' : 'Grid view'}
                        >
                            {gridMode ? <GalleryHorizontalEnd className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
                        </button>
                    )}
                    {!gridMode && (
                        <>
                            <button data-theme-part="button"
                                type="button"
                                onClick={() => scroll('left')}
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/95 opacity-70 shadow-sm transition-all hover:bg-muted hover:opacity-100"
                                aria-label="Scroll left"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <button data-theme-part="button"
                                type="button"
                                onClick={() => scroll('right')}
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-border/40 bg-background/95 opacity-70 shadow-sm transition-all hover:bg-muted hover:opacity-100"
                                aria-label="Scroll right"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>
            </div>
            {gridMode ? (
                <GridModeContext.Provider value={true}>
                    <div className="grid gap-4 pt-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                        {children}
                    </div>
                </GridModeContext.Provider>
            ) : (
                <div
                    ref={scrollRef}
                    data-rail-row=""
                    className="rail-edge-fade flex gap-4 overflow-x-auto pb-1 pt-3 scrollbar-hide scroll-smooth"
                    style={{
                        '--fl': fades.left ? '32px' : '0px',
                        '--fr': fades.right ? '32px' : '0px',
                        maskImage: 'linear-gradient(to right, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%)',
                        WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 var(--fl), #000 calc(100% - var(--fr)), transparent 100%)',
                    } as React.CSSProperties}
                >
                    {children}
                </div>
            )}
        </section>
    )
}

export function ContentRailSkeleton({ count = 6 }: { count?: number }) {
    return (
        <section data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm">
            <div className="flex items-center gap-2.5">
                <Skeleton className="h-5 w-44" />
            </div>
            <div className="flex gap-4 overflow-x-auto pt-3 scrollbar-hide">
                {Array.from({ length: count }).map((_, i) => (
                    <div key={i} className="w-32 md:w-36 shrink-0 space-y-2">
                        <Skeleton className="h-48 md:h-56 w-full rounded-2xl" />
                        <Skeleton className="h-3 w-4/5" />
                        <Skeleton className="h-2.5 w-3/5" />
                    </div>
                ))}
            </div>
        </section>
    )
}
