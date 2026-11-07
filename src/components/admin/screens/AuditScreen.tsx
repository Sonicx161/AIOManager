import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, RefreshCw, ScrollText } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { verifyAuditChain } from '@/api/admin'
import { ADMIN_AUDIT_KEY, auditQueryOptions, paneErrorCopy, paneView, staleNoteCopy, uniqueRows } from '@/lib/admin-queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Chip, LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, TABLE_ROW, TABLE_SURFACE } from '../AdminWidgets'

export function AuditScreen() {
    const queryClient = useQueryClient()
    // Pages accumulate: "Load older rows" appends the next page.
    const audit = useInfiniteQuery(auditQueryOptions())
    const view = paneView(audit)
    const pages = audit.data?.pages
    const rows = uniqueRows(pages, r => r.seq)
    const retentionNote = pages?.[0]?.retentionNote
    const [chain, setChain] = useState<{ ok: boolean; rows: number; at: string; brokenAt: number | null; reason: string | null } | null>(null)

    const verify = useMutation({
        mutationFn: verifyAuditChain,
        onSuccess: (result) => {
            setChain({ ok: result.ok, rows: result.rows, at: result.verifiedAtLabel, brokenAt: result.brokenAt, reason: result.reason })
            toast({
                title: result.ok ? 'Chain verified' : 'Chain broken',
                description: result.ok
                    ? `${result.rows} rows checked, ${result.verifiedAtLabel}.`
                    : `The chain breaks at row ${result.brokenAt ?? '?'} (${result.reason ?? 'unknown'}); rows were edited outside the dashboard.`,
                variant: result.ok ? 'default' : 'destructive',
            })
            queryClient.invalidateQueries({ queryKey: ADMIN_AUDIT_KEY })
        },
        onError: (e: Error) => toast({ variant: 'destructive', title: 'Verify failed', description: e.message }),
    })

    return (
        <div>
            <ScreenHeader
                title="Audit log"
                subtitle="Append-only and hash-chained. Rows cannot be cleared or edited from this dashboard."
            />

            <Panel>
                <PanelHead
                    icon={<ScrollText />}
                    title="Audit log"
                    detail="Each row stores the previous row hash, so silent edits break the chain. Written by dashboard actions and sign-in events only."
                    actions={
                        <>
                            <Chip tone={chain !== null && !chain.ok ? 'bad' : undefined} icon={chain !== null && chain.ok ? <Check className="h-3 w-3" /> : undefined}>
                                {chain === null
                                    ? 'Not verified yet'
                                    : chain.ok
                                        ? `Chain verified, ${chain.rows} rows`
                                        : `Chain broken at ${chain.brokenAt ?? '?'} (${chain.reason})`}
                            </Chip>
                            <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => verify.mutate()} disabled={verify.isPending}>
                                <RefreshCw className="h-3.5 w-3.5" /> Verify chain
                            </Button>
                        </>
                    }
                />

                {view === 'stale' && <StaleNotice message={staleNoteCopy(audit.error)} onRetry={() => audit.refetch()} retrying={audit.isFetching} />}
                {view === 'loading' ? (
                    <PaneLoading />
                ) : view === 'gone' || !audit.data ? (
                    <PaneError message={paneErrorCopy(audit.error, 'The audit log')} onRetry={() => audit.refetch()} retrying={audit.isFetching} />
                ) : (
                    <div className={TABLE_SURFACE} data-audit-rows={rows.length}>
                        {rows.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">No audit rows yet.</p>}
                        {rows.map(r => (
                            <div key={r.seq} data-audit-row className={cn(TABLE_ROW, 'flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-2.5')}>
                                <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">#{r.seq}</span>
                                <span className="w-28 shrink-0 text-xs">{r.timeLabel}</span>
                                <span className="w-32 shrink-0 text-xs font-semibold text-foreground">
                                    {r.action}
                                    <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">{r.event}</span>
                                </span>
                                <span className={cn('min-w-[12rem] flex-1 text-xs leading-relaxed', !r.detail && 'text-muted-foreground')}>
                                    {r.detail}
                                    {r.result !== 'ok' && <span className="ml-1.5 font-semibold text-destructive">({r.result})</span>}
                                </span>
                                <span className="shrink-0 text-xs" title={r.prevHash ? `previous row ${r.prevHash.slice(0, 12)}\u2026` : undefined}>
                                    {r.actor}{r.device ? `, ${r.device}` : ''}
                                </span>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground" title={`row ${r.hash.slice(0, 12)}\u2026`}>
                                    {`${r.hash.slice(0, 8)}\u2026`}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                {audit.hasNextPage && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                            {audit.isFetchingNextPage ? 'Loading' : 'Load older rows'}
                        </Button>
                        {audit.isFetchNextPageError && <span className="text-xs text-destructive" role="alert">Older rows could not be loaded. Try again.</span>}
                    </div>
                )}

                <LegendNote className="mt-3">{retentionNote ?? 'Append-only and hash-chained.'}</LegendNote>
            </Panel>
        </div>
    )
}
