import { computeWatchHours, msToHours, type RuntimeIndex, type WatchHoursRow } from '@/lib/watch-hours'

// Mirrors MetricsWorkerItem in hooks/useMetricsWorker.ts.
interface ActivityItem {
    id: string
    name: string
    type: string
    timestamp: Date
    watched: number
    overallTimeWatched?: number
    accountId: string
    accountName: string
    progress: number
    duration?: number
    mediaServer?: boolean
    mediaPlayed?: boolean
    mediaPositionMs?: number
    itemId: string
    poster: string
    season?: number
    episode?: number
    /** Scope of the cumulative overallTimeWatched counter (account, platform, login, title). */
    counterKey?: string
    /** No real watch date (bitfield recovery / undated external import); excluded from time-based stats. */
    backfill?: boolean
    /** Imported saved watch state; same exclusion as backfill. */
    importedSavedState?: boolean
}
const subDays = (d: Date, n: number) => new Date(d.getTime() - n * 864e5)
const isSeriesType = (t: string) => t === 'series' || t === 'anime' || t === 'episode'
const BINGE_GAP_MINUTES = 90

// Keyword lists are constant, so they are lowercased once here instead of once per
// keyword per row on every message.
const franchises = [
    { name: 'Marvel', keywords: ['Marvel', 'Avengers', 'Iron Man', 'Spider-Man', 'Thor', 'Guardians', 'MCU'] },
    { name: 'Star Trek', keywords: ['Star Trek', 'Discovery', 'Picard', 'Strange New Worlds', 'Enterprise'] },
    { name: 'Star Wars', keywords: ['Star Wars', 'Mandalorian', 'Andor', 'Ahsoka', 'Skywalker', 'Boba Fett'] },
    { name: 'DC Universe', keywords: ['Batman', 'Superman', 'Justice League', 'The Flash', 'Wonder Woman', 'Joker'] },
    { name: 'Game of Thrones', keywords: ['Thrones', 'House of the Dragon', 'Westeros'] }
]
const franchiseKeywordsLower = franchises.map(f => ({ name: f.name, keywords: f.keywords.map(k => k.toLowerCase()) }))

function toLocalDayKey(ts: number): string {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return 'unknown'
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function stableHashIndex(str: string, count: number): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return Math.abs(hash) % count
}

interface UserStatsEntry {
    id: string
    name: string
    currentStreak: number
    bestStreak: number
    count: number
    duration: number
    recentHistory: ActivityItem[]
    bingeDuration: number
    bingeItems: ActivityItem[]
    avatarChar: string
    rank?: number
}

interface AwardEntry {
    id: string
    name: string
    count: number
}

interface CompletionEntry {
    id: string
    name: string
    rate: number
    finishes: number
}

interface SharedUniverseEntry {
    item: ActivityItem
    count: number
    accounts: { id: string; name: string; count: number; firstWatched: Date }[]
    firstSeen: Date
    lastSeen: Date
}

interface VelocityEntry {
    item: ActivityItem
    days: number
    episodes: number
    velocity: number
}

interface PersonaBadge {
    type: string
    icon: string
    color: string
}

interface PersonaEntry {
    id: string
    name: string
    badges: PersonaBadge[]
}

interface TraitMeta {
    label: string
    icon: string
    color: string
}

interface TraitEntry {
    id: string
    name: string
    chronotype: TraitMeta
    formatLoyalty: TraitMeta
}

interface FranchiseEntry {
    name: string
    count: number
}

interface TopAllTimeEntry {
    count: number
    item: ActivityItem
    shared: boolean
}

interface RollupMonthEntry {
    count: number
    minutes: number
}

interface EventRollupsPayload {
    byMonth: Record<string, RollupMonthEntry>
    daysByAccount: Record<string, string[]>
}

interface MetricsResult {
    totalItems: number
    totalHours: number
    estimatedHours: number
    leaderboard: UserStatsEntry[]
    bingeMasters: UserStatsEntry[]
    streakMasters: UserStatsEntry[]
    topTrending: ActivityItem[]
    topAllTime: TopAllTimeEntry[]
    funnel: { started: number, engaged: number, finished: number }
    abandonedSeries: ActivityItem[]
    abandonedMovies: ActivityItem[]
    awards: { midnightSnackers: AwardEntry[], weekendWarriors: AwardEntry[], completionChampions: CompletionEntry[] }
    itemsByHour: number[]
    sharedUniverse: SharedUniverseEntry[]
    contentVelocity: VelocityEntry[]
    typeCounts: { movie: number, series: number, other: number }
    seriesLoyalty: number
    userPersonas: PersonaEntry[]
    userTraits: TraitEntry[]
    franchiseFocus: FranchiseEntry[]
    rareFinds: ActivityItem[]
    streakMap: number[]
    topPilot: UserStatsEntry | null
    theLoop: TopAllTimeEntry | null
    maxActivityHour: number
    weekOverWeek: number
    thisWeekCount: number
    lastWeekCount: number
    firstWatch: { item: ActivityItem; date: Date } | null
    dailyActivity: Record<string, number>
    sessionDepths: { label: string; count: number }[]
    weeklyRhythm: number[]
    comebackTitles: { name: string; gap: number; poster: string }[]
    dropOffAvg: number
    _error?: boolean
    _message?: string
}

self.onmessage = (e: MessageEvent<{ reqId?: number; items: ActivityItem[]; periodStart?: number | null; rollups?: EventRollupsPayload; runtimes?: RuntimeIndex }>) => {
    // Every reply echoes the request id so the main thread can drop replies that
    // no longer match a pending request (parked-worker stragglers, supersessions).
    const reqId = typeof e.data?.reqId === 'number' ? e.data.reqId : -1
    const reply = (result: MetricsResult | { _error: true; _message: string } | null) => self.postMessage({ reqId, result })
    try {
    const { items: allItems, periodStart, rollups, runtimes } = e.data
    if (!allItems || allItems.length === 0) {
        reply(null)
        return
    }
    // Rows before periodStart are credit context only; every stat below counts in-period rows.
    const hasPeriod = typeof periodStart === 'number' && Number.isFinite(periodStart)
    const inPeriod = (value: Date | string | number) => {
        const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
        return Number.isFinite(time) && time >= (periodStart as number)
    }
    const items = hasPeriod ? allItems.filter(h => inPeriod(h.timestamp)) : allItems
    if (items.length === 0) {
        reply(null)
        return
    }

    const now = new Date()

    const itemsByHour = new Array(24).fill(0)
    const typeCounts = { movie: 0, series: 0, other: 0 }

    const userStats: Record<string, {
        name: string
        count: number
        duration: number
        lastActive: Date
        recentHistory: ActivityItem[]
        allDates: Date[]
        hourlyActivity: number[]
        formatCounts: { movie: number; series: number }
    }> = {}
    const trendingItems: Record<string, { count: number, item: ActivityItem }> = {}
    const contentStats: Record<string, {
        count: number
        uniqueEpisodes: Set<string>
        item: ActivityItem
        firstSeen: Date
        lastSeen: Date
        accounts: Map<string, { name: string; count: number; firstWatched: Date }>
    }> = {}
    const abandonedSeries: ActivityItem[] = []
    const abandonedMovies: ActivityItem[] = []

    const sevenDaysAgo = subDays(now, 7)
    const fourteenDaysAgo = subDays(now, 14)
    const thirtyDaysAgo = subDays(now, 30)

    const userAwardMap: Record<string, { midnightPlays: number, weekendPlays: number, totalStarts: number, totalFinishes: number }> = {}
    const franchiseCounts: Record<string, number> = {}
    franchises.forEach(f => franchiseCounts[f.name] = 0)

    // One pass per row: the normalized row (rows arrive cloned over postMessage, so the
    // spread is skipped when the timestamp is already a Date) and its watch-hours credit
    // are built together instead of two full copies of the history per message.
    const contextItems: ActivityItem[] = []
    const hoursRows: WatchHoursRow[] = []
    for (const h of allItems) {
        const isDate = h.timestamp instanceof Date
        const timestamp = isDate ? h.timestamp : new Date(h.timestamp)
        if (isNaN(timestamp.getTime())) continue
        contextItems.push(isDate ? h : { ...h, timestamp })
        hoursRows.push({
            itemId: h.itemId,
            type: h.type,
            timestamp: timestamp.getTime(),
            watched: h.watched,
            duration: h.duration,
            progress: h.progress,
            overallTimeWatched: h.overallTimeWatched,
            counterKey: h.counterKey,
            mediaServer: h.mediaServer,
            mediaPlayed: h.mediaPlayed,
            mediaPositionMs: h.mediaPositionMs,
            mediaKey: h.mediaServer ? h.id : undefined,
            excluded: !!h.backfill || !!h.importedSavedState,
        })
    }
    const periodStartMs = hasPeriod ? (periodStart as number) : -Infinity
    const normalizedItems = hasPeriod ? contextItems.filter(h => h.timestamp.getTime() >= periodStartMs) : contextItems

    // One shared definition of watch hours (also used by Activity and Replay), credited over
    // every row so a time window never re-seeds a cumulative counter.
    const hours = computeWatchHours(hoursRows, runtimes ?? { typical: new Map(), longest: new Map() })
    const periodMs: number[] = []
    let periodTotalMs = 0
    let periodEstimatedMs = 0
    contextItems.forEach((h, index) => {
        if (hasPeriod && h.timestamp.getTime() < periodStartMs) return
        periodMs.push(hours.rowMs[index])
        periodTotalMs += hours.rowMs[index]
        periodEstimatedMs += hours.rowEstimatedMs[index]
    })
    const minutesByRow = periodMs.map(ms => ms / 60000)

    normalizedItems.forEach((h: ActivityItem, index: number) => {
        const timestamp = h.timestamp

        const hTime = timestamp.getTime()
        const hDate = timestamp
        const hour = hDate.getHours()
        const day = hDate.getDay()

        // 1. Totals
        const minutes = minutesByRow[index]
        itemsByHour[hour]++

        // 2. Types
        if (h.type === 'movie') typeCounts.movie++
        else if (isSeriesType(h.type)) typeCounts.series++
        else typeCounts.other++

        // 3. Franchises
        const nameLower = h.name.toLowerCase()
        for (const f of franchiseKeywordsLower) {
            if (f.keywords.some(k => nameLower.includes(k))) franchiseCounts[f.name]++
        }

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
        else if (isSeriesType(h.type)) u.formatCounts.series++

        if (u.recentHistory.length < 8) {
            u.recentHistory.push(h)
        }

        if (hour >= 0 && hour <= 5) m.midnightPlays++
        if (day === 0 || day === 6) m.weekendPlays++
        if (h.progress > 0) m.totalStarts++
        if (h.progress >= 90) m.totalFinishes++

        // 5. Trending (Last 14d). A wider window keeps the rail useful on quiet days.
        if (hTime > fourteenDaysAgo.getTime()) {
            if (!trendingItems[h.itemId]) trendingItems[h.itemId] = { count: 0, item: h }
            trendingItems[h.itemId].count++
        }

        // 6. Content Stats & Abandoned
        if (!contentStats[h.itemId]) {
            contentStats[h.itemId] = {
                count: 0,
                uniqueEpisodes: new Set<string>(),
                item: h,
                firstSeen: h.timestamp,
                lastSeen: h.timestamp,
                accounts: new Map<string, { name: string; count: number; firstWatched: Date }>()
            }
        }
        const cs = contentStats[h.itemId]
        cs.count++
        const epIdentity = h.season !== undefined && h.episode !== undefined
            ? `s${h.season}:e${h.episode}`
            : (h as unknown as Record<string, unknown>).video_id as string || h.id
        cs.uniqueEpisodes.add(epIdentity)
        if (!cs.accounts.has(h.accountId)) {
            cs.accounts.set(h.accountId, { name: h.accountName || 'Unknown', count: 1, firstWatched: h.timestamp })
        } else {
            const acct = cs.accounts.get(h.accountId)
            if (acct) {
                acct.count++
                if (h.timestamp < acct.firstWatched) acct.firstWatched = h.timestamp
            }
        }
        if (h.timestamp < cs.firstSeen) cs.firstSeen = h.timestamp
        if (h.timestamp > cs.lastSeen) cs.lastSeen = h.timestamp

        if (h.progress > 0 && h.progress < 15 && hTime < thirtyDaysAgo.getTime() && h.poster) {
            if (h.type === 'movie') abandonedMovies.push(h)
            else abandonedSeries.push(h)
        }
    })

    // Evicted events exist only in rollups, so adding them to event-derived stats never double counts.
    const rollupCountByItem = new Map<string, number>()
    let rollupMinutesTotal = 0
    let rollupEarliestMs = Infinity
    if (rollups) {
        const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/
        for (const [key, entry] of Object.entries(rollups.byMonth)) {
            if (!entry || typeof entry.count !== 'number' || typeof entry.minutes !== 'number') continue
            const lastColon = key.lastIndexOf(':')
            const month = key.slice(lastColon + 1)
            const firstColon = key.indexOf(':')
            if (lastColon <= 0 || firstColon === lastColon || !MONTH_KEY_RE.test(month)) continue
            const itemId = key.slice(firstColon + 1, lastColon)
            rollupCountByItem.set(itemId, (rollupCountByItem.get(itemId) || 0) + entry.count)
            rollupMinutesTotal += entry.minutes
            const [y, m] = month.split('-').map(Number)
            const monthStart = new Date(y, m - 1, 1).getTime()
            if (monthStart < rollupEarliestMs) rollupEarliestMs = monthStart
        }
    }
    const totalMs = periodTotalMs + rollupMinutesTotal * 60000

    // Binge Logic. Rows without a real watch date (backfill/importedSavedState) are
    // excluded first: their synthetic timestamps cluster at sync time and would
    // otherwise chain a whole large-library import into one fake giant session.
    const bingeEligible = normalizedItems.filter(h => !h.backfill && !h.importedSavedState)
    const chronoHistory = [...bingeEligible].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    const tempBingeTracker: Record<string, { currentChain: ActivityItem[], lastTime: Date }> = {}
    const userBinges: Record<string, { duration: number; items: ActivityItem[] }> = {}

    chronoHistory.forEach((h: ActivityItem) => {
        const bingeKey = `${h.accountId}`
        if (!tempBingeTracker[bingeKey]) {
            tempBingeTracker[bingeKey] = { currentChain: [h], lastTime: h.timestamp }
        } else {
            const tracker = tempBingeTracker[bingeKey]
            const diff = (h.timestamp.getTime() - tracker.lastTime.getTime()) / 60000
            if (diff < BINGE_GAP_MINUTES) {
                tracker.currentChain.push(h)
                tracker.lastTime = h.timestamp
            } else {
                const duration = tracker.currentChain.length
                const uid = h.accountId
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
        const localDays = [...new Set<string>([
            ...u.allDates.map((d: Date) => toLocalDayKey(d instanceof Date ? d.getTime() : new Date(d).getTime())),
            ...(rollups?.daysByAccount?.[uid] || []),
        ])]
        localDays.sort()
        let currentStreak = 0, bestStreak = 0, tempStreak = 0
        if (localDays.length > 0) {
            for (let i = 0; i < localDays.length; i++) {
                if (i === 0) { tempStreak = 1; continue }
                const prev = localDays[i - 1].split('-').map(Number)
                const curr = localDays[i].split('-').map(Number)
                const prevDate = new Date(prev[0], prev[1] - 1, prev[2])
                const currDate = new Date(curr[0], curr[1] - 1, curr[2])
                const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / 864e5)
                if (diffDays === 1) tempStreak++
                else { bestStreak = Math.max(bestStreak, tempStreak); tempStreak = 1 }
            }
            bestStreak = Math.max(bestStreak, tempStreak)
            const lastActiveLocal = toLocalDayKey(u.lastActive instanceof Date ? u.lastActive.getTime() : new Date(u.lastActive).getTime())
            const todayLocal = toLocalDayKey(Date.now())
            const yesterdayLocal = toLocalDayKey(Date.now() - 864e5)
            if (lastActiveLocal === todayLocal || lastActiveLocal === yesterdayLocal) currentStreak = tempStreak
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
    const topAllTime = Object.values(contentStats).map(c => ({
        count: c.count + (rollupCountByItem.get(c.item.itemId) || 0),
        item: c.item,
        shared: c.accounts.size > 1
    })).sort((a, b) => b.count - a.count).slice(0, 20)

    const sharedUniverse = Object.values(contentStats)
        .filter((cs) => cs.accounts.size > 1)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((cs) => ({
            item: cs.item,
            count: cs.count,
            accounts: Array.from(cs.accounts.entries()).map(([id, data]) => ({
                id, name: data.name, count: data.count, firstWatched: data.firstWatched
            })),
            firstSeen: cs.firstSeen,
            lastSeen: cs.lastSeen,
        }))

    const contentVelocity = Object.values(contentStats)
        .filter((cs) => cs.uniqueEpisodes.size > 3 && isSeriesType(cs.item.type))
        .map((cs) => {
            const days = Math.max(1, Math.ceil((cs.lastSeen.getTime() - cs.firstSeen.getTime()) / (1000 * 60 * 60 * 24)))
            return { item: cs.item, days, episodes: cs.uniqueEpisodes.size, velocity: cs.uniqueEpisodes.size / days }
        })
        .sort((a, b) => b.velocity - a.velocity)
        .slice(0, 10)

    const streakMap = new Array(30).fill(0)
    const todayKey = toLocalDayKey(Date.now())
    const todayParts = todayKey.split('-').map(Number)
    const todayDate = new Date(todayParts[0], todayParts[1] - 1, todayParts[2])
    items.forEach(h => {
        const hKey = toLocalDayKey(h.timestamp instanceof Date ? h.timestamp.getTime() : new Date(h.timestamp).getTime())
        const hParts = hKey.split('-').map(Number)
        const hDate = new Date(hParts[0], hParts[1] - 1, hParts[2])
        const diff = Math.round((todayDate.getTime() - hDate.getTime()) / 864e5)
        if (diff >= 0 && diff < 30) streakMap[29 - diff]++
    })

    const topPilot = leaderboard[0] || null
    const theLoop = topAllTime[0] || null

    const seriesItems = items.filter(h => isSeriesType(h.type))
    const topSeriesContentCount = Object.values(contentStats)
        .filter((cs) => isSeriesType(cs.item.type))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .reduce((sum, cs) => sum + cs.count, 0)
    const seriesLoyalty = seriesItems.length > 0 ? (topSeriesContentCount / seriesItems.length) * 100 : 0

    const thisWeekCount = items.filter(h => h.timestamp > sevenDaysAgo).length
    const lastWeekCount = items.filter(h => h.timestamp > fourteenDaysAgo && h.timestamp <= sevenDaysAgo).length
    const weekOverWeek = lastWeekCount > 0 ? Math.round(((thisWeekCount - lastWeekCount) / lastWeekCount) * 100) : (thisWeekCount > 0 ? 100 : 0)

    const allContentFirsts = Object.values(contentStats)
        .filter((cs) => cs.item.poster && (cs.item.type === 'movie' || isSeriesType(cs.item.type)))
        .sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime())
    const firstWatch = allContentFirsts.length > 0 ? {
        item: allContentFirsts[0].item,
        date: rollupEarliestMs < allContentFirsts[0].firstSeen.getTime()
            ? new Date(rollupEarliestMs)
            : allContentFirsts[0].firstSeen
    } : null

    const dailyActivity: Record<string, number> = {}
    const weeklyRhythm = new Array(7).fill(0)
    const allSessionLengths: number[] = []

    normalizedItems.forEach((h: ActivityItem) => {
        const ts = h.timestamp instanceof Date ? h.timestamp : new Date(h.timestamp)
        const dayKey = toLocalDayKey(ts.getTime())
        dailyActivity[dayKey] = (dailyActivity[dayKey] || 0) + 1
        const dow = ts.getDay()
        weeklyRhythm[dow]++
    })

    // Session depths use the same eligibility rule as binge chains: synthetic
    // timestamps never lengthen a "session".
    const chronoForSessions = [...bingeEligible].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    let sessionCount = 0
    let lastSessionTime: Date | null = null
    chronoForSessions.forEach((h: ActivityItem) => {
        if (lastSessionTime) {
            const gap = (h.timestamp.getTime() - lastSessionTime.getTime()) / 60000
            if (gap >= BINGE_GAP_MINUTES) {
                if (sessionCount > 0) allSessionLengths.push(sessionCount)
                sessionCount = 1
            } else {
                sessionCount++
            }
        } else {
            sessionCount = 1
        }
        lastSessionTime = h.timestamp
    })
    if (sessionCount > 0) allSessionLengths.push(sessionCount)

    const sessionBuckets = [
        { label: '1 episode', min: 1, max: 1, count: 0 },
        { label: '2-3 eps', min: 2, max: 3, count: 0 },
        { label: '4-6 eps', min: 4, max: 6, count: 0 },
        { label: '7+ eps', min: 7, max: Infinity, count: 0 },
    ]
    allSessionLengths.forEach(len => {
        const bucket = sessionBuckets.find(b => len >= b.min && len <= b.max)
        if (bucket) bucket.count++
    })

    // Group once; scanning all history for every repeated title makes this pass quadratic.
    const playsByItemId = new Map<string, ActivityItem[]>()
    for (const item of normalizedItems) {
        const plays = playsByItemId.get(item.itemId)
        if (plays) plays.push(item)
        else playsByItemId.set(item.itemId, [item])
    }
    const comebackTitles: { name: string; gap: number; poster: string }[] = []
    Object.values(contentStats).forEach(cs => {
        if (cs.count < 2) return
        const plays = (playsByItemId.get(cs.item.itemId) || []).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        for (let i = 1; i < plays.length; i++) {
            const gapDays = (plays[i].timestamp.getTime() - plays[i - 1].timestamp.getTime()) / 864e5
            if (gapDays >= 14) {
                comebackTitles.push({ name: cs.item.name, gap: Math.round(gapDays), poster: cs.item.poster })
                break
            }
        }
    })
    comebackTitles.sort((a, b) => b.gap - a.gap)

    const abandonedSeriesStats = Object.values(contentStats)
        .filter(cs => isSeriesType(cs.item.type) && cs.uniqueEpisodes.size > 0 && cs.uniqueEpisodes.size < 5)
    const dropOffAvg = abandonedSeriesStats.length > 0
        ? Math.round(abandonedSeriesStats.reduce((sum, cs) => sum + cs.uniqueEpisodes.size, 0) / abandonedSeriesStats.length * 10) / 10
        : 0

    const result: MetricsResult = {
        totalItems: items.length,
        totalHours: msToHours(totalMs),
        estimatedHours: msToHours(periodEstimatedMs),
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
            .filter((cs) => {
                if (cs.item.type !== 'movie' && !isSeriesType(cs.item.type)) return false
                if (Object.keys(userStats).length > 1) {
                    return cs.accounts.size === 1 && cs.count === 1
                }
                return cs.count === 1
            })
            .sort((a, b) => stableHashIndex(a.item.id || a.item.name, 1000) - stableHashIndex(b.item.id || b.item.name, 1000))
            .slice(0, 10)
            .map((cs) => {
                const firstAccount = Array.from(cs.accounts.keys() as IterableIterator<string>)[0] as string
                return { ...cs.item, accountName: userStats[firstAccount]?.name }
            }),
        streakMap,
        topPilot,
        theLoop,
        maxActivityHour: itemsByHour.indexOf(Math.max(...itemsByHour)),
        weekOverWeek,
        thisWeekCount,
        lastWeekCount,
        firstWatch,
        dailyActivity,
        sessionDepths: sessionBuckets.map(b => ({ label: b.label, count: b.count })),
        weeklyRhythm,
        comebackTitles: comebackTitles.slice(0, 5),
        dropOffAvg,
    }

    reply(result)
    } catch (err) {
        reply({ _error: true, _message: err instanceof Error ? err.message : String(err) })
    }
}
