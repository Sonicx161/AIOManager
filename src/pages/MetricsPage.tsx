import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton, StatCardSkeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { ContentRail, ContentRailCard } from '@/components/ui/content-rail'
import { MetricsEmptyState } from '@/components/common/PageEmptyStates'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { CHART_PALETTE } from '@/lib/chart-colors'
import { useLibraryCache } from '@/store/libraryCache'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { useMetricsWorker, createMetricsSourceIdentity, metricsCommitGate, metricsViewState, type MetricsResult } from '@/hooks/useMetricsWorker'
import { useSettledSignal } from '@/hooks/useSettledSignal'
import { useAccountStore } from '@/store/accountStore'
import { useWatchEventStore } from '@/store/watchEventStore'
import type { Account } from '@/types/account'
import { historyEntryToActivityItem, canonicalStremioConnections } from '@/lib/activity-utils'
import { crossLinkWatcherIndex, type WatcherItemIdentity } from '@/lib/watcher-identity'
import {
    Activity,
    Flame,
    Clock,
    Tv,
    Film,
    Trophy,
    Crown,
    Ghost,
    Users,
    PlayCircle,
    Moon,
    Zap,
    CheckCircle,
    Sun,
    Coffee,
    LayoutGrid,
} from 'lucide-react'

import { Suspense, useEffect, useState, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { cn, maskNameLevel, maskEmailLevel, formatHoursAsDays } from '@/lib/utils'
import { AccountSwitcher } from '@/components/common/AccountSwitcher'
import { useUIStore } from '@/store/uiStore'
import { Poster } from '@/components/common/Poster'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatNumber } from '@/components/ui/number-ticker'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { StatusChip } from '@/components/ui/status-chip'
import { Tooltip } from '@/components/ui/tooltip'
import { OperationProgress } from '@/components/ui/operation-progress'
import type { DetailItem } from '@/components/activity/ActivityDetailModal'
import { lazyChunk } from '@/lib/lazy-chunk'
import { ActivityHeatmap, ActivitySparkline, WatchFunnel, ContentDonut, FranchiseBars, VelocityChart, WeekComparison, ContributionGraph, SessionDepth, WeeklyRhythm, ComebackRate, DropOffPoint } from '@/components/metrics'
import { pressable, PRESSABLE_FOCUS } from '@/components/metrics/pressable'
import { rankedProfileCount } from '@/components/metrics/profile-counts'

const ActivityDetailModal = lazyChunk(() => import('@/components/activity/ActivityDetailModal').then(m => ({ default: m.ActivityDetailModal })))

const PERSONA_DESCRIPTIONS: Record<string, string> = {
    'The Completer': 'Finishes over 80% of what they start',
    'The Sampler': 'Starts a lot but rarely finishes',
    'The Night Owl': 'Over 30% of watching happens after midnight',
    'Binge King': 'Watched 8+ episodes in a single session',
    'Weekend Warrior': 'Over 60% of watching happens on weekends',
}

const CHRONOTYPE_DESCRIPTIONS: Record<string, string> = {
    'Early Bird': 'Most active in the morning',
    'Day Dreamer': 'Most active in the afternoon',
    'Prime Time Player': 'Most active in the evening',
    'Night Owl': 'Most active late at night',
    'Balanced Viewer': 'Watches evenly throughout the day',
}

const FORMAT_DESCRIPTIONS: Record<string, string> = {
    'The Cinephile': 'Over 70% movies',
    'Serial Binger': 'Over 70% series',
    'The Hybrid': 'Mixes movies and series evenly',
}

const IconMap: Record<string, React.ElementType> = {
    CheckCircle, Ghost, Moon, Flame, Zap, Clock, Sun, Coffee, Tv, LayoutGrid, Film
}

const METRIC_PERIODS = [
    { id: 'all', label: 'All Time', days: null },
    { id: '24h', label: 'Last 24 Hours', days: 1 },
    { id: '7d', label: 'Last 7 Days', days: 7 },
    { id: '30d', label: 'Last 30 Days', days: 30 },
    { id: '90d', label: 'Last 90 Days', days: 90 },
] as const

type MetricPeriodId = typeof METRIC_PERIODS[number]['id']

// Metrics never renders genres (the worker items omit them), so skip the Cinemeta genre crawl.
const METRICS_HISTORY_OPTIONS = { genres: false, sessions: false } as const

function formatMetricHour(hour: number) {
    const normalizedHour = Number.isFinite(hour) ? ((Math.round(hour) % 24) + 24) % 24 : 0
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2024, 0, 1, normalizedHour))
}

function formatEpisodeLabel(item: { season?: number | null; episode?: number | null }) {
    return Number.isInteger(item.episode) && (item.episode ?? 0) > 0 ? `S${item.season ?? 1} E${item.episode}` : null
}

function WatcherBadges({ accounts: watchAccs, maskName }: { accounts: Account[]; maskName?: (name: string) => string }) {
    if (!watchAccs || watchAccs.length === 0) return null
    return (
        <div className="absolute bottom-2 right-2 z-10 flex items-center -space-x-1.5">
            {watchAccs.slice(0, 3).map(acc => (
                <div key={acc.id} className="h-5 w-5 rounded-full border border-background overflow-hidden bg-card shadow-sm flex items-center justify-center">
                    {acc.avatar ? (
                        <img src={acc.avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : acc.emoji ? (
                        <span className="text-[9px]">{acc.emoji}</span>
                    ) : (
                        <span className="text-[8px] font-bold text-muted-foreground">{((maskName ? maskName(acc.name || '?') : (acc.name || '?'))[0] || '?').toUpperCase()}</span>
                    )}
                </div>
            ))}
            {watchAccs.length > 3 && (
                <div className="h-5 w-5 rounded-full border border-background bg-card shadow-sm flex items-center justify-center">
                    <span className="text-[8px] font-bold text-muted-foreground">+{watchAccs.length - 3}</span>
                </div>
            )}
        </div>
    )
}

export function MetricsPage() {
    useDocumentTitle('Metrics')
    const navigate = useNavigate()
    const prefersReducedMotion = useReducedMotion()
    const accounts = useAccountStore(s => s.accounts)
    const accountsById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts])
    const canonicalConnections = useMemo(() => canonicalStremioConnections(accounts), [accounts])
    const cacheLoading = useLibraryCache(s => s.loading)
    const ensureLoaded = useLibraryCache(s => s.ensureLoaded)
    const loadingProgress = useLibraryCache(s => s.loadingProgress)
    const { history: watchHistory } = useWatchHistory(undefined, true, METRICS_HISTORY_OPTIONS)
    // Exclude backfilled episodes (synthetic timestamps) from time-based metrics; Replay keeps them in totals.
    const history = useMemo(() => watchHistory.map(historyEntryToActivityItem).filter(item => !item.backfill), [watchHistory])
    const rollups = useWatchEventStore(s => s.rollups)

    const [selectedAccountId, setSelectedAccountId] = useState<string>('all')
    const [selectedPeriod, setSelectedPeriod] = useState<MetricPeriodId>('all')
    const [detailItem, setDetailItem] = useState<DetailItem | null>(null)
    const [detailModalSeen, setDetailModalSeen] = useState(false)
    useEffect(() => { if (detailItem) setDetailModalSeen(true) }, [detailItem])

    const openDetail = useCallback((type?: string, itemId?: string, name?: string, poster?: string) => {
        if (!itemId) return
        setDetailItem({ itemId, type: type || 'movie', name, poster })
    }, [])

    const activeAccounts = useMemo(() => {
        const activeAccountIds = new Set(history.map(h => h.accountId))
        return accounts.filter(acc => activeAccountIds.has(acc.id))
    }, [accounts, history])

    const accountFilteredHistory = useMemo(() =>
        selectedAccountId === 'all'
            ? history
            : history.filter(item => item.accountId === selectedAccountId)
    , [history, selectedAccountId])

    // Cutoff is fixed per period or data change, like the filter it replaces.
    const periodStart = useMemo(() => {
        const days = METRIC_PERIODS.find(option => option.id === selectedPeriod)?.days
        return days ? Date.now() - days * 864e5 : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPeriod, accountFilteredHistory])

    const filteredHistory = useMemo(() => {
        if (periodStart == null) return accountFilteredHistory
        return accountFilteredHistory.filter(item => {
            const time = item.timestamp instanceof Date ? item.timestamp.getTime() : new Date(item.timestamp).getTime()
            return Number.isFinite(time) && time >= periodStart
        })
    }, [accountFilteredHistory, periodStart])

    const watchersByItemId = useMemo(() => {
        const map = new Map<string, Account[]>()
        const identityByKey = new Map<string, WatcherItemIdentity>()
        for (const item of filteredHistory) {
            if (!item.itemId) continue
            const acc = accountsById.get(item.accountId)
            if (!acc) continue
            const list = map.get(item.itemId)
            if (list) {
                if (!list.some(a => a.id === acc.id)) list.push(acc)
            } else {
                map.set(item.itemId, [acc])
                identityByKey.set(item.itemId, { itemId: item.itemId, name: item.name, type: item.type })
            }
        }
        // Cross-source identities address the same show with different ids (tt vs
        // platform-scoped); share watchers so shared titles stop showing "1 person".
        crossLinkWatcherIndex(map, identityByKey)
        return map
    }, [filteredHistory, accountsById])

    // Rollups are month-granular all-time aggregates, so they only apply to the unbounded period.
    const scopedRollups = useMemo(() => {
        if (selectedPeriod !== 'all') return undefined
        if (selectedAccountId === 'all') {
            return (Object.keys(rollups.byMonth).length > 0 || Object.keys(rollups.daysByAccount).length > 0) ? rollups : undefined
        }
        const prefix = `${selectedAccountId}:`
        const byMonth: Record<string, { count: number; minutes: number }> = {}
        for (const [key, entry] of Object.entries(rollups.byMonth)) {
            if (key.startsWith(prefix)) byMonth[key] = entry
        }
        const days = rollups.daysByAccount[selectedAccountId]
        if (!days && Object.keys(byMonth).length === 0) return undefined
        return { byMonth, daysByAccount: days ? { [selectedAccountId]: days } : {} }
    }, [rollups, selectedAccountId, selectedPeriod])

    // Selection-independent identity of the source data: full history (before any
    // viewer/period selection), canonical attribution and all rollup days.
    const metricsSourceIdentity = useMemo(
        () => createMetricsSourceIdentity(history, rollups, canonicalConnections),
        [history, rollups, canonicalConnections]
    )

    const workerOptions = useMemo(() => ({ filterKey: `${selectedAccountId}|${selectedPeriod}`, periodStart, runtimeSource: history, sourceIdentity: metricsSourceIdentity }), [selectedAccountId, selectedPeriod, periodStart, history, metricsSourceIdentity])
    const { results: latest, isComputing: workerLoading, isCurrent, scope } = useMetricsWorker(accountFilteredHistory, scopedRollups, canonicalConnections, workerOptions)

    // A result is shown once it was computed for the current session/workspace on
    // settled data. Under sustained churn a result whose key is no longer current
    // still commits (marked refreshing below) so the page always shows visible
    // progress; final numbers are those whose key is current (isCurrent).
    const dataSettled = useSettledSignal(history, cacheLoading)
    const [committed, setCommitted] = useState<{ scope: string; value: MetricsResult } | null>(null)
    const [entrance, setEntrance] = useState<{ totalItems: number; binge: number; hours: number; profiles: number; loyalty: number } | null>(null)
    useEffect(() => {
        if (!latest || !metricsCommitGate(latest, dataSettled)) return
        setCommitted(prev => (prev && prev.scope === scope && prev.value === latest ? prev : { scope, value: latest }))
    }, [latest, dataSettled, scope])
    const stats = committed && committed.scope === scope ? committed.value : null
    if (stats && !stats._error && entrance === null) {
        setEntrance({
            totalItems: stats.totalItems,
            binge: stats.bingeMasters?.[0]?.bingeDuration || 0,
            hours: stats.totalHours,
            profiles: stats.leaderboard?.length || 0,
            loyalty: Math.round(stats.seriesLoyalty),
        })
    }
    // Numbers tick only while they still equal their first-revealed values; any later change swaps instantly.
    const ticked = (value: number, first: number | undefined) => entrance !== null && first !== undefined && value === first

    useEffect(() => {
        if (accounts.length > 0) {
            ensureLoaded(accounts)
        }
    }, [accounts, ensureLoaded])

    const viewState = metricsViewState(stats, workerLoading)
    const isRefreshing = viewState === 'ready' && (workerLoading || !isCurrent || !dataSettled)
    const selectedPeriodLabel = METRIC_PERIODS.find(option => option.id === selectedPeriod)?.label || 'All Time'

    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const maskAccountName = (name: string) => { const n = name || ''; return n.includes('@') ? maskEmailLevel(n, privacyLevel) : maskNameLevel(n, privacyLevel) }

    return (
        <div className="space-y-4">
            <Tabs defaultValue="overview" className="w-full" aria-busy={isRefreshing}>
                <div className="relative mb-4 space-y-3">
                    <ToolbarShell contentClassName="gap-2 sm:gap-3">
                        <TabsList className="w-full justify-start overflow-x-auto bg-muted/35 shadow-none sm:w-auto">
                            <TabsTrigger value="overview">Overview</TabsTrigger>
                            <TabsTrigger value="community">Community</TabsTrigger>
                            <TabsTrigger value="insights">Insights</TabsTrigger>
                            <TabsTrigger value="collection">Collection</TabsTrigger>
                        </TabsList>

                        <div className={cn(
                            "grid w-full gap-2 sm:flex sm:flex-1 sm:flex-wrap sm:items-center sm:min-w-0",
                            activeAccounts.length > 1 ? "grid-cols-2" : "grid-cols-1"
                        )}>
                            {activeAccounts.length > 1 && (
                                <AccountSwitcher
                                    mode="filter"
                                    accounts={activeAccounts}
                                    selectedId={selectedAccountId}
                                    onSelect={setSelectedAccountId}
                                    allLabel="All Users"
                                    placeholder="Search users..."
                                    buttonClassName="inline-flex h-8 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border/40 bg-muted/30 px-3 text-xs font-medium shadow-sm transition-colors hover:bg-muted/50 hover:text-foreground"
                                />
                            )}

                            <Select value={selectedPeriod} onValueChange={(value) => setSelectedPeriod(value as MetricPeriodId)}>
                                <SelectTrigger className="h-8 w-full sm:w-[142px] text-xs font-medium">
                                    <SelectValue placeholder="All Time" />
                                </SelectTrigger>
                                <SelectContent>
                                    {METRIC_PERIODS.map((period) => (
                                        <SelectItem
                                            key={period.id}
                                            value={period.id}
                                        >
                                            {period.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex items-center gap-2 shrink-0 sm:ml-auto">
                            <Button
                                size="sm"
                                onClick={() => navigate('/replay')}
                                className="flex-1 sm:flex-none h-10 px-4 border-none font-bold shadow-lg group overflow-hidden relative transition-transform active:scale-95 flex items-center justify-center gap-2 text-white shine-sweep"
                                style={{
                                    background: 'linear-gradient(90deg, #818cf8 0%, #a78bfa 25%, #f472b6 50%, #a78bfa 75%, #818cf8 100%)',
                                    backgroundSize: '200% auto',
                                }}
                            >
                                <motion.div
                                    initial="initial"
                                    animate={prefersReducedMotion ? 'initial' : 'animate'}
                                    className="flex items-center justify-center relative z-10"
                                >
                                    <motion.svg
                                        xmlns="http://www.w3.org/2000/svg"
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="currentColor"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <motion.path d="m11 19-9-7 9-7v14z" variants={{
                                            initial: { opacity: 0.4 },
                                            animate: { opacity: [0.4, 1, 0.4], transition: { repeat: Infinity, duration: 1.5, ease: "linear" } }
                                        }} />
                                        <motion.path d="m22 19-9-7 9-7v14z" variants={{
                                            initial: { opacity: 1 },
                                            animate: { opacity: [1, 0.4, 1], transition: { repeat: Infinity, duration: 1.5, ease: "linear" } }
                                        }} />
                                    </motion.svg>
                                </motion.div>
                                <span className="relative z-10 uppercase tracking-tight text-xs">Replay</span>
                            </Button>
                        </div>
                    </ToolbarShell>

                    <div
                        aria-hidden
                        data-testid="metrics-refreshing"
                        className={cn(
                            "pointer-events-none absolute inset-x-0 -bottom-2 h-0.5 overflow-hidden rounded-full bg-primary/50 transition-opacity duration-300",
                            isRefreshing ? "animate-pulse opacity-100" : "opacity-0"
                        )}
                    />

                    {(cacheLoading || viewState === 'skeleton') && (
                        <OperationProgress
                            status="running"
                            current={cacheLoading ? loadingProgress.current : 100}
                            total={cacheLoading ? loadingProgress.total : 100}
                            label={cacheLoading
                                ? (loadingProgress.current > 0 ? `Syncing ${loadingProgress.current} of ${loadingProgress.total} accounts` : 'Connecting...')
                                : 'Crunching numbers...'}
                            detail={cacheLoading
                                ? (loadingProgress.current > 0 ? `${loadingProgress.total - loadingProgress.current} remaining` : 'Fetching watch history')
                                : 'Processing metrics data'}
                            className="mt-2"
                        />
                    )}
                </div>

                {viewState === 'error' ? (
                    <TabsContent value="overview" className="space-y-6">
                        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                            <Activity className="h-8 w-8 text-muted-foreground opacity-50" />
                            <div>
                                <p className="text-sm font-semibold text-muted-foreground">Metrics unavailable</p>
                                <p className="text-xs text-muted-foreground/60 mt-1">{stats?._message || 'The calculation timed out or failed. Refresh the page to retry.'}</p>
                            </div>
                        </div>
                    </TabsContent>
                ) : viewState === 'skeleton' || !stats ? (
                    <TabsContent value="overview" className="space-y-6">
                        <div className="space-y-4 animate-in fade-in duration-500">
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                {Array.from({ length: 4 }).map((_, i) => (
                                    <StatCardSkeleton key={i} />
                                ))}
                            </div>
                            <div className="space-y-4">
                                <Skeleton className="h-6 w-40" />
                                <Skeleton className="h-64 w-full rounded-lg" />
                            </div>
                        </div>
                    </TabsContent>
                ) : (<>
                    <TabsContent value="overview" className="space-y-6">
                    {stats.totalItems === 0 ? (
                        <MetricsEmptyState />
                    ) : (
                    <>



                    {/* KEY METRICS GRID */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {[
                            { icon: Activity, label: 'Total Plays', value: stats.totalItems, enter: entrance?.totalItems, color: 'text-primary', bg: 'bg-primary/12', border: 'border-primary/15', tooltip: 'Total items watched in period' },
                            { icon: Zap, label: 'Max Binge Session', value: stats.bingeMasters?.[0]?.bingeDuration || 0, enter: entrance?.binge, color: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/15', tooltip: 'Most titles in one session' },
                            { icon: Clock, label: 'Hours Watched', value: stats.totalHours, enter: entrance?.hours, palette: 'cyan', tooltip: `Total hours of content watched (${formatHoursAsDays(stats.totalHours)})` },
                            { icon: Users, label: 'Active Profiles', value: stats.leaderboard?.length || 0, enter: entrance?.profiles, color: 'text-success', bg: 'bg-success/10', border: 'border-success/15', tooltip: 'Accounts with watch activity' },
                        ].map((card) => {
                            const { icon: Icon, label, value } = card
                            const palette = card.palette ? CHART_PALETTE[card.palette] : null
                            const color = card.color || ''
                            const bg = card.bg || ''
                            return palette ? (
                                <Card key={label} className="rounded-2xl border border-border/40 bg-card/50 shadow-sm">
                                    <CardContent className="p-5">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="text-3xl font-bold tabular-nums tracking-tight" style={{ color: label === 'Hours Watched' ? 'hsl(var(--foreground))' : palette.text }}>
                                                    <StatNumber value={value} animate={ticked(value, card.enter)} />
                                                </div>
                                                <Tooltip content={card.tooltip} side="top">
                                                    <div className="text-xs font-medium text-muted-foreground mt-1 leading-tight cursor-help">{label}</div>
                                                </Tooltip>
                                            </div>
                                            <div className="p-2 rounded-xl shrink-0" style={{ background: palette.bg }}>
                                                <Icon className="h-4 w-4" style={{ color: palette.text }} />
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ) : (
                                <Card key={label} className="rounded-2xl border border-border/40 bg-card/50 shadow-sm">
                                    <CardContent className="p-5">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className={`text-3xl font-bold tabular-nums tracking-tight ${color}`}>
                                                    <StatNumber value={value} animate={ticked(value, card.enter)} />
                                                </div>
                                                <Tooltip content={card.tooltip} side="top">
                                                    <div className="text-xs font-medium text-muted-foreground mt-1 leading-tight cursor-help">{label}</div>
                                                </Tooltip>
                                            </div>
                                            <div className={`p-2 rounded-xl ${bg} shrink-0`}>
                                                <Icon className={`h-4 w-4 ${color}`} />
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            )
                        })}
                    </div>

                    {/* CONTRIBUTION GRAPH */}
                    <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-sm">
                                <Tooltip content="Daily watching activity for the selected period" side="top">
                                    <span className="cursor-help">Activity Calendar</span>
                                </Tooltip>
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ContributionGraph dailyActivity={stats.dailyActivity} />
                        </CardContent>
                    </Card>

                    {/* TRENDING NOW */}
                    <ContentRail title="Trending Now" subtitle="Titles clustering across the last 14 days.">
                        {stats.topTrending?.length > 0 ? (
                            stats.topTrending.map((item, i) => (
                                <ContentRailCard
                                    key={item.id}
                                    rank={i + 1}
                                    poster={item.poster}
                                    title={item.name}
                                    itemId={item.itemId || item.id}
                                    itemType={item.type}
                                    onClick={() => openDetail(item.type, item.itemId || item.id, item.name, item.poster)}
                                />
                            ))
                        ) : (
                            <EmptyState
                                icon={<Flame className="h-6 w-6" />}
                                title="No trending activity"
                                description="Watch a few episodes or movies and they’ll cluster here as your trending titles."
                            />
                        )}
                    </ContentRail>

                    {/* BINGE MASTERY HIGHLIGHT */}
                    <div>
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                                    Binge Mastery
                                    <Tooltip content="Highest binge session in selected time period" side="top">
                                        <StatusChip variant="warning">Top session</StatusChip>
                                    </Tooltip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col md:flex-row items-center gap-8">
                                <div className="text-center md:text-left flex-1">
                                    <div className="text-4xl font-bold"><StatNumber value={stats.bingeMasters?.[0]?.bingeDuration || 0} animate={ticked(stats.bingeMasters?.[0]?.bingeDuration || 0, entrance?.binge)} /></div>
                                    <div className="text-xs font-medium text-muted-foreground uppercase">Titles in one session</div>
                                    <p className="text-sm mt-3 text-muted-foreground">
                                        <span className="font-bold text-primary">{maskAccountName(stats.bingeMasters?.[0]?.name || '')}</span> is currently holding the crown for the most intense watch session.
                                    </p>
                                </div>
                                <div className="flex -space-x-4">
                                    {stats.bingeMasters?.[0]?.bingeItems?.slice(0, 5)?.map((item, i: number) => {
                                        const episodeLabel = formatEpisodeLabel(item)
                                        return (
                                            <div
                                                key={item.id}
                                                {...pressable(() => openDetail(item.type, item.itemId || item.id, item.name, item.poster), item.name)}
                                                className={cn("content-auto-poster relative w-16 h-24 rounded-xl border-2 border-background overflow-hidden shadow-lg transition-transform hover:-translate-y-2 cursor-pointer", PRESSABLE_FOCUS)}
                                                style={{ zIndex: 5 - i }}
                                            >
                                                <Poster
                                                    src={item.poster}
                                                    itemId={item.itemId || item.id}
                                                    itemType={item.type}
                                                    className="w-full h-full object-cover"
                                                />
                                                {episodeLabel && (
                                                    <div className="absolute bottom-1.5 left-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-xs font-bold text-white">
                                                        {episodeLabel}
                                                    </div>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    </div >

                    {/* COMMUNITY AWARDS */}
                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <Tooltip content="Leaderboards for unusual watch habits" side="top">
                                    <h2 className="text-sm font-semibold cursor-help">Community Awards</h2>
                                </Tooltip>
                                <p className="text-xs text-muted-foreground">Low-key leaderboards for unusual watch habits.</p>
                            </div>
                            <StatusChip variant="muted" icon={<Trophy />}>
                                {rankedProfileCount(stats.awards)} ranked
                            </StatusChip>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            <Card className="rounded-2xl border-border/40 bg-muted/20 shadow-none">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-3 text-sm">
                                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-info/10 text-info">
                                            <Moon className="h-4 w-4" />
                                        </span>
                                        <span>Midnight Snackers</span>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {stats.awards?.midnightSnackers?.map((u, i: number) => (
                                        <div key={u.id} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/30 bg-background/35 px-3 py-2">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="text-xs font-bold text-muted-foreground/70">#{i + 1}</span>
                                                <span className="truncate text-sm font-bold">{maskAccountName(u.name)}</span>
                                            </div>
                                            <Badge variant="outline" className="shrink-0 border-info/20 bg-info/10 text-xs text-info">
                                                {u.count} late
                                            </Badge>
                                        </div>
                                    ))}
                                    {stats.awards?.midnightSnackers?.length === 0 && (
                                        <div className="rounded-xl border border-dashed border-border/40 bg-background/20 px-3 py-5 text-center">
                                            <p className="text-xs font-semibold text-muted-foreground">No night owls yet</p>
                                            <p className="text-xs text-muted-foreground/60 mt-0.5">Late-night watches will appear here.</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card className="rounded-2xl border-border/40 bg-muted/20 shadow-none">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-3 text-sm">
                                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-warning/10 text-warning">
                                            <Zap className="h-4 w-4" />
                                        </span>
                                        <span>Weekend Warriors</span>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {stats.awards?.weekendWarriors?.map((u, i: number) => (
                                        <div key={u.id} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/30 bg-background/35 px-3 py-2">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="text-xs font-bold text-muted-foreground/70">#{i + 1}</span>
                                                <span className="truncate text-sm font-bold">{maskAccountName(u.name)}</span>
                                            </div>
                                            <Badge variant="outline" className="shrink-0 border-warning/20 bg-warning/10 text-xs text-warning">
                                                {u.count} weekend
                                            </Badge>
                                        </div>
                                    ))}
                                    {stats.awards?.weekendWarriors?.length === 0 && (
                                        <div className="rounded-xl border border-dashed border-border/40 bg-background/20 px-3 py-5 text-center">
                                            <p className="text-xs font-semibold text-muted-foreground">No weekend streaks yet</p>
                                            <p className="text-xs text-muted-foreground/60 mt-0.5">Weekend watches will appear here.</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card className="rounded-2xl border-border/40 bg-muted/20 shadow-none">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-3 text-sm">
                                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-success/10 text-success">
                                            <CheckCircle className="h-4 w-4" />
                                        </span>
                                        <span>Completionists</span>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {stats.awards?.completionChampions?.map((u, i: number) => (
                                        <div key={u.id} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/30 bg-background/35 px-3 py-2">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="text-xs font-bold text-muted-foreground/70">#{i + 1}</span>
                                                <span className="truncate text-sm font-bold">{maskAccountName(u.name)}</span>
                                            </div>
                                            <Badge variant="outline" className="shrink-0 border-success/20 bg-success/10 text-xs text-success">
                                                {Math.round(u.rate)}%
                                            </Badge>
                                        </div>
                                    ))}
                                    {stats.awards?.completionChampions?.length === 0 && (
                                        <div className="rounded-xl border border-dashed border-border/40 bg-background/20 px-3 py-5 text-center">
                                            <p className="text-xs font-semibold text-muted-foreground">No finishers yet</p>
                                            <p className="text-xs text-muted-foreground/60 mt-0.5">High completion rates will appear here.</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>


                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <Tooltip content="Best and current streaks by account" side="top">
                                    <h2 className="text-sm font-semibold cursor-help">Streak Hall of Fame</h2>
                                </Tooltip>
                                <p className="text-xs text-muted-foreground">Best and current streaks by account.</p>
                            </div>
                            <StatusChip variant="muted">{stats.streakMasters?.length || 0} profiles</StatusChip>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {stats.streakMasters?.map((u, i: number) => (
                                <Card key={u.id} className="rounded-2xl border-border/40 bg-muted/25 shadow-none">
                                    <CardContent className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <div className="font-semibold text-sm text-muted-foreground/70">#{i + 1}</div>
                                            <div>
                                                <div className="font-semibold">{maskAccountName(u.name)}</div>
                                                <div className="text-xs text-muted-foreground">{u.currentStreak > 0 ? "Active now" : "Inactive"}</div>
                                            </div>
                                        </div>
                                        <div className="text-right space-y-1">
                                            <div>
                                                <span className="text-2xl font-bold tabular-nums">{u.bestStreak}</span>
                                                <span className="text-xs font-medium text-muted-foreground ml-1">best</span>
                                            </div>
                                            {u.currentStreak > 0 && (
                                                <StatusChip variant="warning" className="ml-auto">{u.currentStreak} current</StatusChip>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>

                    {/* VIEWING PULSE */}
                    <div>
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                                    Viewing Pulse
                                    <StatusChip variant="muted">{selectedPeriodLabel}</StatusChip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="grid gap-3 md:grid-cols-3">
                                    <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-muted/15 p-4">
                                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            <Clock className="h-3.5 w-3.5 text-info" />
                                            Peak hour
                                        </div>
                                        <div className="mt-3 text-2xl font-bold tracking-tight">{formatMetricHour(stats.maxActivityHour)}</div>
                                        <p className="mt-1 text-xs text-muted-foreground">Busiest watch window.</p>
                                    </div>
                                    <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-muted/15 p-4">
                                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            <Tv className="h-3.5 w-3.5 text-success" />
                                            Series loyalty
                                        </div>
                                        <div className="mt-3 text-2xl font-bold tracking-tight">
                                            <StatNumber value={Math.round(stats.seriesLoyalty)} animate={ticked(Math.round(stats.seriesLoyalty), entrance?.loyalty)} />%
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">Top shows' share of series plays.</p>
                                    </div>
                                    <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-muted/15 p-4">
                                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            <Crown className="h-3.5 w-3.5 text-warning" />
                                            Most replayed
                                        </div>
                                        <div className="mt-3 truncate text-lg font-bold tracking-tight">{stats.theLoop?.item?.name || 'No loop yet'}</div>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {stats.theLoop ? `${stats.theLoop.count} plays in this window.` : 'Repeat favorites will appear here.'}
                                        </p>
                                    </div>
                                </div>
                                {stats.firstWatch ? (() => {
                                    const fw = stats.firstWatch!
                                    const daysAgo = Math.floor((Date.now() - new Date(fw.date).getTime()) / 86400000)
                                    const relativeTime = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo < 7 ? `${daysAgo} days ago` : daysAgo < 30 ? `${Math.floor(daysAgo / 7)} weeks ago` : daysAgo < 365 ? `${Math.floor(daysAgo / 30)} months ago` : `${Math.floor(daysAgo / 365)}y ago`
                                    return (
                                    <motion.div
                                        data-theme-part="panel"
                                        {...pressable(() => openDetail(fw.item.type, fw.item.itemId, fw.item.name, fw.item.poster))}
                                        className={cn("group relative flex cursor-pointer items-stretch gap-0 overflow-hidden rounded-2xl border border-border/35 bg-muted/15", PRESSABLE_FOCUS)}
                                        initial={{ opacity: 0, y: 8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
                                        whileHover={{ scale: 1.01 }}
                                    >
                                        <div className="relative h-20 w-14 shrink-0 overflow-hidden">
                                            <Poster
                                                src={fw.item.poster}
                                                itemId={fw.item.itemId || fw.item.id}
                                                itemType={fw.item.type}
                                                alt={fw.item.name || ""}
                                                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
                                            />
                                            <div className="absolute inset-0 bg-gradient-to-r from-transparent to-muted/15" />
                                        </div>
                                        <div className="flex flex-1 items-center justify-between gap-2 px-3 py-2">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary/70">
                                                    <PlayCircle className="h-3 w-3" />
                                                    Where it began
                                                </div>
                                                <div className="truncate text-sm font-bold">{fw.item.name}</div>
                                                <div className="text-xs text-muted-foreground">{relativeTime}</div>
                                            </div>
                                            <div className="shrink-0 text-right">
                                                <div className="text-lg font-bold tabular-nums leading-none">{stats.totalItems}</div>
                                                <div className="text-[10px] text-muted-foreground">watched since</div>
                                            </div>
                                        </div>
                                    </motion.div>
                                    )
                                })() : (
                                    <div className="rounded-2xl border border-dashed border-border/40 bg-background/20 p-4 text-center text-xs font-semibold text-muted-foreground">
                                        No first-watch signal for this window yet.
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                    </>
                    )}
                </TabsContent >
                <TabsContent value="community" className="space-y-6">
                    {/* User Profiles */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-sm font-semibold">User Profiles</h2>
                            <StatusChip variant="muted">{stats.userPersonas?.length || 0} profiles</StatusChip>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {stats.userPersonas?.map((u) => {
                                const traits = stats.userTraits?.find((t) => t.id === u.id)
                                return (
                                    <Card key={u.id} className="rounded-2xl bg-card/50 border border-border/40 shadow-sm">
                                        <CardContent className="p-4 space-y-3">
                                            <div className="flex items-center gap-3">
                                                <div className="relative w-10 h-10 shrink-0 flex items-center justify-center">
                                                    <SquircleOverlay />
                                                    <span className="relative z-10 text-sm font-bold text-muted-foreground">{maskAccountName(u.name)[0]}</span>
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="font-bold text-sm truncate">{maskAccountName(u.name)}</div>
                                                    <div className="flex flex-wrap gap-1 mt-1.5">
                                                        {u.badges.map((b, bi: number) => {
                                                            const BadgeIcon = IconMap[b.icon] || Flame
                                                            const s = CHART_PALETTE[b.color] || CHART_PALETTE.blue
                                                            return (
                                                                <Tooltip key={bi} content={PERSONA_DESCRIPTIONS[b.type] || 'Earned through watch behavior'} side="top">
                                                                    <span
                                                                        data-theme-part="badge"
                                                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium border cursor-help"
                                                                        style={{ background: s.bg, color: s.text, borderColor: s.border }}
                                                                    >
                                                                        <BadgeIcon className="h-2.5 w-2.5" />
                                                                        {b.type}
                                                                    </span>
                                                                </Tooltip>
                                                            )
                                                        })}
                                                        {u.badges.length === 0 && <span className="text-xs font-semibold text-muted-foreground">No standout habit yet</span>}
                                                    </div>
                                                </div>
                                            </div>
                                            {traits && (
                                                <div className="flex gap-2">
                                                    <Tooltip content={CHRONOTYPE_DESCRIPTIONS[traits.chronotype.label] || 'Peak watching time'} side="top">
                                                        <div data-theme-part="panel" className="flex items-center gap-2 p-2 bg-muted/30 rounded-xl border border-border/40 flex-1 min-w-0 cursor-help">
                                                            {(() => {
                                                                const ChronoIcon = IconMap[traits.chronotype.icon] || Clock
                                                                const s = CHART_PALETTE[traits.chronotype.color] || CHART_PALETTE.blue
                                                                return (
                                                                    <>
                                                                        <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: s.bg }}>
                                                                            <ChronoIcon className="h-3 w-3" style={{ color: s.text }} />
                                                                        </div>
                                                                        <div className="text-xs font-bold truncate">{traits.chronotype.label}</div>
                                                                    </>
                                                                )
                                                            })()}
                                                        </div>
                                                    </Tooltip>
                                                    <Tooltip content={FORMAT_DESCRIPTIONS[traits.formatLoyalty.label] || 'Content format preference'} side="top">
                                                        <div data-theme-part="panel" className="flex items-center gap-2 p-2 bg-muted/30 rounded-xl border border-border/40 flex-1 min-w-0 cursor-help">
                                                            {(() => {
                                                                const FormatIcon = IconMap[traits.formatLoyalty.icon] || LayoutGrid
                                                                const s = CHART_PALETTE[traits.formatLoyalty.color] || CHART_PALETTE.blue
                                                                return (
                                                                    <>
                                                                        <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: s.bg }}>
                                                                            <FormatIcon className="h-3 w-3" style={{ color: s.text }} />
                                                                        </div>
                                                                        <div className="text-xs font-bold truncate">{traits.formatLoyalty.label}</div>
                                                                    </>
                                                                )
                                                            })()}
                                                        </div>
                                                    </Tooltip>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                )
                            })}
                        </div>
                    </div>

                    {/* 1. TOP STREAMERS (FULL LIST) - REDESIGNED */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-sm font-semibold">Community Leaderboard</h2>
                            <StatusChip variant="muted">{stats.leaderboard?.length || 0} profiles</StatusChip>
                        </div>
                        <div className="grid grid-cols-1 gap-3">
                            {stats.leaderboard?.map((user) => (
                                <Card
                                    key={user.name}
                                    className={cn(
                                        "overflow-visible rounded-3xl border-border/40 bg-card/55 shadow-sm ring-1 ring-white/5 group transition-[transform,opacity,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-border hover:shadow-lg",
                                        user.rank === 1 ? "border-primary/30 bg-gradient-to-br from-primary/10 via-card/70 to-card/40" : ""
                                    )}
                                >
                                    <CardContent className="p-4">
                                        <div className="flex flex-col gap-4">
                                            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                                                <div className="flex items-center gap-4 w-full sm:w-auto">
                                                    <div className={cn(
                                                        "w-10 text-center text-2xl font-black tabular-nums transition-colors duration-300 shrink-0",
                                                        user.rank === 1 ? "text-primary" : "text-muted-foreground/35"
                                                    )}>#{user.rank}</div>
                                                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-border/40 bg-muted/35 text-sm font-bold text-muted-foreground shadow-inner overflow-hidden">
                                                        {(() => {
                                                            const acc = accountsById.get(user.id)
                                                            if (acc?.avatar) return <img src={acc.avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                                                            if (acc?.emoji) return <span className="text-lg">{acc.emoji}</span>
                                                            return user.avatarChar
                                                        })()}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="font-semibold text-base tracking-tight truncate">{maskAccountName(user.name)}</div>
                                                            {user.rank === 1 && <StatusChip variant="primary">Lead</StatusChip>}
                                                        </div>
                                                        <div className="text-xs font-medium text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 mt-1">
                                                            <span className="flex items-center gap-1"><PlayCircle className="h-3 w-3 text-primary" /> {user.count}</span>
                                                            <span className="flex items-center gap-1"><Clock className="h-3 w-3 text-primary/80" /> {Math.round(user.duration / 60)}h</span>
                                                            {user.bestStreak > 3 && (
                                                                <span className="flex items-center gap-1 text-warning">
                                                                    <Flame className="h-3 w-3" /> {user.bestStreak}d
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2 self-end sm:self-center">
                                                    {stats.bingeMasters?.[0]?.id === user.id && (
                                                        <Badge variant="outline" className="bg-primary/12 text-primary border-primary/25 px-2 py-0.5 text-xs sm:text-xs font-bold italic">
                                                            BINGE KING
                                                        </Badge>
                                                    )}
                                                    {user.currentStreak > 0 && (
                                                        <Badge className="bg-success text-white hover:bg-success/80 font-bold px-2 py-0.5 text-xs sm:text-xs animate-pulse">
                                                            ON FIRE
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>

                                            {/* History Carousel */}
                                            <div className="w-full overflow-x-auto py-3 scrollbar-hide">
                                                <div className="flex items-center gap-3 px-0.5">
                                                    {user.recentHistory.map((h) => {
                                                        const episodeLabel = formatEpisodeLabel(h)
                                                        return (
                                                            <div
                                                                key={h.id}
                                                                {...pressable(() => openDetail(h.type, h.itemId, h.name, h.poster), h.name)}
                                                                className={cn("content-auto-poster flex-none w-20 sm:w-24 aspect-[2/3] relative group/poster transition-transform hover:-translate-y-1 cursor-pointer rounded-xl", PRESSABLE_FOCUS)}
                                                            >
                                                                <Poster
                                                                    src={h.poster}
                                                                    itemId={h.itemId || h.id}
                                                                    itemType={h.type}
                                                                    className="w-full h-full object-cover rounded-xl shadow-md"
                                                                />
                                                                <div className="absolute inset-0 bg-black/20 group-hover/poster:bg-transparent transition-colors rounded-md" />
                                                                {episodeLabel && (
                                                                    <div className="absolute bottom-1.5 left-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-xs font-bold text-white shadow-sm">
                                                                        {episodeLabel}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>

                    {/* MOVED STREAK HALL OF FAME TO PULSE */}

                </TabsContent >

                {/* TAB 4: THE VAULT (Hall of Fame) */}
                <TabsContent value="collection" className="space-y-6">
                    <div className="grid md:grid-cols-2 gap-4">
                        {/* FORMAT DNA */}
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                                    <Tooltip content="Your content mix across movies, series, and other formats" side="top">
                                        <span className="cursor-help">Format DNA</span>
                                    </Tooltip>
                                    <StatusChip variant="muted"><StatNumber value={stats.totalItems} animate={ticked(stats.totalItems, entrance?.totalItems)} /> titles</StatusChip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ContentDonut typeCounts={stats.typeCounts} />
                            </CardContent>
                        </Card>

                        {/* WEEK OVER WEEK */}
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center justify-between gap-2 text-sm">
                                    <Tooltip content="Week-over-week comparison of your watch activity" side="top">
                                        <span className="cursor-help">Time Dilation</span>
                                    </Tooltip>
                                    <StatusChip variant="primary">{formatHoursAsDays(stats.totalHours)}</StatusChip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <WeekComparison
                                    thisWeekCount={stats.thisWeekCount}
                                    lastWeekCount={stats.lastWeekCount}
                                    weekOverWeek={stats.weekOverWeek}
                                />
                            </CardContent>
                        </Card>
                    </div>

                    {/* SHARED UNIVERSE (ACCOUNT OVERLAP) */}
                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-semibold">Shared Universe</h2>
                                <p className="text-xs text-muted-foreground">Titles watched by multiple accounts.</p>
                            </div>
                            <StatusChip variant="muted">{stats.sharedUniverse?.length || 0} shared</StatusChip>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                            {stats.sharedUniverse?.map((c, i: number) => {
                                const sharedAccs = c.accounts.map(
                                    (acc: { id: string }) => accountsById.get(acc.id)
                                ).filter((acc): acc is Account => acc !== undefined)
                                return (
                                    <div
                                        key={i}
                                        {...pressable(() => openDetail(c.item.type, c.item.itemId, c.item.name, c.item.poster), c.item.name)}
                                        className={cn("content-auto-poster relative aspect-[2/3] group cursor-pointer overflow-hidden rounded-2xl border border-border/40 shadow-sm", PRESSABLE_FOCUS)}
                                    >
                                        <div className="absolute top-2 left-2 z-20 rounded-full bg-black/55 px-2 py-0.5 text-xs font-semibold uppercase text-white backdrop-blur-sm">
                                            Shared
                                        </div>
                                        <Poster
                                            src={c.item.poster}
                                            itemId={c.item.itemId || c.item.id}
                                            itemType={c.item.type}
                                            alt={c.item.name || ""}
                                            className="w-full h-full object-cover transition-transform group-hover:scale-105"
                                        />
                                        {sharedAccs.length > 0 && (
                                            <div className="absolute bottom-2 right-2 z-10 flex items-center -space-x-1.5">
                                                {sharedAccs.slice(0, 3).map((acc) => (
                                                    <div key={acc.id} className="h-5 w-5 rounded-full border border-background overflow-hidden bg-card shadow-sm flex items-center justify-center">
                                                        {acc.avatar ? (
                                                            <img src={acc.avatar} alt="" className="h-full w-full object-cover" loading="lazy" />
                                                        ) : acc.emoji ? (
                                                            <span className="text-[9px]">{acc.emoji}</span>
                                                        ) : (
                                                            <span className="text-[8px] font-bold text-muted-foreground">{(maskAccountName(acc.name || '?')[0] || '?').toUpperCase()}</span>
                                                        )}
                                                    </div>
                                                ))}
                                                {sharedAccs.length > 3 && (
                                                    <div className="h-5 w-5 rounded-full border border-background bg-card shadow-sm flex items-center justify-center">
                                                        <span className="text-[8px] font-bold text-muted-foreground">+{sharedAccs.length - 3}</span>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 to-transparent">
                                            <div className="text-xs font-bold text-white truncate">{c.item.name}</div>
                                            {c.firstSeen && (
                                                <div className="text-xs text-white/50 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                                                    First watched {new Date(c.firstSeen).toLocaleDateString()}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-sm font-semibold">Global Hall of Fame</h2>
                            <StatusChip variant="muted">{stats.topAllTime?.length || 0} titles</StatusChip>
                        </div>
                        {stats.topAllTime?.length > 0 ? (
                            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                {stats.topAllTime?.map((stat, i: number) => {
                                    const watchAccs = watchersByItemId.get(stat.item.itemId) ?? []
                                    return (
                                    <div key={stat.item.id} {...pressable(() => openDetail(stat.item.type, stat.item.itemId, stat.item.name, stat.item.poster), stat.item.name)} className={cn("content-auto-poster group relative aspect-[2/3] rounded-2xl overflow-hidden border border-border/40 bg-muted shadow-sm cursor-pointer transition-transform hover:-translate-y-1", PRESSABLE_FOCUS)}>
                                        <Poster
                                            src={stat.item.poster}
                                            itemId={stat.item.itemId || stat.item.id}
                                            itemType={stat.item.type}
                                            alt={stat.item.name || ""}
                                            className="w-full h-full object-cover"
                                        />
                                        <WatcherBadges accounts={watchAccs} maskName={maskAccountName} />
                                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent flex flex-col justify-end p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <div className="text-4xl font-bold text-white mb-1">#{i + 1}</div>
                                            <div className="text-xs font-medium text-white/80 uppercase">{stat.count} Plays</div>
                                        </div>
                                    </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <EmptyState
                                icon={<Crown className="h-6 w-6" />}
                                title="No all-time data yet"
                                description="Hit a long watch streak and your top titles will appear here. The Hall of Fame ranks across every connected account."
                            />
                        )}
                    </div>

                    {/* HIDDEN GEMS */}
                    <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-sm font-semibold">Hidden Gems</h2>
                            <StatusChip variant="muted">{stats.rareFinds?.length || 0} rare</StatusChip>
                        </div>
                        <div className="flex flex-wrap gap-4">
                            {stats.rareFinds?.map((item) => {
                                const acc = accountsById.get(item.accountId)
                                const watchAccs = acc ? [acc] : []
                                return (
                                <div
                                    key={item.itemId}
                                    {...pressable(() => openDetail(item.type, item.itemId, item.name, item.poster), item.name)}
                                    className={cn("content-auto-poster group relative w-28 aspect-[2/3] rounded-xl overflow-hidden border border-border/40 shadow-sm transition-transform hover:-translate-y-1 cursor-pointer", PRESSABLE_FOCUS)}
                                >
                                    <Poster
                                        src={item.poster}
                                        itemId={item.itemId || item.id}
                                        itemType={item.type}
                                        alt={item.name || ""}
                                        className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-[transform,opacity,box-shadow] duration-500"
                                    />
                                    <WatcherBadges accounts={watchAccs} maskName={maskAccountName} />
                                    <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                        <div className="text-xs font-medium text-white">{maskAccountName(item.accountName)}'s Choice</div>
                                    </div>
                                    <div className="absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">
                                        Rare
                                    </div>
                                </div>
                                )
                            })}
                            {stats.rareFinds?.length === 0 && (
                                <div className="p-8 bg-muted/10 rounded-xl w-full text-center border-2 border-dashed border-border/40">
                                    <p className="text-sm font-semibold text-muted-foreground">No rare finds yet</p>
                                    <p className="text-xs text-muted-foreground mt-1">You all watch the same things!</p>
                                </div>
                            )}
                        </div>
                    </div>

                </TabsContent >


                {/* TAB 6: PERSONALITY (Watch DNA) */}
                <TabsContent value="insights" className="space-y-6">
                    {/* ACTIVITY PATTERNS */}
                    <div className="grid md:grid-cols-2 gap-4">
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    Hourly Activity
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ActivityHeatmap itemsByHour={stats.itemsByHour} />
                            </CardContent>
                        </Card>

                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    30-Day Trend
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ActivitySparkline streakMap={stats.streakMap} />
                            </CardContent>
                        </Card>
                    </div>

                    {/* WEEKLY RHYTHM */}
                    <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-sm">
                                <Tooltip content="Which days of the week you watch most" side="top">
                                    <span className="cursor-help">Weekly Rhythm</span>
                                </Tooltip>
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <WeeklyRhythm weeklyRhythm={stats.weeklyRhythm} />
                        </CardContent>
                    </Card>

                    {/* WATCH FUNNEL + SESSION DEPTH */}
                    <div className="grid md:grid-cols-2 gap-4">
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">Watch Funnel</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <WatchFunnel funnel={stats.funnel} />
                            </CardContent>
                        </Card>
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    <Tooltip content="How many episodes you watch per sitting" side="top">
                                        <span className="cursor-help">Session Depth</span>
                                    </Tooltip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <SessionDepth sessionDepths={stats.sessionDepths} />
                            </CardContent>
                        </Card>
                    </div>

                    {/* DROP-OFF POINT + COMEBACKS */}
                    <div className="grid md:grid-cols-2 gap-4">
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    <Tooltip content="Average episodes watched before abandoning a series" side="top">
                                        <span className="cursor-help">Drop-off Point</span>
                                    </Tooltip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <DropOffPoint avgEpisodes={stats.dropOffAvg} />
                            </CardContent>
                        </Card>
                        <Card className="rounded-2xl border-border/40 bg-card/50 shadow-sm">
                            <CardHeader className="pb-3">
                                <CardTitle className="flex items-center gap-2 text-sm">
                                    <Tooltip content="Titles you returned to after 2+ weeks away" side="top">
                                        <span className="cursor-help">Comebacks</span>
                                    </Tooltip>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <ComebackRate titles={stats.comebackTitles} />
                            </CardContent>
                        </Card>
                    </div>

                        {/* Franchise Spotlight */}
                        <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-4 mt-6">
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-sm font-semibold">Franchise Focus</h2>
                                <StatusChip variant="muted">{stats.franchiseFocus?.length || 0} groups</StatusChip>
                            </div>
                            <FranchiseBars franchiseFocus={stats.franchiseFocus} />
                        </div>

                        {/* BINGE VELOCITY */}
                        <div data-theme-part="card" className="rounded-2xl border border-border/40 bg-card/50 p-3 shadow-sm space-y-4 mt-6">
                            <div className="flex items-center justify-between gap-3">
                                <h2 className="text-sm font-semibold">Binge Velocity</h2>
                                <StatusChip variant="muted">{stats.contentVelocity?.length || 0} tracked</StatusChip>
                            </div>
                            <VelocityChart contentVelocity={stats.contentVelocity} />
                        </div>

                </TabsContent >
                </> )}
            </Tabs >

            {detailModalSeen && (
            <Suspense fallback={null}>
            <ActivityDetailModal
                open={!!detailItem}
                onOpenChange={(open: boolean) => { if (!open) setDetailItem(null) }}
                item={detailItem}
            />
            </Suspense>
            )}
        </div >
    )
}
