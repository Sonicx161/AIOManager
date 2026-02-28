import { ActivityItem } from '@/types/activity'
import { ReplayData, RankedTitle, GenreStat, MonthStat, Milestone, HourlyDistribution, DailyDistribution, YearOverYearDelta } from '@/types/ReplayTypes'
import { format } from 'date-fns'

const GENRE_COLORS: Record<string, string> = {
    'Action': '#ef4444', // Red
    'Adventure': '#f97316', // Orange
    'Animation': '#eab308', // Yellow
    'Comedy': '#22c55e', // Green
    'Crime': '#06b6d4', // Cyan
    'Documentary': '#3b82f6', // Blue
    'Drama': '#8b5cf6', // Violet
    'Family': '#a855f7', // Purple
    'Fantasy': '#d946ef', // Pink
    'History': '#8b5cf6', // Violet
    'Horror': '#ef4444', // Red
    'Music': '#ec4899', // Pink
    'Mystery': '#8b5cf6', // Violet
    'Romance': '#f43f5e', // Rose
    'Science Fiction': '#06b6d4', // Cyan
    'TV Movie': '#94a3b8', // Slate
    'Thriller': '#ef4444', // Red
    'War': '#451a03', // Brown
    'Western': '#d97706' // Amber
}

export function computeReplayData(history: ActivityItem[], targetYear: number | string): ReplayData {
    // Determine if target is a specific month (e.g. "2026-02")
    const isSpecificMonth = typeof targetYear === 'string' && targetYear !== 'all-time' && targetYear.includes('-');

    // 1. Filter history by time window
    const filteredHistory = targetYear === 'all-time'
        ? history
        : isSpecificMonth
            ? history.filter(item => format(new Date(item.timestamp), 'yyyy-MM') === targetYear)
            : history.filter(item => new Date(item.timestamp).getFullYear() === targetYear)

    const historyBeforeTarget = targetYear === 'all-time'
        ? []
        : isSpecificMonth
            ? history.filter(item => {
                const [dy, dm] = (targetYear as string).split('-').map(Number)
                return new Date(item.timestamp) < new Date(dy, dm - 1, 1)
            })
            : history.filter(item => new Date(item.timestamp).getFullYear() < (targetYear as number))

    // Data Structures for Aggregation
    const titleMap = new Map<string, {
        item: ActivityItem,
        count: number,
        totalHours: number,
        years: Set<number>
    }>()

    const genreMap = new Map<string, number>()
    const monthMap = new Map<string, {
        titles: Set<string>,
        hours: number,
        titleCounts: Map<string, { item: ActivityItem, count: number }>
    }>()

    // Aggregation Logic
    filteredHistory.forEach(item => {
        // Format aggregation removed from genreMap as requested.
        // ActivityItem doesn't carry full Cinemeta genres yet, so genreMap will be empty
        // unless actual genres are provided in a future update.

        // Time calculations - prioritize precise timeWatched/overallTimeWatched, fallback to duration * progress
        const timeWatchedMs = item.overallTimeWatched && item.overallTimeWatched > 0
            ? item.overallTimeWatched
            : (item.duration && item.progress) ? item.duration * (item.progress / 100) : item.duration || 3600000;

        const hours = timeWatchedMs / 3600000;

        // Title aggregation
        const uniqueId = item.itemId; // Restore uniqueId extraction
        const current = titleMap.get(uniqueId) || {
            item,
            count: 0,
            totalHours: 0,
            years: new Set()
        }
        current.count++
        current.totalHours += hours
        current.years.add(new Date(item.timestamp).getFullYear())
        titleMap.set(uniqueId, current)

        // Monthly aggregation
        const mKey = format(new Date(item.timestamp), 'yyyy-MM')
        const mData = monthMap.get(mKey) || { titles: new Set(), hours: 0, titleCounts: new Map() }
        mData.titles.add(uniqueId)
        mData.hours += hours

        const mTitleData = mData.titleCounts.get(uniqueId) || { item, count: 0 }
        mTitleData.count++
        mData.titleCounts.set(uniqueId, mTitleData)

        monthMap.set(mKey, mData)
    })

    // Rank Titles
    const rankedTitles: RankedTitle[] = Array.from(titleMap.entries())
        .map(([_, data]) => ({
            id: data.item.id,
            itemId: data.item.itemId,
            uniqueItemId: data.item.uniqueItemId,
            name: data.item.name,
            type: data.item.type,
            poster: data.item.poster,
            watchCount: data.count,
            totalHours: data.totalHours,
            rank: 0 // Will set after sorting
        }))
        .sort((a, b) => b.watchCount - a.watchCount || b.totalHours - a.totalHours)
        .map((t, i) => ({ ...t, rank: i + 1 }))

    // Top Genres
    const totalItems = filteredHistory.length
    const topGenres: GenreStat[] = Array.from(genreMap.entries())
        .map(([genre, count]) => ({
            genre,
            count,
            percentage: Math.round((count / totalItems) * 100),
            color: GENRE_COLORS[genre] || '#6366f1'
        }))
        .sort((a, b) => b.count - a.count)

    // Monthly Breakdown
    const months: MonthStat[] = []
    if (targetYear !== 'all-time' && !isSpecificMonth) {
        for (let m = 0; m < 12; m++) {
            const mKey = `${targetYear}-${String(m + 1).padStart(2, '0')}`
            const mData = monthMap.get(mKey)
            const d = new Date(targetYear as number, m, 1)

            // Find top titles for THIS month using the precomputed Map instead of O(n^2) loop
            let monthlyTitles: any[] = []
            if (mData) {
                monthlyTitles = Array.from(mData.titleCounts.entries())
                    .map(([_, tData]) => ({
                        id: tData.item.id,
                        itemId: tData.item.itemId,
                        uniqueItemId: tData.item.uniqueItemId,
                        name: tData.item.name,
                        type: tData.item.type,
                        poster: tData.item.poster,
                        watchCount: tData.count,
                        totalHours: 0,
                        rank: 0
                    }))
                    .sort((a, b) => b.watchCount - a.watchCount)
                    .slice(0, 3)
            }

            months.push({
                month: format(d, 'MMMM'),
                monthKey: mKey,
                totalTitles: mData?.titles.size || 0,
                totalHours: mData?.hours || 0,
                isHighActivity: false,
                topTitle: monthlyTitles[0],
                top3Titles: monthlyTitles
            })
        }
        const maxHours = Math.max(...months.map(m => m.totalHours))
        months.forEach(m => {
            if (maxHours > 0 && m.totalHours >= maxHours * 0.8) m.isHighActivity = true
        })
    }

    // Special Categories
    const beforeTargetIds = new Set(historyBeforeTarget.map(item => item.itemId))

    // Discoveries: New items first seen in this period
    const discoveries = rankedTitles.filter(t => !beforeTargetIds.has(t.itemId)).slice(0, 10)

    // Marathon: The titles you sank the most hours into — sorted by total hours
    const marathonTitles = [...rankedTitles]
        .sort((a, b) => b.totalHours - a.totalHours)
        .slice(0, 10)

    // Hidden Gems: Strong titles ranked outside your top 3 that still pulled serious hours
    const hiddenGems = rankedTitles
        .filter(t => t.rank > 3)
        .sort((a, b) => b.totalHours - a.totalHours)
        .slice(0, 10)

    // Binge Streaks (Consecutive Days)
    const activeDates = Array.from(new Set(filteredHistory.map(item => format(new Date(item.timestamp), 'yyyy-MM-dd')))).sort()
    let longestStreak = 0
    let currentStreak = 0
    let lastDateObj: Date | null = null

    activeDates.forEach(dateStr => {
        const currentDate = new Date(dateStr)
        if (!lastDateObj) {
            currentStreak = 1
        } else {
            // Calculate absolute difference in days
            const diffTime = Math.abs(currentDate.getTime() - lastDateObj.getTime())
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

            if (diffDays === 1) {
                currentStreak++
            } else if (diffDays > 1) {
                currentStreak = 1
            }
        }
        longestStreak = Math.max(longestStreak, currentStreak)
        lastDateObj = currentDate
    })

    // Hero Mosaic
    const heroPosterArt = rankedTitles.slice(0, 48).map(t => t.poster)

    // Calculate Persona
    const calculatePersona = () => {
        const totalHours = Math.round(Array.from(titleMap.values()).reduce((sum, d) => sum + d.totalHours, 0))
        const nightOwlHours = filteredHistory.filter(h => {
            const hour = new Date(h.timestamp).getHours()
            return hour >= 0 && hour <= 5
        }).length

        const weekendHours = filteredHistory.filter(h => {
            const day = new Date(h.timestamp).getDay()
            return day === 0 || day === 6
        }).length

        if (nightOwlHours > filteredHistory.length * 0.3) {
            return {
                name: 'The Night Owl',
                description: 'Your best streaming starts when the rest of the world is asleep.'
            }
        }
        if (longestStreak > 20) {
            return {
                name: 'The Binger',
                description: 'Once you start, there is no stopping. You live for the "Next Episode" button.'
            }
        }
        if (discoveries.length > 50) {
            return {
                name: 'The Explorer',
                description: 'Always on the hunt for something new. Your curiosity knows no bounds.'
            }
        }
        if (weekendHours > filteredHistory.length * 0.4) {
            return {
                name: 'Weekend Warrior',
                description: 'You save your cinematic adventures for the ultimate weekend escape.'
            }
        }
        if (totalHours > 500) {
            return {
                name: 'The Cinephile',
                description: 'Entertainment is your second language. Your dedication is legendary.'
            }
        }
        return {
            name: 'The Casual',
            description: 'You enjoy the best of both worlds, balancing variety with quality time.'
        }
    }

    const persona = calculatePersona()

    // ═════════════════════════════════════════════════════════════════
    //  NEW FEATURES: Milestones, Hourly, Daily, YoY, Discovery Stats
    // ═════════════════════════════════════════════════════════════════

    const totalHoursComputed = Math.round(Array.from(titleMap.values()).reduce((sum, d) => sum + d.totalHours, 0))

    // ── Milestones & Achievements ──
    const milestones: Milestone[] = [
        { id: 'titles-50', icon: '🎬', title: 'Cineplex Pass', description: 'Watched 50 unique titles', value: titleMap.size, threshold: 50, unlocked: titleMap.size >= 50 },
        { id: 'titles-100', icon: '🏅', title: 'Century Club', description: 'Watched 100 unique titles', value: titleMap.size, threshold: 100, unlocked: titleMap.size >= 100 },
        { id: 'titles-250', icon: '🏆', title: 'Quarter Thousand', description: 'Watched 250 unique titles', value: titleMap.size, threshold: 250, unlocked: titleMap.size >= 250 },
        { id: 'titles-500', icon: '👑', title: 'Half Millennium', description: 'Watched 500 unique titles', value: titleMap.size, threshold: 500, unlocked: titleMap.size >= 500 },
        { id: 'hours-100', icon: '⏱️', title: 'Centurion', description: 'Streamed 100+ hours', value: totalHoursComputed, threshold: 100, unlocked: totalHoursComputed >= 100 },
        { id: 'hours-500', icon: '🔥', title: 'Dedicated Viewer', description: 'Streamed 500+ hours', value: totalHoursComputed, threshold: 500, unlocked: totalHoursComputed >= 500 },
        { id: 'hours-1000', icon: '💎', title: 'Legendary Status', description: 'Streamed 1,000+ hours', value: totalHoursComputed, threshold: 1000, unlocked: totalHoursComputed >= 1000 },
        { id: 'streak-7', icon: '📅', title: 'Week Warrior', description: 'Binge streak of 7+ days', value: longestStreak, threshold: 7, unlocked: longestStreak >= 7 },
        { id: 'streak-14', icon: '🎯', title: 'Fortnight Force', description: 'Binge streak of 14+ days', value: longestStreak, threshold: 14, unlocked: longestStreak >= 14 },
        { id: 'streak-30', icon: '⚡', title: 'Monthly Marathon', description: 'Binge streak of 30+ days', value: longestStreak, threshold: 30, unlocked: longestStreak >= 30 },
        // Genres milestone hidden until Cinemeta genre data is available in ActivityItem
        // { id: 'genres-5', icon: '🔍', title: 'Genre Explorer', description: 'Watched across 5+ categories', value: genreMap.size, threshold: 5, unlocked: genreMap.size >= 5 },
        { id: 'discoveries-25', icon: '🔍', title: 'Trailblazer', description: 'Discovered 25+ new titles', value: discoveries.length, threshold: 25, unlocked: discoveries.length >= 25 },
    ]

    // ── Hourly Distribution (Time-of-Day) ──
    const hourCounts = new Array(24).fill(0)
    filteredHistory.forEach(item => {
        const hour = new Date(item.timestamp).getHours()
        hourCounts[hour]++
    })
    const maxHourCount = Math.max(...hourCounts, 1)
    const hourlyDistribution: HourlyDistribution[] = hourCounts.map((count, hour) => ({
        hour,
        count,
        percentage: Math.round((count / maxHourCount) * 100)
    }))
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts))

    // ── Daily Distribution (Day-of-Week) ──
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dayCounts = new Array(7).fill(0)
    const dayHours = new Array(7).fill(0)
    filteredHistory.forEach(item => {
        const day = new Date(item.timestamp).getDay()
        dayCounts[day]++
        const timeWatchedMs = item.overallTimeWatched && item.overallTimeWatched > 0
            ? item.overallTimeWatched
            : (item.duration && item.progress) ? item.duration * (item.progress / 100) : item.duration || 3600000
        dayHours[day] += timeWatchedMs / 3600000
    })
    const maxDayHour = Math.max(...dayHours, 1)
    const dailyDistribution: DailyDistribution[] = dayCounts.map((count, day) => ({
        day,
        dayName: dayNames[day],
        count,
        hours: Math.round(dayHours[day] * 10) / 10,
        percentage: Math.round((dayHours[day] / maxDayHour) * 100)
    }))
    const peakDayIndex = dayHours.indexOf(Math.max(...dayHours))
    const peakDay = dayNames[peakDayIndex]

    // ── Year-over-Year Comparisons ──
    let yearOverYear: YearOverYearDelta | null = null
    if (typeof targetYear === 'number') {
        const prevYearNum = targetYear - 1
        const prevYearHistory = history.filter(item => new Date(item.timestamp).getFullYear() === prevYearNum)

        if (prevYearHistory.length > 0) {
            const prevTitles = new Set(prevYearHistory.map(i => i.itemId)).size
            const prevHours = Math.round(prevYearHistory.reduce((sum, item) => {
                const tw = item.overallTimeWatched && item.overallTimeWatched > 0
                    ? item.overallTimeWatched
                    : (item.duration && item.progress) ? item.duration * (item.progress / 100) : item.duration || 3600000
                return sum + tw / 3600000
            }, 0))
            const prevSeriesCount = new Set(prevYearHistory.filter(i => i.type === 'series').map(i => i.itemId)).size
            const prevLoyalty = prevTitles > 0 ? Math.round((prevSeriesCount / prevTitles) * 100) : 0

            const currentSeriesCount = Array.from(titleMap.values()).filter(t => t.item.type === 'series').length
            const currentLoyalty = titleMap.size > 0 ? Math.round((currentSeriesCount / titleMap.size) * 100) : 0

            // Previous year streak
            const prevDates = Array.from(new Set(prevYearHistory.map(i => format(new Date(i.timestamp), 'yyyy-MM-dd')))).sort()
            let prevStreak = 0, prevCurrentStreak = 0
            let prevLast: Date | null = null
            prevDates.forEach(ds => {
                const d = new Date(ds)
                if (!prevLast) { prevCurrentStreak = 1 }
                else {
                    const diff = Math.ceil(Math.abs(d.getTime() - prevLast.getTime()) / 86400000)
                    prevCurrentStreak = diff === 1 ? prevCurrentStreak + 1 : 1
                }
                prevStreak = Math.max(prevStreak, prevCurrentStreak)
                prevLast = d
            })

            const pctDelta = (current: number, prev: number) => prev === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - prev) / prev) * 100)

            yearOverYear = {
                prevYear: prevYearNum,
                currentYear: targetYear,
                titlesDelta: pctDelta(titleMap.size, prevTitles),
                hoursDelta: pctDelta(totalHoursComputed, prevHours),
                loyaltyDelta: currentLoyalty - prevLoyalty,
                streakDelta: longestStreak - prevStreak,
                prevTitles,
                prevHours,
                currentTitles: titleMap.size,
                currentHours: totalHoursComputed
            }
        }
    }

    // ── Discovery Stats ──
    const totalUniqueDiscoveries = discoveries.length
    const discoveryPercentage = titleMap.size > 0 ? Math.round((totalUniqueDiscoveries / titleMap.size) * 100) : 0

    return {
        year: targetYear,
        totalTitles: titleMap.size,
        totalHours: totalHoursComputed,
        totalGenres: genreMap.size,
        longestStreak,
        avgTitlesPerMonth: Math.round(titleMap.size / (isSpecificMonth ? 1 : Math.max(1, monthMap.size))),
        topTitles: rankedTitles,
        topGenres,
        monthlyBreakdown: months,
        discoveries,
        marathonTitles,
        hiddenGems,
        availableYears: Array.from(new Set(history.map(item => new Date(item.timestamp).getFullYear()))).sort((a, b) => b - a),
        availableMonths: Array.from(new Set(history.map(item => format(new Date(item.timestamp), 'yyyy-MM')))).sort((a, b) => b.localeCompare(a)),
        heroPosterArt,
        persona: persona.name,
        personaDescription: persona.description,
        // New features
        milestones,
        hourlyDistribution,
        dailyDistribution,
        yearOverYear,
        peakHour,
        peakDay,
        discoveryPercentage,
        totalUniqueDiscoveries
    }
}
