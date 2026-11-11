import { useEffect, useMemo, useState } from "react"
import { Activity, AlertTriangle, ArrowRight, Check } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"
import { AddonIcon } from "@/components/ui/addon-icon"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import { FailoverEmptyState } from "@/components/common/PageEmptyStates"
import { useHistoryStore } from "@/store/historyStore"
import { useFailoverStore } from "@/store/failoverStore"
import { useAccountStore } from "@/store/accountStore"
import { getPlatformEntry } from "@/lib/platform-registry"
import { eventTimeText, missedNote, notificationText, readHistoryDetail, reasonSentence, type PlatformResult } from "@/lib/failover-history-detail"
import { toast } from "@/hooks/use-toast"
import type { AddonDescriptor } from "@/types/addon"
import { identifyAddon } from "@/lib/addon-identifier"
import { normalizeAddonUrl } from "@/lib/utils"

export type FailoverAddon = AddonDescriptor & { manifestUrl?: string }

const findAddon = (url: string, addons: FailoverAddon[]) => {
    const normUrl = normalizeAddonUrl(url).toLowerCase()
    return addons.find(a => normalizeAddonUrl(a.transportUrl || '').toLowerCase() === normUrl || (a.manifestUrl && normalizeAddonUrl(a.manifestUrl).toLowerCase() === normUrl))
}

const addonName = (url: string, addons: FailoverAddon[]) => {
    const addon = findAddon(url, addons)
    return addon?.metadata?.customName || addon?.manifest?.name || identifyAddon(url).name
}

const addonDisplay = (url: string, addons: FailoverAddon[]) => {
    const addon = findAddon(url, addons)
    return {
        name: addon?.metadata?.customName || addon?.manifest?.name || identifyAddon(url).name,
        logo: addon?.metadata?.customLogo || addon?.manifest?.logo || identifyAddon(url).logo,
    }
}

const PlatformResultItem = ({ result, label }: { result: PlatformResult; label: string }) => {
    const entry = getPlatformEntry(result.platform)
    return (
        <span className="inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
            {entry
                ? <img data-theme-part="image-tile" src={entry.logo} alt="" loading="lazy" className="h-3.5 w-3.5 shrink-0 rounded-full object-contain" />
                : <span data-theme-part="image-tile" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-bold text-muted-foreground">{result.platform[0]?.toUpperCase() || '?'}</span>}
            <span className="min-w-0 truncate">{label}</span>
            {result.ok ? <Check className="h-3 w-3 shrink-0 text-success" aria-label="Updated" /> : <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-label="Not updated" />}
        </span>
    )
}

export function FailoverHistory({ addons, accountId }: { addons: FailoverAddon[]; accountId: string }) {
    const allLogs = useHistoryStore(s => s.logs)
    const initialize = useHistoryStore(s => s.initialize)
    const clearLogs = useHistoryStore(s => s.clearLogs)
    const rulesCount = useFailoverStore(s => s.rules.filter(rule => rule.accountId === accountId).length)
    const logs = useMemo(() => allLogs.filter(l => l.accountId === accountId), [allLogs, accountId])
    const connections = useAccountStore(s => s.accounts.find(a => a.id === accountId)?.connections)

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

    const platformLabel = (result: PlatformResult, all: PlatformResult[]) => {
        const name = getPlatformEntry(result.platform)?.name || result.platform
        if (all.filter(p => p.platform === result.platform).length < 2) return name
        const custom = connections?.find(c => c.id === result.id)?.displayName
        return custom ? `${name} (${custom})` : name
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

                    const typeLabel = log.type === 'failover' ? 'Failover' : log.type === 'recovery' ? 'Recovery' : 'Self-healing'
                    const TypeIcon = log.type === 'failover' ? AlertTriangle : log.type === 'recovery' ? Check : Activity

                    const chain = (log.metadata?.chain as string[] | undefined)
                    const activeUrl = log.metadata?.activeUrl as string | undefined
                    const detail = readHistoryDetail(log.metadata)
                    const targetName = activeUrl ? addonName(activeUrl, addons) : ''
                    const why = detail ? reasonSentence(log.type, detail.reason, detail.reason ? addonName(detail.reason.addon, addons) : '', targetName) : null
                    const platforms = detail?.platforms ?? []
                    const missed = platforms.filter(p => !p.ok)
                    const toUrl = activeUrl || (chain && chain.length > 0 ? chain[chain.length - 1] : null) || null
                    const sameAddon = (a: string, b: string) => normalizeAddonUrl(a).toLowerCase() === normalizeAddonUrl(b).toLowerCase()
                    const fromUrl = detail?.from || (chain && toUrl ? chain.find(u => !sameAddon(u, toUrl)) : null) || null
                    const to = toUrl ? addonDisplay(toUrl, addons) : null
                    const from = fromUrl ? addonDisplay(fromUrl, addons) : null
                    const showPair = !!(fromUrl && toUrl && !sameAddon(fromUrl, toUrl))

                    return (
                        <div key={log.id} data-theme-part="panel" className="flex items-start gap-3.5 rounded-2xl border border-border/40 bg-card/70 p-4">
                            {to ? (
                                <AddonIcon name={to.name} logo={to.logo} className="h-10 w-10 rounded-lg bg-muted/40" />
                            ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                                    <TypeIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex items-baseline justify-between gap-2">
                                    <span className="text-xs font-medium text-muted-foreground">
                                        {typeLabel}{repeats > 1 ? ` ×${repeats}` : ''}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {isValidLogDate && logDate ? formatDistanceToNow(logDate, { addSuffix: true }) : 'Unknown time'}
                                    </span>
                                </div>
                                {to && from && showPair ? (
                                    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                                        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                            {from.logo ? <img src={from.logo} alt="" loading="lazy" className="h-4 w-4 shrink-0 rounded-sm object-contain" /> : null}
                                            <span className="max-w-[170px] truncate" title={from.name}>{from.name}</span>
                                        </span>
                                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/35" aria-hidden="true" />
                                        <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold">
                                            {to.logo ? <img src={to.logo} alt="" loading="lazy" className="h-4 w-4 shrink-0 rounded-sm object-contain" /> : null}
                                            <span className="max-w-[220px] truncate" title={to.name}>{to.name}</span>
                                        </span>
                                    </div>
                                ) : to ? (
                                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                                        {to.logo ? <img src={to.logo} alt="" loading="lazy" className="h-4 w-4 shrink-0 rounded-sm object-contain" /> : null}
                                        <span className="max-w-[220px] truncate" title={to.name}>{to.name}</span>
                                    </div>
                                ) : (
                                    <div className="truncate text-sm font-medium">
                                        {resolveUrlToName(log.primaryName || 'System')}
                                    </div>
                                )}
                                {detail ? (
                                    <>
                                        <p className="break-words text-sm text-foreground/90">
                                            {why ?? log.message}
                                        </p>
                                        {platforms.length > 0 && (
                                            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
                                                {platforms.map(p => <PlatformResultItem key={p.id} result={p} label={platformLabel(p, platforms)} />)}
                                            </div>
                                        )}
                                        {missed.map(p => (
                                            <p key={p.id} className="flex min-w-0 items-start gap-2 text-sm text-foreground/85">
                                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                                                <span className="break-words">
                                                    {missedNote(platformLabel(p, platforms), p.error, detail.from ? addonName(detail.from, addons) : null, detail.retryAt, Date.now())}
                                                </span>
                                            </p>
                                        ))}
                                        {isValidLogDate && logDate && (
                                            <p className="text-xs tabular-nums text-muted-foreground">
                                                {eventTimeText(logDate)} · {notificationText(detail.notified, detail.notifiedOk)}.
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <p className="break-words text-sm text-foreground/75">
                                        {log.message.split(' ').map(word => word.startsWith('http') ? resolveUrlToName(word) : word).join(' ')}
                                    </p>
                                )}
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
