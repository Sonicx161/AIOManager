import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
    Activity, ArrowDown, ChevronDown, ChevronUp, Copy, Download, Pause, Play,
    Regex as RegexIcon, SlidersHorizontal, Terminal, TriangleAlert, WrapText,
} from 'lucide-react'
import {
    AdminApiError, downloadLogsExport, getAdminSession, getLogs,
    type LogLine, type LogLevel, type LogsExportFormat,
} from '@/api/admin'
import { formatCount, formatDateTime, relTime } from '@/lib/admin-format'
import { adminRetry, endAdminSession, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { appendTailLine, openLogTail, type TailState } from '@/lib/admin-log-tail'
import {
    activeLogFilterCount, groupLogErrors, type LogErrorGroup, type LogFilters,
    type LogsRequestFilters, LOGS_PAGE_LIMIT, LOGS_Q_MAX, LOGS_TAIL_CAP, LOGS_WINDOWS,
    logLineText, logWindowCutoff,
    logsExportName, mergeLogLines, NO_LOG_FILTERS, tailLineCountsAsNew, tailLineMatches, validateLogPattern,
} from '@/lib/admin-logs'
import { toast } from '@/hooks/use-toast'
import { copyTextToClipboard } from '@/components/ui/copy-button'
import { getLastActivated, pickReturnFocus } from '@/components/ui/dialog-focus'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, TABLE_SURFACE } from '../AdminWidgets'
import { cn } from '@/lib/utils'

const LEVELS: { id: LogLevel | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'info', label: 'Info' },
    { id: 'warn', label: 'Warn' },
    { id: 'error', label: 'Error' },
]

const LEVEL_TEXT: Record<LogLevel, string> = {
    info: 'text-muted-foreground',
    warn: 'text-warning',
    error: 'text-destructive',
}

const TAIL_LABEL: Record<TailState, string> = {
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting',
    stopped: 'Stopped',
}

const WRAP_KEY = 'dashboard-logs-wrap'

const RESTRICTED_TITLE = 'Per-account detail is not exposed to the dashboard.'
const RESTRICTED_NOTE = 'Per-account detail is not exposed to the dashboard; only the error class and code are kept.'

const CHIP_BASE = 'flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors max-md:min-h-10 outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
const CHIP_IDLE = 'border-border/40 text-muted-foreground hover:text-foreground'
const CHIP_ACTIVE = 'border-primary/25 bg-primary/10 text-primary'

function Pill({ selected, onClick, children, destructiveHover }: { selected: boolean; onClick: () => void; children: ReactNode; destructiveHover?: boolean }) {
    return (
        <button
            type="button"
            aria-pressed={selected}
            onClick={onClick}
            className={cn(CHIP_BASE, selected ? CHIP_ACTIVE : CHIP_IDLE, !selected && destructiveHover && 'hover:text-destructive')}
        >
            {children}
        </button>
    )
}

function WindowChips({ value, onChange }: { value: LogFilters['window']; onChange: (w: LogFilters['window']) => void }) {
    return (
        <span role="group" aria-label="Time window" className="flex flex-wrap items-center gap-2">
            {LOGS_WINDOWS.map(w => (
                <Pill key={w.id} selected={value === w.id} onClick={() => onChange(w.id)}>{w.label}</Pill>
            ))}
        </span>
    )
}

function LevelPills({ value, counts, onChange }: { value: LogLevel | 'all'; counts: Record<'all' | LogLevel, number>; onChange: (l: LogLevel | 'all') => void }) {
    return (
        <span role="group" aria-label="Filter by level" className="flex flex-wrap items-center gap-2">
            {LEVELS.map(l => (
                <Pill key={l.id} selected={value === l.id} onClick={() => onChange(l.id)} destructiveHover={l.id === 'error'}>
                    {l.label} {formatCount(counts[l.id])}
                </Pill>
            ))}
        </span>
    )
}

function RegexChip({ active, onToggle }: { active: boolean; onToggle: () => void }) {
    return (
        <Pill selected={active} onClick={onToggle}>
            <RegexIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Regex
        </Pill>
    )
}

function ModuleSelect({ value, modules, onChange, className }: { value: string; modules: string[]; onChange: (m: string) => void; className?: string }) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger aria-label="Filter by module" className={cn('gap-1.5 border-border/40 bg-transparent text-xs', className)}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {modules.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
        </Select>
    )
}

interface LogRowProps {
    line: LogLine
    expanded: boolean
    wrap: boolean
    onToggle: () => void
    onCopy: () => void
}

function LogRow({ line, expanded, wrap, onToggle, onCopy }: LogRowProps) {
    const hidden = /details hidden/i.test(line.message)
    return (
        <div className={cn('group relative border-b border-border/40', expanded ? 'bg-foreground/[0.045]' : 'hover:bg-foreground/[0.035]')}>
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={`Log line ${line.seq}`}
                onClick={onToggle}
                className="flex w-full flex-col gap-y-1 px-3.5 py-2 pr-14 text-left outline-none focus-visible:bg-foreground/[0.045] md:flex-row md:items-baseline md:gap-x-3"
            >
                <span className="flex shrink-0 items-baseline gap-x-3">
                    <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">{line.timeLabel}</span>
                    <span className={cn('w-12 shrink-0 text-xs font-semibold uppercase', LEVEL_TEXT[line.level])}>{line.level}</span>
                    <span className="w-24 shrink-0 truncate text-xs font-semibold text-foreground">{line.module}</span>
                </span>
                <span
                    className={cn(
                        'min-w-0 flex-1 text-xs leading-relaxed text-foreground/85',
                        wrap ? 'whitespace-normal break-words' : 'truncate',
                        hidden && 'italic text-muted-foreground',
                    )}
                    title={hidden ? RESTRICTED_TITLE : undefined}
                >
                    {line.message}
                </span>
            </button>
            <span className="pointer-events-none absolute right-2 top-1/2 z-[1] flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                    type="button"
                    aria-label={`Copy line ${line.seq}`}
                    onClick={onCopy}
                    className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-lg bg-card/80 text-muted-foreground shadow-sm outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                </button>
                <span className="inline-flex h-7 w-7 items-center justify-center bg-card/80 text-muted-foreground shadow-sm" aria-hidden>
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
                </span>
            </span>
            {expanded && (
                <div className="mx-3.5 mb-2.5 rounded-xl border border-border/35 bg-muted/20 px-3 py-2.5">
                    <p className={cn('break-words font-mono text-xs leading-relaxed', hidden ? 'italic text-muted-foreground' : 'text-foreground/90')}>
                        {line.message}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                        <span className="text-muted-foreground">Seq<br /><b className="font-semibold tabular-nums text-foreground/90">{line.seq}</b></span>
                        <span className="text-muted-foreground">Level<br /><b className="font-semibold text-foreground/90">{line.level}</b></span>
                        <span className="text-muted-foreground">Module<br /><b className="font-semibold text-foreground/90">{line.module}</b></span>
                        <span className="text-muted-foreground">Time<br /><b className="font-semibold text-foreground/90">{formatDateTime(line.at)}</b></span>
                    </div>
                    {hidden && <p className="mt-2 text-[11px] text-muted-foreground">{RESTRICTED_NOTE}</p>}
                </div>
            )}
        </div>
    )
}

export function LogsScreen() {
    const queryClient = useQueryClient()
    const [filters, setFilters] = useState<LogFilters>({ ...NO_LOG_FILTERS })
    const [qInput, setQInput] = useState('')
    const [wrap, setWrap] = useState(() => {
        try {
            return localStorage.getItem(WRAP_KEY) === '1'
        } catch {
            return false
        }
    })
    const [live, setLive] = useState(true)
    const [tailState, setTailState] = useState<TailState>('connecting')
    const [tail, setTail] = useState<LogLine[]>([])
    const [olderPages, setOlderPages] = useState<LogLine[]>([])
    const [olderCursor, setOlderCursor] = useState<number | null | undefined>(undefined)
    const [loadingOlder, setLoadingOlder] = useState(false)
    const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
    const [errorsOpen, setErrorsOpen] = useState(true)
    const [sheetOpen, setSheetOpen] = useState(false)
    const [newCount, setNewCount] = useState(0)
    const lastSeqRef = useRef(0)
    const liveRef = useRef(live)
    const atBottomRef = useRef(true)
    const scrollRef = useRef<HTMLDivElement>(null)
    const pendingJump = useRef<number | null>(null)
    const filtersTriggerRef = useRef<HTMLButtonElement>(null)
    const sheetRef = useRef<HTMLDivElement>(null)
    const sheetReturnFocus = useRef<HTMLElement | null>(null)

    const searchQ = filters.q.trim()
    const regexError = filters.regex && searchQ ? validateLogPattern(searchQ) : null
    const effective = useMemo<LogFilters>(
        () => (regexError ? { ...filters, q: '', regex: false } : filters),
        [filters, regexError],
    )

    // One cutoff per filter set (captured when `effective` changes): the first
    // page, every cursor page, refetches and the export share the same `since`,
    // so a crossing of the window boundary cannot open a gap between pages.
    const sinceCutoff = useMemo(() => logWindowCutoff(effective.window), [effective])
    const requestFilters = useMemo<LogsRequestFilters>(
        () => ({ ...effective, since: sinceCutoff ?? undefined }),
        [effective, sinceCutoff],
    )

    const logsQuery = useQuery({
        queryKey: ['admin-logs', requestFilters],
        queryFn: ({ signal }) => getLogs(requestFilters, signal),
        staleTime: 15_000,
        retry: adminRetry,
        placeholderData: keepPreviousData,
    })
    const { data, isFetching, error, refetch } = logsQuery
    const view = paneView(logsQuery)
    const serverRegexError = error instanceof AdminApiError && error.status === 400 && searchQ
        ? (error.message === 'regex_timeout'
            ? 'The pattern was rejected: it ran too long on the server. Narrow it and try again.'
            : `Invalid pattern: ${error.message}. Showing lines without search until it is fixed.`)
        : null

    // 250 ms debounce between typing and the server-side search. Emptying the
    // input also leaves regex mode, matching the approved mockup.
    useEffect(() => {
        const t = setTimeout(() => setFilters(f => {
            const regex = qInput ? f.regex : false
            if (f.q === qInput && f.regex === regex) return f
            return { ...f, q: qInput, regex }
        }), 250)
        return () => clearTimeout(t)
    }, [qInput])

    useEffect(() => {
        try {
            localStorage.setItem(WRAP_KEY, wrap ? '1' : '0')
        } catch {
            // storage unavailable: the preference stays for this session only
        }
    }, [wrap])

    useEffect(() => {
        liveRef.current = live
    }, [live])

    // The tail subscribes once; the filter view it counts against is read
    // through a ref so filter changes never resubscribe the stream.
    const effectiveRef = useRef(effective)
    useEffect(() => { effectiveRef.current = effective }, [effective])

    useEffect(() => {
        if (data && data.lastSeq > lastSeqRef.current) lastSeqRef.current = data.lastSeq
    }, [data])

    // The tail stays subscribed while paused so lines buffer; Resume backfills
    // from lastSeq and jumps to latest, with no gaps.
    const tailOn = data !== undefined
    useEffect(() => {
        if (!tailOn) return
        return openLogTail({
            afterSeq: lastSeqRef.current,
            onLine: line => {
                if (line.seq > lastSeqRef.current) lastSeqRef.current = line.seq
                const follow = liveRef.current && atBottomRef.current
                setTail(prev => appendTailLine(prev, line, LOGS_TAIL_CAP))
                // Only confirmed matches count: lines the filters hide never
                // inflate the pill, and regex lines wait for the refetch that
                // can confirm them (tailLineCountsAsNew reads effectiveRef).
                if (!follow && tailLineCountsAsNew(line, effectiveRef.current)) setNewCount(c => c + 1)
            },
            onState: setTailState,
            isSignedOut: async () => {
                try {
                    await getAdminSession()
                    return false
                } catch (e) {
                    if (e instanceof AdminApiError && e.status === 401) {
                        endAdminSession(queryClient)
                        return true
                    }
                    return false
                }
            },
        })
    }, [tailOn, queryClient])

    const pageLines = useMemo(() => data?.lines ?? [], [data])
    const maxSeq = pageLines.length ? pageLines[pageLines.length - 1].seq : 0
    const freshTail = useMemo(
        () => tail.filter(l => l.seq > maxSeq && tailLineMatches(l, effective)),
        [tail, maxSeq, effective],
    )
    const lines = useMemo(() => mergeLogLines([olderPages, pageLines, freshTail]), [olderPages, pageLines, freshTail])
    const allLoaded = useMemo(
        () => mergeLogLines([olderPages, pageLines, tail.filter(l => l.seq > maxSeq)]),
        [olderPages, pageLines, tail, maxSeq],
    )

    // Regex search is server-side only: new tail lines cannot be matched on the
    // client, so a quiet refetch folds them into the page instead.
    useEffect(() => {
        if (!effective.regex || !searchQ || tail.length === 0) return
        const t = setTimeout(() => { void refetch() }, 600)
        return () => clearTimeout(t)
    }, [tail.length, effective.regex, searchQ, refetch])

    // New page or filter change: older pages, expansion and the new counter reset.
    useEffect(() => {
        setOlderPages([])
        setOlderCursor(undefined)
        setExpandedSeq(null)
        setNewCount(0)
    }, [effective])

    const virtualizer = useVirtualizer({
        count: lines.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 36,
        overscan: 12,
        getItemKey: index => lines[index]?.seq ?? -index - 1,
    })

    // Keep the newest line in view while live and pinned to the bottom; the
    // measured total size re-pins as the virtualizer settles row heights.
    const totalSize = virtualizer.getTotalSize()
    useEffect(() => {
        if (live && atBottomRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [lines.length, live, totalSize])

    // Jump pending: once the target line is in the list, expand it and center it.
    useEffect(() => {
        const seq = pendingJump.current
        if (seq === null) return
        const index = lines.findIndex(l => l.seq === seq)
        if (index === -1) return
        pendingJump.current = null
        virtualizer.scrollToIndex(index, { align: 'center' })
    }, [lines, virtualizer])

    // Phone filters sheet: a modal that traps Tab, closes on Escape and returns
    // focus to the Filters trigger on close, mirroring the ui/dialog contract.
    useEffect(() => {
        if (!sheetOpen) return
        const trigger = filtersTriggerRef.current
        sheetReturnFocus.current = pickReturnFocus(
            [document.activeElement as HTMLElement | null, getLastActivated(), trigger],
            el => el !== document.body && !sheetRef.current?.contains(el),
        )
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                setSheetOpen(false)
                return
            }
            if (e.key !== 'Tab') return
            const container = sheetRef.current
            if (!container) return
            const focusable = Array.from(container.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )).filter(el => el.offsetParent !== null || el === document.activeElement)
            if (!focusable.length) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            // Focus parked on a non-tabbable element would otherwise Tab out of the modal.
            if (!focusable.includes(document.activeElement as HTMLElement)) {
                e.preventDefault()
                ;(e.shiftKey ? last : first).focus()
                return
            }
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault()
                last.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault()
                first.focus()
            }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
            window.removeEventListener('keydown', onKey, true)
            const target = sheetReturnFocus.current
            if (target?.isConnected) target.focus()
            else trigger?.focus()
        }
    }, [sheetOpen])

    const handleScroll = () => {
        const el = scrollRef.current
        if (!el) return
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        if (atBottomRef.current && live && newCount > 0) setNewCount(0)
    }

    const jumpToLatest = () => {
        setNewCount(0)
        const el = scrollRef.current
        if (el) {
            atBottomRef.current = true
            el.scrollTop = el.scrollHeight
        }
        if (!live) {
            setLive(true)
            void refetch()
        }
    }

    const nextCursor = olderCursor !== undefined ? olderCursor : data?.nextCursor ?? null
    const hasOlder = nextCursor !== null && lines.length > 0

    const loadOlder = useCallback(async (): Promise<boolean> => {
        const oldest = allLoaded[0]?.seq
        if (!oldest) return false
        setLoadingOlder(true)
        try {
            // requestFilters carries the captured cutoff, so this page and the
            // first page share one `since` even as the clock moves.
            const page = await getLogs({ ...requestFilters, cursor: oldest, limit: LOGS_PAGE_LIMIT })
            setOlderPages(prev => mergeLogLines([page.lines, prev]))
            setOlderCursor(page.nextCursor)
            return true
        } catch {
            toast({ variant: 'destructive', title: 'Could not load older lines', description: 'The buffer read failed; the loaded lines stay.' })
            return false
        } finally {
            setLoadingOlder(false)
        }
    }, [allLoaded, requestFilters])

    const jumpToGroup = (group: LogErrorGroup) => {
        const target = allLoaded.find(l => l.seq === group.firstSeq)
        if (!target) {
            // First occurrence is older than what is loaded: pull one page, then jump.
            if (nextCursor !== null && !loadingOlder) {
                void loadOlder().then(ok => {
                    if (ok) pendingJump.current = group.firstSeq
                })
            }
            return
        }
        const visible = lines.some(l => l.seq === group.firstSeq)
        if (!visible) {
            // Widen the filters once so the line can show.
            setFilters({ ...NO_LOG_FILTERS })
            setQInput('')
        }
        setExpandedSeq(group.firstSeq)
        pendingJump.current = group.firstSeq
    }

    const copyLine = (line: LogLine) => {
        void copyTextToClipboard(logLineText(line)).then(ok => {
            if (ok) {
                toast({ title: `Line ${line.seq} copied`, description: 'Redacted text only.' })
            } else {
                toast({ variant: 'destructive', title: 'Copy unavailable', description: 'The clipboard is blocked on this connection (http). Select the text and copy it manually.' })
            }
        })
    }

    const runExport = (format: LogsExportFormat) => {
        void downloadLogsExport(requestFilters, format).then(
            () => toast({ title: 'Export downloaded', description: `${logsExportName(format)} honors the current filters; redacted lines only.` }),
            (e: unknown) => toast({
                variant: 'destructive',
                title: 'Export failed',
                description: e instanceof AdminApiError ? paneErrorCopy(e, 'The log export') : 'The export could not be downloaded. Try again.',
            }),
        )
    }

    const clearFilters = () => {
        setFilters({ ...NO_LOG_FILTERS })
        setQInput('')
    }

    const counts: Record<'all' | LogLevel, number> = {
        all: data?.levels.all ?? 0,
        info: data?.levels.info ?? 0,
        warn: data?.levels.warn ?? 0,
        error: data?.levels.error ?? 0,
    }
    const activeCount = activeLogFilterCount(effective)
    const bufferEmpty = (data?.levels.all ?? 0) === 0
    const errorGroups = useMemo(() => groupLogErrors(lines), [lines])
    const tailDisconnected = live && (tailState === 'reconnecting' || tailState === 'stopped')

    return (
        <div>
            <ScreenHeader
                title="Logs"
                subtitle={data
                    ? `Live tail from a ${formatCount(data.bufferSize)}-line ring buffer. Redaction runs before storage, with no unredact toggle.`
                    : 'Redaction runs before storage, with no unredact toggle.'}
            />

            <Panel>
                <PanelHead
                    icon={<Terminal />}
                    title="Live tail"
                    detail={data?.redaction ?? 'Redacted before storage: no bodies, headers, secrets or query strings; IPs are removed.'}
                    actions={
                        <>
                            <span
                                data-tail-state={live ? tailState : 'paused'}
                                className={cn(
                                    'inline-flex items-center gap-1 text-xs font-semibold',
                                    !live || tailState === 'connecting' || tailState === 'stopped' ? 'text-muted-foreground' : tailState === 'live' ? 'text-success' : 'text-warning',
                                )}
                                aria-live="polite"
                            >
                                <Activity className={cn('h-3.5 w-3.5', live && tailState === 'live' && 'motion-safe:animate-pulse')} aria-hidden />
                                {live ? TAIL_LABEL[tailState] : 'Paused'}
                            </span>
                            <Button variant="secondary" size="sm" className="max-md:min-h-10" onClick={() => (live ? setLive(false) : jumpToLatest())} aria-pressed={!live}>
                                {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                {live ? 'Pause' : 'Resume'}
                            </Button>
                            <Button variant="secondary" size="sm" className="max-md:min-h-10" onClick={() => setWrap(w => !w)} aria-pressed={wrap}>
                                <WrapText className="h-3.5 w-3.5" aria-hidden />
                                Wrap
                            </Button>
                            <Button
                                ref={filtersTriggerRef}
                                variant="secondary"
                                size="sm"
                                className="max-md:min-h-10 md:hidden"
                                onClick={() => setSheetOpen(true)}
                                aria-haspopup="dialog"
                                aria-expanded={sheetOpen}
                            >
                                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                                Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
                            </Button>
                        </>
                    }
                />

                {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}
                {view === 'loading' ? (
                    <PaneLoading />
                ) : view === 'gone' || !data ? (
                    <PaneError message={paneErrorCopy(error, 'The log buffer')} onRetry={() => refetch()} retrying={isFetching} />
                ) : (
                    <>
                        <div className="mb-3">
                            <input
                                type="text"
                                value={qInput}
                                onChange={e => setQInput(e.target.value)}
                                maxLength={LOGS_Q_MAX}
                                placeholder="Search lines…"
                                aria-label="Search lines"
                                aria-invalid={Boolean(regexError)}
                                className={cn(
                                    'h-10 w-full min-w-0 rounded-xl border bg-muted/30 px-3.5 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                                    regexError ? 'border-destructive/60' : 'border-border/45',
                                )}
                            />
                            {(regexError || serverRegexError) && (
                                <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
                                    {regexError
                                        ? `Invalid pattern: ${regexError}. Showing lines without search until it is fixed.`
                                        : serverRegexError}
                                </p>
                            )}
                        </div>

                        <div className="mb-3 flex flex-wrap items-center gap-2 max-md:hidden">
                            <WindowChips value={filters.window} onChange={w => setFilters(f => ({ ...f, window: w }))} />
                            <LevelPills value={filters.level} counts={counts} onChange={l => setFilters(f => ({ ...f, level: l }))} />
                            <ModuleSelect
                                value={filters.module}
                                modules={data.modules}
                                onChange={m => setFilters(f => ({ ...f, module: m }))}
                                className="h-8 w-[9.5rem] rounded-full"
                            />
                            <RegexChip active={filters.regex} onToggle={() => setFilters(f => ({ ...f, regex: !f.regex }))} />
                            <Button variant="secondary" size="sm" onClick={() => void runExport('log')}>
                                <Download className="h-3.5 w-3.5" aria-hidden /> Export .log
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => void runExport('ndjson')}>
                                <Download className="h-3.5 w-3.5" aria-hidden /> Export .ndjson
                            </Button>
                        </div>

                        {tailDisconnected && (
                            <div role="status" className="mb-3 flex items-center gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-xs font-medium text-warning">
                                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                Tail disconnected. It resumes where it left off; the buffer keeps every line in the meantime.
                            </div>
                        )}

                        {errorGroups.length > 0 && (
                            <div className="mb-3 rounded-2xl border border-border/40 bg-muted/20">
                                <button
                                    type="button"
                                    aria-expanded={errorsOpen}
                                    onClick={() => setErrorsOpen(o => !o)}
                                    className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                >
                                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
                                    <span className="text-xs font-semibold">Errors, grouped</span>
                                    <span className="text-xs text-muted-foreground">
                                        {errorGroups.length} signatures · {formatCount(data.levels.error)} lines in view
                                    </span>
                                    <span className="ml-auto inline-flex h-6 w-6 items-center justify-center text-muted-foreground">
                                        {errorsOpen ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                                    </span>
                                </button>
                                {errorsOpen && errorGroups.map(g => (
                                    <div key={g.signature} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/30 px-3.5 py-2.5">
                                        <span className="min-w-0 flex-1 basis-48 truncate text-xs text-foreground/85" title={g.signature}>{g.signature}</span>
                                        <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-destructive">×{g.count}</span>
                                        <span className="shrink-0 text-xs text-muted-foreground">last seen {relTime(g.lastAt)}</span>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 shrink-0 px-2.5 text-xs max-md:min-h-10"
                                            onClick={() => jumpToGroup(g)}
                                        >
                                            Jump
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="relative">
                            <div
                                ref={scrollRef}
                                data-logs-scroll
                                onScroll={handleScroll}
                                aria-label="Log lines"
                                className={cn(TABLE_SURFACE, 'max-h-[26rem] overflow-y-auto overscroll-contain')}
                            >
                                {lines.length === 0 ? (
                                    <div className="px-6 py-12 text-center">
                                        <p className="text-xs text-muted-foreground">
                                            {bufferEmpty
                                                ? 'The buffer is empty. New lines appear here as they arrive.'
                                                : 'No lines match the current filters.'}
                                        </p>
                                        {!bufferEmpty && (
                                            <Button variant="outline" size="sm" className="mt-3 max-md:min-h-10" onClick={clearFilters}>
                                                Clear filters
                                            </Button>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                                        {virtualizer.getVirtualItems().map(vi => {
                                            const line = lines[vi.index]
                                            if (!line) return null
                                            return (
                                                <div
                                                    key={line.seq}
                                                    data-index={vi.index}
                                                    ref={virtualizer.measureElement}
                                                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                                                >
                                                    <LogRow
                                                        line={line}
                                                        expanded={expandedSeq === line.seq}
                                                        wrap={wrap}
                                                        onToggle={() => setExpandedSeq(current => (current === line.seq ? null : line.seq))}
                                                        onCopy={() => copyLine(line)}
                                                    />
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                            {newCount > 0 && (
                                <button
                                    type="button"
                                    onClick={jumpToLatest}
                                    className="absolute bottom-3 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                                >
                                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                                    {newCount} new
                                </button>
                            )}
                        </div>

                        {hasOlder && (
                            <div className="mt-2.5 flex justify-center">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs font-semibold max-md:min-h-10"
                                    onClick={() => void loadOlder()}
                                    disabled={loadingOlder}
                                >
                                    {loadingOlder ? 'Loading older lines' : 'Load older lines'}
                                </Button>
                            </div>
                        )}

                        {sheetOpen && (
                            <div className="fixed inset-0 z-[60] md:hidden">
                                <div
                                    aria-hidden
                                    data-theme-part="dialog-overlay"
                                    className="absolute inset-0 bg-black/50"
                                    onClick={() => setSheetOpen(false)}
                                />
                                <div
                                    ref={sheetRef}
                                    role="dialog"
                                    aria-modal="true"
                                    aria-label="Filters"
                                    className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border border-border/50 bg-card p-4 pb-[calc(2rem+env(safe-area-inset-bottom))] shadow-2xl"
                                >
                                    <div className="mb-4 flex items-center justify-between">
                                        <span className="inline-flex items-center gap-2 text-sm font-semibold">
                                            <SlidersHorizontal className="h-4 w-4" aria-hidden />
                                            Filters
                                        </span>
                                        <Button size="sm" className="max-md:min-h-10" onClick={() => setSheetOpen(false)} autoFocus>
                                            Done
                                        </Button>
                                    </div>
                                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Level</p>
                                    <LevelPills value={filters.level} counts={counts} onChange={l => setFilters(f => ({ ...f, level: l }))} />
                                    <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Module</p>
                                    <ModuleSelect
                                        value={filters.module}
                                        modules={data.modules}
                                        onChange={m => setFilters(f => ({ ...f, module: m }))}
                                        className="h-10 w-full rounded-xl"
                                    />
                                    <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Time window</p>
                                    <WindowChips value={filters.window} onChange={w => setFilters(f => ({ ...f, window: w }))} />
                                    <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Regex</p>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <RegexChip active={filters.regex} onToggle={() => setFilters(f => ({ ...f, regex: !f.regex }))} />
                                    </div>
                                    <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Export</p>
                                    <div className="flex flex-wrap gap-2">
                                        <Button variant="secondary" size="sm" className="max-md:min-h-10" onClick={() => void runExport('log')}>
                                            <Download className="h-3.5 w-3.5" aria-hidden /> Export .log
                                        </Button>
                                        <Button variant="secondary" size="sm" className="max-md:min-h-10" onClick={() => void runExport('ndjson')}>
                                            <Download className="h-3.5 w-3.5" aria-hidden /> Export .ndjson
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                )}

                <LegendNote className="mt-3">
                    Search, filters and exports run over the already-redacted ring, so exports contain redacted lines only. <b>Logs cannot be cleared from the Dashboard: there is no clear button by design.</b> The buffer is per process; log files remain the durable record. Wrap and the tail are remembered per browser.
                </LegendNote>
            </Panel>
        </div>
    )
}
