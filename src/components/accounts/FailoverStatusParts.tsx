import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowRight, FlaskConical, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusChip } from '@/components/ui/status-chip'
import { useNow } from '@/hooks/use-relative-time'
import { checkCadenceText, failoverTimingText, lastSwitchText } from '@/lib/failover-rehearsal'
import { useHistoryStore } from '@/store/historyStore'
import type { FailoverRule } from '@/store/failoverStore'

const requestedHistory = new Set<string>()

export function RehearseButton({ onClick }: { onClick: () => void }) {
    return (
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={onClick}>
            <FlaskConical className="h-3 w-3" aria-hidden="true" />
            Rehearse a failover
        </Button>
    )
}

function useLastSwitch(rule: FailoverRule, enabled: boolean): string {
    const logs = useHistoryStore(s => s.logs)
    const initialize = useHistoryStore(s => s.initialize)
    const now = useNow()
    const hasLogs = logs.some(log => log.accountId === rule.accountId)
    useEffect(() => {
        if (!enabled || hasLogs || requestedHistory.has(rule.accountId)) return
        requestedHistory.add(rule.accountId)
        void initialize([rule.accountId])
    }, [enabled, hasLogs, initialize, rule.accountId])
    return lastSwitchText(logs, rule.id, now)
}

export function WatchingLine({ line, rule, onRehearse }: { line: string; rule: FailoverRule; onRehearse?: () => void }) {
    const [open, setOpen] = useState(false)
    const lastSwitch = useLastSwitch(rule, open)
    return (
        <div className="mx-2 flex items-center justify-end gap-1.5 text-xs text-muted-foreground" data-testid="rule-quiet-status">
            <span className="min-w-0 tabular-nums">{line}</span>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" aria-label="How Failover works" className="h-8 w-8 shrink-0 text-foreground/60 hover:bg-foreground/10">
                        <Info className="h-4 w-4" aria-hidden="true" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[min(18rem,92vw)] space-y-1.5 p-3 text-xs" data-testid="how-failover-works">
                    <p className="text-sm font-semibold text-foreground">How Failover works</p>
                    <p className="text-foreground/80">Checks run on the server {checkCadenceText()}, so you can close the app.</p>
                    <p className="text-foreground/80">{failoverTimingText()}</p>
                    <p className="text-muted-foreground">{lastSwitch}</p>
                    {onRehearse && <RehearseButton onClick={() => { setOpen(false); onRehearse() }} />}
                </PopoverContent>
            </Popover>
        </div>
    )
}

export type PlainStatusKind = 'backup' | 'stale'

export function PlainStatusPanel({ kind, sentence, action, errorLine, onRehearse }: {
    kind: PlainStatusKind
    sentence: string
    action?: ReactNode
    errorLine?: ReactNode
    onRehearse?: () => void
}) {
    return (
        <div data-theme-part="panel" className="mx-2 rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5" data-testid="rule-plain-status">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusChip variant="warning" size="sm" icon={kind === 'backup' ? <ArrowRight /> : <AlertTriangle />}>
                        {kind === 'backup' ? 'On backup' : 'Not checked lately'}
                    </StatusChip>
                    <span className="min-w-0 break-words text-sm text-foreground/90">{sentence}</span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {action}
                    {onRehearse && <RehearseButton onClick={onRehearse} />}
                </div>
            </div>
            <p className="mt-1 text-xs text-muted-foreground/60">{failoverTimingText()}</p>
            {errorLine}
        </div>
    )
}
