import { useSyncStore } from '@/store/syncStore'
import { RefreshCw, CloudOff, Cloud } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'

export function SyncStatus() {
    const { isSyncing, isRefreshingFromCloud, lastSyncedAt, auth } = useSyncStore()
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

    if (isSyncing || isRefreshingFromCloud) {
        return (
            <div className="flex items-center gap-1.5 text-xs font-bold text-blue-500 animate-pulse">
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span className="hidden sm:inline">{isRefreshingFromCloud ? 'Refreshing...' : 'Syncing...'}</span>
            </div>
        )
    }

    return (
        <div className="flex items-center gap-1.5 bg-blue-500/8 border border-blue-400/20 px-3 py-1.5 rounded-full shadow-sm transition-all hover:bg-blue-500/10 cursor-help" title={`Last synced ${timeAgo}`}>
            <Cloud className="h-3 w-3 text-blue-400/70" />
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_5px_rgba(96,165,250,0.6)] flex-shrink-0" />
            <span className="text-[10px] font-black uppercase tracking-widest text-blue-300/80 whitespace-nowrap">
                Synced {timeAgo}
            </span>
        </div>
    )
}
