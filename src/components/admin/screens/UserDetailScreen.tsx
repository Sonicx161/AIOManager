import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, History, Info, PauseCircle, PlayCircle, RefreshCw, Trash2, User, Wifi, Wrench, Zap } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import {
    getUserDetail,
    getRepairsCatalog,
    previewRepair,
    runRepair,
    disableUser,
    enableUser,
    softDeleteUser,
    restoreUser,
    type RepairHistoryRow,
    type RepairSpec,
} from '@/api/admin'
import { adminRetry, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Chip, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, Callout, StatusBadge, TABLE_ROW, TABLE_SURFACE } from '../AdminWidgets'
import { TypedActionDialog } from '../TypedActionDialog'

type PendingAction =
    | { kind: 'disable' }
    | { kind: 'enable' }
    | { kind: 'delete' }
    | { kind: 'restore' }
    | { kind: 'repair'; repair: RepairSpec }

// UI copy: the server does not send per-action notes.
const NOTES = {
    repair: 'Needs a reason, writes an audit entry, and the user sees a notice.',
    disable: 'Blocks sign-ins and pushes now; data is kept. The user sees a notice at the next sign-in attempt, and the action with its reason is written to the audit log.',
    delete: 'Sign-ins and sync are blocked and the account is hidden now. Data is kept until you restore the account here. Nothing is purged automatically. The reason is audited.',
    enable: 'Sign-ins and pushes work again. The reason is audited and the user sees a notice.',
    restore: 'Sign-ins and sync work again. The reason is audited and the user sees a notice.',
    actionsUnavailable: 'Account actions arrive with the actions update on the server. Until then this screen is read-only.',
}

// Repairs grouped by the machinery they touch; the featured sync repair is a
// highlighted row inside the Sync card.
const AREAS = [
    { id: 'sync', title: 'Sync', icon: RefreshCw, detail: 'Cached sync responses, sign-ins and per-account server state.' },
    { id: 'activity', title: 'Activity', icon: Activity, detail: 'The activity scan and its per-connection backoffs.' },
    { id: 'autopilot', title: 'Autopilot', icon: Zap, detail: 'Failover rule machinery and health checks.' },
    { id: 'connections', title: 'Connections', icon: Wifi, detail: 'Provider logins, backoff and connection tokens.' },
] as const

const REPAIR_AREA: Record<string, string> = {
    'release-sync-lease': 'sync',
    'clear-server-caches': 'sync',
    'purge-orphaned-state': 'sync',
    'reset-activity-breaker': 'activity',
    'recheck-failover': 'autopilot',
    'clear-login-backoff': 'connections',
    'refresh-connection-token': 'connections',
}

const REPAIR_DETAILS: Record<string, string> = {
    'clear-login-backoff': 'Clears login backoff and auth cooldown on this account\u2019s connections, so the next sign-in attempt is not delayed.',
    'clear-server-caches': 'Clears every per-account cache layer: connection, canonical, rule and decrypt caches, plus cached sync responses and sign-ins.',
    'reset-activity-breaker': 'Clears the activity scanner\u2019s backoff entries for this account, so its connections are retried on the next cycle.',
    'recheck-failover': 'Re-runs the health check on this account\u2019s Failover rules without changing them.',
    'refresh-connection-token': 'Forces a token refresh on this account\u2019s connections at the next reconciler pass.',
    'purge-orphaned-state': 'Removes server state left behind for accounts that no longer exist.',
}

const repairArea = (id: string) => REPAIR_AREA[id] ?? 'sync'
const repairDetail = (r: RepairSpec) => r.description || REPAIR_DETAILS[r.id] || NOTES.repair

function lastRunFor(history: RepairHistoryRow[], repairId: string): RepairHistoryRow | null {
    return history.find(h => h.repairId === repairId) ?? null
}

export function UserDetailScreen() {
    const { userId = '' } = useParams()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [pending, setPending] = useState<PendingAction | null>(null)
    const [dialogReason, setDialogReason] = useState('')
    const [previewArmed, setPreviewArmed] = useState<string | null>(null)

    const { data, isPending, isFetching, error, refetch } = useQuery({
        queryKey: ['admin-user', userId],
        queryFn: () => getUserDetail(userId),
        enabled: !!userId,
        staleTime: 30_000,
        retry: adminRetry,
    })

    // The audited run history: one feed for the per-row "Last run" lines and the
    // history panel below the cards.
    const feed = useQuery({
        queryKey: ['admin-user-repairs', userId],
        queryFn: () => getRepairsCatalog(userId),
        enabled: !!userId,
        staleTime: 30_000,
        retry: adminRetry,
    })
    const history = feed.data?.history ?? []

    // A dry run is a read; it arms once the typed reason is valid, not per keystroke.
    useEffect(() => {
        setDialogReason('')
        setPreviewArmed(null)
    }, [pending])
    useEffect(() => {
        if (pending?.kind === 'repair' && previewArmed === null && dialogReason.trim().length >= 3) {
            setPreviewArmed(pending.repair.id)
        }
    }, [pending, previewArmed, dialogReason])
    const preview = useQuery({
        queryKey: ['admin-repair-preview', userId, previewArmed],
        // The dry-run reason is shape-validated only and never stored; a fixed
        // literal keeps the query stable while the dialog reason is still edited.
        queryFn: () => previewRepair(userId, previewArmed as string, 'plan the repair before running it'),
        enabled: pending?.kind === 'repair' && previewArmed !== null,
        staleTime: 15_000,
        retry: adminRetry,
    })

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ['admin-user', userId] })
        queryClient.invalidateQueries({ queryKey: ['admin-user-repairs', userId] })
        queryClient.invalidateQueries({ queryKey: ['admin-users'] })
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] })
    }

    const action = useMutation({
        mutationFn: ({ pending: p, reason, confirm }: { pending: PendingAction; reason: string; confirm: string }) => {
            if (p.kind === 'disable') return disableUser(userId, reason, confirm).then(() => 'Account disabled. The user sees a notice at the next sign-in attempt.')
            if (p.kind === 'enable') return enableUser(userId, reason, confirm).then(() => 'Account enabled again.')
            if (p.kind === 'delete') return softDeleteUser(userId, reason, confirm).then(() => 'Account soft deleted. Restore it here any time.')
            if (p.kind === 'restore') return restoreUser(userId, reason, confirm).then(() => 'Account restored.')
            return runRepair(userId, p.repair.id, { reason }).then(r => r.message || 'Repair done.')
        },
        onSuccess: (message: string) => {
            setPending(null)
            toast({ title: 'Done', description: message })
            invalidate()
        },
        onError: (e: Error) => toast({ variant: 'destructive', title: 'Action failed', description: e.message }),
    })

    // A 404 wins over a cached copy: the account is gone even if it loaded before.
    const view = paneView({ isPending, data, error })
    if (userId && view === 'loading') return <PaneLoading />
    if (view === 'gone' || !data) {
        const gone = view === 'gone'
        return (
            <PaneError
                message={gone ? 'This account no longer exists.' : paneErrorCopy(error, 'This account')}
                onRetry={gone ? undefined : () => refetch()}
                retrying={isFetching}
            >
                <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => navigate('/dashboard/users')}>Back to Users</Button>
            </PaneError>
        )
    }

    const status = data.status ?? 'active'
    const byArea = new Map<string, RepairSpec[]>(AREAS.map(a => [a.id, [] as RepairSpec[]]))
    for (const r of data.repairs) {
        byArea.get(repairArea(r.id))?.push(r)
    }
    // The featured sync repair leads its card.
    byArea.get('sync')?.sort((a, b) => (a.id === 'release-sync-lease' ? -1 : b.id === 'release-sync-lease' ? 1 : 0))

    const facts: [string, string][] = [
        ['Label', data.handle],
        ['First seen', data.createdLabel],
        ['Last seen', data.lastSeenLabel],
        ['Connections', `${data.connectionsLabel}${data.connectionsDetail ? ` (${data.connectionsDetail})` : ''}`],
        ['Failover rules', data.ruleCountLabel],
        ['Storage', data.storageLabel],
        ['Per-user activity', 'none, by design'],
    ]

    const dialogFor = (p: PendingAction): { title: string; desc: React.ReactNode; word: string | null; label: string; destructive: boolean; repair?: RepairSpec } => {
        switch (p.kind) {
            case 'disable': return { title: `Disable account ${data.handle}?`, desc: NOTES.disable, word: 'DISABLE', label: 'Disable account', destructive: true }
            case 'enable': return { title: `Enable account ${data.handle}?`, desc: NOTES.enable, word: 'ENABLE', label: 'Enable account', destructive: false }
            case 'delete': return { title: `Delete account ${data.handle}? (soft)`, desc: NOTES.delete, word: 'DELETE', label: 'Delete account', destructive: true }
            case 'restore': return { title: `Restore account ${data.handle}?`, desc: NOTES.restore, word: 'RESTORE', label: 'Restore account', destructive: false }
            case 'repair': return {
                title: `Run repair: ${p.repair.name}?`,
                desc: `${p.repair.name}. ${NOTES.repair}`,
                word: null,
                label: 'Run repair',
                destructive: false,
                repair: p.repair,
            }
        }
    }

    const previewFootnote = (p: RepairSpec) => {
        if (previewArmed !== p.id) {
            return <span>Type a reason to load the dry run: what this repair would touch, and the notice the user would see.</span>
        }
        if (preview.isPending) return <span>Running the dry run, nothing changes yet.</span>
        if (preview.isError) return <span>The dry run could not load; the repair itself still reports its counts after running.</span>
        const plan = preview.data
        return (
            <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-foreground/80">Dry run</span>
                    <Chip tone="info">{plan.scope}</Chip>
                    <span className="tabular-nums">{plan.matchCount} match{plan.matchCount === 1 ? '' : 'es'}</span>
                </div>
                <p>{plan.summary}</p>
                {plan.samples.length > 0 && <p>Sample keys touched: {plan.samples.join(', ')}.</p>}
                <p>The user sees: <span className="text-foreground/80">{plan.userNotice}</span></p>
                <p>{NOTES.repair}</p>
            </div>
        )
    }

    return (
        <div>
            <ScreenHeader
                title="User detail"
                subtitle="Everything the dashboard knows about one account: metadata and machinery, never contents."
            />
            {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
                    <User className="h-4 w-4" />
                </span>
                <div className="min-w-[10rem] flex-1">
                    <div className="font-mono text-[15px] font-semibold">{data.handle}</div>
                    <div className="text-xs text-muted-foreground/70">Stable label; the full account id never leaves the server.</div>
                </div>
                {status !== 'active' && <StatusBadge status={status} />}
            </div>

            <Panel>
                <PanelHead icon={<Info />} title="Account facts" detail="Counts and coarse times only: whole hours inside 48 h, days after that. The label is a one-way hash; the full id never leaves the server." />
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                    {facts.map(([label, value]) => (
                        <div key={label}>
                            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
                            <div className="mt-0.5 text-[13px] font-medium">{value}</div>
                        </div>
                    ))}
                </div>
            </Panel>

            <section className="mt-5" aria-labelledby="repairs-heading">
                <h3 id="repairs-heading" className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Repairs by area
                </h3>
                <div className="grid gap-3 lg:grid-cols-2">
                    {AREAS.map(area => {
                        const rows = byArea.get(area.id) ?? []
                        if (!rows.length) return null
                        const Icon = area.icon
                        return (
                            <Panel key={area.id}>
                                <PanelHead icon={<Icon />} title={area.title} detail={area.detail} />
                                <div className="space-y-2">
                                    {rows.map(r => {
                                        const last = lastRunFor(history, r.id)
                                        const featured = r.id === 'release-sync-lease'
                                        return (
                                            <div
                                                key={r.id}
                                                data-featured={featured || undefined}
                                                className={cn(
                                                    'flex items-start gap-3 rounded-xl border px-3 py-2.5',
                                                    featured ? 'border-primary/25 bg-primary/[0.05]' : 'border-border/25',
                                                )}
                                            >
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="text-[13px] font-medium text-foreground">{r.name}</span>
                                                        {featured && r.available && <Chip tone="info"><Wrench className="h-3 w-3" /> featured</Chip>}
                                                    </div>
                                                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{repairDetail(r)}</div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {last
                                                            ? <>Last run {last.atLabel}: <span className="text-foreground/75">{last.outcomeLabel}</span></>
                                                            : 'Not run here yet.'}
                                                    </div>
                                                </div>
                                                {r.available && (
                                                    <Button variant={featured ? 'default' : 'outline'} size="sm" className="shrink-0 max-md:min-h-10" onClick={() => setPending({ kind: 'repair', repair: r })}>
                                                        Run
                                                    </Button>
                                                )}
                                                {!r.available && (
                                                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground/60">
                                                        <Wrench className="h-3 w-3" /> Unavailable
                                                    </span>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </Panel>
                        )
                    })}
                </div>
            </section>

            <section className="mt-5" aria-labelledby="history-heading">
                <Panel>
                    <PanelHead
                        icon={<History />}
                        title="Repair history"
                        detail="Every run on this account, read from the append-only audit chain: when, which repair, the reason written then, and the outcome counts. Newest first."
                    />
                    {feed.isPending ? (
                        <p className="text-xs text-muted-foreground" role="status">Loading history.</p>
                    ) : feed.isError ? (
                        <p className="text-xs text-muted-foreground" role="status">History is unavailable right now; the repairs above still work.</p>
                    ) : history.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No repairs have been run on this account yet.</p>
                    ) : (
                        <div className={TABLE_SURFACE}>
                            <div>
                                {history.map(h => (
                                    <div key={h.id} className={cn(TABLE_ROW, 'flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-2.5')}>
                                        <span className="w-20 shrink-0 text-xs font-medium text-foreground/80">{h.atLabel}</span>
                                        <span className="min-w-[12rem] flex-1 text-[13px] font-medium">{h.repairLabel}</span>
                                        <span className="min-w-[12rem] flex-1 text-xs text-muted-foreground">{h.reason ?? <i className="text-muted-foreground/70 not-italic">no reason recorded</i>}</span>
                                        <span className="text-xs tabular-nums text-muted-foreground">{h.outcomeLabel}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </Panel>
            </section>

            <section id="danger" className="mt-5 grid scroll-mt-24 gap-3 lg:grid-cols-2" aria-labelledby="danger-heading">
                <h3 id="danger-heading" className="sr-only">Account state actions</h3>
                {status === 'deleted' ? (
                    <div className="lg:col-span-2">
                        <Panel className="border-warning/30 bg-warning/[0.05]">
                            <PanelHead
                                icon={<PlayCircle />}
                                title="Deleted, data kept"
                                detail="Sign-ins and sync are blocked. Restore the account here; nothing is purged automatically."
                            />
                            <Button variant="default" size="sm" className="max-md:min-h-10" onClick={() => setPending({ kind: 'restore' })}>Restore account</Button>
                        </Panel>
                    </div>
                ) : data.actionsAvailable ? (
                    <>
                        <Panel className="border-warning/25 bg-warning/[0.04]">
                            <PanelHead
                                icon={status === 'disabled' ? <PlayCircle /> : <PauseCircle />}
                                title={status === 'disabled' ? 'Enable, the way back in' : 'Disable, the preferred action'}
                                detail={status === 'disabled'
                                    ? 'Sign-ins and pushes work again the moment this lands. Reversible, audited, and the user sees a notice.'
                                    : 'Reversible any time. Blocks sync sign-ins and pushes; data is kept.'}
                            />
                            {status === 'disabled' ? (
                                <Button variant="default" size="sm" className="max-md:min-h-10" onClick={() => setPending({ kind: 'enable' })}>Enable account</Button>
                            ) : (
                                <Button variant="destructive" size="sm" className="max-md:min-h-10" onClick={() => setPending({ kind: 'disable' })}>Disable account</Button>
                            )}
                        </Panel>
                        <Panel className="border-destructive/25 bg-destructive/[0.06]">
                            <PanelHead icon={<Trash2 />} title="Soft delete, last resort" detail="Blocks sign-in and sync, keeps the data, restorable here. Written reason, typed confirmation, audit entry." />
                            <Button variant="destructive" size="sm" className="max-md:min-h-10" onClick={() => setPending({ kind: 'delete' })}>Delete account</Button>
                        </Panel>
                    </>
                ) : (
                    <div className="lg:col-span-2">
                        <Callout tone="neutral">{NOTES.actionsUnavailable}</Callout>
                    </div>
                )}
            </section>

            {pending && (() => {
                const d = dialogFor(pending)
                return (
                    <TypedActionDialog
                        open
                        onOpenChange={open => { if (!open) setPending(null) }}
                        title={d.title}
                        description={d.desc}
                        confirmWord={d.word}
                        actionLabel={d.label}
                        destructive={d.destructive}
                        busy={action.isPending}
                        onReasonChange={setDialogReason}
                        footnote={d.repair ? previewFootnote(d.repair) : undefined}
                        onConfirm={(reason, confirm) => action.mutate({ pending, reason, confirm })}
                    />
                )
            })()}

            <p className="mt-4 text-xs">
                <Link to="/dashboard/users" className="inline-flex min-h-[40px] items-center font-semibold text-primary hover:underline">Back to Users</Link>
            </p>
        </div>
    )
}
