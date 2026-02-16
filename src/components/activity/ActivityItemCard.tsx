
import { ActivityItem } from '@/types/activity'
import { formatDistanceToNow } from 'date-fns'
import { PlayCircle, Trash2, Tv, Film, Activity, CheckSquare } from 'lucide-react'
import { memo } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

// Cluster Type Definition
export type HistoryCluster = {
    isCluster: true,
    name: string,
    items: ActivityItem[],
    timestamp: Date
}

export const isCluster = (entry: ActivityItem | HistoryCluster): entry is HistoryCluster => {
    return (entry as any).isCluster === true
}

interface ActivityItemCardProps {
    entry: ActivityItem | HistoryCluster
    viewMode: 'grid' | 'list'
    isSelected: boolean
    isBulkMode: boolean
    onToggleSelect?: (id: string | string[]) => void
    onDelete?: (id: string | string[], removeFromLibrary: boolean) => void
}

export const ActivityItemCard = memo(({
    entry,
    viewMode,
    isSelected,
    isBulkMode,
    onToggleSelect,
    onDelete
}: ActivityItemCardProps) => {

    // Extract the main item to show (always the latest one in a cluster)
    const item = isCluster(entry) ? entry.items[0] : entry
    const cluster = isCluster(entry) ? entry : null

    // Helper: Get safe date
    const getSafeDate = (date: Date | string) => {
        const d = new Date(date)
        return isNaN(d.getTime()) ? new Date() : d
    }

    const itemDate = getSafeDate(item.timestamp)
    const userName = item.accountName || 'Unknown User'

    // Live logic: < 20 mins ago
    const diffNow = new Date().getTime() - itemDate.getTime()
    const isLive = diffNow < 1200000 // 20 mins

    const remainingMinutes = item.duration && item.watched
        ? Math.max(0, Math.round((item.duration - item.watched) / 60000))
        : 0

    // Color Helpers
    const getColorClasses = (index: number) => {
        const colors = [
            'border-blue-500/50 hover:border-blue-500 bg-blue-500/5',
            'border-purple-500/50 hover:border-purple-500 bg-purple-500/5',
            'border-green-500/50 hover:border-green-500 bg-green-500/5',
            'border-amber-500/50 hover:border-amber-500 bg-amber-500/5',
            'border-rose-500/50 hover:border-rose-500 bg-rose-500/5',
            'border-cyan-500/50 hover:border-cyan-500 bg-cyan-500/5',
            'border-orange-500/50 hover:border-orange-500 bg-orange-500/5',
            'border-pink-500/50 hover:border-pink-500 bg-pink-500/5',
            'border-indigo-500/50 hover:border-indigo-500 bg-indigo-500/5',
            'border-emerald-500/50 hover:border-emerald-500 bg-emerald-500/5',
        ]
        return colors[index % colors.length]
    }

    const getAvatarColor = (index: number) => {
        const colors = [
            'bg-blue-500/20 text-blue-400',
            'bg-purple-500/20 text-purple-400',
            'bg-green-500/20 text-green-400',
            'bg-amber-500/20 text-amber-400',
            'bg-rose-500/20 text-rose-400',
            'bg-cyan-500/20 text-cyan-400',
            'bg-orange-500/20 text-orange-400',
            'bg-pink-500/20 text-pink-400',
            'bg-indigo-500/20 text-indigo-400',
            'bg-emerald-500/20 text-emerald-400',
        ]
        return colors[index % colors.length]
    }

    const handleClick = () => {
        if (isBulkMode || isSelected) { // If bulk mode OR passing selection, toggle
            if (cluster) {
                onToggleSelect?.(cluster.items.map(i => i.id))
            } else {
                onToggleSelect?.(item.id)
            }
        } else {
            // Open in Stremio Desktop App
            const type = item.type === 'anime' ? 'series' : item.type
            window.location.href = `stremio:///detail/${type}/${item.itemId}`
        }
    }

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (cluster) {
            onDelete?.(cluster.items.map(i => i.id), false)
        } else {
            onDelete?.(item.id, false)
        }
    }


    if (viewMode === 'grid') {
        return (
            <div
                className={`group relative aspect-[2/3] rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-200 ${isSelected ? 'border-primary ring-2 ring-primary/20 scale-[0.98]' : 'border-transparent hover:border-primary/50'
                    }`}
                onClick={handleClick}
            >
                {/* Selection Overlay */}
                {(isBulkMode || isSelected) && (
                    <div className={`absolute top-2 left-2 z-30 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-primary border-primary' : 'bg-black/40 border-white/40'}`}>
                        {isSelected && <CheckSquare className="w-3.5 h-3.5 text-white" />}
                    </div>
                )}
                <img
                    src={item.poster}
                    alt={item.name}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                    loading="lazy"
                />

                {/* Gradient overlay for readability */}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 pointer-events-none">
                    {(!isBulkMode && !isSelected) && (
                        <div className="bg-primary/20 backdrop-blur-md rounded-full p-3 border border-primary/50">
                            <PlayCircle className="w-8 h-8 text-white drop-shadow-lg" />
                        </div>
                    )}
                </div>

                {/* Bottom Layout: Left stack + Right user/time */}
                <div className="absolute bottom-0 left-0 right-0 p-2.5 flex items-end justify-between gap-2 z-10">
                    {/* Left Stack: Title, Season/Ep, Timestamp */}
                    <div className="flex flex-col gap-1 items-start min-w-0 flex-1">
                        <div className="bg-black/60 backdrop-blur-sm rounded px-1.5 py-1 max-w-full">
                            <h3 className="font-black text-[11px] text-white leading-tight line-clamp-2">
                                {item.name}
                            </h3>
                            {cluster ? (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                    {cluster.items.map(i => ({ s: i.season || 1, e: i.episode })).filter(i => i.e !== undefined).sort((a, b) => b.e! - a.e!).map((item, idx) => (
                                        <span key={idx} className="text-[10px] font-black text-primary bg-primary/10 px-1 rounded">
                                            S{item.s} E{item.e}
                                        </span>
                                    ))}
                                </div>
                            ) : (item.type === 'series' || item.type === 'anime') && item.episode !== undefined && (
                                <span className={cn(
                                    "text-[10px] font-bold block mt-0.5",
                                    getAvatarColor(item.accountColorIndex).split(' ')[1]
                                )}>
                                    S{item.season ?? 1} E{item.episode}
                                </span>
                            )}
                        </div>
                        {!isLive && (
                            <span className="text-[9px] text-white/80 font-semibold bg-black/50 backdrop-blur-sm rounded px-1.5 py-0.5">
                                {formatDistanceToNow(itemDate, { addSuffix: true })}
                            </span>
                        )}
                    </div>

                    {/* Right: User + Time Left */}
                    <div className="flex flex-col gap-1 items-end shrink-0">
                        <Badge variant="secondary" className="bg-black/60 hover:bg-black/70 text-white backdrop-blur-sm border-0 shadow-lg flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold">
                            <Avatar className="h-3 w-3 border border-white/20">
                                <AvatarFallback className={cn("text-[6px] font-bold", getAvatarColor(item.accountColorIndex))}>
                                    {userName[0]?.toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <span className="truncate max-w-[50px]">{userName}</span>
                            {remainingMinutes > 0 && !isLive && (
                                <span className="text-primary font-black ml-0.5">
                                    • {remainingMinutes}M
                                </span>
                            )}
                        </Badge>
                    </div>
                </div>

                {/* Live: Watching Now Overlay */}
                {isLive && (
                    <div className="absolute top-2 right-2 z-20">
                        <Badge className="bg-green-500 text-white border-0 shadow-xl animate-pulse flex items-center gap-1 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide">
                            <Activity className="h-2.5 w-2.5" /> NOW
                        </Badge>
                    </div>
                )}
            </div>
        )
    }

    // LIST VIEW
    return (
        <div
            className={cn(
                'group flex items-center gap-6 p-4 rounded-2xl border transition-all duration-200 cursor-pointer',
                isSelected ? 'bg-primary/5 border-primary shadow-md ring-2 ring-primary/20' : cn('shadow-sm', getColorClasses(item.accountColorIndex))
            )}
            onClick={handleClick}
        >
            {/* Selection Checkbox (List) */}
            {(isBulkMode || isSelected) && (
                <div className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-primary border-primary' : 'bg-muted-foreground/20 border-border'}`}>
                    {isSelected && <CheckSquare className="w-3.5 h-3.5 text-white" />}
                </div>
            )}
            <div className="relative w-24 h-36 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-muted shadow-sm group-hover:shadow-md transition-all">
                <img src={item.poster} className="w-full h-full object-cover" loading="lazy" />
                {item.progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                        <div
                            className="h-full bg-primary transition-all duration-500"
                            style={{ width: `${item.progress}%` }}
                        />
                    </div>
                )}
            </div>

            <div className="flex-1 min-w-0 py-2 space-y-2">
                <div className="flex items-center gap-2">
                    <Badge variant="outline" className="flex items-center gap-1 text-[9px] uppercase tracking-tighter px-1.5 h-5 font-black opacity-60">
                        {isLive ? (
                            <span className="text-green-500 animate-pulse flex items-center gap-1">
                                <Activity className="h-3 w-3" /> WATCHING NOW
                            </span>
                        ) : (
                            <>
                                {item.type === 'movie' ? <Film className="h-3 w-3" /> : <Tv className="h-3 w-3" />}
                                {item.type}
                            </>
                        )}
                    </Badge>
                    <span className="text-xs font-mono opacity-50 flex items-center gap-1">
                        {formatDistanceToNow(itemDate, { addSuffix: true })}
                    </span>
                </div>

                <h4 className="font-black text-xl truncate tracking-tight">{item.name}</h4>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    {cluster ? (
                        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide py-1">
                            <span className="text-[10px] font-black tracking-tighter text-primary bg-primary/20 px-2 py-0.5 rounded border border-primary/30">
                                {cluster.items.length} EPISODES
                            </span>
                            <div className="flex flex-wrap gap-1">
                                {cluster.items.map(i => ({ s: i.season || 1, e: i.episode })).filter(i => i.e !== undefined).sort((a, b) => b.e! - a.e!).map((item, idx) => (
                                    <span key={idx} className="text-[9px] font-bold opacity-70 bg-muted px-1.5 rounded border border-border/50">
                                        S{item.s} E{item.e}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ) : (item.type === 'series' || item.type === 'anime') && item.episode !== undefined && (
                        <span className={cn(
                            "flex items-center gap-1 font-mono font-bold",
                            getAvatarColor(item.accountColorIndex).split(' ')[1]
                        )}>
                            S{item.season} E{item.episode}
                        </span>
                    )}

                    <div className="flex items-center gap-2">
                        <Avatar className="h-5 w-5 border border-border">
                            <AvatarFallback className={cn("text-[9px] font-bold", getAvatarColor(item.accountColorIndex))}>
                                {userName[0]?.toUpperCase()}
                            </AvatarFallback>
                        </Avatar>
                        <span className="font-medium text-foreground/80">{userName}</span>
                    </div>
                </div>

                {/* Progress Bar Label */}
                {item.progress > 0 && (
                    <div className="flex items-center gap-3 mt-4 max-w-md">
                        <Progress value={item.progress} className="h-1.5 flex-1" />
                        <div className="flex items-center gap-1 text-[10px] font-black tracking-tighter opacity-70 min-w-[70px] justify-end">
                            <span>{Math.round(item.progress)}%</span>
                            {remainingMinutes > 0 && <span>• {remainingMinutes}m left</span>}
                        </div>
                    </div>
                )}
            </div>

            <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={handleDelete}
            >
                <Trash2 className="h-5 w-5" />
            </Button>
        </div>
    )
})

ActivityItemCard.displayName = 'ActivityItemCard'
