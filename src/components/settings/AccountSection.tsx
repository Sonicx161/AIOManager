import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Check, Copy, User, Clock, RefreshCw, Upload, Download } from 'lucide-react'
import { useSyncStore } from '@/store/syncStore'
import { toast } from '@/hooks/use-toast'
import { getTimeAgo } from '@/lib/utils'

export function AccountSection() {
    const { auth, syncToRemote, syncFromRemote, isSyncing, lastSyncedAt, setDisplayName } = useSyncStore()

    const [copied, setCopied] = useState(false)

    if (!auth.isAuthenticated) {
        return (
            <section>
                <div className="p-4 rounded-xl border bg-card/50 text-sm text-muted-foreground text-center py-8">
                    Cloud Sync not connected. Log in to manage your account.
                </div>
            </section>
        )
    }

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(auth.id)
            setCopied(true)
            toast({ title: "Copied UUID", description: "Account UUID copied to clipboard." })
            setTimeout(() => setCopied(false), 2000)
        } catch (err) {
            console.error('Failed to copy ID:', err)
            toast({ variant: "destructive", title: "Copy Failed", description: "Could not copy ID to clipboard." })
        }
    }

    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-6">
                {/* Display Name */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">Display Name</Label>
                    <div className="relative">
                        <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Your Name"
                            className="pl-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                            value={auth.name}
                            onChange={(e) => setDisplayName(e.target.value)}
                        />
                    </div>
                </div>

                {/* ID Display */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">Your UUID</Label>
                    <div className="flex gap-2">
                        <Input value={auth.id} readOnly className="font-mono bg-muted/50 text-xs h-9" />
                        <Button variant="outline" size="icon" className="h-9 w-9" onClick={copyId} title="Copy UUID">
                            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                </div>

                {/* Sync Status */}
                <div className="flex items-center justify-between text-sm bg-primary/5 p-3 rounded-lg border border-primary/10">
                    <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-green-500" />
                        <span className="font-medium">Authenticated</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last Sync
                        </span>
                        <span className="font-bold text-xs">
                            {lastSyncedAt ? getTimeAgo(new Date(lastSyncedAt)) : 'Never'}
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="space-y-3 pt-2">
                    <div className="p-3 rounded-lg border bg-primary/10 border-primary/20">
                        <p className="text-[11px] text-primary font-medium leading-relaxed">
                            Cloud Sync is active. Every change you make is instantly saved to the server.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <Button variant="default" className="shadow-lg shadow-primary/20" onClick={() => syncToRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                            Push to Cloud
                        </Button>
                        <Button variant="outline" onClick={() => syncFromRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                            Pull from Cloud
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    )
}
