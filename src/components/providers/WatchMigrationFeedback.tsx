import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, CheckCircle2, CircleAlert, Download, Info, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatWatchPosition, watchRecordSubtitle, watchRecordTitle } from '@/lib/watch-state/records'
import type { MigrationResult, WatchMigrationPlan, WatchStateRecord } from '@/lib/watch-state/types'
import { MigrationArtwork } from './MigrationArtwork'

export type MigrationOutcome = 'complete' | 'stopped' | 'failed'
export interface ImportProgress { completed: number; total: number }

export function migrationStateLabel(record: Pick<WatchStateRecord, 'watched' | 'positionMs'> & Partial<Pick<WatchStateRecord, 'playedAt' | 'playCount'>>): string {
    const values = []
    if (record.watched === true) values.push('Watched')
    else if (record.watched === false) values.push('Not watched')
    if (record.positionMs !== undefined && record.positionMs > 0) values.push(`Continue at ${formatWatchPosition(record.positionMs)}`)
    if (record.playedAt !== undefined && record.playedAt !== null) values.push(`Last played ${new Date(record.playedAt).toLocaleString()}`)
    if (record.playCount !== undefined && record.playCount > 0) values.push(`${record.playCount.toLocaleString()} ${record.playCount === 1 ? 'play' : 'plays'}`)
    return values.join(' · ') || 'No saved watch information'
}

export function MigrationProgressPanel({ mode, message, progress }: {
    mode: 'preview' | 'import'; message: string; progress: ImportProgress | null
}) {
    const percent = progress ? Math.round(progress.completed / Math.max(1, progress.total) * 100) : undefined
    return <section aria-label={mode === 'import' ? 'Import progress' : 'Preview progress'} data-theme-part="panel" className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-primary" />{mode === 'import' ? 'Importing your watch information' : 'Preparing your preview'}</h3>
        <p role="status" className="sr-only">{mode === 'import' ? 'Saving and confirming the selected titles.' : 'Reading connections and checking matches. Nothing is being saved.'}</p>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div role="progressbar" aria-label={mode === 'import' ? 'Import progress' : 'Preview progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={progress ? `${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} titles checked` : undefined} data-theme-part="progress" className="h-2 overflow-hidden rounded-full bg-muted">
            <div data-theme-part="progress-indicator" className={progress ? 'h-full rounded-full bg-primary motion-safe:transition-[width]' : 'h-full w-1/3 animate-pulse rounded-full bg-primary'} style={progress ? { width: `${percent}%` } : undefined} />
        </div>
        {progress && <p className="flex justify-between gap-3 text-xs tabular-nums text-muted-foreground"><span>{progress.completed.toLocaleString()} of {progress.total.toLocaleString()} titles checked</span><span>{percent}%</span></p>}
        <p className="text-xs leading-relaxed text-muted-foreground">{mode === 'import' ? 'Each title is checked before saving and confirmed afterward. You can stop at any time; confirmed titles stay saved.' : 'Reading your connections and checking matches. Nothing is being saved.'}</p>
    </section>
}

const resultLabels = { applied: 'Imported', unchanged: 'Already saved', conflict: 'Kept', failed: 'Unconfirmed' } as const

export function MigrationImportLog({ plan, results }: { plan: WatchMigrationPlan; results: MigrationResult[] }) {
    const rows = useMemo(() => new Map(plan.rows.map(row => [row.id, row])), [plan])
    const recent = results.slice(-6)
    return <section aria-label="Import log" className="overflow-hidden rounded-2xl border border-border/40 bg-card shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/40 px-4 py-3">
            <h4 className="text-sm font-semibold">Import log</h4>
            <span className="text-xs tabular-nums text-muted-foreground">{results.length > 6 ? `Latest 6 of ${results.length.toLocaleString()} checked` : `${results.length.toLocaleString()} checked`}</span>
        </div>
        {recent.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">Checking your titles. Results will appear here.</p>}
        <ol role="log" aria-label="Recent import results" aria-live="polite" aria-relevant="additions" className="divide-y divide-border/40 px-4">
            {recent.map(result => {
                const row = rows.get(result.rowId)
                const ResultIcon = result.status === 'applied' || result.status === 'unchanged' ? CheckCircle2 : result.status === 'failed' ? CircleAlert : Info
                return <li key={result.rowId} className="flex items-start gap-2.5 py-3">
                    <ResultIcon aria-hidden="true" className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', result.status === 'failed' ? 'text-warning' : 'text-muted-foreground')} />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium [overflow-wrap:anywhere]">{row ? watchRecordTitle(row.source) : 'Title'}</p>
                        {row && <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{watchRecordSubtitle(row.source)}</p>}
                    </div>
                    <span className="max-w-[40%] text-right text-xs leading-5 text-muted-foreground">{result.status === 'applied' ? 'Saved and confirmed' : resultLabels[result.status]}</span>
                </li>
            })}
        </ol>
    </section>
}

const resultDescriptions = {
    applied: 'Saved and confirmed on this connection.',
    unchanged: 'Already saved here. No extra copy was needed.',
    conflict: 'Changed or existing watch information was kept.',
    failed: 'We couldn’t confirm this save. The title may already be saved; check a fresh preview before trying again.',
} as const

function resultExplanation(result: MigrationResult): string {
    if (result.status === 'failed' && result.failure) return result.message
    if (result.status === 'conflict' && result.message.includes('source record changed')) return 'The source changed after the preview. This title wasn’t copied; preview again to check its new state.'
    if (result.status === 'conflict' && result.message.includes('playing on the destination')) return 'This title is playing now, so it wasn’t copied. Try again after playback stops.'
    return resultDescriptions[result.status]
}

export function MigrationResultsPanel({ plan, results, outcome, connections, notice, unattempted = 0, onExport }: {
    plan: WatchMigrationPlan; results: MigrationResult[]; outcome: MigrationOutcome
    connections: { source: { name: string; user: string; logo: ReactNode }; destination: { name: string; user: string; logo: ReactNode } }
    notice?: string; unattempted?: number; onExport?: () => void
}) {
    const heading = useRef<HTMLHeadingElement>(null)
    const [filter, setFilter] = useState<'all' | 'applied' | 'kept' | 'attention'>('all')
    const [page, setPage] = useState(0)
    const rows = useMemo(() => new Map(plan.rows.map(row => [row.id, row])), [plan])
    const byResult = useMemo(() => new Map(results.map(result => [result.rowId, result])), [results])
    const imported = results.filter(result => result.status === 'applied').length
    const kept = results.filter(result => result.status === 'unchanged' || result.status === 'conflict').length
    const review = results.filter(result => result.status === 'failed').length
    const readyWithoutResult = plan.rows.filter(row => row.status === 'ready' && !byResult.has(row.id)).length
    const otherReady = Math.max(0, readyWithoutResult - unattempted)
    const alreadySaved = plan.rows.filter(row => row.status === 'unchanged').length
    const previewKept = plan.rows.filter(row => row.status === 'conflict').length
    const unmatched = plan.rows.filter(row => row.status === 'skipped' || row.status === 'unsupported').length
    const undated = results.filter(result => result.status === 'applied' && rows.get(result.rowId)?.undated === true).length
    const datesNotCopied = results.some(result => result.status === 'applied' && rows.get(result.rowId)?.notes.includes('Original watch dates cannot be preserved by this destination.'))
    const visible = results.filter(result => filter === 'all' || (filter === 'attention' ? result.status === 'failed' : filter === 'kept' ? result.status === 'unchanged' || result.status === 'conflict' : result.status === 'applied'))
    const pageCount = Math.max(1, Math.ceil(visible.length / 50))
    const shownPage = Math.min(page, pageCount - 1)
    // Filters only earn their space once the list is long enough to need them and more than
    // one outcome category exists; a short list stays a plain, scannable list.
    const filterChoices = useMemo(() => ([
        { key: 'all' as const, label: 'All', count: results.length },
        { key: 'applied' as const, label: 'Imported', count: imported },
        { key: 'kept' as const, label: 'Kept', count: kept },
        { key: 'attention' as const, label: 'Unconfirmed', count: review },
    ]).filter(choice => choice.key === 'all' || choice.count > 0), [results.length, imported, kept, review])
    const showFilters = results.length >= 10 && filterChoices.length > 2
    // The heading names the actionable outcome (mockup target): unconfirmed writes outrank
    // the stopped flag, and a clean run stays a plain "Import complete".
    let title = 'Import complete'
    if (outcome === 'failed' || review > 0) title = review === 1 ? 'One title needs review' : review > 1 ? `${review.toLocaleString()} titles need review` : 'Import needs attention'
    else if (outcome === 'stopped') title = 'Import stopped'
    const tone = outcome === 'failed' && review === 0 ? 'destructive' : outcome === 'stopped' || review > 0 ? 'warning' : 'success'
    const OutcomeIcon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? CircleAlert : CircleAlert
    useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
    return <section aria-label="Import results" className="space-y-4">
        <div className="space-y-2">
            <h3 ref={heading} tabIndex={-1} className={cn('flex items-center gap-2 text-lg font-semibold leading-tight tracking-tight outline-none', tone === 'destructive' ? 'text-destructive' : tone === 'warning' && 'text-warning')}><OutcomeIcon aria-hidden="true" className={cn('h-5 w-5 shrink-0', tone === 'success' ? 'text-success' : tone === 'warning' && 'text-warning')} />{title}</h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground">
                <div className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">{connections.source.logo}<span className="min-w-0">{connections.source.name} · {connections.source.user}</span></div>
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <div className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">{connections.destination.logo}<span className="min-w-0">{connections.destination.name} · {connections.destination.user}</span></div>
            </div>
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm leading-relaxed"><span className="sr-only">Outcome counts: </span>
                {(imported > 0 || review > 0 || unattempted > 0 || kept === 0) && <span><span className="font-semibold tabular-nums text-success">{imported.toLocaleString()}</span> <span className="text-muted-foreground">{imported > 0 ? 'imported and confirmed' : 'imported'}</span></span>}
                {kept > 0 && <span><span className="font-semibold tabular-nums">{kept.toLocaleString()}</span> <span className="text-muted-foreground">kept as is</span></span>}
                {review > 0 && <span><span className="font-semibold tabular-nums text-warning">{review.toLocaleString()}</span> <span className="text-muted-foreground">unconfirmed</span></span>}
                {unattempted > 0 && <span><span className="font-semibold tabular-nums">{unattempted.toLocaleString()}</span> <span className="text-muted-foreground">not attempted</span></span>}
                {imported === 0 && kept === 0 && review === 0 && unattempted === 0 && <span className="text-muted-foreground">Nothing was confirmed in this run.</span>}
            </p>
            {notice && <p className="flex items-start gap-2 text-xs leading-relaxed text-warning"><CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{notice}</span></p>}
        </div>
        {results.length > 0 ? <div className="space-y-1.5">
            {showFilters && <div aria-label="Filter import results" className="flex flex-wrap gap-1.5">
                {filterChoices.map(choice => <Button key={choice.key} size="sm" variant="ghost" aria-pressed={filter === choice.key} onClick={() => { setFilter(choice.key); setPage(0) }} className={cn('h-7 gap-1.5 rounded-full px-2.5 text-xs', filter === choice.key ? 'bg-muted text-foreground' : 'text-muted-foreground')}>{choice.label}<span className="tabular-nums text-[10px] text-muted-foreground">{choice.count.toLocaleString()}</span></Button>)}
            </div>}
            {visible.length > 0 ? <ul aria-label="Imported title results" className="divide-y divide-border/40 border-y border-border/40">{visible.slice(shownPage * 50, (shownPage + 1) * 50).map(result => {
                const row = rows.get(result.rowId)
                return <li key={result.rowId} className="flex items-start gap-3 py-3">
                    {row && <MigrationArtwork record={row.source} />}
                    <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1"><div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{row ? watchRecordTitle(row.source) : 'Title'}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{row ? watchRecordSubtitle(row.source) : 'Title'}</p></div><span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs', result.status === 'failed' ? 'text-warning' : 'text-muted-foreground')}>{result.status === 'applied' && <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />}{resultLabels[result.status]}</span></div>
                        {result.verified && (result.status === 'applied' || result.status === 'unchanged') && <p className="text-xs leading-relaxed text-muted-foreground"><span className="font-medium text-foreground/80">Saved here:</span> {migrationStateLabel(result.verified)}</p>}
                        <p className="text-xs leading-relaxed text-muted-foreground">{resultExplanation(result)}</p>
                    </div>
                </li>
            })}</ul> : <p className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center text-sm text-muted-foreground">No titles in this result filter.</p>}
            {pageCount > 1 && <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground"><Button size="sm" variant="outline" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</Button><span>Page {shownPage + 1} of {pageCount}</span><Button size="sm" variant="outline" disabled={shownPage + 1 === pageCount} onClick={() => setPage(shownPage + 1)}>Next</Button></div>}
        </div> : <p className="text-sm text-muted-foreground">No titles were confirmed in this run.</p>}
        <details data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/20">
            <summary className="cursor-pointer select-none rounded-2xl px-4 py-2.5 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Import details &amp; report</summary>
            <div className="space-y-2 border-t border-border/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
                {outcome === 'stopped' && <p>Confirmed titles stay saved. Titles that weren’t reached can be reviewed and retried after a fresh preview.</p>}
                {undated > 0 && <p className="flex items-start gap-2"><Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{undated.toLocaleString()} {undated === 1 ? 'title had' : 'titles had'} no exact watch time and {undated === 1 ? 'was' : 'were'} sent without a date.</span></p>}
                {datesNotCopied && <p className="flex items-start gap-2"><Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Original watch dates weren’t copied. This server may show when the import ran instead.</span></p>}
                {!plan.source.complete && <p className="flex items-start gap-2"><CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>The source returned an incomplete history. Only titles found in this preview were considered.</span></p>}
                {(otherReady > 0 || alreadySaved > 0 || unmatched > 0 || previewKept > 0) && <div className="space-y-1 border-l-2 border-border pl-3">
                    {otherReady > 0 && <p>{otherReady.toLocaleString()} other {otherReady === 1 ? 'title is' : 'titles are'} ready in this preview but weren’t selected.</p>}
                    {alreadySaved > 0 && <p>{alreadySaved.toLocaleString()} {alreadySaved === 1 ? 'title was' : 'titles were'} already saved before this import.</p>}
                    {previewKept > 0 && <p>{previewKept.toLocaleString()} {previewKept === 1 ? 'title was' : 'titles were'} kept during preview because existing destination data or its match could not be safely changed. Review their reasons in a fresh preview.</p>}
                    {unmatched > 0 && <p>{unmatched.toLocaleString()} {unmatched === 1 ? 'title could' : 'titles could'} not be matched or are unsupported. You can review them in the item details.</p>}
                </div>}
                {onExport && <div className="flex flex-wrap items-center gap-3 pt-1">
                    <Button size="sm" variant="outline" onClick={onExport}><Download aria-hidden="true" className="h-3.5 w-3.5" />Export report</Button>
                    <span>Reports include title and account names.</span>
                </div>}
            </div>
        </details>
    </section>
}
