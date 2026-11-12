import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, CheckCircle2, Download, Import, Info, ShieldCheck, Square, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusChip } from '@/components/ui/status-chip'
import { EmptyState } from '@/components/common/EmptyState'
import { AccountAvatar } from '@/components/common/AccountSwitcher'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { captureSyncOwnership, type SyncOwnership } from '@/store/sync-store-helpers'
import { subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { maskEmailLevel, maskNameLevel, maskProfileLevel } from '@/lib/utils'
import { createWatchMigrationDestination } from '@/lib/watch-state/destinations'
import { createWatchMigrationSource, migrationSourceLabel, watchMigrationSources } from '@/lib/watch-state/sources'
import { watchConnectionLabel } from './watch-migration-labels'
import { useNuvioProfileRows } from './use-nuvio-profile-rows'
import { executeWatchMigration, migrationReport, planWatchMigration } from '@/lib/watch-state/migration'
import { migrationErrorMessage } from '@/lib/watch-state/error-messages'
import { isStaleKeptResult } from '@/lib/watch-state/result-counts'
import { undatedRowCount, watchRecordSubtitle, watchRecordTitle } from '@/lib/watch-state/records'
import type { MigrationResult, MigrationRow, WatchMigrationPlan, WatchStateDestination, WatchStateSource } from '@/lib/watch-state/types'
import { refreshJellyfinMedia } from './useJellyfinMedia'
import { useLibraryCache } from '@/store/libraryCache'
import { PlatformLogo, connectionLogoProduct } from './ConnectionPrimitives'
import { MigrationArtwork } from './MigrationArtwork'
import { MigrationTitleDetails } from './MigrationTitleDetails'
import { MigrationProgressPanel, MigrationImportLog, MigrationResultsPanel, migrationStateLabel, type ImportProgress, type MigrationOutcome } from './WatchMigrationFeedback'
import type { Account } from '@/types/account'
import type { Connection } from '@/types/connection'

interface Props {
    open: boolean
    onOpenChange: (open: boolean) => void
    accountId: string
    connection: Connection
}

interface MigrationSession {
    key: CryptoKey
    ownership: SyncOwnership
    source: WatchStateSource
    destination: WatchStateDestination
    sourceAccountId: string
    sourceId: string
    sourceStamp: string
    destinationStamp: string
}

const statusVariants = {
    ready: 'primary', unchanged: 'muted', conflict: 'warning', skipped: 'muted',
    unsupported: 'warning', applied: 'success', failed: 'destructive',
} as const

function MigrationEndpoint({ label, connection, name, user, userId, compact = false }: {
    label: string; connection: Connection; name: string; user: string; userId?: string; compact?: boolean
}) {
    return <div data-theme-part="panel" className={`min-w-0 rounded-2xl border border-border/40 bg-card/50 shadow-sm ${compact ? 'p-3' : 'p-4'}`}>
        {!compact && <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>}
        <div className="flex items-center gap-3">
            <PlatformLogo platform={connection.platform} product={connectionLogoProduct(connection)} isHydra={connection.connectionType === 'hydra-outbound'} className={`${compact ? 'h-9 w-9' : 'h-11 w-11'} shrink-0`} />
            <div className={`min-w-0 flex-1 ${compact ? 'space-y-0.5' : 'space-y-1'}`}>
                {compact && <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>}
                <p className="break-words text-sm font-semibold">{name}</p>
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><UserRound aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">User: {user}</span></p>
            </div>
        </div>
        {userId && <details className="mt-3 border-t border-border/30 pt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Connection details</summary>
            <p className="mt-2 break-all font-mono">User ID: {userId}</p>
            <p className="mt-2">To use another destination user, add that user as a connection first.</p>
        </details>}
    </div>
}

function connectionStamp(account: Account | undefined, connectionId: string): string {
    if (!account) return ''
    const connection = watchMigrationSources(account).find(item => item.id === connectionId)
    if (!connection?.enabled) return ''
    return JSON.stringify([account.id, connection.id, connection.platform, connection.connectionType, connection.credentials, connection.mediaServer, connection.profileMapping, account.authKey])
}

function statusLabel(status: MigrationRow['status'] | MigrationResult['status']): string {
    if (status === 'ready') return 'Ready'
    if (status === 'applied') return 'Imported'
    if (status === 'unchanged') return 'Already saved'
    if (status === 'conflict') return 'Kept'
    if (status === 'failed') return 'Check before retry'
    if (status === 'unsupported') return 'Unsupported'
    return 'Skipped'
}

function rowExplanation(row: MigrationRow, result?: MigrationResult): string {
    const status = result?.status || row.status
    if (status === 'applied') return 'Imported and confirmed on this connection.'
    if (status === 'unchanged') return 'Already saved here. No changes were needed.'
    if (status === 'ready') return 'Ready to copy. Only the selected watch information will be added.'
    if (status === 'failed') return 'We couldn’t confirm this import. Check the item details before trying again.'
    if (status === 'conflict') {
        if (result?.message.includes('source record changed')) return 'This title changed in your source after the preview. Preview again before copying it.'
        if (result?.message.includes('playing on the destination')) return 'This title is playing right now. Try importing it after playback stops.'
        return row.target
            ? 'Existing information was kept without overwriting it. See the item details for the reason.'
            : 'We couldn’t choose one matching title with confidence, so nothing will be copied.'
    }
    if (status === 'unsupported') return 'This connection can’t copy the selected information for this title.'
    return 'This title couldn’t be matched to this user’s library. Nothing will be copied.'
}

function readableNote(note: string): string {
    if (note === 'Stremio keeps one resume point per series: resume points for different episodes of the same series cannot be combined or replaced.') return 'Stremio keeps one resume point per series. Conflicting progress for another episode is kept.'
    if (note === 'Stremio stores no per-episode watch dates or play counts: it keeps one last-watched date per title, only ever moved forward, and exact dates are copied only for movies and the resume episode.') return 'Stremio keeps one watch date per title. Exact dates are copied for movies and the resume episode, and play counts are not copied.'
    if (note === 'Stremio offers no compare-and-swap: every write re-reads the row immediately before saving and verifies it by reading it back.') return 'Each title is checked again before saving and read back afterward. Stremio cannot lock out simultaneous changes from another client.'
    if (note === 'Series longer than 2,500 listed episodes cannot be verified episode by episode on this destination.') return 'Series with more than 2,500 episodes are too large to check completely for this import.'
    if (note === 'This source is pinned to one Nuvio profile; other profiles of the account are not read.') return 'Only the selected Nuvio profile is included. Other profiles stay separate.'
    if (note === 'Watched marks may be forwarded to the trackers this AIOMetadata profile reports to.') return 'AIOMetadata may also send these watched titles to this profile’s linked tracking services.'
    if (note === 'Watched marks may be forwarded to the watch-state sinks this AIOStreams server reports to.') return 'AIOStreams may also send these updates to its linked tracking services.'
    if (note === 'Original watch dates cannot be preserved by this destination.') return 'The source date won’t be copied. This server may show the import time instead.'
    return note.replaceAll('watched flags', 'watched titles').replaceAll('resume points', 'saved playback positions').replaceAll('play counts', 'number of plays')
}

export function WatchMigrationDialog({ open, onOpenChange, accountId, connection }: Props) {
    const accounts = useAccountStore(state => state.accounts)
    const encryptionKey = useAuthStore(state => state.encryptionKey)
    const privacy = useUIStore(state => state.isPrivacyModeEnabled)
    const nameLevel = useUIStore(state => state.privacyLevelNames)
    const emailLevel = useUIStore(state => state.privacyLevelEmail)
    const profileLevel = useUIStore(state => state.privacyLevelProfiles)
    const [sourceAccountId, setSourceAccountId] = useState(accountId)
    const [sourceId, setSourceId] = useState('')
    const [watched, setWatched] = useState(connection.platform !== 'realstream')
    const [resume, setResume] = useState(true)
    const [plan, setPlan] = useState<WatchMigrationPlan | null>(null)
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [results, setResults] = useState<MigrationResult[]>([])
    const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
    const [progress, setProgress] = useState('')
    const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
    const [outcome, setOutcome] = useState<MigrationOutcome | null>(null)
    const [showResults, setShowResults] = useState(false)
    const [error, setError] = useState('')
    const [search, setSearch] = useState('')
    const [filter, setFilter] = useState('all')
    const [page, setPage] = useState(0)
    const request = useRef<AbortController | null>(null)
    const stopButton = useRef<HTMLButtonElement>(null)
    const primaryButton = useRef<HTMLButtonElement>(null)
    const previewHeading = useRef<HTMLHeadingElement>(null)
    const session = useRef<MigrationSession | null>(null)
    const sourceAccount = accounts.find(account => account.id === sourceAccountId)
    const sources = useMemo(() => sourceAccount ? watchMigrationSources(sourceAccount).filter(item => item.id !== connection.id || sourceAccount.id !== accountId) : [], [sourceAccount, accountId, connection.id])
    const displayName = (value: string) => value.includes('@') ? maskEmailLevel(value, privacy ? emailLevel : 0) : maskNameLevel(value, privacy ? nameLevel : 0)
    const identifier = (value: string) => maskProfileLevel(value, privacy ? profileLevel : 0)
    const selectedSource = sources.find(source => source.id === sourceId)
    const sourceProfileRows = useNuvioProfileRows(sourceAccount?.id, sources)
    const sourceProfileNames = useCallback((item: Connection) => sourceProfileRows[item.id], [sourceProfileRows])

    useEffect(() => {
        if (busy) stopButton.current?.focus()
        else if (plan && !showResults) previewHeading.current?.focus({ preventScroll: true })
        else if (!plan) primaryButton.current?.focus({ preventScroll: true })
    }, [busy, plan, showResults])

    useEffect(() => {
        if (!open) return
        const check = () => {
            const current = session.current
            if (!current) return
            const currentAccounts = useAccountStore.getState().accounts
            if (useAuthStore.getState().encryptionKey !== current.key
                || !current.ownership.current()
                || connectionStamp(currentAccounts.find(account => account.id === current.sourceAccountId), current.sourceId) !== current.sourceStamp
                || connectionStamp(currentAccounts.find(account => account.id === accountId), connection.id) !== current.destinationStamp) {
                request.current?.abort()
                session.current = null
                setPlan(null)
                setResults([])
                setOutcome(null)
                setShowResults(false)
                setImportProgress(null)
                setSelected(new Set())
                setError('The workspace, vault, source or destination changed. Unlock and preview again.')
            }
        }
        const stop = () => { request.current?.abort() }
        const accountsUnsubscribe = useAccountStore.subscribe(check)
        const authUnsubscribe = useAuthStore.subscribe(check)
        const workspaceUnsubscribe = subscribeWorkspaceChanges(check)
        window.addEventListener('pagehide', stop)
        return () => {
            stop()
            session.current = null
            accountsUnsubscribe()
            authUnsubscribe()
            workspaceUnsubscribe()
            window.removeEventListener('pagehide', stop)
        }
    }, [open, accountId, connection.id])

    const reset = () => {
        request.current?.abort()
        session.current = null
        setPlan(null)
        setResults([])
        setOutcome(null)
        setShowResults(false)
        setImportProgress(null)
        setSelected(new Set())
        setProgress('')
        setError('')
        setSearch('')
        setFilter('all')
        setPage(0)
    }

    const preview = async () => {
        if (request.current || !sourceAccount || !sourceId || !encryptionKey) return
        const controller = new AbortController()
        request.current = controller
        session.current = null
        setBusy('preview')
        setError('')
        setProgress('Verifying the source and destination users…')
        const sourceStamp = connectionStamp(sourceAccount, sourceId)
        const destinationAccount = useAccountStore.getState().accounts.find(account => account.id === accountId)
        const destinationStamp = connectionStamp(destinationAccount, connection.id)
        const ownership = captureSyncOwnership()
        const assertCurrent = () => {
            ownership.assert()
            const fresh = useAccountStore.getState().accounts
            if (useAuthStore.getState().encryptionKey !== encryptionKey
                || sourceStamp !== connectionStamp(fresh.find(account => account.id === sourceAccountId), sourceId)
                || destinationStamp !== connectionStamp(fresh.find(account => account.id === accountId), connection.id)) throw new Error('The destination changed. Preview again before importing.')
        }
        try {
            if (!sourceStamp || !destinationStamp || !connection.enabled) throw new Error('Connection disabled')
            const [source, destination] = await Promise.all([
                createWatchMigrationSource(sourceAccount, encryptionKey, sourceId, controller.signal, assertCurrent),
                createWatchMigrationDestination(destinationAccount!, encryptionKey, connection.id, controller.signal, assertCurrent),
            ])
            controller.signal.throwIfAborted()
            const current = useAccountStore.getState().accounts
            if (useAuthStore.getState().encryptionKey !== encryptionKey
                || sourceStamp !== connectionStamp(current.find(account => account.id === sourceAccountId), sourceId)
                || destinationStamp !== connectionStamp(current.find(account => account.id === accountId), connection.id)) throw new Error('Connection changed')
            ownership.assert()
            const context = { key: encryptionKey, ownership, source, destination, sourceAccountId, sourceId, sourceStamp, destinationStamp }
            session.current = context
            const snapshot = await source.read(controller.signal, setProgress)
            controller.signal.throwIfAborted()
            if (snapshot.scope === destination.scope) {
                session.current = null
                setError('The source and destination are the same remote user. Choose another account or connection.')
                setProgress('')
                return
            }
            const result = await planWatchMigration(snapshot, destination, { watched, resume }, controller.signal, setProgress)
            controller.signal.throwIfAborted()
            if (session.current !== context) throw new Error('Connection changed')
            setPlan(result)
            setResults([])
            setSelected(new Set(result.rows.filter(row => row.status === 'ready').map(row => row.id)))
            setPage(0)
            setProgress('Preview ready. Choose the titles to import.')
        } catch (cause) {
            if (controller.signal.aborted) setProgress('Preview stopped. Preview again when ready.')
            else {
                setProgress('')
                setError(migrationErrorMessage(cause, 'Could not build the preview. Test both connections, verify the selected user or profile, then try again.'))
            }
            session.current = null
        } finally {
            controller.abort()
            if (request.current === controller) request.current = null
            setBusy(null)
        }
    }

    const run = async () => {
        const current = session.current
        if (!current || !plan || request.current) return
        const finished = new Set(results.filter(result => result.status !== 'failed').map(result => result.rowId))
        const total = plan.rows.filter(row => row.status === 'ready' && row.target && row.patch && selected.has(row.id) && !finished.has(row.id)).length
        if (!total) return
        const controller = new AbortController()
        request.current = controller
        setBusy('import')
        setImportProgress({ completed: 0, total })
        setOutcome(null)
        setShowResults(false)
        setProgress('Checking your source before importing…')
        setError('')
        const pending = new Map(results.map(result => [result.rowId, result]))
        const checked = new Set<string>()
        let changed = false
        let lastUpdate = 0
        let lastMessageUpdate = 0
        const reportProgress = (message: string) => {
            const now = performance.now()
            if (session.current === current && now - lastMessageUpdate >= 250) {
                setProgress(message)
                lastMessageUpdate = now
            }
        }
        const publish = () => {
            if (changed && session.current === current) {
                setResults([...pending.values()])
                setImportProgress({ completed: checked.size, total })
            }
            changed = false
            lastUpdate = performance.now()
        }
        try {
            await executeWatchMigration(plan, current.source, current.destination, selected, results, controller.signal, result => {
                pending.set(result.rowId, result)
                checked.add(result.rowId)
                changed = true
                if (performance.now() - lastUpdate >= 250 || result.status === 'failed') publish()
            }, reportProgress)
            controller.signal.throwIfAborted()
            if (session.current === current) setOutcome('complete')
            setProgress('Import finished. Review the confirmed and skipped titles.')
        } catch (cause) {
            if (session.current === current) setOutcome(controller.signal.aborted ? 'stopped' : 'failed')
            setProgress(controller.signal.aborted ? 'Import stopped. Confirmed titles were kept. Check unfinished titles before retrying.' : '')
            if (!controller.signal.aborted) setError(migrationErrorMessage(cause, 'The import stopped. Test both connections and preview again before continuing.'))
        } finally {
            publish()
            if (session.current === current) setShowResults(true)
            controller.abort()
            if (current.ownership.current() && useAuthStore.getState().encryptionKey === current.key) {
                if (connection.platform === 'jellyfin') refreshJellyfinMedia(accountId, connection.id)
                else useLibraryCache.getState().invalidate()
            }
            if (request.current === controller) request.current = null
            setBusy(null)
        }
    }

    const byResult = useMemo(() => new Map(results.map(result => [result.rowId, result])), [results])
    const ready = useMemo(() => plan?.rows.filter(row => row.status === 'ready') || [], [plan])
    const remaining = useMemo(() => ready.filter(row => selected.has(row.id) && !['applied', 'unchanged', 'conflict'].includes(byResult.get(row.id)?.status || '')), [ready, selected, byResult])
    const searchRows = useMemo(() => plan?.rows.map(row => ({ row, title: `${watchRecordTitle(row.source)} ${watchRecordSubtitle(row.source)}`.toLocaleLowerCase() })) || [], [plan])
    const matchingRows = useMemo(() => {
        const query = search.toLocaleLowerCase()
        return searchRows.filter(item => item.title.includes(query)).map(item => item.row)
    }, [searchRows, search])
    const visibleRows = useMemo(() => filter === 'all' ? matchingRows : matchingRows.filter(row => {
        const status = byResult.get(row.id)?.status || row.status
        return status === filter
    }), [matchingRows, byResult, filter])
    const pageCount = Math.max(1, Math.ceil(visibleRows.length / 50))
    const shownPage = Math.min(page, pageCount - 1)
    const verifiedCount = useMemo(() => results.filter(result => result.status === 'applied' || result.status === 'unchanged').length, [results])
    const pendingReadyCount = ready.filter(row => !['applied', 'unchanged', 'conflict'].includes(byResult.get(row.id)?.status || '')).length
    const failedCount = results.filter(result => result.status === 'failed').length
    // "Remaining" mixes rows that failed verification with rows the run never reached; the
    // result state reports them separately so retry copy never claims the wrong population.
    const unattemptedCount = remaining.filter(row => !byResult.has(row.id)).length
    // A stale-kept row was never written, so it needs a fresh preview like an unattempted one.
    const staleKeptCount = results.filter(result => isStaleKeptResult(result)).length
    const undatedCount = plan ? undatedRowCount(plan.rows) : 0
    const alreadySavedCount = plan?.rows.filter(row => row.status === 'unchanged' || byResult.get(row.id)?.status === 'unchanged').length || 0
    const skippedBreakdown = useMemo(() => {
        if (!plan) return null
        const skipped = plan.rows.filter(row => row.status === 'skipped' || row.status === 'unsupported')
        if (!skipped.length) return null
        const removed = skipped.filter(row => row.notes.some(note => note === 'This item was removed from the Stremio library. Its retained watch state is listed for review and will not be imported.')).length
        const alignment = skipped.filter(row => row.notes.some(note => /episode|alignment|order/i.test(note)) && row.reason.includes('No matching title')).length
        const destinationMissing = skipped.filter(row => row.reason === 'No matching title is available to this destination user.' && !row.notes.some(note => /episode|alignment|order/i.test(note))).length
        return { total: skipped.length, removed, destinationMissing, alignment, other: Math.max(0, skipped.length - removed - destinationMissing - alignment) }
    }, [plan])
    const showingResults = !!plan && !!outcome && showResults && !busy
    const summaryNotes = plan?.notes.filter(note => /keeps one resume point|stores no per-episode watch dates|Original watch dates cannot|may be forwarded/.test(note)) || []
    const detailNotes = plan?.notes.filter(note => !summaryNotes.includes(note)
        && !(plan.source.complete === false && note.startsWith('This source read is partial.'))) || []
    const connectionSummary = <div role="group" aria-label="Import connections" className={plan ? 'grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]' : ''}>
        {plan && selectedSource && <>
            <MigrationEndpoint label="Source" connection={selectedSource} name={migrationSourceLabel(selectedSource, displayName)} user={displayName(plan.source.subject)} compact={showingResults} />
            <ArrowRight aria-hidden="true" className={`mx-auto h-4 w-4 text-muted-foreground ${showingResults ? 'hidden sm:block' : 'rotate-90 sm:rotate-0'}`} />
        </>}
        <MigrationEndpoint label="Destination" connection={connection}
            name={migrationSourceLabel(connection, displayName)}
            user={displayName(plan?.destination.subject || connection.mediaServer?.userName || connection.credentials?.email || 'Identity checked during preview')}
            userId={showingResults || !connection.mediaServer?.userId ? undefined : identifier(connection.mediaServer.userId)} compact={showingResults} />
    </div>

    const download = () => {
        if (!plan) return
        const url = URL.createObjectURL(new Blob([JSON.stringify(migrationReport(plan, results), null, 2)], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'watch-state-import-report.json'
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1_000)
    }

    // Review before retry: an unconfirmed write can't be distinguished from one that actually
    // saved, so the result state never re-runs the stale plan. The secondary action always
    // returns through a fresh preview; the future-preview guards stay fully in force.
    const reviewAndPreviewAgain = () => {
        reset()
        void preview()
    }

    return (
        <Dialog open={open} onOpenChange={value => { if (!value) reset(); onOpenChange(value) }}>
            <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-h-[90dvh] sm:max-w-3xl">
                <DialogHeader className="pr-5">
                    <DialogTitle>Import watch state</DialogTitle>
                    <DialogDescription className={showingResults ? 'sr-only' : undefined}>{showingResults ? 'Import result summary.' : busy === 'import' ? 'Keep this window open while your selected titles are copied and confirmed.' : 'Import watched titles and continue-watching progress into this connection. You’ll preview the changes and choose what to copy before saving. Existing history is kept.'}</DialogDescription>
                </DialogHeader>
                <div className="min-h-0 space-y-4 overflow-y-auto px-1 pb-1">
                    {!busy && !showingResults && connectionSummary}
                    {busy === 'import' && plan && selectedSource && <p className="break-words text-xs text-muted-foreground">{migrationSourceLabel(selectedSource, displayName)} → {migrationSourceLabel(connection, displayName)} · {displayName(plan.destination.subject)}</p>}
                    {busy ? <><MigrationProgressPanel mode={busy} message={progress} progress={busy === 'import' ? importProgress : null} />{busy === 'import' && plan && <MigrationImportLog plan={plan} results={results} />}</> : showingResults && plan && outcome && selectedSource ? <MigrationResultsPanel plan={plan} results={results} outcome={outcome} notice={error || undefined} unattempted={unattemptedCount} onExport={download} connections={{
                        source: { name: migrationSourceLabel(selectedSource, displayName), user: displayName(plan.source.subject), logo: <PlatformLogo platform={selectedSource.platform} isHydra={selectedSource.connectionType === 'hydra-outbound'} className="h-4 w-4" /> },
                        destination: { name: migrationSourceLabel(connection, displayName), user: displayName(plan.destination.subject), logo: <PlatformLogo platform={connection.platform} className="h-4 w-4" /> },
                    }} /> : !plan ? <div className="space-y-4">
                        <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm">
                        <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Source</p><StatusChip size="sm" variant={sourceId ? 'primary' : 'muted'}>Required</StatusChip></div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label htmlFor="migration-source-account">Source account</Label>
                                <Select value={sourceAccountId} onValueChange={value => { setSourceAccountId(value); setSourceId('') }} disabled={!!busy}>
                                    <SelectTrigger id="migration-source-account"><SelectValue placeholder="Choose an account" /></SelectTrigger>
                                    <SelectContent>{accounts.map(account => (
                                        <SelectItem key={account.id} value={account.id} textValue={displayName(account.name)} className="py-2">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <AccountAvatar account={account} />
                                                <span className="truncate">{displayName(account.name)}</span>
                                            </span>
                                        </SelectItem>
                                    ))}</SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="migration-source-connection">Source connection</Label>
                                <Select value={sourceId} onValueChange={setSourceId} disabled={!!busy || !sources.length}>
                                    <SelectTrigger id="migration-source-connection"><SelectValue placeholder={sources.length ? 'Choose a connection' : 'No enabled source connections'} /></SelectTrigger>
                                    <SelectContent>{sources.map(source => {
                                        const label = watchConnectionLabel(source, watchMigrationSources(sourceAccount!), sourceAccount, displayName, identifier, sourceProfileNames)
                                        return <SelectItem key={source.id} value={source.id} textValue={label} className="py-2">
                                            <span className="flex min-w-0 items-center gap-2" title={label}>
                                                <span aria-hidden="true"><PlatformLogo platform={source.platform} isHydra={source.connectionType === 'hydra-outbound'} className="h-6 w-6 shrink-0" /></span>
                                                <span className="min-w-0 truncate">{label}</span>
                                            </span>
                                        </SelectItem>
                                    })}</SelectContent>
                                </Select>
                            </div>
                        </div>
                        </div>
                        <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">What to copy</p>
                        <div className="flex flex-wrap gap-x-5 gap-y-2">
                            <div className="flex items-center gap-2"><Checkbox id="migration-watched" checked={watched} onCheckedChange={value => setWatched(value === true)} disabled={!!busy || connection.platform === 'realstream'} /><Label htmlFor="migration-watched">Watched titles</Label></div>
                            <div className="flex items-center gap-2"><Checkbox id="migration-resume" checked={resume} onCheckedChange={value => setResume(value === true)} disabled={!!busy} /><Label htmlFor="migration-resume">Continue watching</Label></div>
                        </div>
                        {connection.platform === 'realstream' && <p className="text-xs leading-relaxed text-muted-foreground">RealStream accepts supported playback positions. Its API does not provide a verified watched-title import.</p>}
                        </div>
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">Review the titles before copying. We’ll show what can be added and what’s already saved. Some services don’t share original watch dates or a full viewing history.</p>
                    </div> : <div className="space-y-4">
                        <h3 ref={previewHeading} tabIndex={-1} className="text-base font-semibold outline-none">Review your import</h3>
                        <div aria-label="Import preview counts" className="flex flex-wrap items-baseline gap-x-5 gap-y-2 rounded-2xl border border-border/40 bg-card px-4 py-3 text-xs text-muted-foreground shadow-sm">
                            <p><span className="mr-1 text-base font-semibold tabular-nums text-foreground">{plan.source.records.length.toLocaleString()}</span> titles found</p>
                            <p><span className="mr-1 text-base font-semibold tabular-nums text-foreground">{pendingReadyCount.toLocaleString()}</span> ready to import</p>
                            {verifiedCount > 0 && <p><span className="mr-1 text-base font-semibold tabular-nums text-foreground">{verifiedCount.toLocaleString()}</span> confirmed</p>}
                        </div>
                        {skippedBreakdown && <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                            <p className="font-medium text-foreground">{skippedBreakdown.total.toLocaleString()} records are skipped safely</p>
                            <p>Nothing will be written for these records. {skippedBreakdown.removed > 0 && <>{skippedBreakdown.removed.toLocaleString()} were removed from the Stremio library. </>}{skippedBreakdown.destinationMissing > 0 && <>{skippedBreakdown.destinationMissing.toLocaleString()} could not be found in the destination library. </>}{skippedBreakdown.alignment > 0 && <>{skippedBreakdown.alignment.toLocaleString()} episode {skippedBreakdown.alignment === 1 ? 'mapping could' : 'mappings could'} not be verified. </>}{skippedBreakdown.other > 0 && <>{skippedBreakdown.other.toLocaleString()} need review. </>}</p>
                        </div>}
                        {undatedCount > 0 && <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info aria-hidden="true" className="h-4 w-4 shrink-0" />{undatedCount.toLocaleString()} {undatedCount === 1 ? 'title has' : 'titles have'} no exact watch time and will be sent without a date.</p>}
                        {alreadySavedCount > 0 && <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0" />{alreadySavedCount.toLocaleString()} {alreadySavedCount === 1 ? 'title is' : 'titles are'} already saved here and won’t be copied again.</p>}
                        <div data-theme-part="panel" className="space-y-2 rounded-2xl border border-border/40 bg-muted/20 p-3">
                            <p className="flex items-center gap-2 text-xs font-medium"><Info aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />Import details and limits</p>
                            {!plan.source.complete && <p className="text-xs leading-relaxed text-warning">Some source history could not be verified as complete. Only the titles in this preview can be copied; existing destination history is kept.</p>}
                            {summaryNotes.length > 0 && <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">{summaryNotes.map(note => <li key={note}>{readableNote(note)}</li>)}</ul>}
                            {detailNotes.length > 0 && <details className="border-t border-border/30 pt-2 text-xs leading-relaxed text-muted-foreground"><summary className="cursor-pointer font-medium">How this import works</summary><ul className="mt-2 list-disc space-y-1.5 pl-4">{detailNotes.map(note => <li key={note}>{readableNote(note)}</li>)}</ul></details>}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input aria-label="Search import titles" placeholder="Search titles…" value={search} onChange={event => { setSearch(event.target.value); setPage(0) }} className="min-w-0 flex-1" />
                            <Select value={filter} onValueChange={value => { setFilter(value); setPage(0) }}>
                                <SelectTrigger aria-label="Filter import status" className="w-44"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="all">All records</SelectItem>{(['ready', 'unchanged', 'conflict', 'skipped', 'unsupported', 'applied', 'failed'] as const).map(status => <SelectItem key={status} value={status}>{statusLabel(status)}</SelectItem>)}</SelectContent>
                            </Select>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <Button size="sm" variant="subtle" disabled={!!busy} onClick={() => setSelected(new Set(ready.map(row => row.id)))}>Select ready</Button>
                            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setSelected(new Set())}>Clear selection</Button>
                            <span className="text-muted-foreground">{remaining.length.toLocaleString()} selected to import</span>
                        </div>
                        {visibleRows.length ? <ul aria-label="Import preview" className="space-y-2">{visibleRows.slice(shownPage * 50, (shownPage + 1) * 50).map(row => {
                            const result = byResult.get(row.id)
                            const status = result?.status || row.status
                            return <li key={row.id} data-theme-part="card" className={`rounded-2xl border bg-card/50 p-3 shadow-sm space-y-3 ${status === 'ready' && selected.has(row.id) ? 'border-primary/30' : 'border-border/40'}`}>
                                <div className="flex items-start gap-3">
                                    {row.status === 'ready' && <Checkbox className="mt-2" aria-label={`Import ${watchRecordTitle(row.source)} ${watchRecordSubtitle(row.source)}`} checked={selected.has(row.id)} disabled={!!busy || !!result && result.status !== 'failed'} onCheckedChange={value => setSelected(previous => { const next = new Set(previous); if (value === true) next.add(row.id); else next.delete(row.id); return next })} />}
                                    <MigrationArtwork record={row.source} />
                                    <div className="min-w-0 flex-1 space-y-1"><p className="break-words text-sm font-semibold">{watchRecordTitle(row.source)}</p><p className="text-xs text-muted-foreground">{watchRecordSubtitle(row.source)}</p></div>
                                    <StatusChip size="sm" variant={statusVariants[status]} icon={status === 'applied' ? <CheckCircle2 /> : undefined}>{statusLabel(status)}</StatusChip>
                                </div>
                                <div className="grid gap-2 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
                                    <p className="rounded-lg bg-muted/30 px-2.5 py-2">From your source: {migrationStateLabel(row.source)}</p>
                                    {row.target && <p className="rounded-lg bg-muted/30 px-2.5 py-2">{result?.verified ? 'Saved here' : 'Currently here'}: {migrationStateLabel(result?.verified || row.target)}</p>}
                                </div>
                                {row.status === 'ready' && row.patch && !result && <p className="flex items-center gap-1.5 text-xs text-primary"><Import aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />Will add: {migrationStateLabel(row.patch)}</p>}
                                <p className="text-xs leading-relaxed">{rowExplanation(row, result)}</p>
                                <MigrationTitleDetails record={row.source} />
                                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Item details</summary><p className="mt-2 leading-relaxed">{result?.message || row.reason}</p>{row.target && <p className="mt-2 break-all font-mono">Destination item: {row.target.id}</p>}</details>
                                {row.notes.map(note => <p key={note} className="text-xs text-muted-foreground">{readableNote(note)}</p>)}
                            </li>
                        })}</ul> : <EmptyState title="No matching records" description="Choose another filter or source to review more saved state." />}
                        {pageCount > 1 && <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><Button size="sm" variant="outline" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</Button><span>Page {shownPage + 1} of {pageCount}</span><Button size="sm" variant="outline" disabled={shownPage + 1 === pageCount} onClick={() => setPage(shownPage + 1)}>Next</Button></div>}
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">We check each title before copying and confirm it was saved afterward. This connection may also update its linked tracking services. Closing this window or locking the vault stops the import; switching tabs does not. You can preview again later; saved titles won’t be copied twice.</p>
                    </div>}
                    <div aria-live="polite" className="text-sm text-muted-foreground">{!busy && !showingResults && progress}</div>
                    {error && !showingResults && <p role="alert" className="text-sm text-destructive">{error}</p>}
                </div>
                <DialogFooter className={showingResults ? 'flex flex-wrap items-center justify-end gap-2 border-t border-border/30 pt-4' : 'flex-wrap gap-2'}>
                    {busy ? <Button ref={stopButton} variant="outline" onClick={() => request.current?.abort()}><Square className="h-4 w-4" />Stop</Button> : showingResults ? <>
                        {(failedCount > 0 || unattemptedCount > 0 || staleKeptCount > 0) && <Button variant="outline" onClick={reviewAndPreviewAgain}>Review &amp; preview again</Button>}
                        <Button onClick={() => { reset(); onOpenChange(false) }}>Done</Button>
                    </> : <>
                        <Button variant="ghost" onClick={() => { reset(); onOpenChange(false) }}>Close</Button>
                        {plan && <Button variant="outline" onClick={reset}>Change source / preview again</Button>}
                        {plan && <Button variant="outline" onClick={download}><Download className="h-4 w-4" />Export report</Button>}
                        {plan && outcome && <Button variant="outline" onClick={() => setShowResults(true)}>View results</Button>}
                        {!plan ? <Button ref={primaryButton} onClick={() => void preview()} disabled={!sourceId || !encryptionKey || !connection.enabled || !watched && !resume}>Preview import</Button> : <Button ref={primaryButton} onClick={() => void run()} disabled={!remaining.length || !session.current}>{results.length && !remaining.length ? 'Import complete' : `${results.length ? 'Import remaining' : 'Import'} ${remaining.length.toLocaleString()} ${remaining.length === 1 ? 'title' : 'titles'}`}</Button>}
                    </>}
                </DialogFooter>
                {plan && !busy && !showingResults && <p className="text-xs text-muted-foreground">Exported reports contain title and user names.</p>}
            </DialogContent>
        </Dialog>
    )
}
