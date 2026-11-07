import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { OperationProgress } from '@/components/ui/operation-progress'
import { CheckCircle2, AlertCircle, Loader2, Upload, Clock, XCircle } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { publishScope, type PmdbPublishResult } from '@/lib/pmdb-list-publisher'

type RailStatus = 'idle' | 'publishing' | 'done' | 'error' | 'skipped'

interface RailStatusInfo {
    status: RailStatus
    added: number
    removed: number
    processed: number
    total: number
    failed?: number
    unresolved?: number
    error?: string
    lastError?: string
}

interface PublishToPmdbDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    scope: string
    scopeLabel: string
    rails: Array<{ railName: string; railKey: string; items: Array<{ id: string; type: string; name: string }> }>
}

export function PublishToPmdbDialog({ open, onOpenChange, scope, scopeLabel, rails }: PublishToPmdbDialogProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [publishing, setPublishing] = useState(false)
    const [cancelled, setCancelled] = useState(false)
    const [railStatuses, setRailStatuses] = useState<Record<string, RailStatusInfo>>({})
    const abortRef = useRef<AbortController | null>(null)
    const wasOpenRef = useRef(false)

    useEffect(() => {
        // Seed defaults only on the closed-to-open transition; late rails or publishing flips must not wipe results.
        if (open && !wasOpenRef.current) {
            const defaults = new Set<string>()
            for (const r of rails) {
                if (r.items.length > 0) defaults.add(r.railKey)
            }
            setSelected(defaults)
            setRailStatuses({})
            setPublishing(false)
        }
        wasOpenRef.current = open
    }, [open, rails])

    const toggleRail = useCallback((railKey: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(railKey)) next.delete(railKey)
            else next.add(railKey)
            return next
        })
    }, [])

    const selectedRails = useMemo(
        () => rails.filter(r => selected.has(r.railKey) && r.items.length > 0),
        [rails, selected]
    )

    const overallTotal = useMemo(
        () => selectedRails.reduce((s, r) => s + r.items.length, 0),
        [selectedRails]
    )
    const overallProcessed = useMemo(
        () => Object.values(railStatuses).reduce((s, info) => s + (info.processed || 0), 0),
        [railStatuses]
    )
  

    const handlePublish = useCallback(async () => {
        if (publishing) return
        if (selectedRails.length === 0) return

        setPublishing(true)
        setCancelled(false)
        const controller = new AbortController()
        abortRef.current = controller
        const initial: Record<string, RailStatusInfo> = {}
        for (const r of selectedRails) {
            initial[r.railKey] = {
                status: 'publishing',
                added: 0,
                removed: 0,
                processed: 0,
                total: r.items.length,
            }
        }
        setRailStatuses(initial)

        try {
            const results = await publishScope(
                scope,
                scopeLabel,
                selectedRails,
                (result: PmdbPublishResult) => {
                    setRailStatuses(prev => ({
                        ...prev,
                        [result.railKey]: {
                            status: result.skipped ? 'skipped' : result.error ? 'error' : 'done',
                            added: result.added,
                            removed: result.removed,
                            processed: result.error ? result.added + result.removed : (prev[result.railKey]?.total ?? 0),
                            total: prev[result.railKey]?.total ?? 0,
                            failed: result.failed,
                            unresolved: result.unresolved,
                            error: result.error,
                            lastError: result.lastError,
                        },
                    }))
                },
                (railKey: string, added: number, removed: number) => {
                    setRailStatuses(prev => {
                        const info = prev[railKey]
                        if (!info) return prev
                        return {
                            ...prev,
                            [railKey]: {
                                ...info,
                                added,
                                removed,
                                processed: added + removed,
                            },
                        }
                    })
                },
                controller.signal
            )

            const wasCancelled = controller.signal.aborted

            setRailStatuses(prev => {
                const next = { ...prev }
                for (const [key, info] of Object.entries(next)) {
                    if (info.status === 'publishing') {
                        next[key] = { ...info, status: 'skipped' }
                    }
                }
                return next
            })

            const published = results.filter(r => !r.skipped && !r.error)
            const failed = results.filter(r => r.error)
            const totalAdded = published.reduce((s, r) => s + r.added, 0)
            const totalRemoved = published.reduce((s, r) => s + r.removed, 0)
            const totalFailed = published.reduce((s, r) => s + r.failed + r.unresolved, 0)

            if (wasCancelled) {
                toast({
                    title: 'Publish cancelled',
                    description: `${published.length} rail${published.length === 1 ? '' : 's'} published (${totalAdded} added) before cancellation.`,
                })
            } else if (published.length > 0) {
                const failNote = failed.length > 0 ? `, ${failed.length} failed` : ''
                const partialNote = totalFailed > 0 ? `, ${totalFailed} item${totalFailed === 1 ? '' : 's'} not published` : ''
                toast({
                    title: 'Published to PMDB',
                    description: `Published ${published.length} rail${published.length === 1 ? '' : 's'} (${totalAdded} added, ${totalRemoved} removed)${failNote}${partialNote}`,
                })
            } else if (failed.length > 0) {
                toast({
                    variant: 'destructive',
                    title: 'PMDB publish failed',
                    description: failed[0]?.error || 'All rails failed to publish.',
                })
            }

            if (failed.length === 0 && !wasCancelled) {
                onOpenChange(false)
            }
        } catch (err) {
            toast({
                variant: 'destructive',
                title: 'PMDB publish failed',
                description: err instanceof Error ? err.message : undefined,
            })
        } finally {
            setPublishing(false)
            abortRef.current = null
        }
    }, [selectedRails, scope, scopeLabel, onOpenChange, publishing])

    const handleCancel = useCallback(() => {
        abortRef.current?.abort()
        setCancelled(true)
    }, [])

    const selectedCount = selected.size

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Upload className="h-4 w-4 text-primary" />
                        Publish to PMDB
                    </DialogTitle>
                    <p className="text-sm text-muted-foreground">
                        Send recommendation rails from{' '}
                        <span className="font-medium text-foreground">{scopeLabel}</span>{' '}
                        to your PMDB lists.
                    </p>
                </DialogHeader>

                {rails.length === 0 ? (
                    <div className="rounded-lg border border-border/40 bg-muted/20 p-4 text-center">
                        <p className="text-sm text-muted-foreground">
                            No recommendation rails available to publish yet.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-1.5 max-h-[50vh] overflow-y-auto pr-1 -mr-1">
                        {rails.map(rail => {
                            const isEmpty = rail.items.length === 0
                            const isChecked = selected.has(rail.railKey)
                            const info = railStatuses[rail.railKey]
                            const disabled = isEmpty || publishing
                            const isPublishing = info?.status === 'publishing'
                            const pct = info && info.total > 0
                                ? Math.min(100, Math.round((info.processed / info.total) * 100))
                                : 0
                            return (
                                <div data-theme-part="panel" data-theme-tone="status"
                                    key={rail.railKey}
                                    className={cn(
                                        'flex flex-col gap-2 rounded-lg border border-border/40 px-3 py-2.5 transition-colors',
                                        disabled && !isPublishing ? 'opacity-60' : '',
                                        info?.status === 'done' && 'border-success/40 bg-success/5',
                                        info?.status === 'error' && 'border-destructive/40 bg-destructive/5',
                                        isPublishing && 'border-primary/40 bg-primary/5',
                                    )}
                                >
                                    <div className="flex items-center gap-3">
                                        <Checkbox
                                            checked={isChecked}
                                            disabled={disabled}
                                            onCheckedChange={() => toggleRail(rail.railKey)}
                                            aria-label={rail.railName}
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-sm font-medium truncate">{rail.railName}</span>
                                                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                                                    {rail.items.length} {rail.items.length === 1 ? 'item' : 'items'}
                                                </span>
                                            </div>
                                        </div>
                                        {info?.status === 'done' && (
                                            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                                        )}
                                        {info?.status === 'error' && (
                                            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                                        )}
                                        {isPublishing && (
                                            <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                                        )}
                                    </div>

                                    {isPublishing && (
                                        <div className="space-y-1">
                                            <Progress value={pct} className="h-1.5" />
                                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                                <span className="flex items-center gap-1">
                                                    <Clock className="h-3 w-3" />
                                                    {info.processed} / {info.total}
                                                </span>
                                                <span className="tabular-nums">{pct}%</span>
                                            </div>
                                        </div>
                                    )}

                                    {info?.status === 'done' && (
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-xs text-success">
                                                {info.added > 0 || info.removed > 0
                                                    ? `${info.added} added, ${info.removed} removed`
                                                    : 'Already up to date'}
                                            </span>
                                            {(info.failed || info.unresolved) ? (
                                                <span className="text-xs text-warning">
                                                    {[
                                                        info.unresolved ? `${info.unresolved} couldn't resolve to TMDB` : '',
                                                        info.failed ? `${info.failed} failed${info.lastError ? ` (${info.lastError})` : ''}` : '',
                                                    ].filter(Boolean).join(' · ')}
                                                </span>
                                            ) : null}
                                        </div>
                                    )}
                                    {info?.status === 'error' && (
                                        <span className="text-xs text-destructive">{info.error || 'Failed'}</span>
                                    )}
                                    {info?.status === 'skipped' && (
                                        <span className="text-xs text-muted-foreground">Skipped (empty)</span>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}

                {publishing && overallTotal > 0 && (
                    <div className="px-1">
                        <OperationProgress
                            status="running"
                            current={overallProcessed}
                            total={overallTotal}
                            label="Overall Progress"
                            variant="bare"
                        />
                    </div>
                )}

                <DialogFooter>
                    {publishing ? (
                        <Button
                            variant="destructive"
                            onClick={handleCancel}
                            disabled={cancelled}
                        >
                            <XCircle className="h-4 w-4" />
                            {cancelled ? 'Cancelling...' : 'Cancel'}
                        </Button>
                    ) : (
                        <>
                            <Button variant="outline" onClick={() => onOpenChange(false)}>
                                Close
                            </Button>
                            <Button
                                onClick={handlePublish}
                                disabled={selectedCount === 0 || rails.length === 0}
                            >
                                <Upload className="h-4 w-4" />
                                {selectedCount > 0
                                    ? `Publish ${selectedCount} rail${selectedCount === 1 ? '' : 's'}`
                                    : 'Publish'}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
