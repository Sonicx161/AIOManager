import { ActivityItem } from '@/types/activity'
import { ReplayData, RankedTitle, GenreStat, MonthStat, Milestone, HourlyDistribution, DailyDistribution, YearOverYearDelta } from '@/types/ReplayTypes'
import { getCinemetaPosterUrl } from '@/lib/cinemeta-utils'
import { cumulativeWatchKey } from '@/lib/activity-utils'
import { buildRuntimeIndex, computeWatchHours, hoursRowFromItem, msToHours, type RuntimeIndex } from '@/lib/watch-hours'
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

/**
 * Hours per row from the shared helper, so Replay agrees with Metrics and Activity. Credit is
 * computed over every row given, then `sumOver` totals just a period, so a year never re-seeds
 * a cumulative counter.
 */
function watchTimeByRow(items: ActivityItem[], runtimes: RuntimeIndex, canonical?: ReadonlyMap<string, string | undefined>) {
    const result = computeWatchHours(items.map(item => hoursRowFromItem(item, cumulativeWatchKey(item, canonical))), runtimes)
    const times = new Map<ActivityItem, number>()
    const estimates = new Map<ActivityItem, number>()
    items.forEach((item, index) => {
        times.set(item, result.rowMs[index])
        estimates.set(item, result.rowEstimatedMs[index])
    })
    const sumOver = (rows: ActivityItem[]) => {
        let totalMs = 0
        let estimatedMs = 0
        for (const row of rows) {
            totalMs += times.get(row) ?? 0
            estimatedMs += estimates.get(row) ?? 0
        }
        return { totalMs, estimatedMs }
    }
    return { times, sumOver }
}

const localDayKey = (timestamp: Date | string | number) => format(new Date(timestamp), 'yyyy-MM-dd')

function localDayNumber(key: string): number {
    const [y, m, d] = key.split('-').map(Number)
    return Math.round(new Date(y, m - 1, d).getTime() / 86400000)
}

function longestRun(dayKeys: string[]): number {
    let longest = 0
    let current = 0
    let last: number | null = null
    for (const key of dayKeys) {
        const day = localDayNumber(key)
        current = last !== null && day - last === 1 ? current + 1 : 1
        longest = Math.max(longest, current)
        last = day
    }
    return longest
}

export type ReplayDataWithEstimate = ReplayData & { estimatedHours: number }

export function computeReplayData(
    history: ActivityItem[],
    targetYear: number | string,
    options?: { canonicalConnections?: ReadonlyMap<string, string | undefined>; now?: Date }
): ReplayDataWithEstimate {
    const canonical = options?.canonicalConnections
    const isSpecificMonth = typeof targetYear === 'string' && targetYear !== 'all-time' && targetYear.includes('-');

    // Parsing each timestamp once per call removes repeated `new Date` allocations; output is unchanged.
    const parsedDates = new Map<ActivityItem, Date>()
    const toDate = (item: ActivityItem): Date => {
        let d = parsedDates.get(item)
        if (!d) {
            d = new Date(item.timestamp)
            parsedDates.set(item, d)
        }
        return d
    }

    const filteredHistory = targetYear === 'all-time'
        ? history
        : isSpecificMonth
            ? history.filter(item => format(toDate(item), 'yyyy-MM') === targetYear)
            : history.filter(item => toDate(item).getFullYear() === targetYear)

    const historyBeforeTarget = targetYear === 'all-time'
        ? []
        : isSpecificMonth
            ? (() => {
                const [dy, dm] = (targetYear as string).split('-').map(Number)
                const monthStart = new Date(dy, dm - 1, 1)
                return history.filter(item => toDate(item) < monthStart)
            })()
            : history.filter(item => toDate(item).getFullYear() < (targetYear as number))

    // Backfilled episodes (recovered from the watched-bitfield) have a synthetic timestamp, so they
    // count toward titles/episodes/discoveries but are excluded from every time-based stat (monthly
    // breakdown, streaks, hourly/daily distribution, busiest day, YoY hours).
    const timeHistory = filteredHistory.filter(item => !item.backfill)
    const runtimes = buildRuntimeIndex(history)
    const { times: timeByRow, sumOver } = watchTimeByRow(history, runtimes, canonical)
    const { totalMs: periodMs, estimatedMs: periodEstimatedMs } = sumOver(filteredHistory)

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

    filteredHistory.forEach(item => {
        const hours = (timeByRow.get(item) ?? 0) / 3600000

        const uniqueId = item.itemId;
        const current = titleMap.get(uniqueId) || {
            item,
            count: 0,
            totalHours: 0,
            years: new Set<number>()
        }

        current.count++
        current.totalHours += hours
        current.years.add(toDate(item).getFullYear())
        titleMap.set(uniqueId, current)

        if (item.genres) {
            for (const genre of item.genres) {
                genreMap.set(genre, (genreMap.get(genre) || 0) + 1)
            }
        }
    })

    timeHistory.forEach(item => {
        const hours = (timeByRow.get(item) ?? 0) / 3600000

        const uniqueId = item.itemId;
        const mKey = format(toDate(item), 'yyyy-MM')
        const mData = monthMap.get(mKey) || { titles: new Set(), hours: 0, titleCounts: new Map() }
        mData.titles.add(uniqueId)
        mData.hours += hours

        const mTitleData = mData.titleCounts.get(uniqueId) || { item, count: 0 }
        mTitleData.count++
        mData.titleCounts.set(uniqueId, mTitleData)

        monthMap.set(mKey, mData)
    })

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
            rank: 0
        }))
        .sort((a, b) => b.totalHours - a.totalHours || b.watchCount - a.watchCount)
        .map((t, i) => ({ ...t, rank: i + 1 }))

    const totalItems = filteredHistory.length
    const topGenres: GenreStat[] = Array.from(genreMap.entries())
        .map(([genre, count]) => ({
            genre,
            count,
            percentage: Math.round((count / totalItems) * 100),
            color: GENRE_COLORS[genre] || '#6366f1'
        }))
        .sort((a, b) => b.count - a.count)

    const months: MonthStat[] = []
    if (targetYear !== 'all-time' && !isSpecificMonth) {
        const now = options?.now ?? new Date()
        const lastMonth = Number(targetYear) === now.getFullYear() ? now.getMonth() + 1 : 12
        for (let m = 0; m < lastMonth; m++) {
            const mKey = `${targetYear}-${String(m + 1).padStart(2, '0')}`
            const mData = monthMap.get(mKey)
            const d = new Date(targetYear as number, m, 1)

            // Find top titles for THIS month using the precomputed Map instead of O(n^2) loop
            let monthlyTitles: RankedTitle[] = []
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

    const beforeTargetIds = new Set(historyBeforeTarget.map(item => item.itemId))

    // Discoveries: New items first seen in this period. Keep the full count separate from the
    // display slice -- persona/milestones/stats below need the true total, not the capped 10.
    const allDiscoveries = rankedTitles.filter(t => !beforeTargetIds.has(t.itemId))
    const discoveryCount = allDiscoveries.length
    const discoveries = allDiscoveries.slice(0, 10)

    const marathonTitles = [...rankedTitles]
        .sort((a, b) => b.totalHours - a.totalHours)
        .slice(0, 10)

    const hiddenGems = rankedTitles
        .filter(t => t.rank > 3)
        .sort((a, b) => b.totalHours - a.totalHours)
        .slice(0, 10)

    const longestStreak = longestRun(Array.from(new Set(timeHistory.map(item => localDayKey(toDate(item))))).sort())

    const heroPosterArt = rankedTitles.slice(0, 48).map(t => {
        const tt = t.itemId?.match(/tt\d+/i)?.[0]
        return tt ? getCinemetaPosterUrl(tt) : t.poster
    })

    const calculatePersona = () => {
        const totalHours = msToHours(periodMs)
        const nightOwlHours = timeHistory.filter(h => {
            const hour = toDate(h).getHours()
            return hour >= 0 && hour <= 5
        }).length

        const weekendHours = timeHistory.filter(h => {
            const day = toDate(h).getDay()
            return day === 0 || day === 6
        }).length

        if (nightOwlHours > timeHistory.length * 0.3) {
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
        if (discoveryCount > 50) {
            return {
                name: 'The Explorer',
                description: 'Always on the hunt for something new. Your curiosity knows no bounds.'
            }
        }
        if (weekendHours > timeHistory.length * 0.4) {
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

    const totalHoursComputed = msToHours(periodMs)

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
        { id: 'genres-5', icon: '🔍', title: 'Genre Explorer', description: 'Watched across 5+ categories', value: genreMap.size, threshold: 5, unlocked: genreMap.size >= 5 },
        { id: 'discoveries-25', icon: '🔍', title: 'Trailblazer', description: 'Discovered 25+ new titles', value: discoveryCount, threshold: 25, unlocked: discoveryCount >= 25 },
    ]

    const hourCounts = new Array(24).fill(0)
    timeHistory.forEach(item => {
        const hour = toDate(item).getHours()
        hourCounts[hour]++
    })
    const maxHourCount = Math.max(...hourCounts, 1)
    const hourlyDistribution: HourlyDistribution[] = hourCounts.map((count, hour) => ({
        hour,
        count,
        percentage: Math.round((count / maxHourCount) * 100)
    }))
    const peakHour = hourCounts.indexOf(Math.max(...hourCounts))

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dayCounts = new Array(7).fill(0)
    const dayHours = new Array(7).fill(0)
    timeHistory.forEach(item => {
        const day = toDate(item).getDay()
        dayCounts[day]++
        dayHours[day] += (timeByRow.get(item) ?? 0) / 3600000
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

    let yearOverYear: YearOverYearDelta | null = null
    if (typeof targetYear === 'number') {
        const prevYearNum = targetYear - 1
        const prevYearHistory = history.filter(item => toDate(item).getFullYear() === prevYearNum)

        if (prevYearHistory.length > 0) {
            const prevYearTimeHistory = prevYearHistory.filter(i => !i.backfill)
            const prevTitles = new Set(prevYearHistory.map(i => i.itemId)).size
            const prevHours = msToHours(sumOver(prevYearHistory).totalMs)
            const prevSeriesCount = new Set(prevYearHistory.filter(i => i.type === 'series').map(i => i.itemId)).size
            const prevLoyalty = prevTitles > 0 ? Math.round((prevSeriesCount / prevTitles) * 100) : 0

            const currentSeriesCount = Array.from(titleMap.values()).filter(t => t.item.type === 'series').length
            const currentLoyalty = titleMap.size > 0 ? Math.round((currentSeriesCount / titleMap.size) * 100) : 0

            const prevStreak = longestRun(Array.from(new Set(prevYearTimeHistory.map(i => localDayKey(toDate(i))))).sort())

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

    const totalUniqueDiscoveries = discoveryCount
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
        availableYears: Array.from(new Set(history.map(item => toDate(item).getFullYear()))).sort((a, b) => b - a),
        availableMonths: Array.from(new Set(history.map(item => format(toDate(item), 'yyyy-MM')))).sort((a, b) => b.localeCompare(a)),
        heroPosterArt,
        persona: persona.name,
        personaDescription: persona.description,
        milestones,
        hourlyDistribution,
        dailyDistribution,
        yearOverYear,
        peakHour,
        peakDay,
        discoveryPercentage,
        totalUniqueDiscoveries,
        estimatedHours: msToHours(periodEstimatedMs),
    }
}
