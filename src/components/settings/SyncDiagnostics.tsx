import * as React from "react"
import { SquircleOverlay } from "@/components/ui/squircle-overlay"
import { useSyncStore } from "@/store/syncStore"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import {
    History,
    CloudUpload,
    CloudDownload,
    AlertCircle,
    CheckCircle2,
    Clock,
    Zap,
    Info,
    RefreshCcw,
    Server
} from "lucide-react"
import { cn, getTimeAgo } from "@/lib/utils"

function DiagnosticStat({
    icon,
    label,
    value,
    detail,
    tone = 'muted'
}: {
    icon: React.ReactNode
    label: string
    value: string
    detail: string
    tone?: 'muted' | 'success' | 'warning' | 'destructive'
}) {
    return (
        <div data-theme-tone="status" data-theme-part="panel" className={cn(
            "min-w-0 rounded-2xl border bg-background/35 p-3",
            tone === 'success' && "border-success/25 bg-success/5",
            tone === 'warning' && "border-warning/25 bg-warning/5",
            tone === 'destructive' && "border-destructive/25 bg-destructive/5",
            tone === 'muted' && "border-border/35"
        )}>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-lg border border-border/35 bg-muted/25",
                    tone === 'success' && "border-success/20 bg-success/10 text-success",
                    tone === 'warning' && "border-warning/20 bg-warning/10 text-warning",
                    tone === 'destructive' && "border-destructive/20 bg-destructive/10 text-destructive"
                )}>
                    {icon}
                </span>
                {label}
            </div>
            <div className="truncate text-sm font-semibold">{value}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
        </div>
    )
}

export function SyncDiagnostics() {
    const auth = useSyncStore(s => s.auth)
    const lastSyncedAt = useSyncStore(s => s.lastSyncedAt)
    const isSyncing = useSyncStore(s => s.isSyncing)
    const isRefreshingFromCloud = useSyncStore(s => s.isRefreshingFromCloud)
    const isInitialSyncCompleted = useSyncStore(s => s.isInitialSyncCompleted)
    const history = useSyncStore(s => s.history)
    const forcePushState = useSyncStore(s => s.forcePushState)
    const forceMirrorState = useSyncStore(s => s.forceMirrorState)
    const [showPushConfirm, setShowPushConfirm] = React.useState(false)
    const [showMirrorConfirm, setShowMirrorConfirm] = React.useState(false)
    const [isActionLoading, setIsActionLoading] = React.useState(false)

    const diagnostics = React.useMemo(() => {
        const latestEntry = history[0] ?? null
        const errorCount = history.reduce((total, entry) => total + (entry.status === 'error' ? 1 : 0), 0)
        const lastSyncDate = lastSyncedAt ? new Date(lastSyncedAt) : null
        const lastSyncTime = lastSyncDate?.getTime() ?? 0
        const hasValidSyncTime = lastSyncDate !== null && Number.isFinite(lastSyncTime) && lastSyncTime > 0

        return {
            latestEntry,
            errorCount,
            lastSyncLabel: hasValidSyncTime ? getTimeAgo(lastSyncDate) : 'Never',
        }
    }, [history, lastSyncedAt])

    const handleForcePush = async () => {
        setIsActionLoading(true)
        try {
            await forcePushState()
            setShowPushConfirm(false)
        } finally {
            setIsActionLoading(false)
        }
    }

    const handleForceMirror = async () => {
        setIsActionLoading(true)
        try {
            await forceMirrorState()
            setShowMirrorConfirm(false)
        } finally {
            setIsActionLoading(false)
        }
    }

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'push': return <CloudUpload className="h-4 w-4 text-primary" />
            case 'pull': return <CloudDownload className="h-4 w-4 text-success" />
            case 'force-push': return <Zap className="h-4 w-4 text-warning" />
            case 'force-mirror': return <AlertCircle className="h-4 w-4 text-warning" />
            default: return <Info className="h-4 w-4" />
        }
    }

    return (
        <div data-theme-part="panel" className="overflow-hidden rounded-[1.75rem] border border-border/45 bg-card/80 shadow-sm">
            <div className="flex items-center gap-3 p-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                    <SquircleOverlay />
                    <History className="relative z-10 h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold">Advanced Cloud Sync Diagnostics</h3>
                    <p className="text-xs text-muted-foreground">History logs and manual overrides</p>
                </div>
            </div>

            <div className="space-y-6 border-t border-border/40 p-4 pt-4">
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <DiagnosticStat
                            icon={<Server className="h-3.5 w-3.5" />}
                            label="Cloud"
                            value={auth.isAuthenticated ? 'Connected' : 'Not linked'}
                            detail={auth.isAuthenticated ? (auth.name || 'Sync account active') : 'Register or log in to enable sync'}
                            tone={auth.isAuthenticated ? 'success' : 'muted'}
                        />
                        <DiagnosticStat
                            icon={<Clock className="h-3.5 w-3.5" />}
                            label="Last save"
                            value={diagnostics.lastSyncLabel}
                            detail={isRefreshingFromCloud ? 'Refreshing from cloud' : isSyncing ? 'Sync in progress' : 'Idle'}
                            tone={isSyncing || isRefreshingFromCloud ? 'warning' : 'muted'}
                        />
                        <DiagnosticStat
                            icon={<RefreshCcw className="h-3.5 w-3.5" />}
                            label="Push guard"
                            value={!auth.isAuthenticated ? 'Inactive' : isInitialSyncCompleted ? 'Ready' : 'Waiting'}
                            detail={!auth.isAuthenticated ? 'Cloud sync is off' : isInitialSyncCompleted ? 'Initial cloud pull completed' : 'Pull from cloud before pushing'}
                            tone={!auth.isAuthenticated ? 'muted' : isInitialSyncCompleted ? 'success' : 'warning'}
                        />
                        <DiagnosticStat
                            icon={diagnostics.errorCount > 0 ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            label="Current log"
                            value={diagnostics.errorCount > 0 ? `${diagnostics.errorCount} error${diagnostics.errorCount !== 1 ? 's' : ''}` : 'Clean'}
                            detail={diagnostics.latestEntry ? diagnostics.latestEntry.message : 'No events this session'}
                            tone={diagnostics.errorCount > 0 ? 'destructive' : 'success'}
                        />
                    </div>


                    <div className="grid gap-3 md:grid-cols-2">
                        <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-background/35 p-3">
                            <Button
                                variant="outline"
                                onClick={() => setShowPushConfirm(true)}
                                className="h-9 w-full justify-start gap-2 text-xs"
                            >
                                <Zap className="h-3.5 w-3.5 text-warning" />
                                Force Push to Cloud
                            </Button>
                            <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
                                Replace all cloud data with your current local state. Use when cloud is out of date.
                            </p>
                        </div>

                        <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-background/35 p-3">
                            <Button
                                variant="outline"
                                onClick={() => setShowMirrorConfirm(true)}
                                className="h-9 w-full justify-start gap-2 text-xs"
                            >
                                <AlertCircle className="h-3.5 w-3.5 text-warning" />
                                Force Mirror from Cloud
                            </Button>
                            <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
                                Discards local changes for exact cloud state.
                            </p>
                        </div>
                    </div>


                    <div className="space-y-2">
                        <h4 className="text-xs font-medium text-foreground/60 flex items-center gap-2">
                            Sync Event Log (Latest 50)
                            <Badge variant="outline" className="text-xs py-0 px-1.5 h-4 font-normal">Session Only</Badge>
                        </h4>

                        <ScrollArea data-theme-part="panel" className="h-[200px] rounded-2xl border border-border/35 bg-background/35">
                            <div className="p-2 space-y-1">
                                {history.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center py-8 text-muted-foreground">
                                        <Clock className="h-8 w-8 mb-2 opacity-20" />
                                        <p className="text-xs">No sync events recorded this session.</p>
                                    </div>
                                ) : (
                                    history.map((entry) => (
                                        <div
                                            key={entry.id}
                                            className="flex items-start gap-3 p-2 rounded hover:bg-accent/50 transition-colors border-b border-muted/30 last:border-0"
                                        >
                                            <div className="mt-0.5">{getTypeIcon(entry.type)}</div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between gap-2 mb-0.5">
                                                    <span className="text-xs font-medium capitalize flex items-center gap-1.5">
                                                        {entry.type.replace('-', ' ')}
                                                        {entry.isAuto && <Badge variant="secondary" className="text-xs py-0 px-1 h-3.5">Auto</Badge>}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground font-mono">
                                                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                    </span>
                                                </div>
                                                <p className={cn(
                                                    "text-xs leading-tight break-words",
                                                    entry.status === 'error' ? "text-destructive" : "text-muted-foreground"
                                                )}>
                                                    {entry.status === 'error' && <AlertCircle className="inline h-3 w-3 mr-1 align-baseline" />}
                                                    {entry.status === 'success' && <CheckCircle2 className="inline h-3 w-3 mr-1 align-baseline text-success" />}
                                                    {entry.message}
                                                </p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </div>


            <ConfirmationDialog
                open={showPushConfirm}
                onOpenChange={setShowPushConfirm}
                title="Force Push to Cloud?"
                description={
                    <div className="space-y-2">
                        <p>Your cloud data will be replaced with your current local state. Other devices will pull this state on next sync.</p>
                        <p className="font-semibold text-destructive">Any changes made on other devices since your last sync will be lost.</p>
                    </div>
                }
                confirmText="Push Local State"
                isDestructive={true}
                isLoading={isActionLoading}
                onConfirm={handleForcePush}
            />

            <ConfirmationDialog
                open={showMirrorConfirm}
                onOpenChange={setShowMirrorConfirm}
                title="Force Mirror from Cloud?"
                description={
                    <div className="space-y-2">
                        <p>This will wipe your local changes and replace them with the exact state from the cloud.</p>
                        <p className="font-semibold text-destructive">This cannot be undone.</p>
                    </div>
                }
                confirmText="Mirror Cloud State"
                isDestructive={true}
                isLoading={isActionLoading}
                onConfirm={handleForceMirror}
            />
        </div>
    )
}
