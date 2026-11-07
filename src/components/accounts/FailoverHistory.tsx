import { memo, useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, ArrowRight, Check } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import { StatusChip } from "@/components/ui/status-chip"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { Tooltip } from "@/components/ui/tooltip"
import { FailoverEmptyState } from "@/components/common/PageEmptyStates"
import { useHistoryStore } from "@/store/historyStore"
import { useFailoverStore } from "@/store/failoverStore"
import { toast } from "@/hooks/use-toast"
import type { AddonDescriptor } from "@/types/addon"
import { identifyAddon } from "@/lib/addon-identifier"
import { normalizeAddonUrl } from "@/lib/utils"

export type FailoverAddon = AddonDescriptor & { manifestUrl?: string }

const ChainPill = memo(({ url, status, addons }: { url: string; status: 'active' | 'failed' | 'idle'; addons: FailoverAddon[] }) => {
    const normUrl = normalizeAddonUrl(url).toLowerCase()
    const addon = addons.find(a => {
        const aNorm = normalizeAddonUrl(a.transportUrl || '').toLowerCase()
        return aNorm === normUrl || (a.manifestUrl && normalizeAddonUrl(a.manifestUrl).toLowerCase() === normUrl)
    })
    const displayName = addon?.metadata?.customName || addon?.manifest?.name || identifyAddon(url).name
    const logo = addon?.metadata?.customLogo || addon?.manifest?.logo || identifyAddon(url).logo

    const styles: Record<string, { wrapper: string; dot: string }> = {
        active: { wrapper: 'border-success/30 bg-success/10 text-success', dot: 'bg-success shadow-sm shadow-success/30' },
        failed: { wrapper: 'border-destructive/30 bg-destructive/10 text-destructive', dot: 'bg-destructive shadow-sm shadow-destructive/30' },
        idle: { wrapper: 'border-border/30 bg-muted/20 text-muted-foreground', dot: 'bg-muted-foreground/25' },
    }
    const s = styles[status]

    return (
        <span data-theme-part="badge" className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${s.wrapper}`}>
            <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
            {logo ? (
                <img src={logo} alt="" className="h-4 w-4 rounded-sm object-contain" loading="lazy" />
            ) : null}
            <Tooltip content={url}>
            <span className="truncate max-w-[120px]">{displayName}</span>
        </Tooltip>
        </span>
    )
})
ChainPill.displayName = 'ChainPill'

export function FailoverHistory({ addons, accountId }: { addons: FailoverAddon[]; accountId: string }) {
    const allLogs = useHistoryStore(s => s.logs)
    const initialize = useHistoryStore(s => s.initialize)
    const clearLogs = useHistoryStore(s => s.clearLogs)
    const rulesCount = useFailoverStore(s => s.rules.filter(rule => rule.accountId === accountId).length)
    const logs = useMemo(() => allLogs.filter(l => l.accountId === accountId), [allLogs, accountId])

    // Collapse consecutive same-type events from one primary: flapping would otherwise flood the log.
    const groupedLogs = useMemo(() => {
        const out: Array<{ log: (typeof allLogs)[number]; repeats: number }> = []
        for (const log of logs) {
            const prev = out[out.length - 1]
            if (prev && prev.log.type === log.type && prev.log.primaryName === log.primaryName) {
                prev.repeats++
            } else {
                out.push({ log, repeats: 1 })
            }
        }
        return out
    }, [logs])
    const [showAllLogs, setShowAllLogs] = useState(false)
    const visibleLogs = showAllLogs ? groupedLogs : groupedLogs.slice(0, 8)
    const [showClearConfirm, setShowClearConfirm] = useState(false)
    const [isClearing, setIsClearing] = useState(false)

    const handleClearLogs = async () => {
        setIsClearing(true)
        try {
            await clearLogs(accountId)
            setShowClearConfirm(false)
        } catch {
            toast({ variant: 'destructive', title: 'Clear Failed', description: 'Could not clear history for this account.' })
        } finally {
            setIsClearing(false)
        }
    }

    const resolveUrlToName = (url: string) => {
        if (!url || !url.startsWith('http')) return url;
        const cleanUrl = url.replace(/[,.]$/, '');
        const normClean = normalizeAddonUrl(cleanUrl).toLowerCase();
        const addon = addons.find(a => {
            const aNorm = normalizeAddonUrl(a.transportUrl || '').toLowerCase()
            return aNorm === normClean || (a.manifestUrl && normalizeAddonUrl(a.manifestUrl).toLowerCase() === normClean)
        });
        let name = cleanUrl;
        if (addon) {
            name = addon.metadata?.customName || identifyAddon(cleanUrl, addon.manifest).name;
        } else {
            try {
                name = new URL(cleanUrl).hostname;
            } catch {
                name = cleanUrl;
            }
        }
        return url.replace(cleanUrl, name);
    }

    useEffect(() => {
        initialize()
    }, [initialize, accountId])

    if (logs.length === 0) {
        return (
            <FailoverEmptyState rulesCount={rulesCount} addonsCount={addons.length} />
        )
    }

    return (
        <>
        <div data-theme-part="panel" className="bg-card border border-border/40 rounded-2xl p-5 mb-6 shadow-sm">
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h3 className="text-lg font-bold">Event Log</h3>
                    <p className="text-sm text-foreground/60">Recent autopilot and recovery actions.</p>
                </div>
                <Button size="sm" variant="outline" className="min-h-11 sm:min-h-0 shrink-0" onClick={() => setShowClearConfirm(true)} disabled={isClearing}>
                    {isClearing ? 'Clearing...' : 'Clear history'}
                </Button>
            </div>
            <div className="space-y-3">
                {visibleLogs.map(({ log, repeats }) => {
                    const logDate = log.timestamp ? new Date(log.timestamp) : null;
                    const isValidLogDate = logDate && !isNaN(logDate.getTime());

                    let Icon = Activity;
                    let typeColor = 'text-muted-foreground';
                    let typeVariant: 'muted' | 'primary' | 'success' | 'destructive' = 'muted';
                    let iconBg = 'bg-muted/40';

                    if (log.type === 'failover') {
                        Icon = AlertTriangle;
                        typeColor = 'text-destructive';
                        typeVariant = 'destructive';
                        iconBg = 'bg-destructive/15';
                    } else if (log.type === 'recovery') {
                        Icon = Check;
                        typeColor = 'text-success';
                        typeVariant = 'success';
                        iconBg = 'bg-success/15';
                    } else if (log.type === 'self-healing') {
                        Icon = Activity;
                        typeColor = 'text-primary';
                        typeVariant = 'primary';
                        iconBg = 'bg-primary/15';
                    }

                    const chain = (log.metadata?.chain as string[] | undefined)
                    const activeUrl = log.metadata?.activeUrl as string | undefined
                    const latencyMs = log.metadata?.latencyMs as number | undefined

                    return (
                        <div key={log.id} data-theme-part="panel" className="rounded-xl border border-border/30 bg-muted/20 p-4">
                            <div className="flex items-start gap-3">
                                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
                                    <Icon className={`w-4 h-4 ${typeColor}`} />
                                </div>
                                <div className="flex-1 min-w-0 space-y-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <StatusChip variant={typeVariant} size="sm">
                                                {log.type}{repeats > 1 ? ` ×${repeats}` : ''}
                                            </StatusChip>
                                            {latencyMs != null && (
                                                <span data-theme-part="badge" className="text-xs font-mono text-muted-foreground/50 bg-muted/30 rounded px-1.5 py-0.5">
                                                    {latencyMs < 1000 ? `${Math.round(latencyMs)}ms` : `${(latencyMs / 1000).toFixed(1)}s`}
                                                </span>
                                            )}
                                        </div>
                                        <span className="font-mono text-[11px] text-muted-foreground/50 shrink-0">
                                            {isValidLogDate && logDate ? formatDistanceToNow(logDate, { addSuffix: true }) : 'Unknown time'}
                                        </span>
                                    </div>
                                    {chain && chain.length > 0 ? (
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {chain.map((url, i) => {
                                                const isActive = activeUrl && normalizeAddonUrl(url).toLowerCase() === normalizeAddonUrl(activeUrl).toLowerCase()
                                                const isPrimary = i === 0
                                                const isFailed = log.type === 'failover' && isPrimary
                                                const status = isActive ? 'active' : isFailed ? 'failed' : 'idle'
                                                return (
                                                    <span key={i} className="flex items-center gap-1.5">
                                                        <ChainPill url={url} status={status} addons={addons} />
                                                        {i < chain.length - 1 && (
                                                            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/25 shrink-0" />
                                                        )}
                                                    </span>
                                                )
                                            })}
                                        </div>
                                    ) : (
                                        <div className="text-sm font-medium truncate">
                                            {resolveUrlToName(log.primaryName || 'System')}
                                        </div>
                                    )}
                                    <div className="text-[11px] text-foreground/40 leading-relaxed">
                                        {log.message.split(' ').map(word => word.startsWith('http') ? resolveUrlToName(word) : word).join(' ')}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
                {groupedLogs.length > visibleLogs.length && (
                    <Button size="sm" variant="outline" className="w-full" onClick={() => setShowAllLogs(s => !s)}>
                        {showAllLogs ? 'Show recent events' : `Show ${groupedLogs.length - visibleLogs.length} older events`}
                    </Button>
                )}
            </div>
        </div>
        <ConfirmationDialog
            open={showClearConfirm}
            onOpenChange={(open) => {
                if (!open && isClearing) return
                setShowClearConfirm(open)
            }}
            title="Clear history?"
            description="Removes Autopilot events for this account. Other accounts are not affected."
            confirmText="Clear history"
            isDestructive
            isLoading={isClearing}
            onConfirm={() => { void handleClearLogs() }}
        />
        </>
    )
}
