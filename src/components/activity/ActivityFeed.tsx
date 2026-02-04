import { ActivityItem } from '@/store/activityStore'
import { format, isToday, isYesterday, formatDistanceToNow } from 'date-fns'
import { PlayCircle, Trash2, Tv, Film, Activity } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '../../components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface ActivityFeedProps {
    history: ActivityItem[]
    viewMode?: 'grid' | 'list'
    onToggleSelect?: (id: string) => void
    selectedItems?: Set<string>
}

export function ActivityFeed({
    history,
    viewMode = 'grid',
    onToggleSelect,
    selectedItems = new Set(),
}: ActivityFeedProps) {
    const [activeTab, setActiveTab] = useState("all")
    const isSelectionMode = onToggleSelect !== undefined

    // Filter history based on active tab AND search query
    const filteredHistory = useMemo(() => {
        let filtered = history

        // 1. Filter by Tab
        if (activeTab === 'movies') filtered = filtered.filter(h => h.type === 'movie')
        else if (activeTab === 'series') filtered = filtered.filter(h => h.type === 'series' || h.type === 'episode')
        else if (activeTab === 'now') {
            const twentyMinsAgo = new Date().getTime() - (20 * 60 * 1000)
            filtered = filtered.filter(h => new Date(h.timestamp).getTime() > twentyMinsAgo)
        }

        return filtered
    }, [history, activeTab])

    const groupedHistory = useMemo(() => {
        // Sort by timestamp descending
        const sorted = [...filteredHistory].sort((a, b) => {
            const dateA = new Date(a.timestamp).getTime()
            const dateB = new Date(b.timestamp).getTime()
            return dateB - dateA
        })

        return sorted.reduce((groups, item) => {
            const date = new Date(item.timestamp)
            const dateStr = isNaN(date.getTime()) ? 'Unknown Date' : date.toDateString()

            if (!groups[dateStr]) {
                groups[dateStr] = []
            }
            groups[dateStr].push(item)
            return groups
        }, {} as Record<string, ActivityItem[]>)
    }, [filteredHistory])

    const formatDateHeader = (dateStr: string) => {
        if (dateStr === 'Unknown Date') return dateStr
        const date = new Date(dateStr)
        if (isToday(date)) return 'Today'
        if (isYesterday(date)) return 'Yesterday'
        return format(date, 'MMMM d, yyyy')
    }

    const getSafeDate = (date: Date | string) => {
        const d = new Date(date)
        return isNaN(d.getTime()) ? new Date() : d
    }

    // --- RENDER HELPERS ---
    const renderEmptyState = () => (
        <div className="text-center py-20 border-2 border-dashed rounded-xl opacity-50">
            <div className=" bg-muted/30 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                {activeTab === 'now' ? <Activity className="h-8 w-8 opacity-50" /> : <PlayCircle className="h-8 w-8 opacity-50" />}
            </div>
            <p className="text-sm font-medium">No activity found</p>
            <p className="text-xs text-muted-foreground mt-1">
                {activeTab === 'now' ? "Nobody is watching right now." : "Time to start watching something!"}
            </p>
        </div>
    )

    const renderFeedContent = () => {
        if (filteredHistory.length === 0) return renderEmptyState()

        return (
            <div className="space-y-8 animate-in fade-in duration-500">
                {Object.entries(groupedHistory).map(([date, items]) => (
                    <div key={date} className="space-y-4">
                        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-md py-2 flex items-center gap-4 border-b border-border/50">
                            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
                                {formatDateHeader(date)}
                            </h3>
                        </div>

                        <div className={viewMode === 'grid' ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4" : "space-y-3"}>
                            {items.map((item) => {
                                const isSelected = selectedItems.has(item.id)
                                const itemDate = getSafeDate(item.timestamp)
                                const userName = item.accountName || 'Unknown User'
                                // Live logic: < 20 mins ago (User requested "Currently watching")
                                const diffNow = new Date().getTime() - itemDate.getTime()
                                const isLive = diffNow < 1200000 // 20 mins

                                const remainingMinutes = item.duration && item.watched
                                    ? Math.max(0, Math.round((item.duration - item.watched) / 60000))
                                    : 0

                                if (viewMode === 'grid') {
                                    return (
                                        <div
                                            key={item.id}
                                            className={`group relative aspect-[2/3] rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-200 ${isSelected ? 'border-primary ring-2 ring-primary/20 scale-[0.98]' : 'border-transparent hover:border-primary/50'
                                                }`}
                                            onClick={() => onToggleSelect?.(item.id)}
                                        >
                                            <img
                                                src={item.poster}
                                                alt={item.name}
                                                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                                loading="lazy"
                                            />

                                            {/* Top Left: Title & Time */}
                                            <div className="absolute top-2 left-2 flex flex-col gap-1 items-start z-10">
                                                <Badge className="bg-black/60 text-white backdrop-blur-md border-0 shadow-lg px-2 py-0.5 text-[10px] font-black leading-tight max-w-[120px]">
                                                    <span className="truncate">{item.name}</span>
                                                </Badge>
                                                {!isLive && (
                                                    <Badge className="bg-black/60 text-white/80 backdrop-blur-md border-0 px-2 py-0.5 text-[9px] font-bold shadow-lg">
                                                        {formatDistanceToNow(itemDate, { addSuffix: true })}
                                                    </Badge>
                                                )}
                                            </div>

                                            {/* Top Right: User & Remaining */}
                                            <div className="absolute top-2 right-2 flex flex-col gap-1 items-end z-10">
                                                <Badge variant="secondary" className="bg-black/60 hover:bg-black/80 text-white backdrop-blur-md border-0 shadow-lg flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold">
                                                    <Avatar className="h-3 w-3 border border-white/20">
                                                        <AvatarFallback className="bg-primary/20 text-[6px] text-white my-auto">
                                                            {userName[0]?.toUpperCase()}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span className="truncate max-w-[60px]">{userName}</span>
                                                </Badge>

                                                {remainingMinutes > 0 && !isLive && (
                                                    <Badge className="bg-black/60 text-white backdrop-blur-md border-0 px-2 py-0.5 text-[9px] font-black shadow-lg">
                                                        {remainingMinutes}M LEFT
                                                    </Badge>
                                                )}
                                            </div>

                                            {/* Bottom: Watching Now Overlay */}
                                            {isLive && (
                                                <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-green-500/80 to-transparent flex justify-center">
                                                    <Badge className="bg-white text-green-600 border-0 shadow-xl animate-pulse flex items-center gap-1.5 px-3 py-1 text-[10px] font-black uppercase tracking-widest">
                                                        <Activity className="h-3 w-3" /> Watching Now
                                                    </Badge>
                                                </div>
                                            )}

                                            {!isLive && (
                                                <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                            )}
                                        </div>
                                    )
                                }

                                // LIST VIEW
                                return (
                                    <div
                                        key={item.id}
                                        className={`group flex items-center gap-6 p-4 rounded-2xl border transition-all duration-200 ${isSelected ? 'bg-primary/5 border-primary shadow-sm' : 'hover:bg-muted/30 border-border/40'
                                            }`}
                                        onClick={() => isSelectionMode && onToggleSelect?.(item.id)}
                                    >
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
                                                {item.type === 'series' && (
                                                    <span className="flex items-center gap-1 font-mono text-primary font-bold">
                                                        S{item.season} E{item.episode}
                                                    </span>
                                                )}

                                                <div className="flex items-center gap-2">
                                                    <Avatar className="h-5 w-5 border border-border">
                                                        <AvatarFallback className="text-[9px] bg-secondary font-bold">
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
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                toast({
                                                    title: 'Coming Soon',
                                                    description: 'Direct deletion from feed will be available next sync.',
                                                })
                                            }}
                                        >
                                            <Trash2 className="h-5 w-5" />
                                        </Button>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <Tabs defaultValue="all" onValueChange={setActiveTab} className="w-full">
                <div className="flex items-center justify-between mb-2">
                    <TabsList>
                        <TabsTrigger value="all">All Activity</TabsTrigger>
                        <TabsTrigger value="movies">Movies</TabsTrigger>
                        <TabsTrigger value="series">Series</TabsTrigger>
                        <TabsTrigger value="now" className="data-[state=active]:text-green-400 data-[state=active]:bg-green-400/10">
                            <Activity className="h-3 w-3 mr-1.5" /> Now
                        </TabsTrigger>
                    </TabsList>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground hidden sm:block">
                        {history.length} movies and shows
                    </div>
                </div>

                <TabsContent value="all" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="movies" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="series" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="now" className="mt-0">{renderFeedContent()}</TabsContent>
            </Tabs>
        </div>
    )
}
