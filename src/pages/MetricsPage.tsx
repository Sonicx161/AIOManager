import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useActivityStore, ActivityItem } from '@/store/activityStore'
import {
    Activity,
    Flame,
    Clock,
    Tv,
    Film,
    Trophy,
    Crown,
    PieChart,
    Ghost,
    Users,
    ChevronLeft,
    ChevronRight,
    PlayCircle,
    Moon,
    Zap,
    CheckCircle,
} from 'lucide-react'
import { useMemo, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '../components/ui/avatar'
import { subHours, isWeekend, subDays, differenceInMinutes } from 'date-fns'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function MetricsPage() {
    const { history, initialize, fetchActivity } = useActivityStore()

    useEffect(() => {
        initialize().then(() => {
            // Background refresh if we already have history loaded from cache
            const hasData = useActivityStore.getState().history.length > 0
            fetchActivity(hasData)
        })
    }, [initialize, fetchActivity])

    const stats = useMemo(() => {
        if (history.length === 0) return null

        // --- PRE-CALCULATION SETUP ---
        const sortedHistory = [...history].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        let totalDurationMinutes = 0
        const itemsByHour = Array(24).fill(0)
        let weekendCount = 0
        let weekdayCount = 0
        const typeCounts = { movie: 0, series: 0, animation: 0, other: 0 }

        // Maps
        const userStats: Record<string, {
            name: string,
            count: number,
            duration: number,
            lastActive: Date,
            recentHistory: typeof history,
            dailyActivity: Set<string>,
            allDates: Date[] // For complex streak calc
        }> = {}

        const trendingItems: Record<string, { count: number, item: typeof history[0] }> = {}
        const contentStats: Record<string, { count: number, item: typeof history[0] }> = {}

        // Deep Dive Stats
        const abandonedSeries: typeof history = []
        const abandonedMovies: typeof history = []

        // Binge Logic (Global Leaderboard)

        const twoDaysAgo = subHours(new Date(), 48)
        const thirtyDaysAgo = subDays(new Date(), 30)

        // --- ITERATION ---
        sortedHistory.forEach((h: ActivityItem) => {
            const dayKey = h.timestamp.toISOString().split('T')[0]

            // 1. Global Totals
            const minutes = (h.duration || 0) / 60000
            totalDurationMinutes += minutes

            // 2. Hourly Activity
            const hour = new Date(h.timestamp).getHours()
            itemsByHour[hour]++

            // 3. Weekend Warriors
            if (isWeekend(h.timestamp)) weekendCount++
            else weekdayCount++

            // 4. Type Distribution
            if (h.type === 'movie') typeCounts.movie++
            else if (h.type === 'series' || h.type === 'episode') typeCounts.series++
            else typeCounts.other++

            // 5. User Leaderboard Data
            if (!userStats[h.accountId]) {
                userStats[h.accountId] = {
                    name: h.accountName || 'Unknown',
                    count: 0,
                    duration: 0,
                    lastActive: h.timestamp,
                    recentHistory: [],
                    dailyActivity: new Set(),
                    allDates: []
                }
            }
            const u = userStats[h.accountId]
            u.count++
            u.duration += minutes
            u.dailyActivity.add(dayKey)
            u.allDates.push(h.timestamp)

            if (h.timestamp > u.lastActive) u.lastActive = h.timestamp
            if (u.recentHistory.length < 8 && !u.recentHistory.some(rh => rh.itemId === h.itemId)) {
                u.recentHistory.push(h)
            }

            // 6. Trending
            if (h.timestamp > twoDaysAgo) {
                if (!trendingItems[h.itemId]) trendingItems[h.itemId] = { count: 0, item: h }
                trendingItems[h.itemId].count++
            }

            // 7. Top Content (Vault)
            if (!contentStats[h.itemId]) contentStats[h.itemId] = { count: 0, item: h }
            contentStats[h.itemId].count++

            // 8. The Graveyard (Abandoned)
            // Rules: Progress > 0 but < 15%, last watched > 30 days ago, must have poster
            if (h.progress > 0 && h.progress < 15 && h.timestamp < thirtyDaysAgo && h.poster) {
                if (h.type === 'movie') abandonedMovies.push(h)
                else abandonedSeries.push(h)
            }
        })

        // --- POST-LOOP CALCULATIONS ---

        // 9. Day of Week Stats
        const dayCounts = [0, 0, 0, 0, 0, 0, 0] // Sun - Sat
        history.forEach(h => {
            const day = new Date(h.timestamp).getDay()
            dayCounts[day]++
        })

        // 10. Longest Movie
        let longestMovie: ActivityItem | null = null
        history.filter(h => h.type === 'movie').forEach(h => {
            if (!longestMovie || (h.duration || 0) > (longestMovie.duration || 0)) {
                longestMovie = h
            }
        })

        // --- BINGE CALCULATION (Global) ---
        const chronoHistory = [...history].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        const tempBingeTracker: Record<string, { currentChain: ActivityItem[], lastTime: Date }> = {}
        const userBinges: Record<string, { duration: number, items: ActivityItem[] }> = {}

        chronoHistory.forEach((h: ActivityItem) => {
            const uid = h.accountId
            if (!tempBingeTracker[uid]) {
                tempBingeTracker[uid] = { currentChain: [h], lastTime: h.timestamp }
            } else {
                const tracker = tempBingeTracker[uid]
                const diff = differenceInMinutes(h.timestamp, tracker.lastTime)

                if (diff < 90) {
                    tracker.currentChain.push(h)
                    tracker.lastTime = h.timestamp
                } else {
                    const currentDuration = tracker.currentChain.length * 30
                    if (!userBinges[uid] || currentDuration > userBinges[uid].duration) {
                        userBinges[uid] = { duration: currentDuration, items: [...tracker.currentChain] }
                    }
                    tracker.currentChain = [h]
                    tracker.lastTime = h.timestamp
                }
            }
        })
        Object.keys(tempBingeTracker).forEach(uid => {
            const tracker = tempBingeTracker[uid]
            const currentDuration = tracker.currentChain.length * 30
            if (!userBinges[uid] || currentDuration > userBinges[uid].duration) {
                userBinges[uid] = { duration: currentDuration, items: [...tracker.currentChain] }
            }
        })

        // --- STREAK CALCULATION ---
        const streakStats = Object.keys(userStats).map(uid => {
            const u = userStats[uid]
            u.allDates.sort((a, b) => a.getTime() - b.getTime())
            let currentStreak = 0, bestStreak = 0, tempStreak = 0
            if (u.allDates.length > 0) {
                for (let i = 0; i < u.allDates.length; i++) {
                    if (i === 0) tempStreak = 1
                    else {
                        const diffDays = Math.floor((u.allDates[i].getTime() - u.allDates[i - 1].getTime()) / (1000 * 60 * 60 * 24))
                        if (diffDays === 0) continue
                        if (diffDays === 1) tempStreak++
                        else { bestStreak = Math.max(bestStreak, tempStreak); tempStreak = 1 }
                    }
                }
                bestStreak = Math.max(bestStreak, tempStreak)
                const daysSinceLast = Math.floor((new Date().getTime() - u.lastActive.getTime()) / (1000 * 60 * 60 * 24))
                if (daysSinceLast <= 1) currentStreak = tempStreak
            }
            const binge = userBinges[uid] || { duration: 0, items: [] }
            return {
                id: uid, name: u.name, currentStreak, bestStreak, avatarChar: u.name[0],
                count: u.count, duration: u.duration, recentHistory: u.recentHistory,
                bingeDuration: binge.duration, bingeItems: binge.items
            }
        })

        // --- FORMATTING ---
        const leaderboard = [...streakStats].sort((a, b) => b.count - a.count).map((u, i) => ({ ...u, rank: i + 1 }))
        const bingeMasters = [...streakStats].sort((a, b) => b.bingeDuration - a.bingeDuration)
        const streakMasters = [...streakStats].sort((a, b) => b.bestStreak - a.bestStreak)
        const topTrending = Object.values(trendingItems).sort((a, b) => b.count - a.count).slice(0, 10).map(t => t.item)
        const topAllTime = Object.values(contentStats).sort((a, b) => b.count - a.count).slice(0, 20).map(c => ({ count: c.count, item: c.item }))
        const maxActivityHour = Math.max(...itemsByHour)
        const peakHour = itemsByHour.indexOf(maxActivityHour)

        let startedCount = 0, engagedCount = 0, finishedCount = 0
        history.forEach(h => {
            if (h.progress > 0) startedCount++
            if (h.progress >= 50) engagedCount++
            if (h.progress >= 90) finishedCount++
        })

        // 11. Community Awards (Fun Logic)
        const userAwardMap: Record<string, { midnightPlays: number, weekendPlays: number, totalStarts: number, totalFinishes: number }> = {}
        history.forEach(h => {
            if (!userAwardMap[h.accountId]) userAwardMap[h.accountId] = { midnightPlays: 0, weekendPlays: 0, totalStarts: 0, totalFinishes: 0 }
            const m = userAwardMap[h.accountId]
            const hour = new Date(h.timestamp).getHours()
            const day = new Date(h.timestamp).getDay()
            if (hour >= 0 && hour <= 5) m.midnightPlays++
            if (day === 0 || day === 6) m.weekendPlays++
            if (h.progress > 0) m.totalStarts++
            if (h.progress >= 90) m.totalFinishes++
        })

        const midnightSnackers = Object.entries(userAwardMap)
            .map(([id, data]) => ({ id, name: userStats[id]?.name || 'Unknown', count: data.midnightPlays }))
            .filter(u => u.count > 0).sort((a, b) => b.count - a.count).slice(0, 5)

        const weekendWarriors = Object.entries(userAwardMap)
            .map(([id, data]) => ({ id, name: userStats[id]?.name || 'Unknown', count: data.weekendPlays }))
            .filter(u => u.count > 0).sort((a, b) => b.count - a.count).slice(0, 5)

        const completionChampions = Object.entries(userAwardMap)
            .map(([id, data]) => ({
                id, name: userStats[id]?.name || 'Unknown',
                rate: data.totalStarts > 0 ? (data.totalFinishes / data.totalStarts) * 100 : 0,
                finishes: data.totalFinishes
            }))
            .filter(u => u.finishes > 5).sort((a, b) => b.rate - a.rate).slice(0, 5)

        return {
            totalItems: history.length,
            totalHours: Math.round(totalDurationMinutes / 60),
            leaderboard, streakMasters, bingeMasters, itemsByHour, maxActivityHour, peakHour,
            funnel: { started: startedCount, engaged: engagedCount, finished: finishedCount },
            weekendCount, weekdayCount, typeCounts, topTrending, topAllTime,
            abandonedSeries, abandonedMovies, dayCounts, longestMovie,
            awards: { midnightSnackers, weekendWarriors, completionChampions }
        }
    }, [history])

    if (!stats) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center p-8 opacity-50">
                <Activity className="h-16 w-16 mb-4 animate-pulse text-indigo-500" />
                <h2 className="text-2xl font-bold">Crunching the numbers...</h2>
            </div>
        )
    }

    return (
        <div className="space-y-8 pb-32 animate-in fade-in duration-700">
            {/* HEADER */}
            <div className="px-4 flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
                    <p className="text-muted-foreground mt-1">
                        Community Core insights and global statistics.
                    </p>
                </div>
                {useActivityStore.getState().loading && (
                    <div className="flex items-center gap-2 text-xs font-bold text-indigo-500 animate-pulse bg-indigo-500/10 px-3 py-1.5 rounded-full border border-indigo-500/20">
                        <Activity className="h-3 w-3" />
                        Syncing...
                    </div>
                )}
            </div>

            <Tabs defaultValue="pulse" className="w-full">
                <div className="flex justify-start mb-8 px-4 overflow-x-auto scrollbar-hide">
                    <TabsList className="inline-flex w-auto whitespace-nowrap">
                        <TabsTrigger value="pulse" className="shrink-0 px-8">Pulse</TabsTrigger>
                        <TabsTrigger value="community" className="shrink-0 px-8">Community</TabsTrigger>
                        <TabsTrigger value="deep-dive" className="shrink-0 px-8">Deep Dive</TabsTrigger>
                        <TabsTrigger value="vault" className="shrink-0 px-8">The Vault</TabsTrigger>
                    </TabsList>
                </div>

                {/* TAB 1: PULSE (Overview) */}
                <TabsContent value="pulse" className="space-y-12">
                    {/* COMMUNITY AWARDS */}
                    <div className="px-4 space-y-6">
                        <div className="flex items-center gap-3">
                            <Trophy className="h-6 w-6 text-yellow-500" />
                            <h2 className="text-2xl font-black">Community Awards</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {/* Midnight Snackers */}
                            <Card className="bg-indigo-500/5 border-indigo-500/20 group hover:border-indigo-500/40 transition-colors">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-2 text-indigo-400">
                                        <Moon className="h-4 w-4" /> Midnight Snackers
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {stats.awards.midnightSnackers.map((u, i) => (
                                        <div key={u.id} className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black text-indigo-500/50">#{i + 1}</span>
                                                <span className="font-bold text-sm truncate max-w-[120px]">{u.name}</span>
                                            </div>
                                            <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
                                                {u.count} Late Night Plays
                                            </Badge>
                                        </div>
                                    ))}
                                    {stats.awards.midnightSnackers.length === 0 && <div className="text-xs italic text-muted-foreground">No night owls yet...</div>}
                                </CardContent>
                            </Card>

                            {/* Weekend Warriors */}
                            <Card className="bg-orange-500/5 border-orange-500/20 group hover:border-orange-500/40 transition-colors">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-2 text-orange-400">
                                        <Zap className="h-4 w-4" /> Weekend Warriors
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {stats.awards.weekendWarriors.map((u, i) => (
                                        <div key={u.id} className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black text-orange-500/50">#{i + 1}</span>
                                                <span className="font-bold text-sm truncate max-w-[120px]">{u.name}</span>
                                            </div>
                                            <Badge variant="outline" className="text-[10px] bg-orange-500/10 text-orange-400 border-orange-500/20">
                                                {u.count} Weekend Plays
                                            </Badge>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>

                            {/* Completion Champions */}
                            <Card className="bg-emerald-500/5 border-emerald-500/20 group hover:border-emerald-500/40 transition-colors">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-2 text-emerald-400">
                                        <CheckCircle className="h-4 w-4" /> Completionists
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {stats.awards.completionChampions.map((u, i) => (
                                        <div key={u.id} className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black text-emerald-500/50">#{i + 1}</span>
                                                <span className="font-bold text-sm truncate max-w-[120px]">{u.name}</span>
                                            </div>
                                            <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                                                {Math.round(u.rate)}% Finished
                                            </Badge>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        </div>
                    </div>

                    {/* TRENDING NOW */}
                    <div className="space-y-4 group/trending">
                        <div className="flex items-center justify-between px-4">
                            <div className="flex items-center gap-3">
                                <Flame className="h-6 w-6 text-orange-500" />
                                <h2 className="text-2xl font-black">Trending Now</h2>
                            </div>
                            <div className="flex gap-2">
                                <Button
                                    variant="outline" size="icon" className="h-8 w-8 rounded-full opacity-50 hover:opacity-100 disabled:opacity-20"
                                    onClick={() => document.getElementById('trending-scroll')?.scrollBy({ left: -300, behavior: 'smooth' })}
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <Button
                                    variant="outline" size="icon" className="h-8 w-8 rounded-full opacity-50 hover:opacity-100 disabled:opacity-20"
                                    onClick={() => document.getElementById('trending-scroll')?.scrollBy({ left: 300, behavior: 'smooth' })}
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>

                        {/* Improved Scroll Area */}
                        <div id="trending-scroll" className="w-full overflow-x-auto pb-4 px-4 scrollbar-hide scroll-smooth">
                            <div className="flex gap-4">
                                {stats.topTrending.map((item, i) => (
                                    <a key={item.id} href={`stremio:///detail/${item.type}/${item.itemId}`} className="relative w-32 h-48 md:w-40 md:h-60 shrink-0 rounded-xl overflow-hidden shadow-xl group cursor-pointer transition-transform hover:-translate-y-2">
                                        <div className="absolute top-2 left-2 z-10 bg-orange-500/90 text-white font-black text-xs px-2 py-1 rounded shadow-lg">#{i + 1}</div>
                                        <img src={item.poster} className="w-full h-full object-cover" />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                                            <div className="text-white text-sm font-bold truncate">{item.name}</div>
                                        </div>
                                    </a>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* TOP STREAMERS PREVIEW */}
                    <div className="px-4">
                        <Card className="bg-gradient-to-r from-muted/50 to-background border-border/50">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Trophy className="h-5 w-5 text-yellow-500" /> Top Streamer
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                {stats.leaderboard[0] && (
                                    <div className="flex items-center gap-4">
                                        <Avatar className="h-16 w-16 border-4 border-yellow-500">
                                            <AvatarFallback className="text-xl font-black bg-yellow-500 text-black">
                                                {stats.leaderboard[0].avatarChar}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div>
                                            <div className="text-2xl font-black">{stats.leaderboard[0].name}</div>
                                            <div className="text-sm text-muted-foreground font-bold">
                                                {stats.leaderboard[0].count} titles • {Math.round(stats.leaderboard[0].duration / 60)} hours
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* MOVED: STREAK HALL OF FAME (DUAL STREAKS) */}
                    <div className="px-4 space-y-6">
                        <div className="flex items-center gap-3">
                            <Flame className="h-6 w-6 text-orange-500" />
                            <h2 className="text-2xl font-black">Streak Hall of Fame</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {stats.streakMasters.map((u, i) => (
                                <Card key={u.id} className="bg-orange-500/5 border-orange-500/20">
                                    <CardContent className="p-6 flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="font-black text-xl text-orange-500">#{i + 1}</div>
                                            <div>
                                                <div className="font-bold">{u.name}</div>
                                                <div className="text-xs font-bold text-muted-foreground uppercase">{u.currentStreak > 0 ? "Active Now" : "Inactive"}</div>
                                            </div>
                                        </div>
                                        <div className="text-right space-y-1">
                                            <div>
                                                <span className="text-2xl font-black">{u.bestStreak}</span>
                                                <span className="text-[10px] uppercase font-bold text-muted-foreground ml-1">Best</span>
                                            </div>
                                            {u.currentStreak > 0 && (
                                                <div className="text-orange-500 animate-pulse">
                                                    <span className="text-lg font-black">{u.currentStreak}</span>
                                                    <span className="text-[10px] uppercase font-bold ml-1">Current</span>
                                                </div>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>

                    {/* CONTENT MIX (PULSE PREVIEW) */}
                    <div className="px-4">
                        <Card className="bg-muted/10 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <PieChart className="h-5 w-5 text-indigo-400" /> Content Mix
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex items-center gap-8">
                                    <div className="flex-1 space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                                <span>Movies</span>
                                                <span>{stats.typeCounts.movie || 0}</span>
                                            </div>
                                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-pink-500"
                                                    style={{ width: `${(stats.typeCounts.movie / stats.totalItems) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                                <span>Series</span>
                                                <span>{stats.typeCounts.series || 0}</span>
                                            </div>
                                            <div className="h-2 bg-muted rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-blue-500"
                                                    style={{ width: `${(stats.typeCounts.series / stats.totalItems) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="hidden sm:block text-right">
                                        <div className="text-4xl font-black text-foreground">{stats.totalItems}</div>
                                        <div className="text-[10px] uppercase font-black tracking-tighter text-muted-foreground transition-all group-hover:text-primary">Total Titles</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                {/* TAB 2: COMMUNITY (Leaderboards) */}
                <TabsContent value="community" className="space-y-12 px-4">
                    {/* 1. TOP STREAMERS (FULL LIST) - REDESIGNED */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Users className="h-6 w-6 text-blue-500" />
                            <h2 className="text-2xl font-black">Community Leaderboard</h2>
                        </div>
                        <div className="grid grid-cols-1 gap-6">
                            {stats.leaderboard.map((user) => (
                                <Card key={user.name} className="overflow-hidden group hover:border-primary/40 transition-colors">
                                    <CardContent className="p-8">
                                        <div className="flex flex-col gap-6">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-6">
                                                    <div className="text-5xl font-black text-muted-foreground/30">#{user.rank}</div>
                                                    <Avatar className="h-16 w-16 border-4 border-background shadow-xl">
                                                        <AvatarFallback className="font-bold text-2xl">{user.avatarChar}</AvatarFallback>
                                                    </Avatar>
                                                    <div>
                                                        <div className="font-black text-3xl">{user.name}</div>
                                                        <div className="text-sm font-bold text-muted-foreground uppercase flex gap-4 mt-1">
                                                            <span className="flex items-center gap-1"><PlayCircle className="h-3 w-3" /> {user.count} Plays</span>
                                                            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {Math.round(user.duration / 60)} Hours</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* History Carousel */}
                                            <div className="w-full overflow-x-auto pb-2 scrollbar-hide">
                                                <div className="flex items-center gap-4">
                                                    {user.recentHistory.map(h => (
                                                        <a key={h.id} href={`stremio:///detail/${h.type}/${h.itemId}`} className="flex-none w-24 aspect-[2/3] relative group/poster transition-transform hover:-translate-y-2 cursor-pointer">
                                                            <img src={h.poster} className="w-full h-full object-cover rounded-md shadow-md" />
                                                            <div className="absolute inset-0 bg-black/20 group-hover/poster:bg-transparent transition-colors rounded-md" />
                                                        </a>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>

                    {/* MOVED STREAK HALL OF FAME TO PULSE */}

                    {/* COMPLETION FUNNEL */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <PieChart className="h-10 w-10 text-emerald-500" />
                            <h2 className="text-4xl font-black tracking-tighter">Retention Funnel</h2>
                        </div>
                        <Card className="bg-muted/10 border-border/60">
                            <CardContent className="p-8">
                                <div className="space-y-12">
                                    {[
                                        { label: 'Started', count: stats.funnel.started, color: 'bg-emerald-500/20', textColor: 'text-emerald-400', width: '100%' },
                                        { label: 'Halfway', count: stats.funnel.engaged, color: 'bg-emerald-500/40', textColor: 'text-emerald-400', width: '70%' },
                                        { label: 'Finished', count: stats.funnel.finished, color: 'bg-emerald-500', textColor: 'text-white', width: '40%' }
                                    ].map((step, i) => (
                                        <div key={i} className="flex flex-col items-center gap-4">
                                            <div className={`h-12 flex items-center justify-center rounded-lg font-black text-xl shadow-lg border border-emerald-500/20 ${step.color} ${step.textColor}`} style={{ width: step.width }}>
                                                {step.count} TITLES
                                            </div>
                                            <div className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">{step.label}</div>
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-12 p-6 bg-emerald-500/5 rounded-xl border border-emerald-500/10 text-center">
                                    <div className="text-3xl font-black text-emerald-500">
                                        {stats.funnel.started > 0 ? Math.round((stats.funnel.finished / stats.funnel.started) * 100) : 0}%
                                    </div>
                                    <div className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mt-1">Global Completion Rate</div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                {/* TAB 3: DEEP DIVE (Pro Stats) */}
                <TabsContent value="deep-dive" className="space-y-8 px-4">
                    <div className="grid md:grid-cols-2 gap-6">
                        {/* MOVED GENRE DNA TO VAULT - REPLACED WITH DAY OF WEEK */}
                        {/* PRIME TIME HEATMAP */}
                        <Card className="bg-muted/10 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Clock className="h-5 w-5 text-orange-400" /> Prime Time
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex justify-between items-end h-16 gap-0.5">
                                    {stats.itemsByHour.map((count, i) => {
                                        const max = stats.maxActivityHour || 1
                                        const opacity = 0.1 + (count / max) * 0.9
                                        return (
                                            <div
                                                key={i}
                                                className="flex-1 rounded-sm bg-orange-500 transition-all cursor-help"
                                                style={{
                                                    height: `${20 + (count / max) * 80}%`,
                                                    opacity
                                                }}
                                                title={`${i}:00 - ${count} plays`}
                                            />
                                        )
                                    })}
                                </div>
                                <div className="flex justify-between text-[10px] uppercase font-black text-muted-foreground tracking-widest pt-2 border-t border-border/40">
                                    <span>12 AM</span>
                                    <span>6 AM</span>
                                    <span>12 PM</span>
                                    <span>6 PM</span>
                                    <span>11 PM</span>
                                </div>
                                <div className="text-sm font-bold bg-orange-500/10 text-orange-400 p-3 rounded-lg border border-orange-500/20">
                                    Your peak activity is at <span className="text-foreground">{stats.peakHour}:00</span>.
                                </div>
                            </CardContent>
                        </Card>

                        {/* MOVED HOURLY ACTIVITY TO PULSE - REPLACED WITH CONTENT ERA? OR JUST EXPANDED */}
                        {stats.longestMovie && (
                            <Card className="bg-muted/10 border-border/60">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Film className="h-5 w-5 text-pink-500" /> Longest Movie
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex gap-4">
                                        <img src={(stats.longestMovie as any).poster} className="h-32 w-24 object-cover rounded shadow" />
                                        <div className="space-y-2">
                                            <div className="text-xl font-black line-clamp-2">{(stats.longestMovie as any).name}</div>
                                            <div className="text-sm font-bold text-muted-foreground">
                                                {Math.round(((stats.longestMovie as any).duration || 0) / 60000)} Minutes
                                            </div>
                                            <div className="text-xs uppercase tracking-widest text-pink-500 font-bold">Endurance Badge</div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>

                    {/* THE GRAVEYARD (SPLIT) - EXPANDED */}
                    <div className="space-y-8 pt-8 border-t border-border/50">
                        <div className="flex items-center gap-3">
                            <Ghost className="h-8 w-8 text-muted-foreground" />
                            <h2 className="text-3xl font-black text-muted-foreground">The Graveyard</h2>
                        </div>
                        <div className="grid md:grid-cols-2 gap-8">
                            {/* ABANDONED SERIES */}
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-muted-foreground">Abandoned Shows</h3>
                                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {stats.abandonedSeries.map(item => (
                                        <a key={item.id} href={`stremio:///detail/${item.type}/${item.itemId}`} className="relative aspect-[2/3] grayscale hover:grayscale-0 transition-all duration-500 rounded-lg overflow-hidden group cursor-pointer opacity-70 hover:opacity-100 shadow-md">
                                            <img src={item.poster} className="w-full h-full object-cover" />
                                            <div className="absolute top-1 right-1 bg-red-500 text-[10px] text-white px-1.5 rounded font-bold">
                                                {Math.round(item.progress)}%
                                            </div>
                                        </a>
                                    ))}
                                    {stats.abandonedSeries.length === 0 && <div className="text-xs italic text-muted-foreground col-span-3">No abandoned shows. Good job!</div>}
                                </div>
                            </div>

                            {/* ABANDONED MOVIES */}
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-muted-foreground">Walked Out Movies</h3>
                                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {stats.abandonedMovies.map(item => (
                                        <a key={item.id} href={`stremio:///detail/${item.type}/${item.itemId}`} className="relative aspect-[2/3] grayscale hover:grayscale-0 transition-all duration-500 rounded-lg overflow-hidden group cursor-pointer opacity-70 hover:opacity-100 shadow-md">
                                            <img src={item.poster} className="w-full h-full object-cover" />
                                            <div className="absolute top-1 right-1 bg-red-500 text-[10px] text-white px-1.5 rounded font-bold">
                                                {Math.round(item.progress)}%
                                            </div>
                                        </a>
                                    ))}
                                    {stats.abandonedMovies.length === 0 && <div className="text-xs italic text-muted-foreground col-span-3">No unfinished movies. Cinema lover!</div>}
                                </div>
                            </div>
                        </div>
                    </div>
                </TabsContent>

                {/* TAB 4: THE VAULT (Hall of Fame) */}
                <TabsContent value="vault" className="space-y-12 px-4">
                    <div className="grid md:grid-cols-2 gap-8">
                        {/* GENRE DNA */}
                        <Card className="bg-muted/10 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <PieChart className="h-5 w-5 text-purple-400" /> Genre DNA
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex items-center justify-center py-8 gap-8">
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="h-24 w-24 rounded-full border-[6px] border-primary flex items-center justify-center bg-primary/10 shadow-[0_0_15px_rgba(var(--primary),0.3)]">
                                            <Tv className="h-8 w-8 text-primary" />
                                        </div>
                                        <div className="text-center">
                                            <div className="text-3xl font-black">{stats.typeCounts.series}</div>
                                            <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Series</div>
                                        </div>
                                    </div>
                                    <div className="h-24 w-px bg-border/50" />
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="h-24 w-24 rounded-full border-[6px] border-blue-500 flex items-center justify-center bg-blue-500/10 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                                            <Film className="h-8 w-8 text-blue-500" />
                                        </div>
                                        <div className="text-center">
                                            <div className="text-3xl font-black">{stats.typeCounts.movie}</div>
                                            <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Movies</div>
                                        </div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* TOTAL WATCH TIME */}
                        <Card className="bg-gradient-to-br from-indigo-900/20 to-purple-900/20 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Clock className="h-5 w-5 text-indigo-400" /> Time Dilation
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col items-center justify-center h-[200px] gap-4">
                                <div className="text-center space-y-2">
                                    <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">
                                        {Math.floor(stats.totalHours / 24)}
                                    </div>
                                    <div className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">Days of Life</div>
                                </div>
                                <div className="text-md font-bold text-muted-foreground/80">
                                    +{stats.totalHours % 24} Hours
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Crown className="h-6 w-6 text-yellow-600" />
                            <h2 className="text-2xl font-black">Global Hall of Fame</h2>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                            {stats.topAllTime.map((stat, i) => (
                                <a key={stat.item.id} href={`stremio:///detail/${stat.item.type}/${stat.item.itemId}`} className="group relative aspect-[2/3] rounded-xl overflow-hidden bg-muted shadow-lg cursor-pointer transition-transform hover:-translate-y-2">
                                    <img src={stat.item.poster} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent flex flex-col justify-end p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <div className="text-4xl font-black text-white mb-1">#{i + 1}</div>
                                        <div className="text-xs font-bold text-white/80 uppercase tracking-widest">{stat.count} Plays</div>
                                    </div>
                                </a>
                            ))}
                        </div>
                    </div>

                </TabsContent>
            </Tabs>
        </div>
    )
}
