
import { ActivityItem } from '@/types/activity'
import { isToday, isYesterday, format } from 'date-fns'
import { PlayCircle, Activity, ArrowUp } from 'lucide-react'
import { useMemo, useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ActivityItemCard, isCluster, HistoryCluster } from './ActivityItemCard'

interface ActivityFeedProps {
    history: ActivityItem[]
    viewMode?: 'grid' | 'list'
    onToggleSelect?: (id: string | string[]) => void
    onDelete?: (id: string | string[], removeFromLibrary: boolean) => void
    selectedItems?: Set<string>
    isBulkMode?: boolean
}

export function ActivityFeed({
    history,
    viewMode = 'grid',
    onToggleSelect,
    onDelete,
    selectedItems = new Set(),
    isBulkMode = false,
}: ActivityFeedProps) {
    const [activeTab, setActiveTab] = useState("all")
    const [visibleCount, setVisibleCount] = useState(500)
    const [showScrollTop, setShowScrollTop] = useState(false)

    // Reset visible count when tab changes
    useEffect(() => {
        setVisibleCount(500)
    }, [activeTab])

    // Scroll to Top Logic
    useEffect(() => {
        const handleScroll = () => {
            setShowScrollTop(window.scrollY > 400)
        }
        window.addEventListener('scroll', handleScroll)
        return () => window.removeEventListener('scroll', handleScroll)
    }, [])

    const scrollToTop = () => {
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

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
        const sorted = [...filteredHistory].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )

        const dates: string[] = []
        const groups: Record<string, (ActivityItem | HistoryCluster)[]> = {}

        sorted.forEach(item => {
            const date = new Date(item.timestamp)
            const dateStr = isNaN(date.getTime()) ? 'Unknown Date' : date.toDateString()

            if (!groups[dateStr]) {
                groups[dateStr] = []
                dates.push(dateStr)
            }

            const currentGroup = groups[dateStr]
            const lastEntry = currentGroup[currentGroup.length - 1]

            // If movie, always separate item
            if (item.type === 'movie' || !item.name) {
                currentGroup.push(item)
                return
            }

            // Cluster logic: If same show name as last entry, add to cluster
            if (lastEntry && isCluster(lastEntry) && lastEntry.name === item.name) {
                lastEntry.items.push(item)
            } else if (lastEntry && !isCluster(lastEntry) && lastEntry.name === item.name && (item.type === 'series' || item.type === 'episode')) {
                // Convert last item to a cluster and add current item
                const cluster: HistoryCluster = {
                    isCluster: true,
                    name: item.name,
                    items: [lastEntry, item],
                    timestamp: new Date(lastEntry.timestamp)
                }
                currentGroup[currentGroup.length - 1] = cluster
            } else {
                currentGroup.push(item)
            }
        })

        return dates.map(date => ({
            date,
            items: groups[date]
        }))
    }, [filteredHistory])

    const formatDateHeader = (dateStr: string) => {
        if (dateStr === 'Unknown Date') return dateStr
        const date = new Date(dateStr)
        if (isToday(date)) return 'Today'
        if (isYesterday(date)) return 'Yesterday'
        return format(date, 'MMMM d, yyyy')
    }

    // Pagination Logic
    const { visibleGroups, hasMore } = useMemo(() => {
        let count = 0
        const visible: typeof groupedHistory = []
        let moreAvailable = false

        for (const group of groupedHistory) {
            if (count >= visibleCount) {
                moreAvailable = true
                break
            }

            // If the whole group fits, add it.
            // If not, we could slice it, but for simplicity let's just add full groups 
            // until we cross the limit.
            // Actually, adding full groups is safer for DOM integrity (headers etc).
            // But if one group is huge (mock data), we might want to slice it.
            // Let's stick to full groups for now, assuming date grouping breaks it down enough.
            // Exception: If the FIRST group is huge, we must render it.

            visible.push(group)
            count += group.items.length
        }

        return {
            visibleGroups: visible,
            hasMore: moreAvailable
        }
    }, [groupedHistory, visibleCount])


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
            <div className="space-y-8 animate-in fade-in duration-500 pb-20">
                {visibleGroups.map(({ date, items }) => (
                    <div key={date} className="space-y-4">
                        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-md py-2 flex items-center gap-4 border-b border-border/50">
                            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
                                {formatDateHeader(date)}
                            </h3>
                        </div>

                        <div className={viewMode === 'grid' ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4" : "space-y-3"}>
                            {items.map((entry) => {
                                // Unique key: Use ID of first item
                                const key = isCluster(entry) ? entry.items[0].id : entry.id
                                const item = isCluster(entry) ? entry.items[0] : entry
                                const isSelected = isCluster(entry)
                                    ? entry.items.every(i => selectedItems.has(i.id))
                                    : selectedItems.has(item.id)

                                return (
                                    <ActivityItemCard
                                        key={key}
                                        entry={entry}
                                        viewMode={viewMode}
                                        isSelected={isSelected}
                                        isBulkMode={isBulkMode}
                                        onToggleSelect={onToggleSelect}
                                        onDelete={onDelete}
                                    />
                                )
                            })}
                        </div>
                    </div>
                ))}

                {hasMore && (
                    <div className="flex justify-center pt-8">
                        <Button
                            variant="outline"
                            size="lg"
                            className="min-w-[200px]"
                            onClick={() => setVisibleCount(c => c + 500)}
                        >
                            Load More
                        </Button>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <Tabs defaultValue="all" onValueChange={setActiveTab} className="w-full">
                <div className="flex items-center justify-between mb-2 gap-4">
                    <div className="overflow-x-auto scrollbar-hide">
                        <TabsList className="flex whitespace-nowrap">
                            <TabsTrigger value="all" className="shrink-0">All Activity</TabsTrigger>
                            <TabsTrigger value="movies" className="shrink-0">Movies</TabsTrigger>
                            <TabsTrigger value="series" className="shrink-0">Series</TabsTrigger>
                            <TabsTrigger value="now" className="data-[state=active]:text-green-400 data-[state=active]:bg-green-400/10 shrink-0">
                                <Activity className="h-3 w-3 mr-1.5" /> Now
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <span className="text-[10px] uppercase font-black tracking-wider text-muted-foreground whitespace-nowrap hidden sm:block">
                        Showing {Math.min(visibleCount, filteredHistory.length)} of {filteredHistory.length}
                    </span>
                </div>

                <TabsContent value="all" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="movies" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="series" className="mt-0">{renderFeedContent()}</TabsContent>
                <TabsContent value="now" className="mt-0">{renderFeedContent()}</TabsContent>
            </Tabs>

            {/* Scroll to Top Button */}
            <div className={`fixed bottom-8 right-8 transition-all duration-300 ${showScrollTop ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}>
                <Button
                    size="icon"
                    className="h-12 w-12 rounded-full shadow-xl bg-primary hover:bg-primary/90"
                    onClick={scrollToTop}
                >
                    <ArrowUp className="h-6 w-6" />
                </Button>
            </div>
        </div>
    )
}
