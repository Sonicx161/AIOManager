interface ActivityItem {
    id: string
    name: string
    type: string
    timestamp: Date
    duration: number
    watched: number
    overallTimeWatched?: number
    accountId: string
    accountName: string
    progress: number
    itemId: string
    poster: string
}
import { subHours, subDays } from 'date-fns'

// Minimal types for worker environment
interface MetricsResult {
    totalItems: number
    totalHours: number
    leaderboard: any[]
    bingeMasters: any[]
    streakMasters: any[]
    topTrending: ActivityItem[]
    topAllTime: any[]
    funnel: { started: number, engaged: number, finished: number }
    abandonedSeries: ActivityItem[]
    abandonedMovies: ActivityItem[]
    awards: { midnightSnackers: any[], weekendWarriors: any[], completionChampions: any[] }
    itemsByHour: number[]
    sharedUniverse: any[]
    contentVelocity: any[]
    typeCounts: { movie: number, series: number, other: number }
    seriesLoyalty: number
    userPersonas: any[]
    userTraits: any[]
    franchiseFocus: any[]
    rareFinds: any[]
    streakMap: number[]
    topPilot: any | null
    theLoop: any | null
    maxActivityHour: number
}

self.onmessage = (e: MessageEvent<{ items: ActivityItem[] }>) => {
    const { items } = e.data
    if (!items || items.length === 0) {
        self.postMessage(null)
        return
    }

    const now = new Date()

    let totalDurationMinutes = 0
    const itemsByHour = new Array(24).fill(0)
    const typeCounts = { movie: 0, series: 0, other: 0 }

    const userStats: Record<string, any> = {}
    const trendingItems: Record<string, { count: number, item: ActivityItem }> = {}
    const contentStats: Record<string, any> = {}
    const abandonedSeries: ActivityItem[] = []
    const abandonedMovies: ActivityItem[] = []

    const twoDaysAgo = subHours(now, 48)
    const thirtyDaysAgo = subDays(now, 30)

    const userAwardMap: Record<string, { midnightPlays: number, weekendPlays: number, totalStarts: number, totalFinishes: number }> = {}
    const franchises = [
        { name: 'Marvel', keywords: ['Marvel', 'Avengers', 'Iron Man', 'Spider-Man', 'Thor', 'Guardians', 'MCU'] },
        { name: 'Star Trek', keywords: ['Star Trek', 'Discovery', 'Picard', 'Strange New Worlds', 'Enterprise'] },
        { name: 'Star Wars', keywords: ['Star Wars', 'Mandalorian', 'Andor', 'Ahsoka', 'Skywalker', 'Boba Fett'] },
        { name: 'DC Universe', keywords: ['Batman', 'Superman', 'Justice League', 'The Flash', 'Wonder Woman', 'Joker'] },
        { name: 'Game of Thrones', keywords: ['Thrones', 'House of the Dragon', 'Westeros'] }
    ]
    const franchiseCounts: Record<string, number> = {}
    franchises.forEach(f => franchiseCounts[f.name] = 0)

    items.forEach((h: ActivityItem) => {
        const hTime = h.timestamp.getTime()
        const hDate = new Date(hTime)
        const hour = hDate.getHours()
        const day = hDate.getDay()

        // 1. Totals
        let minutes = 0

        // precise tracking: use overallTimeWatched if available (covers total series time from server)
        if (h.overallTimeWatched && h.overallTimeWatched > 0) {
            minutes = h.overallTimeWatched / 60000
        } else {
            // align with ActivityPage: use actual watched time, not full duration
            minutes = (h.watched || 0) / 60000
        }

        // Sanity Check: If play duration > 24 hours (for single items) or > 50,000 hours (for series totals)
        // 50,000h = ~5.7 years, which is a safe upper bound for valid watch time vs Unix timestamp junk (which is ~470k hours)
        const limit = (h.overallTimeWatched && h.overallTimeWatched > 0) ? 50000 * 60 : 24 * 60
        if (minutes > limit) {
            minutes = 0
        }

        totalDurationMinutes += minutes
        itemsByHour[hour]++

        // 2. Types
        if (h.type === 'movie') typeCounts.movie++
        else if (h.type === 'series' || h.type === 'episode') typeCounts.series++
        else typeCounts.other++

        // 3. Franchises
        franchises.forEach(f => {
            if (f.keywords.some(k => h.name.toLowerCase().includes(k.toLowerCase()))) {
                franchiseCounts[f.name]++
            }
        })

        // 4. User Stats & Awards
        if (!userStats[h.accountId]) {
            userStats[h.accountId] = {
                name: h.accountName || 'Unknown',
                count: 0,
                duration: 0,
                lastActive: h.timestamp,
                recentHistory: [],
                allDates: [],
                hourlyActivity: new Array(24).fill(0),
                formatCounts: { movie: 0, series: 0 }
            }
            userAwardMap[h.accountId] = { midnightPlays: 0, weekendPlays: 0, totalStarts: 0, totalFinishes: 0 }
        }

        const u = userStats[h.accountId]
        const m = userAwardMap[h.accountId]

        u.count++
        u.duration += minutes
        u.allDates.push(h.timestamp)
        if (h.timestamp > u.lastActive) u.lastActive = h.timestamp
        u.hourlyActivity[hour]++

        if (h.type === 'movie') u.formatCounts.movie++
        else if (h.type === 'series' || h.type === 'episode') u.formatCounts.series++

        if (u.recentHistory.length < 8 && !u.recentHistory.some((rh: any) => rh.itemId === h.itemId)) {
            u.recentHistory.push(h)
        }

        if (hour >= 0 && hour <= 5) m.midnightPlays++
        if (day === 0 || day === 6) m.weekendPlays++
        if (h.progress > 0) m.totalStarts++
        if (h.progress >= 90) m.totalFinishes++

        // 5. Trending (Last 48h)
        if (hTime > twoDaysAgo.getTime()) {
            if (!trendingItems[h.itemId]) trendingItems[h.itemId] = { count: 0, item: h }
            trendingItems[h.itemId].count++
        }

        // 6. Content Stats & Abandoned
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

        if (h.progress > 0 && h.progress < 15 && hTime < thirtyDaysAgo.getTime() && h.poster) {
            if (h.type === 'movie') abandonedMovies.push(h)
            else abandonedSeries.push(h)
        }
    })

    // Binge Logic
    const chronoHistory = [...items].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    const tempBingeTracker: Record<string, { currentChain: ActivityItem[], lastTime: Date }> = {}
    const userBinges: Record<string, { duration: number, items: ActivityItem[] }> = {}

    chronoHistory.forEach((h: ActivityItem) => {
        const uid = h.accountId
        if (!tempBingeTracker[uid]) {
            tempBingeTracker[uid] = { currentChain: [h], lastTime: h.timestamp }
        } else {
            const tracker = tempBingeTracker[uid]
            const diff = (h.timestamp.getTime() - tracker.lastTime.getTime()) / 60000
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
        if (!userBinges[uid] || tracker.currentChain.length > userBinges[uid].duration) {
            userBinges[uid] = { duration: tracker.currentChain.length, items: [...tracker.currentChain].reverse() }
        }
    })

    // Personas & Traits
    const userPersonas = Object.entries(userAwardMap).map(([id, data]) => {
        const completionRate = data.totalStarts > 0 ? (data.totalFinishes / data.totalStarts) * 100 : 0
        const bingeLen = userBinges[id]?.duration || 0
        const u = userStats[id]
        const badges = []
        if (completionRate > 80 && data.totalFinishes > 10) badges.push({ type: 'The Completer', icon: 'CheckCircle', color: 'emerald' })
        if (completionRate < 30 && data.totalStarts > 20) badges.push({ type: 'The Sampler', icon: 'Ghost', color: 'pink' })
        if (data.midnightPlays > data.totalStarts * 0.3) badges.push({ type: 'The Night Owl', icon: 'Moon', color: 'violet' })
        if (bingeLen > 8) badges.push({ type: 'Binge King', icon: 'Flame', color: 'orange' })
        if (data.weekendPlays > data.totalStarts * 0.6) badges.push({ type: 'Weekend Warrior', icon: 'Zap', color: 'yellow' })
        return { id, name: u.name, badges }
    })

    const userTraits = Object.entries(userStats).map(([id, u]) => {
        const morning = u.hourlyActivity.slice(5, 12).reduce((a: number, b: number) => a + b, 0)
        const afternoon = u.hourlyActivity.slice(12, 17).reduce((a: number, b: number) => a + b, 0)
        const evening = u.hourlyActivity.slice(17, 23).reduce((a: number, b: number) => a + b, 0)
        const night = u.hourlyActivity.slice(23, 24).reduce((a: number, b: number) => a + b, 0) + u.hourlyActivity.slice(0, 5).reduce((a: number, b: number) => a + b, 0)

        let chronotype = { label: 'Balanced Viewer', icon: 'Clock', color: 'gray' }
        const max = Math.max(morning, afternoon, evening, night)
        if (max > 0) {
            if (max === morning) chronotype = { label: 'Early Bird', icon: 'Sun', color: 'orange' }
            else if (max === afternoon) chronotype = { label: 'Day Dreamer', icon: 'Coffee', color: 'blue' }
            else if (max === evening) chronotype = { label: 'Prime Time Player', icon: 'Tv', color: 'violet' }
            else chronotype = { label: 'Night Owl', icon: 'Moon', color: 'purple' }
        }

        const total = u.formatCounts.movie + u.formatCounts.series
        let formatLoyalty = { label: 'The Hybrid', icon: 'LayoutGrid', color: 'emerald' }
        if (total > 0) {
            if (u.formatCounts.movie / total > 0.7) formatLoyalty = { label: 'The Cinephile', icon: 'Film', color: 'rose' }
            else if (u.formatCounts.series / total > 0.7) formatLoyalty = { label: 'Serial Binger', icon: 'Tv', color: 'cyan' }
        }
        return { id, name: u.name, chronotype, formatLoyalty }
    })

    // Streaks
    const streakStats = Object.keys(userStats).map(uid => {
        const u = userStats[uid]
        u.allDates.sort((a: Date, b: Date) => a.getTime() - b.getTime())
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
            const daysSinceLast = Math.floor((now.getTime() - u.lastActive.getTime()) / (1000 * 60 * 60 * 24))
            if (daysSinceLast <= 1) currentStreak = tempStreak
        }
        const binge = userBinges[uid] || { duration: 0, items: [] }
        const avatarChar = (u.name && u.name.length > 0) ? u.name[0].toUpperCase() : '?'
        return {
            id: uid, name: u.name, currentStreak, bestStreak,
            count: u.count, duration: u.duration, recentHistory: u.recentHistory,
            bingeDuration: binge.duration, bingeItems: binge.items,
            avatarChar
        }
    })

    // Final sorting & collections
    const leaderboard = [...streakStats].sort((a, b) => b.count - a.count).map((u, i) => ({ ...u, rank: i + 1 }))
    const bingeMasters = [...streakStats].sort((a, b) => b.bingeDuration - a.bingeDuration)
    const streakMasters = [...streakStats].sort((a, b) => b.bestStreak - a.bestStreak)
    const topTrending = Object.values(trendingItems).sort((a, b) => b.count - a.count).slice(0, 10).map(t => t.item)
    const topAllTime = Object.values(contentStats).sort((a, b) => b.count - a.count).slice(0, 20).map(c => ({
        count: c.count,
        item: c.item,
        shared: c.accounts.size > 1
    }))

    const sharedUniverse = Object.values(contentStats)
        .filter((cs: any) => cs.accounts.size > 1)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)

    const contentVelocity = Object.values(contentStats)
        .filter((cs: any) => cs.count > 3 && cs.item.type === 'series')
        .map((cs: any) => {
            const days = Math.max(1, Math.ceil((cs.lastSeen.getTime() - cs.firstSeen.getTime()) / (1000 * 60 * 60 * 24)))
            return { item: cs.item, days, episodes: cs.count, velocity: cs.count / days }
        })
        .sort((a, b) => b.velocity - a.velocity)
        .slice(0, 10)

    const streakMap = new Array(30).fill(0)
    items.forEach(h => {
        const diff = Math.floor((now.getTime() - h.timestamp.getTime()) / (1000 * 60 * 60 * 24))
        if (diff >= 0 && diff < 30) streakMap[29 - diff]++
    })

    const topPilot = leaderboard[0] || null
    const theLoop = topAllTime[0] || null

    const seriesItems = items.filter(h => h.type === 'series' || h.type === 'episode')
    const topSeriesContentCount = Object.values(contentStats)
        .filter((cs: any) => cs.item.type === 'series' || cs.item.type === 'episode')
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .reduce((sum, cs) => sum + cs.count, 0)
    const seriesLoyalty = seriesItems.length > 0 ? (topSeriesContentCount / seriesItems.length) * 100 : 0

    const result: MetricsResult = {
        totalItems: items.length,
        totalHours: Math.floor(totalDurationMinutes / 60),
        leaderboard,
        bingeMasters,
        streakMasters,
        topTrending,
        topAllTime,
        funnel: {
            started: Object.values(userAwardMap).reduce((a, b) => a + b.totalStarts, 0),
            engaged: items.filter(h => h.progress >= 50).length,
            finished: Object.values(userAwardMap).reduce((a, b) => a + b.totalFinishes, 0),
        },
        abandonedSeries,
        abandonedMovies,
        awards: {
            midnightSnackers: Object.entries(userAwardMap).map(([id, d]) => ({ id, name: userStats[id].name, count: d.midnightPlays })).filter(u => u.count > 0).sort((a, b) => b.count - a.count).slice(0, 5),
            weekendWarriors: Object.entries(userAwardMap).map(([id, d]) => ({ id, name: userStats[id].name, count: d.weekendPlays })).filter(u => u.count > 0).sort((a, b) => b.count - a.count).slice(0, 5),
            completionChampions: Object.entries(userAwardMap).map(([id, d]) => ({
                id, name: userStats[id].name,
                rate: d.totalStarts > 0 ? (d.totalFinishes / d.totalStarts) * 100 : 0,
                finishes: d.totalFinishes
            })).filter(u => u.finishes > 5).sort((a, b) => b.rate - a.rate).slice(0, 5)
        },
        itemsByHour,
        sharedUniverse,
        contentVelocity,
        typeCounts,
        seriesLoyalty,
        userPersonas,
        userTraits,
        franchiseFocus: Object.entries(franchiseCounts).map(([name, count]) => ({ name, count })).filter(f => f.count > 0).sort((a, b) => b.count - a.count),
        rareFinds: Object.values(contentStats)
            .filter((cs: any) => {
                if (cs.item.type !== 'movie' && cs.item.type !== 'series') return false
                // If multiple accounts, rare means only one person watched it
                if (Object.keys(userStats).length > 1) {
                    return cs.accounts.size === 1 && cs.count === 1
                }
                // If single account, rare means it's a one-off watch among many replays
                return cs.count === 1
            })
            .sort(() => Math.random() - 0.5) // Randomize slightly for discovery
            .slice(0, 10)
            .map(cs => ({ ...cs.item, accountName: userStats[Array.from(cs.accounts)[0] as string]?.name })),
        streakMap,
        topPilot,
        theLoop,
        maxActivityHour: Math.max(...itemsByHour)
    }

    self.postMessage(result)
}
