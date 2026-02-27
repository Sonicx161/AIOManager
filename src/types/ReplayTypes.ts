export interface RankedTitle {
    id: string
    itemId: string
    uniqueItemId: string
    name: string
    type: string
    poster: string
    watchCount: number
    totalHours: number
    rank: number
}

export interface GenreStat {
    genre: string
    count: number
    percentage: number
    color: string
}

export interface MonthStat {
    month: string // e.g., "January"
    monthKey: string // e.g., "2026-01"
    topTitle?: RankedTitle
    top3Titles?: RankedTitle[]
    totalTitles: number
    totalHours: number
    isHighActivity: boolean
}

export interface Milestone {
    id: string
    icon: string       // emoji
    title: string
    description: string
    value: number
    threshold: number
    unlocked: boolean
}

export interface HourlyDistribution {
    hour: number      // 0-23
    count: number
    percentage: number
}

export interface DailyDistribution {
    day: number        // 0=Sun, 6=Sat
    dayName: string
    count: number
    hours: number
    percentage: number
}

export interface YearOverYearDelta {
    prevYear: number | string
    currentYear: number | string
    titlesDelta: number        // percentage change
    hoursDelta: number
    loyaltyDelta: number
    streakDelta: number
    prevTitles: number
    prevHours: number
    currentTitles: number
    currentHours: number
}

export interface ReplayData {
    year: number | string // 'all-time', flat year (2026), or specific month ('2026-01')
    totalTitles: number
    totalHours: number
    totalGenres: number
    longestStreak: number
    avgTitlesPerMonth: number
    topTitles: RankedTitle[]
    topGenres: GenreStat[]
    monthlyBreakdown: MonthStat[]
    discoveries: RankedTitle[]
    marathonTitles: RankedTitle[]
    hiddenGems: RankedTitle[]
    availableYears: number[]
    availableMonths: string[] // List of "YYYY-MM" strings in the current history breakdown
    heroPosterArt: string[] // For background mosaic
    persona: string
    personaDescription: string
    // New features
    milestones: Milestone[]
    hourlyDistribution: HourlyDistribution[]
    dailyDistribution: DailyDistribution[]
    yearOverYear: YearOverYearDelta | null
    peakHour: number
    peakDay: string
    discoveryPercentage: number   // % of titles that were brand new
    totalUniqueDiscoveries: number
}
