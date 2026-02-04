import { useSyncStore } from '@/store/syncStore'
import { RefreshCw, CloudOff, Cloud } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'

export function SyncStatus() {
    const { isSyncing, lastSyncedAt, auth } = useSyncStore()
    const [timeAgo, setTimeAgo] = useState<string>('')
    const isOnline = auth.isAuthenticated

    useEffect(() => {
        const updateTime = () => {
            if (lastSyncedAt) {
                setTimeAgo(formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true }))
            }
        }
        updateTime()
        const interval = setInterval(updateTime, 60000)
        return () => clearInterval(interval)
    }, [lastSyncedAt])

    if (!isOnline) {
        return (
            <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground/50" title="Offline Mode">
                <CloudOff className="h-3 w-3" />
                <span className="hidden sm:inline">Offline</span>
            </div>
        )
    }

    if (isSyncing) {
        return (
            <div className="flex items-center gap-1.5 text-xs font-bold text-blue-500 animate-pulse">
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span className="hidden sm:inline">Syncing...</span>
            </div>
        )
    }

    return (
        <div className="flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 px-3 py-1 rounded-full backdrop-blur-md shadow-sm transition-all hover:bg-indigo-500/20 cursor-help" title={`Last synced ${timeAgo}`}>
            <Cloud className="h-3.5 w-3.5 text-indigo-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-indigo-300 whitespace-nowrap">
                Synced {timeAgo}
            </span>
            <span className="relative flex h-1.5 w-1.5 ml-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-indigo-500"></span>
            </span>
        </div>
    )
}
