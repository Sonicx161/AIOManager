import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MetricsPageSkeleton } from '@/components/ui/skeleton'
import { useActivityStore } from '@/store/activityStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useMetricsWorker } from '@/hooks/useMetricsWorker'
import { useAccountStore } from '@/store/accountStore'
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
    Hammer,
    RefreshCw,
    Sun,
    Coffee,
    LayoutGrid,
} from 'lucide-react'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '../components/ui/avatar'
import { cn, openStremioDetail } from '@/lib/utils'
import { Poster } from '@/components/common/Poster'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"

const IconMap: Record<string, React.ElementType> = {
    CheckCircle, Ghost, Moon, Flame, Zap, Clock, Sun, Coffee, Tv, LayoutGrid, Film
}

export function MetricsPage() {
    const navigate = useNavigate()
    // const { history, initialize, fetchActivity } = useActivityStore() // Deprecated for display
    const { initialize } = useActivityStore()
    const { accounts } = useAccountStore()
    const { items: history, loading: cacheLoading, ensureLoaded, loadingProgress } = useLibraryCache()

    const [selectedAccountId, setSelectedAccountId] = useState<string>('all')

    const filteredHistory = selectedAccountId === 'all'
        ? history
        : history.filter(item => item.accountId === selectedAccountId)

    const { results: stats, isComputing: workerLoading } = useMetricsWorker(filteredHistory)

    useEffect(() => {
        // We still init activityStore for background tasks/deletion logic availability
        initialize().then(() => {
            if (accounts.length > 0) {
                ensureLoaded(accounts)
            }
        })
    }, [initialize, accounts, ensureLoaded])

    if (!stats || workerLoading) {
        return (
            <div>
                <MetricsPageSkeleton />
                <div className="mt-4 text-center text-sm text-muted-foreground font-mono animate-pulse">
                    {cacheLoading
                        ? (loadingProgress.current > 0 ? `Synced ${loadingProgress.current} of ${loadingProgress.total} accounts` : 'Connecting to Stremio...')
                        : 'Crunching numbers...'}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-8 pb-32 animate-in fade-in duration-700">
            {/* HEADER */}
            <div className="px-4 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="flex items-center justify-between md:block">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
                        <p className="text-muted-foreground mt-1">
                            Community Core insights and global statistics.
                        </p>
                    </div>
                    {(cacheLoading) && (
                        <div className="flex md:hidden items-center gap-2 text-xs font-bold text-primary animate-pulse bg-primary/10 px-3 py-1.5 rounded-full border border-primary/20">
                            <Activity className="h-3 w-3" />
                            Syncing...
                        </div>
                    )}
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 lg:gap-3">
                    {(cacheLoading) && (
                        <div className="hidden md:flex items-center gap-2 text-xs font-bold text-primary animate-pulse bg-primary/10 px-3 py-1.5 rounded-full border border-primary/20">
                            <Activity className="h-3 w-3" />
                            Syncing...
                        </div>
                    )}
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                            <SelectTrigger className="flex-1 sm:w-[180px] h-10 bg-white/5 border-white/10">
                                <SelectValue placeholder="All Accounts" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Accounts</SelectItem>
                                {(() => {
                                    const activeAccountIds = new Set(history.map(h => h.accountId))
                                    return accounts
                                        .filter(acc => activeAccountIds.has(acc.id))
                                        .map(acc => (
                                            <SelectItem key={acc.id} value={acc.id}>
                                                <div className="flex items-center gap-2">
                                                    {acc.emoji && <span>{acc.emoji}</span>}
                                                    <span className="truncate">{acc.name || acc.email || 'Unknown Account'}</span>
                                                </div>
                                            </SelectItem>
                                        ))
                                })()}
                            </SelectContent>
                        </Select>
                        <Button
                            size="sm"
                            onClick={() => navigate('/replay')}
                            className="flex-1 sm:flex-none h-10 px-4 text-black border-none font-black shadow-lg shadow-primary/20 group overflow-hidden relative animate-shimmer-bg transition-transform active:scale-95 flex items-center justify-center gap-2"
                            style={{
                                background: 'linear-gradient(90deg, #818cf8 0%, #a78bfa 25%, #f472b6 50%, #a78bfa 75%, #818cf8 100%)',
                                backgroundSize: '200% auto',
                            }}
                        >
                            <motion.div
                                initial="initial"
                                animate="animate"
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
                    {!cacheLoading && (
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button
                                    size="sm"
                                    className="w-full sm:w-auto h-10 px-4 bg-yellow-500 hover:bg-yellow-400 text-black border border-yellow-600/20 font-bold"
                                >
                                    <Hammer className="mr-2 h-3.5 w-3.5" />
                                    Force Resync
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="w-[95vw] sm:w-full max-w-lg">
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Resync Activity Data?</AlertDialogTitle>
                                    <AlertDialogDescription asChild>
                                        <div className="space-y-2">
                                            <p>
                                                This will <strong>discard the local cache</strong> and re-fetch fresh data from Stremio.
                                            </p>
                                            <div className="bg-primary/10 p-3 rounded-md border border-primary/20 text-xs text-primary font-medium">
                                                <p>✨ <strong>Self-Healing</strong></p>
                                                <p className="mt-1 font-normal opacity-90">
                                                    If numbers look wrong or "phantom" items appear, this will fix it by mirroring exactly what is on your Stremio account.
                                                </p>
                                            </div>
                                        </div>
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                                    <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                        onClick={() => {
                                            useLibraryCache.getState().invalidate()
                                            useLibraryCache.getState().ensureLoaded(accounts)
                                        }}
                                        className="bg-primary hover:bg-primary/90 text-white"
                                    >
                                        <RefreshCw className="mr-2 h-4 w-4" />
                                        Resync Now
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    )}
                </div>
            </div>

            <Tabs defaultValue="pulse" className="w-full">
                <div className="mb-8 px-4">
                    <TabsList className="flex flex-wrap h-auto bg-transparent p-0 gap-2 justify-start w-full">
                        <TabsTrigger value="pulse" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30">Pulse</TabsTrigger>
                        <TabsTrigger value="community" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30">Community</TabsTrigger>
                        <TabsTrigger value="personality" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30">Personality</TabsTrigger>
                        <TabsTrigger value="vault" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30">Vault</TabsTrigger>
                        <TabsTrigger value="deep-dive" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30">Deep Dive</TabsTrigger>
                    </TabsList>
                </div>

                {/* TAB 1: PULSE (Overview) */}
                <TabsContent value="pulse" className="space-y-12">



                    {/* KEY METRICS GRID */}
                    <div className="px-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <Card className="bg-primary/5 border-primary/10">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-4">
                                    <div className="p-3 bg-primary/10 rounded-xl">
                                        <Activity className="h-6 w-6 text-primary" />
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
                                    {stats.topTrending.map((item: any, i: number) => (
                                        <div
                                            key={item.id}
                                            onClick={() => {
                                                openStremioDetail(item.type, item.itemId || item.id)
                                            }}
                                            className="relative w-32 h-48 md:w-40 md:h-60 shrink-0 rounded-xl overflow-hidden shadow-xl group cursor-pointer transition-transform hover:-translate-y-2"
                                        >
                                            <div className="absolute top-2 left-2 z-10 bg-orange-500/90 text-white font-black text-xs px-2 py-1 rounded shadow-lg">#{i + 1}</div>
                                            <Poster
                                                src={item.poster}
                                                itemId={item.itemId || item.id}
                                                itemType={item.type}
                                                className="w-full h-full object-cover"
                                            />
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                                                <div className="text-white text-sm font-bold truncate">{item.name}</div>
                                            </div>
                                        </div>
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
                    < div className="px-4" >
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
                                    {stats.bingeMasters[0]?.bingeItems.slice(0, 5).map((item: any, i: number) => (
                                        <div
                                            key={item.id}
                                            onClick={() => {
                                                openStremioDetail(item.type, item.itemId || item.id)
                                            }}
                                            className="relative w-16 h-24 rounded-lg border-2 border-background overflow-hidden shadow-lg transition-transform hover:-translate-y-2 cursor-pointer"
                                            style={{ zIndex: 5 - i }}
                                        >
                                            <Poster
                                                src={item.poster}
                                                itemId={item.itemId || item.id}
                                                itemType={item.type}
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    </div >

                    {/* COMMUNITY AWARDS */}
                    < div className="px-4 space-y-6" >
                        <div className="flex items-center gap-3">
                            <Trophy className="h-6 w-6 text-yellow-500" />
                            <h2 className="text-2xl font-black">Community Awards</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {/* Midnight Snackers */}
                            <Card className="bg-primary/5 border-primary/20 group hover:border-primary/40 transition-colors">
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-2 text-primary/80">
                                        <Moon className="h-4 w-4" /> Midnight Snackers
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {stats.awards.midnightSnackers.map((u: any, i: number) => (
                                        <div key={u.id} className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-black text-primary/50">#{i + 1}</span>
                                                <span className="font-bold text-sm truncate max-w-[120px]">{u.name}</span>
                                            </div>
                                            <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/20">
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
                                    {stats.awards.weekendWarriors.map((u: any, i: number) => (
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
                                    {stats.awards.completionChampions.map((u: any, i: number) => (
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
                    </div >


                    <div className="px-4 space-y-6">
                        <div className="flex items-center gap-3">
                            <Flame className="h-6 w-6 text-orange-500" />
                            <h2 className="text-2xl font-black">Streak Hall of Fame</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {stats.streakMasters.map((u: any, i: number) => (
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
                                    <PieChart className="h-5 w-5 text-primary/80" /> Content Mix
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
                </TabsContent >

                {/* TAB 2: COMMUNITY (Leaderboards) */}
                < TabsContent value="community" className="space-y-12 px-4" >
                    {/* 1. TOP STREAMERS (FULL LIST) - REDESIGNED */}
                    < div className="space-y-6" >
                        <div className="flex items-center gap-3">
                            <Users className="h-6 w-6 text-blue-500" />
                            <h2 className="text-2xl font-black">Community Leaderboard</h2>
                        </div>
                        <div className="grid grid-cols-1 gap-6">
                            {stats.leaderboard.map((user: any) => (
                                <Card
                                    key={user.name}
                                    className={cn(
                                        "overflow-hidden group hover:border-primary/40 transition-all duration-500",
                                        user.rank === 1 ? "border-yellow-500/50 bg-yellow-500/5 shadow-[0_0_30px_rgba(234,179,8,0.1)]" : ""
                                    )}
                                >
                                    <CardContent className="p-4 sm:p-8">
                                        <div className="flex flex-col gap-4 sm:gap-6">
                                            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-6">
                                                <div className="flex items-center gap-4 sm:gap-6 w-full sm:w-auto">
                                                    <div className={cn(
                                                        "text-3xl sm:text-5xl font-black transition-colors duration-500 shrink-0",
                                                        user.rank === 1 ? "text-yellow-500" : "text-muted-foreground/30"
                                                    )}>#{user.rank}</div>
                                                    <Avatar className={cn(
                                                        "h-12 w-12 sm:h-20 sm:w-20 border-2 sm:border-4 border-background shadow-2xl transition-transform group-hover:scale-110 duration-500 shrink-0",
                                                        user.rank === 1 ? "border-yellow-500" : ""
                                                    )}>
                                                        <AvatarFallback className={cn(
                                                            "font-black text-xl sm:text-3xl",
                                                            user.rank === 1 ? "bg-yellow-500 text-black" : ""
                                                        )}>{user.avatarChar}</AvatarFallback>
                                                    </Avatar>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2 sm:gap-3">
                                                            <div className="font-black text-xl sm:text-3xl tracking-tight truncate">{user.name}</div>
                                                            {user.rank === 1 && <Crown className="h-4 w-4 sm:h-6 sm:w-6 text-yellow-500 animate-bounce shrink-0" />}
                                                        </div>
                                                        <div className="text-[10px] sm:text-xs font-bold text-muted-foreground uppercase flex flex-wrap gap-x-3 gap-y-1 mt-1">
                                                            <span className="flex items-center gap-1"><PlayCircle className="h-3 w-3 text-primary" /> {user.count}</span>
                                                            <span className="flex items-center gap-1"><Clock className="h-3 w-3 text-primary/80" /> {Math.round(user.duration / 60)}h</span>
                                                            {user.bestStreak > 3 && (
                                                                <span className="flex items-center gap-1 text-orange-500">
                                                                    <Flame className="h-3 w-3" /> {user.bestStreak}d
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2 self-end sm:self-center">
                                                    {stats.bingeMasters[0]?.id === user.id && (
                                                        <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/20 px-2 py-0.5 text-[9px] sm:text-[10px] font-black italic">
                                                            BINGE KING
                                                        </Badge>
                                                    )}
                                                    {user.currentStreak > 0 && (
                                                        <Badge className="bg-emerald-500 text-white hover:bg-emerald-600 font-bold px-2 py-0.5 text-[9px] sm:text-[10px] animate-pulse">
                                                            ON FIRE
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>

                                            {/* History Carousel */}
                                            <div className="w-full overflow-x-auto pb-2 scrollbar-hide">
                                                <div className="flex items-center gap-4">
                                                    {user.recentHistory.map((h: any) => (
                                                        <div
                                                            key={h.id}
                                                            onClick={() => {
                                                                openStremioDetail(h.type, h.itemId)
                                                            }}
                                                            className="flex-none w-24 aspect-[2/3] relative group/poster transition-transform hover:-translate-y-2 cursor-pointer"
                                                        >
                                                            <Poster
                                                                src={h.poster}
                                                                itemId={h.itemId || h._id}
                                                                itemType={h.type}
                                                                className="w-full h-full object-cover rounded-md shadow-md"
                                                            />
                                                            <div className="absolute inset-0 bg-black/20 group-hover/poster:bg-transparent transition-colors rounded-md" />
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div >

                    {/* MOVED STREAK HALL OF FAME TO PULSE */}

                </TabsContent >

                {/* TAB 3: DEEP DIVE (Pro Stats) */}
                < TabsContent value="deep-dive" className="space-y-8 px-4" >
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
                                <CardTitle className="flex items-center gap-2 text-primary">
                                    <Activity className="h-5 w-5" /> The Loop
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                {stats.theLoop ? (
                                    <div className="flex gap-6">
                                        <div
                                            onClick={() => {
                                                openStremioDetail(stats.theLoop.item.type, stats.theLoop.item.itemId)
                                            }}
                                            className="shrink-0 group cursor-pointer"
                                        >
                                            <Poster
                                                src={stats.theLoop.item.poster}
                                                itemId={stats.theLoop.item.itemId || stats.theLoop.item._id}
                                                itemType={stats.theLoop.item.type}
                                                className="h-40 w-28 object-cover rounded-xl shadow-2xl transition-transform group-hover:scale-105"
                                            />
                                        </div>
                                        <div className="flex-1 py-2">
                                            <div className="text-xl font-black line-clamp-2">{stats.theLoop.item.name}</div>
                                            <div className="mt-4 space-y-3">
                                                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                                    <span>Replays</span>
                                                    <span className="text-primary/80">{stats.theLoop.count} Hits</span>
                                                </div>
                                                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                                    <div className="h-full bg-primary" style={{ width: '100%' }} />
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
                                <div className="flex justify-between items-end h-16 gap-0.5 overflow-hidden">
                                    {stats.itemsByHour.map((count: number, i: number) => {
                                        const max = stats.maxActivityHour || 1
                                        const opacity = 0.1 + (count / max) * 0.9
                                        return (
                                            <div
                                                key={i}
                                                className="flex-1 min-w-[4px] rounded-sm bg-orange-500 transition-all cursor-help"
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
                                    {stats.streakMap.map((count: number, i: number) => {
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
                            {stats.contentVelocity.map((v: any, i: number) => (
                                <div
                                    key={i}
                                    onClick={() => {
                                        openStremioDetail(v.item.type, v.item.itemId)
                                    }}
                                    className="block group cursor-pointer"
                                >
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
                                </div>
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
                                    {stats.abandonedSeries.map((item: any) => (
                                        <div key={item.id} onClick={() => openStremioDetail(item.type, item.itemId)} className="relative aspect-[2/3] grayscale hover:grayscale-0 transition-all duration-500 rounded-lg overflow-hidden group cursor-pointer opacity-70 hover:opacity-100 shadow-md">
                                            <img src={item.poster} className="w-full h-full object-cover" />
                                            <div className="absolute top-1 right-1 bg-red-500 text-[10px] text-white px-1.5 rounded font-bold">
                                                {Math.round(item.progress)}%
                                            </div>
                                        </div>
                                    ))}
                                    {stats.abandonedSeries.length === 0 && <div className="text-xs italic text-muted-foreground col-span-3">No abandoned shows. Good job!</div>}
                                </div>
                            </div>

                            {/* ABANDONED MOVIES */}
                            <div className="space-y-4">
                                <h3 className="text-lg font-bold text-muted-foreground">Walked Out Movies</h3>
                                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-4">
                                    {stats.abandonedMovies.map((item: any) => (
                                        <div key={item.id} onClick={() => openStremioDetail(item.type, item.itemId)} className="relative aspect-[2/3] grayscale hover:grayscale-0 transition-all duration-500 rounded-lg overflow-hidden group cursor-pointer opacity-70 hover:opacity-100 shadow-md">
                                            <img src={item.poster} className="w-full h-full object-cover" />
                                            <div className="absolute top-1 right-1 bg-red-500 text-[10px] text-white px-1.5 rounded font-bold">
                                                {Math.round(item.progress)}%
                                            </div>
                                        </div>
                                    ))}
                                    {stats.abandonedMovies.length === 0 && <div className="text-xs italic text-muted-foreground col-span-3">No unfinished movies. Cinema lover!</div>}
                                </div>
                            </div>
                        </div>
                    </div>
                </TabsContent >

                {/* TAB 4: THE VAULT (Hall of Fame) */}
                < TabsContent value="vault" className="space-y-12 px-4" >
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
                        <Card className="bg-gradient-to-br from-primary/20 to-purple-900/20 border-border/60">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Clock className="h-5 w-5 text-primary/80" /> Time Dilation
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex flex-col items-center justify-center h-[200px] gap-4">
                                <div className="text-center space-y-2">
                                    <div className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-primary to-purple-400">
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
                            {stats.sharedUniverse.map((c: any, i: number) => (
                                <div
                                    key={i}
                                    onClick={() => openStremioDetail(c.item.type, c.item.itemId)}
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
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="flex items-center gap-3">
                            <Crown className="h-6 w-6 text-yellow-600" />
                            <h2 className="text-2xl font-black">Global Hall of Fame</h2>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                            {stats.topAllTime.map((stat: any, i: number) => (
                                <div key={stat.item.id} onClick={() => openStremioDetail(stat.item.type, stat.item.itemId)} className="group relative aspect-[2/3] rounded-xl overflow-hidden bg-muted shadow-lg cursor-pointer transition-transform hover:-translate-y-2">
                                    <img src={stat.item.poster} className="w-full h-full object-cover" />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent flex flex-col justify-end p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <div className="text-4xl font-black text-white mb-1">#{i + 1}</div>
                                        <div className="text-xs font-bold text-white/80 uppercase tracking-widest">{stat.count} Plays</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                </TabsContent >


                {/* TAB 6: PERSONALITY (Watch DNA) */}
                < TabsContent value="personality" className="space-y-12 px-4 pb-20" >

                    {/* Watch Personas */}
                    < div className="space-y-6" >
                        <div className="flex items-center gap-3">
                            <Trophy className="h-6 w-6 text-yellow-500" />
                            <h2 className="text-2xl font-black">Watch Personas</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {stats.userPersonas.map((u: any) => (
                                <Card key={u.id} className="bg-muted/5 border-border/40">
                                    <CardContent className="p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-black text-primary">
                                                {u.name[0]}
                                            </div>
                                            <div>
                                                <div className="font-bold text-sm">{u.name}</div>
                                                <div className="flex gap-1 mt-1">
                                                    {u.badges.map((b: any, bi: number) => {
                                                        const BadgeIcon = IconMap[b.icon] || Flame
                                                        return (
                                                            <Badge key={bi} variant="outline" className={`text-[8px] uppercase font-black bg-${b.color}-500/10 text-${b.color}-500 border-${b.color}-500/20 py-0 flex items-center gap-1`}>
                                                                <BadgeIcon className="h-2 w-2" />
                                                                {b.type}
                                                            </Badge>
                                                        )
                                                    })}
                                                    {u.badges.length === 0 && <span className="text-[10px] text-muted-foreground italic">Finding persona...</span>}
                                                </div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div >



                    {/* User Traits Grid */}
                    < div className="space-y-6" >
                        <div className="flex items-center gap-3">
                            <Zap className="h-6 w-6 text-orange-500" />
                            <h2 className="text-2xl font-black">Habit Profiles</h2>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {stats.userTraits.map((u: any) => (
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
                                                    {(() => {
                                                        const ChronoIcon = IconMap[u.chronotype.icon] || Clock
                                                        return <ChronoIcon className={`h-4 w-4 text-${u.chronotype.color}-500`} />
                                                    })()}
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
                                                    {(() => {
                                                        const FormatIcon = IconMap[u.formatLoyalty.icon] || LayoutGrid
                                                        return <FormatIcon className={`h-4 w-4 text-${u.formatLoyalty.color}-500`} />
                                                    })()}
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
                                <PieChart className="h-6 w-6 text-primary" />
                                <h2 className="text-2xl font-black">Franchise Focus</h2>
                            </div>
                            <div className="space-y-3">
                                {stats.franchiseFocus.map((f: any, i: number) => (
                                    <div key={i} className="space-y-1">
                                        <div className="flex justify-between text-[10px] font-black uppercase tracking-widest px-1">
                                            <span className="text-muted-foreground">{f.name}</span>
                                            <span className="text-primary/80">{f.count} Plays</span>
                                        </div>
                                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-primary transition-all duration-1000"
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
                                <Crown className="h-6 w-6 text-primary/80" />
                                <h2 className="text-2xl font-black">Hidden Gems (Rare Finds)</h2>
                            </div>
                            <div className="flex flex-wrap gap-4">
                                {stats.rareFinds.map((item: any) => (
                                    <div
                                        key={item.itemId}
                                        onClick={() => openStremioDetail(item.type, item.itemId)}
                                        className="group relative w-32 aspect-[2/3] rounded-xl overflow-hidden shadow-xl transition-transform hover:-translate-y-2 cursor-pointer"
                                    >
                                        <img src={item.poster} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
                                        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                                            <div className="text-[8px] font-black text-white uppercase">{item.accountName}'s Choice</div>
                                        </div>
                                        <div className="absolute top-2 right-2 bg-primary text-[8px] font-black text-primary-foreground px-2 py-0.5 rounded-full shadow-lg border border-white/20">
                                            Rare
                                        </div>
                                    </div>
                                ))}
                                {stats.rareFinds.length === 0 && (
                                    <div className="text-sm italic text-muted-foreground p-8 bg-muted/10 rounded-xl w-full text-center border-2 border-dashed border-border">
                                        You all watch the same things! No rare finds yet.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div >
                </TabsContent >
            </Tabs >
        </div >
    )
}
