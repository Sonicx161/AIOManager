import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { seasonStepNeighbors } from './season-picker'
import type { SeasonInfo } from '@/api/metadata/adapters/tmdb'

interface SeasonControlProps {
    seasons: SeasonInfo[]
    selected: number | null
    onSelect: (seasonNumber: number) => void
    watchedSeasons: ReadonlySet<number>
    isLight: boolean
}

const seasonLabel = (s: { seasonNumber: number; name: string }) =>
    s.seasonNumber === 0 ? 'Specials' : s.name || `Season ${s.seasonNumber}`

/** Compact season control for shows with many seasons: prev / label / next plus a listbox. */
export function SeasonControl({ seasons, selected, onSelect, watchedSeasons, isLight }: SeasonControlProps) {
    const [open, setOpen] = useState(false)
    const [focusIndex, setFocusIndex] = useState(-1)
    const rootRef = useRef<HTMLDivElement>(null)
    const labelRef = useRef<HTMLButtonElement>(null)
    const optionRefs = useRef<Array<HTMLLIElement | null>>([])
    const listId = useId()

    const selectedIndex = seasons.findIndex(s => s.seasonNumber === selected)
    const current = selectedIndex >= 0 ? seasons[selectedIndex] : null
    const { prev, next } = seasonStepNeighbors(seasons, selected)

    const closeList = (returnFocus = true) => {
        setOpen(false)
        if (returnFocus) labelRef.current?.focus()
    }

    const choose = (seasonNumber: number) => {
        onSelect(seasonNumber)
        closeList()
    }

    // The list opens focused and scrolled to the current season.
    useEffect(() => {
        if (!open) return
        const initial = selectedIndex >= 0 ? selectedIndex : 0
        setFocusIndex(initial)
        const el = optionRefs.current[initial]
        if (el) {
            el.focus({ preventScroll: true })
            el.scrollIntoView({ block: 'center' })
        }
    }, [open, seasons, selectedIndex])

    // Close on any pointer outside the control. Capture phase: the dialog stops
    // propagation on its own pointer events, so document bubble listeners never fire.
    useEffect(() => {
        if (!open) return
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
                setOpen(false)
            }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
    }, [open])

    const handleListKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            e.stopPropagation()
            const dir = e.key === 'ArrowDown' ? 1 : -1
            const base = focusIndex >= 0 ? focusIndex : Math.max(0, selectedIndex)
            const target = Math.min(seasons.length - 1, Math.max(0, base + dir))
            setFocusIndex(target)
            optionRefs.current[target]?.focus()
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault()
            const target = e.key === 'Home' ? 0 : seasons.length - 1
            setFocusIndex(target)
            optionRefs.current[target]?.focus()
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            const idx = focusIndex >= 0 ? focusIndex : selectedIndex
            const s = idx >= 0 ? seasons[idx] : undefined
            if (s) choose(s.seasonNumber)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            closeList()
        } else if (e.key === 'Tab') {
            setOpen(false)
        }
    }

    const stepperBtn = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/60 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-35 sm:h-9 sm:w-9'

    return (
        <div ref={rootRef} data-season-control="" className="relative">
            <div className="flex items-center gap-1.5">
                <button
                    type="button"
                    aria-label="Previous season"
                    disabled={prev === null}
                    onClick={() => { if (prev !== null) onSelect(prev) }}
                    className={stepperBtn}
                >
                    <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                    ref={labelRef}
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => (open ? closeList() : setOpen(true))}
                    onKeyDown={e => {
                        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                            e.preventDefault()
                            setOpen(true)
                        }
                    }}
                    className={cn(
                        'flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-xs transition-all active:scale-95 sm:h-9 sm:px-5',
                        isLight
                            ? 'bg-muted/50 text-foreground hover:bg-muted'
                            : 'bg-white/10 text-white hover:bg-white/20',
                    )}
                >
                    <span className="truncate font-bold">{current ? seasonLabel(current) : 'Season'}</span>
                    {current && current.episodeCount > 0 && (
                        <span className="truncate font-medium text-muted-foreground">
                            {'\u00b7 '}{current.episodeCount} episode{current.episodeCount === 1 ? '' : 's'}
                        </span>
                    )}
                    {current?.airDate && (
                        <span className="hidden truncate font-medium text-muted-foreground sm:inline">
                            {'\u00b7 '}{new Date(current.airDate).getFullYear()}
                        </span>
                    )}
                    <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
                </button>
                <button
                    type="button"
                    aria-label="Next season"
                    disabled={next === null}
                    onClick={() => { if (next !== null) onSelect(next) }}
                    className={stepperBtn}
                >
                    <ChevronRight className="h-4 w-4" />
                </button>
            </div>

            {open && (
                <ul
                    id={listId}
                    role="listbox"
                    aria-label="Seasons"
                    onKeyDown={handleListKeyDown}
                    className="absolute inset-x-0 top-full z-30 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-card p-1.5 shadow-2xl sm:right-auto sm:w-72"
                >
                    {seasons.map((s, i) => {
                        const isSelected = s.seasonNumber === selected
                        const isWatched = watchedSeasons.has(s.seasonNumber)
                        return (
                            <li
                                key={s.seasonNumber}
                                ref={el => { optionRefs.current[i] = el }}
                                role="option"
                                aria-selected={isSelected}
                                tabIndex={focusIndex === i ? 0 : -1}
                                data-season-option={s.seasonNumber}
                                data-state={isSelected ? 'active' : 'inactive'}
                                data-watched={isWatched ? 'true' : 'false'}
                                onClick={() => choose(s.seasonNumber)}
                                className={cn(
                                    'flex min-h-11 cursor-pointer select-none items-center justify-between gap-2 rounded-lg px-3 text-xs sm:min-h-0 sm:py-2.5',
                                    isSelected
                                        ? 'bg-primary/10 font-bold text-primary'
                                        : focusIndex === i
                                            ? 'bg-muted/70 font-medium text-foreground'
                                            : 'font-medium text-foreground/85 hover:bg-muted/50',
                                )}
                            >
                                <span className="truncate">{seasonLabel(s)}</span>
                                {isWatched && (
                                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-success">
                                        <Check className="h-3 w-3" strokeWidth={3} />
                                        Watched
                                    </span>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
