import * as React from "react"
import { useSyncStore } from "@/store/syncStore"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog"
import {
    History,
    ChevronDown,
    ChevronRight,
    CloudUpload,
    CloudDownload,
    AlertCircle,
    CheckCircle2,
    Clock,
    Zap,
    Info
} from "lucide-react"
import { cn } from "@/lib/utils"

export function SyncDiagnostics() {
    const { history, forcePushState, forceMirrorState } = useSyncStore()
    const [isExpanded, setIsExpanded] = React.useState(false)
    const [showPushConfirm, setShowPushConfirm] = React.useState(false)
    const [showMirrorConfirm, setShowMirrorConfirm] = React.useState(false)
    const [isActionLoading, setIsActionLoading] = React.useState(false)

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
            case 'push': return <CloudUpload className="h-4 w-4 text-blue-500" />
            case 'pull': return <CloudDownload className="h-4 w-4 text-green-500" />
            case 'force-push': return <Zap className="h-4 w-4 text-amber-500" />
            case 'force-mirror': return <AlertCircle className="h-4 w-4 text-orange-500" />
            default: return <Info className="h-4 w-4" />
        }
    }

    return (
        <Card className="border-muted/40 shadow-sm overflow-hidden">
            <CardHeader
                className="py-3 px-4 cursor-pointer hover:bg-accent/30 transition-colors flex flex-row items-center justify-between"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-primary" />
                    <div>
                        <CardTitle className="text-sm font-semibold">Advanced Sync Diagnostics</CardTitle>
                        <CardDescription className="text-xs">History logs and manual overrides</CardDescription>
                    </div>
                </div>
                {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </CardHeader>

            {isExpanded && (
                <CardContent className="p-4 pt-0 space-y-6 animate-in slide-in-from-top-2 duration-200">
                    {/* Action Buttons */}
                    <div className="grid grid-cols-2 gap-3 pt-2">
                        <div className="space-y-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full justify-start text-xs border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-600 h-9"
                                onClick={() => setShowPushConfirm(true)}
                            >
                                <Zap className="h-3.5 w-3.5 mr-2 text-amber-500" />
                                Force Push to Cloud
                            </Button>
                            <p className="text-[10px] text-muted-foreground px-1 leading-tight">
                                Overwrites cloud data with local state. Use if cloud is stale.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full justify-start text-xs border-orange-500/30 hover:bg-orange-500/10 hover:text-orange-600 h-9"
                                onClick={() => setShowMirrorConfirm(true)}
                            >
                                <AlertCircle className="h-3.5 w-3.5 mr-2 text-orange-500" />
                                Force Mirror from Cloud
                            </Button>
                            <p className="text-[10px] text-muted-foreground px-1 leading-tight">
                                Discards local changes for exact cloud state.
                            </p>
                        </div>
                    </div>

                    {/* History Log */}
                    <div className="space-y-2">
                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                            Sync Event Log (Latest 50)
                            <Badge variant="outline" className="text-[9px] py-0 px-1.5 h-4 font-normal">Session Only</Badge>
                        </h4>

                        <ScrollArea className="h-[200px] rounded-md border border-muted/50 bg-muted/20">
                            <div className="p-2 space-y-1">
                                {history.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center py-8 text-muted-foreground">
                                        <Clock className="h-8 w-8 mb-2 opacity-20" />
                                        <p className="text-[11px]">No sync events recorded this session.</p>
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
                                                        {entry.isAuto && <Badge variant="secondary" className="text-[9px] py-0 px-1 h-3.5">Auto</Badge>}
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground font-mono">
                                                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                    </span>
                                                </div>
                                                <p className={cn(
                                                    "text-[11px] leading-tight break-words",
                                                    entry.status === 'error' ? "text-destructive" : "text-muted-foreground"
                                                )}>
                                                    {entry.status === 'error' && <AlertCircle className="inline h-3 w-3 mr-1 align-baseline" />}
                                                    {entry.status === 'success' && <CheckCircle2 className="inline h-3 w-3 mr-1 align-baseline text-green-500" />}
                                                    {entry.message}
                                                </p>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </ScrollArea>
                    </div>
                </CardContent>
            )}

            {/* Confirmation Dialogs */}
            <ConfirmationDialog
                open={showPushConfirm}
                onOpenChange={setShowPushConfirm}
                title="Force Push to Cloud?"
                description={
                    <div className="space-y-2">
                        <p>This will overwrite your cloud data with your current local state.</p>
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
        </Card>
    )
}
