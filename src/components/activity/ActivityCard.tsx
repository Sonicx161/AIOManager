import { formatDistanceToNow } from 'date-fns'
import { PlayCircle, CheckSquare, Activity } from 'lucide-react'
import { ActivityItem } from '@/types/activity'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

interface ActivityCardProps {
    item: ActivityItem
    viewMode: 'grid' | 'list'
    isSelected: boolean
    isBulkMode: boolean
    isLive: boolean
    remainingMinutes: number
    onToggleSelect: (id: string | string[]) => void
    onOpenDetail: (item: ActivityItem) => void
    onDelete?: (id: string | string[], removeRemote: boolean) => void
    cluster?: { items: ActivityItem[] } | null
    getAvatarColor: (index: number) => string
}

export function ActivityCard({
    item,
    viewMode,
    isSelected,
    isBulkMode,
    isLive,
    remainingMinutes,
    onToggleSelect,
    onOpenDetail,
    cluster,
    getAvatarColor,
}: ActivityCardProps) {
    const itemDate = item.timestamp
    const userName = item.accountName || 'Unknown User'

    if (viewMode === 'grid') {
        return (
            <div
                className={cn(
                    "group relative aspect-[2/3] rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-200",
                    isSelected ? 'border-primary ring-2 ring-primary/20 scale-[0.98]' : 'border-transparent hover:border-primary/50'
                )}
                onClick={() => {
                    if (isBulkMode || isSelected) {
                        onToggleSelect(cluster ? cluster.items.map(i => i.id) : item.id)
                    } else {
                        onOpenDetail(item)
                    }
                }}
            >
                {/* Selection Overlay */}
                {(isBulkMode || isSelected) && (
                    <div className={cn(
                        "absolute top-2 left-2 z-30 w-5 h-5 rounded border-2 flex items-center justify-center transition-all",
                        isSelected ? 'bg-primary border-primary' : 'bg-black/40 border-white/40'
                    )}>
                        {isSelected && <CheckSquare className="w-3.5 h-3.5 text-white" />}
                    </div>
                )}
                <img
                    src={item.poster}
                    alt={item.name}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                    loading="lazy"
                    decoding="async"
                />

                {/* Gradient overlay for readability */}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />

                {/* Play Icon on Hover */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 pointer-events-none">
                    {(!isBulkMode && !isSelected) && (
                        <div className="bg-primary/20 backdrop-blur-md rounded-full p-3 border border-primary/50">
                            <PlayCircle className="w-8 h-8 text-white drop-shadow-lg" />
                        </div>
                    )}
                </div>

                {/* Bottom Layout: Left stack + Right user/time */}
                <div className="absolute bottom-0 left-0 right-0 p-2.5 flex items-end justify-between gap-2 z-10">
                    <div className="flex flex-col gap-1 items-start min-w-0 flex-1">
                        <div className="bg-black/60 backdrop-blur-sm rounded px-1.5 py-1 max-w-full">
                            <h3 className="font-black text-[11px] text-white leading-tight line-clamp-2">
                                {item.name}
                            </h3>
                            {cluster ? (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                    {cluster.items.map(i => ({ s: i.season || 1, e: i.episode }))
                                        .filter(i => i.e !== undefined)
                                        .sort((a, b) => b.e! - a.e!)
                                        .slice(0, 2) // Limit to avoid overlap
                                        .map((it, idx) => (
                                            <span key={idx} className="text-[10px] font-black text-primary bg-primary/10 px-1 rounded">
                                                S{it.s} E{it.e}
                                            </span>
                                        ))
                                    }
                                    {cluster.items.length > 2 && <span className="text-[8px] text-white/50">+{cluster.items.length - 2}</span>}
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

                    <div className="flex flex-col gap-1 items-end shrink-0">
                        <Badge variant="secondary" className="bg-black/60 hover:bg-black/70 text-white backdrop-blur-sm border-0 shadow-lg flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold">
                            <Avatar className="h-3 w-3 border border-white/20">
                                <AvatarFallback className={cn("text-[6px] font-bold", getAvatarColor(item.accountColorIndex))}>
                                    {userName[0]?.toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <span className="truncate max-w-[50px]">{userName}</span>
                            {remainingMinutes > 0 && !isLive && (
                                <span className="text-primary font-black ml-0.5">• {remainingMinutes}M</span>
                            )}
                        </Badge>
                    </div>
                </div>

                {/* Live Indicator */}
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

    return null // List view handled differently or we can extend this later
}
