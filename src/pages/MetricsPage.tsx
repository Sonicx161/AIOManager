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
    Sun,
    Coffee,
    LayoutGrid as Grid,
} from 'lucide-react'
import { useMemo, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '../components/ui/avatar'
import { subHours, subDays } from 'date-fns'
import { cn } from '@/lib/utils'
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
        const typeCounts = { movie: 0, series: 0, animation: 0, other: 0 }

        // Maps
        const userStats: Record<string, {
            name: string,
            count: number,
            duration: number,
            lastActive: Date,
            recentHistory: typeof history,
            dailyActivity: Set<string>,

            allDates: Date[], // For complex streak calc
            hourlyActivity: number[],
            formatCounts: { movie: number, series: number }
        }> = {}

        const trendingItems: Record<string, { count: number, item: typeof history[0] }> = {}
        const contentStats: Record<string, {
            count: number,
            item: typeof history[0],
            firstSeen: Date,
            lastSeen: Date,
            accounts: Set<string>
        }> = {}

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

            // 3. Weekend Warriors (Legacy count removed)
            // if (isWeekend(h.timestamp)) weekendCount++
            // else weekdayCount++

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
                    allDates: [],
                    hourlyActivity: new Array(24).fill(0),
                    formatCounts: { movie: 0, series: 0 }
                }
            }
            const u = userStats[h.accountId]
            u.count++
            u.duration += minutes
            u.dailyActivity.add(dayKey)
            u.allDates.push(h.timestamp)

            if (h.timestamp > u.lastActive) u.lastActive = h.timestamp

            // Track Hourly & Format
            u.hourlyActivity[hour]++
            if (h.type === 'movie') u.formatCounts.movie++
            else if (h.type === 'series') u.formatCounts.series++

            if (u.recentHistory.length < 8 && !u.recentHistory.some(rh => rh.itemId === h.itemId)) {
                u.recentHistory.push(h)
            }

            // 6. Trending
            if (h.timestamp > twoDaysAgo) {
                if (!trendingItems[h.itemId]) trendingItems[h.itemId] = { count: 0, item: h }
                trendingItems[h.itemId].count++
            }

            // 7. Top Content (Vault) & Overlap
            if (!contentStats[h.itemId]) {
                contentStats[h.itemId] = {
                    count: 0,
                    item: h,
                    firstSeen: h.timestamp,
                    lastSeen: h.timestamp,
                    accounts: new Set()
                }
            }
            const cs = contentStats[h.itemId]
            cs.count++
            cs.accounts.add(h.accountId)
            if (h.timestamp < cs.firstSeen) cs.firstSeen = h.timestamp
            if (h.timestamp > cs.lastSeen) cs.lastSeen = h.timestamp

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
                const diff = (h.timestamp.getTime() - tracker.lastTime.getTime()) / 60000 // minutes

                // Gap < 90 mins = same session
                if (diff < 90) {
                    tracker.currentChain.push(h)
                    tracker.lastTime = h.timestamp
                } else {
                    const duration = tracker.currentChain.length
                    if (!userBinges[uid] || duration > userBinges[uid].duration) {
                        userBinges[uid] = { duration, items: [...tracker.currentChain].reverse() }
                    }
                    tracker.currentChain = [h]
                    tracker.lastTime = h.timestamp
                }
            }
        })
        Object.keys(tempBingeTracker).forEach(uid => {
            const tracker = tempBingeTracker[uid]
            const duration = tracker.currentChain.length
            if (!userBinges[uid] || duration > (userBinges[uid]?.duration || 0)) {
                userBinges[uid] = { duration, items: [...tracker.currentChain].reverse() }
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

        // 11. Shared Universe (Account Overlap)
        const sharedUniverse = Object.values(contentStats)
            .filter(cs => cs.accounts.size > 1)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10)

        // 12. Content Velocity (Binge Speed)
        const contentVelocity = Object.values(contentStats)
            .filter(cs => cs.count > 3 && cs.item.type === 'series')
            .map(cs => {
                const days = Math.max(1, Math.ceil((cs.lastSeen.getTime() - cs.firstSeen.getTime()) / (1000 * 60 * 60 * 24)))
                return {
                    item: cs.item,
                    days,
                    episodes: cs.count,
                    velocity: cs.count / days
                }
            })
            .sort((a, b) => b.velocity - a.velocity)
            .slice(0, 10)

        // --- FORMATTING ---
        const leaderboard = [...streakStats].sort((a, b) => b.count - a.count).map((u, i) => ({ ...u, rank: i + 1 }))
        const bingeMasters = [...streakStats].sort((a, b) => b.bingeDuration - a.bingeDuration)
        const streakMasters = [...streakStats].sort((a, b) => b.bestStreak - a.bestStreak)
        const topTrending = Object.values(trendingItems).sort((a, b) => b.count - a.count).slice(0, 10).map(t => t.item)
        const topAllTime = Object.values(contentStats).sort((a, b) => b.count - a.count).slice(0, 20).map(c => ({
            count: c.count,
            item: c.item,
            shared: c.accounts.size > 1
        }))
        const maxActivityHour = Math.max(...itemsByHour)
        const peakHour = itemsByHour.indexOf(maxActivityHour)

        let startedCount = 0, engagedCount = 0, finishedCount = 0
        history.forEach(h => {
            if (h.progress > 0) startedCount++
            if (h.progress >= 50) engagedCount++
            if (h.progress >= 90) finishedCount++
        })

        // 13. Community Awards (Fun Logic)
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

        // 14. Live Activity (Last 24h)
        const activityBy24h = new Array(24).fill(0)
        history.forEach(h => {
            const diffHours = (new Date().getTime() - h.timestamp.getTime()) / (1000 * 60 * 60)
            if (diffHours >= 0 && diffHours < 24) {
                const hourIndex = 23 - Math.floor(diffHours)
                activityBy24h[hourIndex]++
            }
        })

        // 15. Series Loyalty
        const seriesItems = history.filter(h => h.type === 'series')
        const seriesContentStats = Object.values(contentStats).filter(cs => cs.item.type === 'series')
        const totalSeriesPlays = seriesItems.length
        const top5SeriesPlays = seriesContentStats.sort((a, b) => b.count - a.count).slice(0, 5).reduce((sum, cs) => sum + cs.count, 0)
        const seriesLoyalty = totalSeriesPlays > 0 ? (top5SeriesPlays / totalSeriesPlays) * 100 : 0

        // 16. Watch Personas
        const userPersonas = Object.entries(userAwardMap).map(([id, data]) => {
            const completionRate = data.totalStarts > 0 ? (data.totalFinishes / data.totalStarts) * 100 : 0
            const bingeData = userBinges[id] || { duration: 0 }

            const badges = []
            if (completionRate > 80 && data.totalFinishes > 10) badges.push({ type: 'The Completer', icon: 'CheckCircle', color: 'emerald' })
            if (completionRate < 30 && data.totalStarts > 20) badges.push({ type: 'The Sampler', icon: 'Ghost', color: 'pink' })
            if (data.midnightPlays > data.totalStarts * 0.3) badges.push({ type: 'The Night Owl', icon: 'Moon', color: 'indigo' })
            if (bingeData.duration > 8) badges.push({ type: 'Binge King', icon: 'Flame', color: 'orange' })
            if (data.weekendPlays > data.totalStarts * 0.6) badges.push({ type: 'Weekend Warrior', icon: 'Zap', color: 'yellow' })

            return { id, name: userStats[id]?.name || 'Unknown', badges }
        })

        // 17. User Traits (Chronotype & Format)
        const userTraits = Object.entries(userStats).map(([id, u]) => {
            // Chronotype
            const morning = u.hourlyActivity.slice(5, 12).reduce((a: number, b: number) => a + b, 0)
            const afternoon = u.hourlyActivity.slice(12, 17).reduce((a: number, b: number) => a + b, 0)
            const evening = u.hourlyActivity.slice(17, 23).reduce((a: number, b: number) => a + b, 0)
            const night = u.hourlyActivity.slice(23, 24).reduce((a: number, b: number) => a + b, 0) + u.hourlyActivity.slice(0, 5).reduce((a: number, b: number) => a + b, 0)

            let chronotype = { label: 'Balanced Viewer', icon: Clock, color: 'gray' }
            const max = Math.max(morning, afternoon, evening, night)
            if (max > 0) {
                if (max === morning) chronotype = { label: 'Early Bird', icon: Sun, color: 'orange' }
                else if (max === afternoon) chronotype = { label: 'Day Dreamer', icon: Coffee, color: 'blue' }
                else if (max === evening) chronotype = { label: 'Prime Time Player', icon: Tv, color: 'indigo' }
                else chronotype = { label: 'Night Owl', icon: Moon, color: 'purple' }
            }

            // Format Loyalty
            const total = u.formatCounts.movie + u.formatCounts.series
            let formatLoyalty = { label: 'The Hybrid', icon: Grid, color: 'emerald' }
            if (total > 0) {
                if (u.formatCounts.movie / total > 0.7) formatLoyalty = { label: 'The Cinephile', icon: Film, color: 'rose' }
                else if (u.formatCounts.series / total > 0.7) formatLoyalty = { label: 'Serial Binger', icon: Tv, color: 'cyan' }
            }

            return { id, name: u.name, chronotype, formatLoyalty }
        })

        // 18. Franchise Focus
        const franchises = [
            { name: 'Marvel', keywords: ['Marvel', 'Avengers', 'Iron Man', 'Spider-Man', 'Thor', 'Guardians', 'MCU'] },
            { name: 'Star Trek', keywords: ['Star Trek', 'Discovery', 'Picard', 'Strange New Worlds', 'Enterprise'] },
            { name: 'Star Wars', keywords: ['Star Wars', 'Mandalorian', 'Andor', 'Ahsoka', 'Skywalker', 'Boba Fett'] },
            { name: 'DC Universe', keywords: ['Batman', 'Superman', 'Justice League', 'The Flash', 'Wonder Woman', 'Joker'] },
            { name: 'Game of Thrones', keywords: ['Thrones', 'House of the Dragon', 'Westeros'] }
        ]
        const franchiseFocus = franchises.map(f => {
            const count = history.filter(h => f.keywords.some(k => h.name.toLowerCase().includes(k.toLowerCase()))).length
            return { name: f.name, count }
        }).sort((a, b) => b.count - a.count).filter(f => f.count > 0)

        // 19. Rare Finds (Unique to one account)
        const itemUserMap: Record<string, Set<string>> = {}
        history.forEach(h => {
            if (!itemUserMap[h.itemId]) itemUserMap[h.itemId] = new Set()
            itemUserMap[h.itemId].add(h.accountId)
        })
        const rareFinds = history.filter(h => itemUserMap[h.itemId].size === 1)
            .reduce((acc: any[], h) => {
                if (!acc.find(x => x.itemId === h.itemId)) acc.push(h)
                return acc
            }, []).slice(0, 10)

        // 20. 30-Day Activity Streak Map
        const streakMapData = new Array(30).fill(0)
        history.forEach(h => {
            const diff = Math.floor((new Date().getTime() - h.timestamp.getTime()) / (1000 * 60 * 60 * 24))
            if (diff >= 0 && diff < 30) {
                streakMapData[29 - diff]++
            }
        })

        // 21. Live Pilot (Most active in last 12h)
        const recentPilotHistory = history.filter(h => h.timestamp.getTime() > new Date().getTime() - 12 * 60 * 60 * 1000)
        const pilotMap: Record<string, { name: string, count: number }> = {}
        recentPilotHistory.forEach(h => {
            if (!pilotMap[h.accountId]) pilotMap[h.accountId] = { name: h.accountName || 'Unknown', count: 0 }
            pilotMap[h.accountId].count++
        })
        const topPilot = Object.values(pilotMap).sort((a, b) => b.count - a.count)[0] || null

        // 22. The Loop (Most rewatched title)
        const theLoop = Object.values(contentStats).sort((a, b) => b.count - a.count)[0] || null

        // 11. Activity Timeframes - REMOVED per user request

        return {
            totalItems: history.length,
            totalHours: Math.floor(totalDurationMinutes / 60),
            leaderboard,
            bingeMasters,
            streakMasters,
            topTrending,
            topAllTime,
            funnel: { started: startedCount, engaged: engagedCount, finished: finishedCount },
            typeCounts,
            abandonedSeries,
            abandonedMovies,
            itemsByHour,
            maxActivityHour: Math.max(...itemsByHour),
            peakHour,
            longestMovie,
            awards: { midnightSnackers, weekendWarriors, completionChampions },
            sharedUniverse,
            contentVelocity,
            seriesLoyalty,
            userPersonas,
            userTraits, // Replaces Soulmates
            franchiseFocus,
            rareFinds,
            streakMap: streakMapData,
            syncStatus: (new Date().getTime() - (history[0]?.timestamp.getTime() || 0)) < 3600000 ? 'Healthy' : 'Syncing',
            homeMood: history.filter(h => h.timestamp.getTime() > new Date().getTime() - 4 * 60 * 60 * 1000).length > 5 ? 'High Energy' : 'Chill',
            topPilot,
            theLoop
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
                <div className="flex items-center justify-between mb-8 px-4 gap-4">
                    <div className="overflow-x-auto scrollbar-hide">
                        <TabsList className="flex whitespace-nowrap">
                            <TabsTrigger value="pulse" className="shrink-0">Pulse</TabsTrigger>
                            <TabsTrigger value="community" className="shrink-0">Community ({stats.leaderboard.length})</TabsTrigger>
                            <TabsTrigger value="personality" className="shrink-0">Personality</TabsTrigger>
                            <TabsTrigger value="vault" className="shrink-0">Vault ({stats.topAllTime.length})</TabsTrigger>
                            <TabsTrigger value="deep-dive" className="shrink-0">Deep Dive</TabsTrigger>
                        </TabsList>
                    </div>
                </div>

                {/* TAB 1: PULSE (Overview) */}
                <TabsContent value="pulse" className="space-y-12">



                    {/* KEY METRICS GRID */}
                    <div className="px-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <Card className="bg-indigo-500/5 border-indigo-500/10">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 bg-indigo-500/10 rounded-xl">
                                        <Activity className="h-6 w-6 text-indigo-500" />
                                    </div>
                                    <div>
                                        <div className="text-2xl font-black">{stats.totalItems}</div>
                                        <div className="text-[10px] uppercase font-black tracking-tighter text-muted-foreground">Total Plays</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-orange-500/5 border-orange-500/10">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 bg-orange-500/10 rounded-xl">
                                        <Zap className="h-6 w-6 text-orange-500" />
                                    </div>
                                    <div>
                                        <div className="text-2xl font-black">{stats.bingeMasters[0]?.bingeDuration || 0}</div>
                                        <div className="text-[10px] uppercase font-black tracking-tighter text-muted-foreground">Max Binge Session</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-emerald-500/5 border-emerald-500/10">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 bg-emerald-500/10 rounded-xl">
                                        <Clock className="h-6 w-6 text-emerald-500" />
                                    </div>
                                    <div>
                                        <div className="text-2xl font-black">{stats.totalHours}</div>
                                        <div className="text-[10px] uppercase font-black tracking-tighter text-muted-foreground">Hours Watched</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-pink-500/5 border-pink-500/10">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 bg-pink-500/10 rounded-xl">
                                        <Users className="h-6 w-6 text-pink-500" />
                                    </div>
                                    <div>
                                        <div className="text-2xl font-black">{stats.leaderboard.length}</div>
                                        <div className="text-[10px] uppercase font-black tracking-tighter text-muted-foreground">Active Profiles</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
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
                            {stats.topTrending.length > 0 ? (
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
                            ) : (
                                <div className="flex items-center justify-center py-12 text-center">
                                    <div className="opacity-50">
                                        <Flame className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                                        <p className="text-sm font-medium text-muted-foreground">No trending activity in the last 48 hours</p>
                                        <p className="text-xs text-muted-foreground/60 mt-1">Start watching to populate this section</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* BINGE MASTERY HIGHLIGHT */}
                    <div className="px-4">
                        <Card className="bg-gradient-to-r from-orange-500/10 to-transparent border-orange-500/20">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-orange-500">
                                    <Flame className="h-5 w-5 animate-pulse" /> Binge Mastery
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col md:flex-row items-center gap-8">
                                <div className="text-center md:text-left flex-1">
                                    <div className="text-4xl font-black">{stats.bingeMasters[0]?.bingeDuration || 0}</div>
                                    <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Titles in one session</div>
                                    <p className="text-sm mt-3 opacity-70">
                                        <span className="font-bold text-orange-500">{stats.bingeMasters[0]?.name}</span> is currently holding the crown for the most intense watch session.
                                    </p>
                                </div>
                                <div className="flex -space-x-4">
                                    {stats.bingeMasters[0]?.bingeItems.slice(0, 5).map((item, i) => (
                                        <a key={item.id} href={`stremio:///detail/${item.type}/${item.itemId}`} className="relative w-16 h-24 rounded-lg border-2 border-background overflow-hidden shadow-lg transition-transform hover:-translate-y-2" style={{ zIndex: 5 - i }}>
                                            <img src={item.poster} className="w-full h-full object-cover" />
                                        </a>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

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
                                <Card
                                    key={user.name}
                                    className={cn(
                                        "overflow-hidden group hover:border-primary/40 transition-all duration-500",
                                        user.rank === 1 ? "border-yellow-500/50 bg-yellow-500/5 shadow-[0_0_30px_rgba(234,179,8,0.1)]" : ""
                                    )}
                                >
                                    <CardContent className="p-8">
                                        <div className="flex flex-col gap-6">
                                            <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                                                <div className="flex items-center gap-6">
                                                    <div className={cn(
                                                        "text-5xl font-black transition-colors duration-500",
                                                        user.rank === 1 ? "text-yellow-500" : "text-muted-foreground/30"
                                                    )}>#{user.rank}</div>
                                                    <Avatar className={cn(
                                                        "h-20 w-20 border-4 border-background shadow-2xl transition-transform group-hover:scale-110 duration-500",
                                                        user.rank === 1 ? "border-yellow-500" : ""
                                                    )}>
                                                        <AvatarFallback className={cn(
                                                            "font-black text-3xl",
                                                            user.rank === 1 ? "bg-yellow-500 text-black" : ""
                                                        )}>{user.avatarChar}</AvatarFallback>
                                                    </Avatar>
                                                    <div>
                                                        <div className="flex items-center gap-3">
                                                            <div className="font-black text-3xl tracking-tight">{user.name}</div>
                                                            {user.rank === 1 && <Crown className="h-6 w-6 text-yellow-500 animate-bounce" />}
                                                        </div>
                                                        <div className="text-xs font-bold text-muted-foreground uppercase flex flex-wrap gap-4 mt-1">
                                                            <span className="flex items-center gap-1.5"><PlayCircle className="h-3.5 w-3.5 text-primary" /> {user.count} Plays</span>
                                                            <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-indigo-400" /> {Math.round(user.duration / 60)} Hours</span>
                                                            {user.bestStreak > 3 && (
                                                                <span className="flex items-center gap-1.5 text-orange-500">
                                                                    <Flame className="h-3.5 w-3.5" /> {user.bestStreak} Day Streak
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-3">
                                                    {stats.bingeMasters[0]?.id === user.id && (
                                                        <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/20 px-3 py-1 font-black italic">
                                                            BINGE KING
                                                        </Badge>
                                                    )}
                                                    {user.currentStreak > 0 && (
                                                        <Badge className="bg-emerald-500 text-white hover:bg-emerald-600 font-bold px-3 py-1 animate-pulse">
                                                            ON FIRE
                                                        </Badge>
                                                    )}
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

                </TabsContent>

                {/* TAB 3: DEEP DIVE (Pro Stats) */}
                <TabsContent value="deep-dive" className="space-y-8 px-4">
                    <div className="grid md:grid-cols-2 gap-6">
                        {/* THE ENDURANCE TEST (Rebranded Funnel) */}
                        <Card className="bg-muted/10 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-emerald-500">
                                    <Trophy className="h-5 w-5" /> The Endurance Test
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-8">
                                <div className="space-y-8">
                                    {[
                                        { label: 'Initiated', count: stats.funnel.started, width: '100%', opacity: 0.3 },
                                        { label: 'Engaged', count: stats.funnel.engaged, width: '70%', opacity: 0.6 },
                                        { label: 'Completed', count: stats.funnel.finished, width: '40%', opacity: 1 }
                                    ].map((step, i) => (
                                        <div key={i} className="flex flex-col items-center gap-2">
                                            <div className="h-10 bg-emerald-500 rounded-lg shadow-lg" style={{ width: step.width, opacity: step.opacity }} />
                                            <div className="text-[10px] font-black uppercase text-muted-foreground">{step.label}: {step.count}</div>
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-8 pt-8 border-t border-border/40 text-center">
                                    <div className="text-4xl font-black text-emerald-500">
                                        {stats.funnel.started > 0 ? Math.round((stats.funnel.finished / stats.funnel.started) * 100) : 0}%
                                    </div>
                                    <div className="text-[10px] font-black text-muted-foreground uppercase tracking-widest mt-1">Loyalty Quotient</div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* THE LOOP (Most Rewatched) */}
                        <Card className="bg-muted/10 border-border/60 overflow-hidden">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2 text-indigo-500">
                                    <Activity className="h-5 w-5" /> The Loop
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                {stats.theLoop ? (
                                    <div className="flex gap-6">
                                        <a href={`stremio:///detail/${stats.theLoop.item.type}/${stats.theLoop.item.itemId}`} className="shrink-0 group">
                                            <img src={stats.theLoop.item.poster} className="h-40 w-28 object-cover rounded-xl shadow-2xl transition-transform group-hover:scale-105" />
                                        </a>
                                        <div className="flex-1 py-2">
                                            <div className="text-xl font-black line-clamp-2">{stats.theLoop.item.name}</div>
                                            <div className="mt-4 space-y-3">
                                                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                                    <span>Replays</span>
                                                    <span className="text-indigo-400">{stats.theLoop.count} Hits</span>
                                                </div>
                                                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                                    <div className="h-full bg-indigo-500" style={{ width: '100%' }} />
                                                </div>
                                                <p className="text-[10px] text-muted-foreground font-medium leading-relaxed italic">
                                                    The content you just can't quit.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="h-40 flex items-center justify-center text-muted-foreground italic">No data yet.</div>
                                )}
                            </CardContent>
                        </Card>

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
                                    <span>12 PM</span>
                                    <span>11 PM</span>
                                </div>
                            </CardContent>
                        </Card>

                        {/* SERIES LOYALTY (New) */}
                        <Card className="bg-blue-500/5 border-blue-500/10">
                            <CardHeader>
                                <CardTitle className="text-sm font-black uppercase tracking-widest text-blue-400 flex items-center gap-2">
                                    <Trophy className="h-4 w-4" /> Series Loyalty
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-4xl font-black text-blue-500">{Math.round(stats.seriesLoyalty)}%</div>
                                <p className="text-[10px] text-muted-foreground mt-2 font-bold uppercase leading-tight">
                                    Frequency shared by top 5 series.
                                </p>
                                <div className="mt-4 h-1.5 bg-muted rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500" style={{ width: `${stats.seriesLoyalty}%` }} />
                                </div>
                            </CardContent>
                        </Card>

                        {/* STREAK MAP (GitHub Style) */}
                        <Card className="bg-emerald-500/5 border-emerald-500/10">
                            <CardHeader>
                                <CardTitle className="text-sm font-black uppercase tracking-widest text-emerald-500 flex items-center gap-2">
                                    <Activity className="h-4 w-4" /> Activity Heatmap
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-wrap gap-1.5 justify-center">
                                    {stats.streakMap.map((count, i) => {
                                        let color = 'bg-muted/20'
                                        if (count > 0 && count <= 2) color = 'bg-emerald-500/20'
                                        else if (count > 2 && count <= 5) color = 'bg-emerald-500/40'
                                        else if (count > 5 && count <= 10) color = 'bg-emerald-500/60'
                                        else if (count > 10) color = 'bg-emerald-500'

                                        return (
                                            <div
                                                key={i}
                                                className={`w-4 h-4 rounded-sm ${color} transition-all hover:scale-125 cursor-default group relative`}
                                            >
                                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-black text-[10px] text-white rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-20 pointer-events-none font-bold">
                                                    {count} Plays {29 - i === 0 ? 'Today' : `${29 - i}d ago`}
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* CONTENT VELOCITY (BINGE SPEED) */}
                    <div className="space-y-6 pt-8 border-t border-border/50">
                        <div className="flex items-center gap-3">
                            <Zap className="h-6 w-6 text-orange-500" />
                            <h2 className="text-2xl font-black">Content Velocity</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {stats.contentVelocity.map((v, i) => (
                                <a key={i} href={`stremio:///detail/${v.item.type}/${v.item.itemId}`} className="block group">
                                    <Card className="bg-orange-500/5 border-orange-500/10 group-hover:border-orange-500/30 transition-colors">
                                        <CardContent className="p-4 flex items-center gap-4">
                                            <img src={v.item.poster} className="h-20 w-14 object-cover rounded shadow" />
                                            <div className="flex-1 min-w-0">
                                                <div className="font-bold truncate text-sm">{v.item.name}</div>
                                                <div className="text-[10px] text-muted-foreground font-bold uppercase mt-1">
                                                    {v.episodes} EPs in {v.days} days
                                                </div>
                                                <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full bg-orange-500"
                                                        style={{ width: `${Math.min(100, v.velocity * 20)}%` }}
                                                    />
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-lg font-black text-orange-500">{v.velocity.toFixed(1)}</div>
                                                <div className="text-[8px] font-black text-muted-foreground uppercase">Ep/Day</div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </a>
                            ))}
                        </div>
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


                    {/* SHARED UNIVERSE (ACCOUNT OVERLAP) */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Users className="h-6 w-6 text-pink-500" />
                            <h2 className="text-2xl font-black">Shared Universe</h2>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                            {stats.sharedUniverse.map((c, i) => (
                                <a
                                    key={i}
                                    href={`stremio:///detail/${c.item.type}/${c.item.itemId}`}
                                    className="relative aspect-[2/3] group cursor-pointer overflow-hidden rounded-xl"
                                >
                                    <div className="absolute top-2 left-2 z-20 bg-pink-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded shadow-lg uppercase tracking-widest">
                                        Shared
                                    </div>
                                    <img src={c.item.poster} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                                    <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 to-transparent">
                                        <div className="text-[10px] font-black text-pink-400 uppercase">{c.accounts.size} Accounts</div>
                                        <div className="text-xs font-bold text-white truncate">{c.item.name}</div>
                                    </div>
                                </a>
                            ))}
                        </div>
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


                {/* TAB 6: PERSONALITY (Watch DNA) */}
                <TabsContent value="personality" className="space-y-12 px-4 pb-20">

                    {/* Watch Personas */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Trophy className="h-6 w-6 text-yellow-500" />
                            <h2 className="text-2xl font-black">Watch Personas</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {stats.userPersonas.map((u) => (
                                <Card key={u.id} className="bg-muted/5 border-border/40">
                                    <CardContent className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center font-black text-indigo-500">
                                                {u.name[0]}
                                            </div>
                                            <div>
                                                <div className="font-bold text-sm">{u.name}</div>
                                                <div className="flex gap-1 mt-1">
                                                    {u.badges.map((b, bi) => (
                                                        <Badge key={bi} variant="outline" className={`text-[8px] uppercase font-black bg-${b.color}-500/10 text-${b.color}-500 border-${b.color}-500/20 py-0`}>
                                                            {b.type}
                                                        </Badge>
                                                    ))}
                                                    {u.badges.length === 0 && <span className="text-[10px] text-muted-foreground italic">Finding persona...</span>}
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>



                    {/* User Traits Grid */}
                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Zap className="h-6 w-6 text-orange-500" />
                            <h2 className="text-2xl font-black">Habit Profiles</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {stats.userTraits.map(u => (
                                <Card key={u.id} className="bg-muted/10 border-border/50">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-lg flex items-center gap-2">
                                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-black">
                                                {u.name[0]}
                                            </div>
                                            {u.name}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-4">
                                        {/* Chronotype */}
                                        <div className="flex items-center justify-between p-3 bg-background/50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-2 rounded-full bg-${u.chronotype.color}-500/10`}>
                                                    <u.chronotype.icon className={`h-4 w-4 text-${u.chronotype.color}-500`} />
                                                </div>
                                                <div>
                                                    <div className="text-xs font-bold text-muted-foreground uppercase">Chronotype</div>
                                                    <div className="font-bold text-sm">{u.chronotype.label}</div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Format Loyalty */}
                                        <div className="flex items-center justify-between p-3 bg-background/50 rounded-lg">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-2 rounded-full bg-${u.formatLoyalty.color}-500/10`}>
                                                    <u.formatLoyalty.icon className={`h-4 w-4 text-${u.formatLoyalty.color}-500`} />
                                                </div>
                                                <div>
                                                    <div className="text-xs font-bold text-muted-foreground uppercase">Format</div>
                                                    <div className="font-bold text-sm">{u.formatLoyalty.label}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>

                        {/* Franchise Spotlight */}
                        <div className="space-y-4 mt-12">
                            <div className="flex items-center gap-3">
                                <PieChart className="h-6 w-6 text-indigo-500" />
                                <h2 className="text-2xl font-black">Franchise Focus</h2>
                            </div>
                            <div className="space-y-3">
                                {stats.franchiseFocus.map((f, i) => (
                                    <div key={i} className="space-y-1">
                                        <div className="flex justify-between text-[10px] font-black uppercase tracking-widest px-1">
                                            <span className="text-muted-foreground">{f.name}</span>
                                            <span className="text-indigo-400">{f.count} Plays</span>
                                        </div>
                                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-indigo-500 transition-all duration-1000"
                                                style={{ width: `${Math.min(100, (f.count / stats.totalItems) * 500)}%` }}
                                            />
                                        </div>
                                    </div>
                                ))}
                                {stats.franchiseFocus.length === 0 && (
                                    <div className="text-xs text-muted-foreground italic p-4 bg-muted/20 rounded-lg text-center font-bold">
                                        No major franchises detected in your history.
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* RARE FINDS */}
                        <div className="space-y-6 md:col-span-2 mt-8">
                            <div className="flex items-center gap-3">
                                <Crown className="h-6 w-6 text-indigo-400" />
                                <h2 className="text-2xl font-black">Hidden Gems (Rare Finds)</h2>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                {stats.rareFinds.map((item: any) => (
                                    <a
                                        key={item.itemId}
                                        href={`stremio:///detail/${item.type}/${item.itemId}`}
                                        className="group relative w-32 aspect-[2/3] rounded-xl overflow-hidden shadow-xl transition-transform hover:-translate-y-2"
                                    >
                                        <img src={item.poster} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
                                        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                            <div className="text-[8px] font-black text-white uppercase">{item.accountName}'s Choice</div>
                                        </div>
                                        <div className="absolute top-2 right-2 bg-indigo-500 text-[8px] font-black text-white px-2 py-0.5 rounded-full shadow-lg border border-white/20">
                                            Rare
                                        </div>
                                    </a>
                                ))}
                                {stats.rareFinds.length === 0 && (
                                    <div className="text-sm italic text-muted-foreground p-8 bg-muted/10 rounded-xl w-full text-center border-2 border-dashed border-border">
                                        You all watch the same things! No rare finds yet.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </TabsContent>
            </Tabs >
        </div >
    )
}
