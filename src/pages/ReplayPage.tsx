import { useMemo, useState, useEffect, useRef, startTransition } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Sparkles, AlertCircle, ChevronUp, ChevronDown, CalendarDays, X } from 'lucide-react'
import { useLibraryCache } from '@/store/libraryCache'
import { useWatchHistory } from '@/hooks/useWatchHistory'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { maskedDisplayName } from '@/components/common/AccountSwitcher'
import { computeReplayData, type ReplayDataWithEstimate } from '@/lib/compute-replay-data'
import { historyEntryToActivityItem, canonicalStremioConnections } from '@/lib/activity-utils'
import { ReplayHero } from '@/components/replay/ReplayHero'
import { ReplayStats } from '@/components/replay/ReplayStats'
import { ReplayYearInNumbers } from '@/components/replay/ReplayYearInNumbers'
import { ReplayTopTitles } from '@/components/replay/ReplayTopTitles'
import { ReplayMonths } from '@/components/replay/ReplayMonths'
import { ReplayMilestones } from '@/components/replay/ReplayMilestones'
import { ReplayInsights } from '@/components/replay/ReplayInsights'
import { ReplayShareCard } from '@/components/replay/ReplayShareCard'
import { ReplayAccountSwitcher } from '@/components/replay/ReplayAccountSwitcher'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/hooks/use-document-title'

const REPLAY_HISTORY_OPTIONS = { sessions: false } as const

export function ReplayPage() {
    useDocumentTitle('Replay')
    const navigate = useNavigate()
    const containerRef = useRef<HTMLDivElement>(null)
    const { loading, ensureLoaded } = useLibraryCache()
    const { history: watchHistory } = useWatchHistory(undefined, true, REPLAY_HISTORY_OPTIONS)
    const items = useMemo(() => watchHistory.map(historyEntryToActivityItem), [watchHistory])
    const accounts = useAccountStore(s => s.accounts)
    const canonicalConnections = useMemo(() => canonicalStremioConnections(accounts), [accounts])
    const [userSelectedYear, setUserSelectedYear] = useState<number | string | null>(null)
    const [selectedAccountId, setSelectedAccountId] = useState<string>('all')
    const [activeSection, setActiveSection] = useState('hero')
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
    const reduceMotion = useReducedMotion()
    const namePrivacy = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    const emailPrivacy = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelEmail : 0))

    // Force body background to Replay's own dark color to prevent theme gradient bleed
    useEffect(() => {
        const metaThemeColor = document.querySelector('meta[name="theme-color"]')
        const originalColor = metaThemeColor?.getAttribute('content')
        if (metaThemeColor) {
            metaThemeColor.setAttribute('content', '#08080f')
        }

        // Suppress body's theme gradient and html scrollbar while Replay is mounted
        const html = document.documentElement
        const body = document.body
        const origHtmlOverflow = html.style.overflow
        const origBg = body.style.backgroundColor
        const origBgImage = body.style.backgroundImage
        html.style.overflow = 'hidden'
        body.style.backgroundColor = '#08080f'
        body.style.backgroundImage = 'none'

        return () => {
            if (metaThemeColor && originalColor) {
                metaThemeColor.setAttribute('content', originalColor)
            }
            html.style.overflow = origHtmlOverflow
            body.style.backgroundColor = origBg
            body.style.backgroundImage = origBgImage
        }
    }, [])

    // Only show accounts that have watch history (matches Metrics & Activity behavior)
    const activeAccounts = useMemo(() => {
        const activeIds = new Set(items.map(item => item.accountId))
        return accounts.filter(acc => activeIds.has(acc.id))
    }, [accounts, items])

    const filteredItems = useMemo(() => {
        if (selectedAccountId === 'all') return items
        return items.filter(item => item.accountId === selectedAccountId)
    }, [items, selectedAccountId])

    const [allTimeData, setAllTimeData] = useState<ReplayDataWithEstimate | null>(null)
    const [replayData, setReplayData] = useState<ReplayDataWithEstimate | null>(null)

    useEffect(() => {
        if (!filteredItems.length) return
        startTransition(() => {
            setAllTimeData(computeReplayData(filteredItems, 'all-time', { canonicalConnections }))
        })
    }, [filteredItems, canonicalConnections])

    const activeSelectedYear = userSelectedYear ?? (allTimeData?.availableYears?.[0] ?? 'all-time')
    const isSpecificMonth = typeof activeSelectedYear === 'string' && activeSelectedYear !== 'all-time' && activeSelectedYear.includes('-')

    useEffect(() => {
        if (!filteredItems.length || !allTimeData) return
        startTransition(() => {
            setReplayData(computeReplayData(filteredItems, activeSelectedYear, { canonicalConnections }))
        })
    }, [filteredItems, activeSelectedYear, allTimeData, canonicalConnections])

    const sections = useMemo(() => {
        const base = [
            { id: 'hero', label: 'Summary' },
            { id: 'glance', label: 'At a Glance' },
            { id: 'stats', label: 'Stats' },
            { id: 'titles', label: 'Top Titles' }
        ]
        if (!isSpecificMonth) {
            base.push({ id: 'months', label: 'Timeline' })
        }
        base.push(
            { id: 'milestones', label: 'Milestones' },
            { id: 'insights', label: 'Insights' },
            { id: 'share', label: 'Share Card' }
        )
        return base
    }, [isSpecificMonth])

    useEffect(() => {
        setActiveSection('hero')
    }, [sections])

    const scrollToSection = (id: string) => {
        document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        setActiveSection(id)
    }

    const handleScrollDirection = (direction: 'up' | 'down') => {
        const currentIndex = sections.findIndex(s => s.id === activeSection)
        if (direction === 'up' && currentIndex > 0) {
            scrollToSection(sections[currentIndex - 1].id)
        } else if (direction === 'down' && currentIndex < sections.length - 1) {
            scrollToSection(sections[currentIndex + 1].id)
        }
    }

    const observerRef = useRef<IntersectionObserver | null>(null)

    useEffect(() => {
        const timer = setTimeout(() => {
            if (observerRef.current) observerRef.current.disconnect()

            const observerOptions = {
                root: containerRef.current,
                rootMargin: '-20% 0px -40% 0px',
                threshold: 0.1
            }

            const observerCallback: IntersectionObserverCallback = (entries) => {
                const visibleEntries = entries.filter(e => e.isIntersecting)
                if (visibleEntries.length > 0) {
                    const id = visibleEntries[0].target.id.replace('section-', '')
                    requestAnimationFrame(() => setActiveSection(id))
                }
            }

            observerRef.current = new IntersectionObserver(observerCallback, observerOptions)
            sections.forEach(section => {
                const el = document.getElementById(`section-${section.id}`)
                if (el) {
                    observerRef.current?.observe(el)
                }
            })
        }, 500)

        return () => {
            clearTimeout(timer)
            if (observerRef.current) observerRef.current.disconnect()
        }
    }, [activeSelectedYear, sections])


    const userName = useMemo(() => {
        const label = (acc: (typeof accounts)[number] | undefined) =>
            acc ? maskedDisplayName(acc.name, acc.email, namePrivacy, emailPrivacy) || 'Unknown' : 'Unknown'
        if (selectedAccountId !== 'all') return label(accounts.find(a => a.id === selectedAccountId))
        if (accounts.length === 0) return ''
        if (accounts.length === 1) return label(accounts[0])
        return `All Accounts (+${accounts.length})`
    }, [accounts, selectedAccountId, namePrivacy, emailPrivacy])

    useEffect(() => {
        ensureLoaded(accounts)
    }, [accounts, ensureLoaded])


    const handleYearChange = (year: number | string) => {
        setUserSelectedYear(year)
        if (containerRef.current) {
            containerRef.current.scrollTo({ top: 0, behavior: 'auto' })
        }
    }


    if ((loading && items.length === 0) || !replayData || !allTimeData) {
        return (
            <div style={{ '--background': '0 0% 0%', '--foreground': '0 0% 98%', '--card': '0 0% 4%', '--card-foreground': '0 0% 98%', '--popover': '0 0% 4%', '--popover-foreground': '0 0% 98%', '--primary': '45 93% 47%', '--primary-foreground': '0 0% 0%', '--secondary': '0 0% 10%', '--secondary-foreground': '0 0% 98%', '--muted': '0 0% 10%', '--muted-foreground': '0 0% 64%', '--accent': '0 0% 10%', '--accent-foreground': '0 0% 98%', '--destructive': '0 63% 31%', '--destructive-foreground': '0 0% 98%', '--border': '0 0% 15%', '--input': '0 0% 15%', '--ring': '45 93% 47%', background: '#08080f', color: 'white', minHeight: '100vh' } as React.CSSProperties}>
                <div className="min-h-screen mesh-gradient flex flex-col items-center justify-center p-8 text-center">
                    <motion.div
                        animate={reduceMotion ? undefined : { rotate: 360, scale: [1, 1.1, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center border border-white/20 mb-8"
                    >
                        <Sparkles className="text-white w-8 h-8" />
                    </motion.div>
                    <h1 className="text-3xl font-bold text-white tracking-tighter uppercase">Curating the Reel</h1>
                    <p className="text-white/40 mt-2 font-bold max-w-xs">{loading ? "We're indexing your watch history..." : "Computing powerful analytics..."}</p>
                </div>
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div style={{ '--background': '0 0% 0%', '--foreground': '0 0% 98%', '--card': '0 0% 4%', '--card-foreground': '0 0% 98%', '--popover': '0 0% 4%', '--popover-foreground': '0 0% 98%', '--primary': '45 93% 47%', '--primary-foreground': '0 0% 0%', '--secondary': '0 0% 10%', '--secondary-foreground': '0 0% 98%', '--muted': '0 0% 10%', '--muted-foreground': '0 0% 64%', '--accent': '0 0% 10%', '--accent-foreground': '0 0% 98%', '--destructive': '0 63% 31%', '--destructive-foreground': '0 0% 98%', '--border': '0 0% 15%', '--input': '0 0% 15%', '--ring': '45 93% 47%', background: '#08080f', color: 'white', minHeight: '100vh' } as React.CSSProperties}>
                <div className="min-h-screen mesh-gradient flex flex-col items-center justify-center p-8 text-center">
                    <div data-theme-part="panel" data-theme-tone="status" className="p-4 bg-destructive/10 rounded-xl border border-destructive/20 mb-8">
                        <AlertCircle className="text-destructive w-8 h-8" />
                    </div>
                    <h1 className="text-3xl font-bold text-white tracking-tighter uppercase">No History Found</h1>
                    <p className="text-white/40 mt-2 font-bold max-w-sm mb-12">
                        We couldn't find any watch history for your accounts. Start watching something to see your Replay!
                    </p>
                    <button
                        type="button"
                        data-theme-part="button"
                        onClick={() => navigate('/metrics')}
                        className="bg-[#151520] shadow-xl border border-white/10 px-8 py-4 rounded-full text-white font-bold uppercase flex items-center gap-3 hover:bg-white/10 transition-all"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        Back to Metrics
                    </button>
                </div>
            </div>
        )
    }

    return (
        <div style={{ '--background': '0 0% 0%', '--foreground': '0 0% 98%', '--card': '0 0% 4%', '--card-foreground': '0 0% 98%', '--popover': '0 0% 4%', '--popover-foreground': '0 0% 98%', '--primary': '45 93% 47%', '--primary-foreground': '0 0% 0%', '--secondary': '0 0% 10%', '--secondary-foreground': '0 0% 98%', '--muted': '0 0% 10%', '--muted-foreground': '0 0% 64%', '--accent': '0 0% 10%', '--accent-foreground': '0 0% 98%', '--destructive': '0 63% 31%', '--destructive-foreground': '0 0% 98%', '--border': '0 0% 15%', '--input': '0 0% 15%', '--ring': '45 93% 47%', position: 'fixed', inset: 0, zIndex: 50, background: '#08080f', backgroundImage: 'none', color: 'white' } as React.CSSProperties}>
            <div className="relative h-screen w-full bg-[#08080f] text-white selection:bg-primary/30 overflow-hidden">

                {/* FIXED PERFORMANCE BACKGROUND */}
                <div className="absolute inset-0 z-0 mesh-gradient opacity-60 pointer-events-none" />
                <div className="noise-overlay" />
                <div className="vignette-overlay" />

                {/* TOP NAVIGATION OVERLAY / ACCOUNT SELECTOR */}
                <div className="fixed top-0 inset-x-0 h-20 md:h-24 z-[100] flex items-center justify-between px-4 md:px-8 bg-gradient-to-b from-[#08080f]/95 to-transparent pointer-events-none pt-2 md:pt-0">
                    <div className="w-1/4 md:w-1/3 flex justify-start pointer-events-auto">
                        <button
                            type="button"
                            aria-label="Exit Replay"
                            data-theme-part="button"
                            onClick={() => navigate('/metrics')}
                            className="bg-white/5 md:bg-[#151520] backdrop-blur-md shadow-xl border border-white/10 p-2.5 md:p-3 rounded-full md:rounded-xl text-white/40 hover:text-white transition-all flex items-center gap-3 group"
                        >
                            <ArrowLeft className="w-5 h-5 md:w-5 md:h-5 group-hover:-translate-x-1 transition-transform" />
                            <span className="font-bold text-xs uppercase hidden lg:block">Exit Replay</span>
                        </button>
                    </div>

                    <div className="flex-1 md:w-1/3 flex justify-center pointer-events-auto">
                        <ReplayAccountSwitcher
                            accounts={activeAccounts}
                            selectedAccountId={selectedAccountId}
                            onSelect={(id) => {
                                setSelectedAccountId(id)
                                setUserSelectedYear(null)
                                if (containerRef.current) containerRef.current.scrollTo({ top: 0, behavior: 'auto' })
                            }}
                        />
                    </div>

                    <div className="w-1/4 md:w-1/3 flex justify-end pointer-events-none" />
                </div>


                <div
                    ref={containerRef}
                    className="relative z-10 h-screen overflow-y-auto no-scrollbar scroll-smooth"
                >

                    {/* YEAR SELECTOR - FLOATING PILL */}
                    <div
                        className="fixed right-3 md:right-6 md:-translate-y-1/2 z-50 flex flex-col gap-1 items-center pointer-events-auto shadow-2xl transition-all duration-300 bottom-8 md:top-1/2 md:bottom-auto"
                        style={{
                            background: 'rgba(255,255,255,0.05)',
                            backdropFilter: 'blur(20px)',
                            border: '1px solid rgba(255,255,255,0.1)',
                            boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',
                            borderRadius: '999px',
                            padding: '8px 6px',
                            willChange: 'transform',
                            contain: 'layout',
                            transform: 'md:translateY(-50%) translateZ(0)'
                        }}
                    >
                        <div className={cn("flex-col items-center gap-1", isMobileMenuOpen ? "flex" : "hidden md:flex")}>
                            {replayData.availableYears.map((year: number) => {
                                const isSelectedYear = activeSelectedYear === year || (typeof activeSelectedYear === 'string' && activeSelectedYear.startsWith(String(year)));

                                return (
                                    <div key={year} className="flex flex-col items-center">
                                        <button
                                            type="button"
                                            aria-label={String(year)}
                                            aria-pressed={isSelectedYear}
                                            data-theme-part="tab"
                                            data-state={isSelectedYear ? 'active' : 'inactive'}
                                            onClick={() => handleYearChange(year)}
                                            className="w-9 h-9 flex flex-shrink-0 items-center justify-center transition-all duration-200"
                                            style={{
                                                fontFamily: '"DM Mono", monospace',
                                                fontSize: '10px',
                                                fontWeight: 700,
                                                borderRadius: '999px',
                                                background: isSelectedYear ? 'white' : 'transparent',
                                                color: isSelectedYear ? 'black' : 'rgba(255,255,255,0.35)',
                                                boxShadow: isSelectedYear ? '0 0 12px rgba(255,255,255,0.3)' : 'none',
                                            }}
                                            onMouseEnter={(e) => {
                                                if (!isSelectedYear) {
                                                    e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                                                    e.currentTarget.style.color = 'white';
                                                }
                                            }}
                                            onMouseLeave={(e) => {
                                                if (!isSelectedYear) {
                                                    e.currentTarget.style.background = 'transparent';
                                                    e.currentTarget.style.color = 'rgba(255,255,255,0.35)';
                                                }
                                            }}
                                        >
                                            {year.toString().slice(-2)}
                                        </button>

                                        <AnimatePresence mode="popLayout">
                                            {isSelectedYear && (
                                                <div className="flex flex-col items-center gap-1 mt-1">
                                                    <div style={{ width: '1px', height: '6px', background: 'rgba(255,255,255,0.1)' }} />

                                                    {replayData.availableMonths
                                                        .filter((m: string) => m.startsWith(String(year)))
                                                        .filter((m: string) => {
                                                            const [y, mo] = m.split('-').map(Number);
                                                            const now = new Date();
                                                            if (y > now.getFullYear()) return false;
                                                            if (y === now.getFullYear() && mo > now.getMonth() + 1) return false;
                                                            return true;
                                                        })
                                                        .sort((a: string, b: string) => a.localeCompare(b))
                                                        .map((monthStr: string, index: number, arr: string[]) => {
                                                            const [yn, mn] = monthStr.split('-').map(Number);
                                                            const label = new Date(yn, mn - 1, 1).toLocaleString('default', { month: 'short' }).toUpperCase();
                                                            const isSelectedMonth = activeSelectedYear === monthStr;

                                                            return (
                                                                <div key={monthStr} className="flex flex-col items-center gap-1 text-center">
                                                                    <motion.button
                                                                        initial={{ opacity: 0, scale: 0.8 }}
                                                                        animate={{ opacity: 1, scale: 1 }}
                                                                        exit={{ opacity: 0, scale: 0.8 }}
                                                                        transition={{ delay: index * 0.04 }}
                                                                        type="button"
                                                                        aria-label={new Date(yn, mn - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' })}
                                                                        aria-pressed={isSelectedMonth}
                                                                        data-theme-part="tab"
                                                                        data-state={isSelectedMonth ? 'active' : 'inactive'}
                                                                        onClick={() => handleYearChange(monthStr)}
                                                                        className="w-9 h-9 flex flex-shrink-0 items-center justify-center transition-all duration-200"
                                                                        style={{
                                                                            fontFamily: '"DM Mono", monospace',
                                                                            fontSize: '8px',
                                                                            fontWeight: 700,
                                                                            borderRadius: '999px',
                                                                            background: isSelectedMonth ? 'hsl(var(--primary))' : 'rgba(255,255,255,0.05)',
                                                                            color: isSelectedMonth ? 'white' : 'rgba(255,255,255,0.3)',
                                                                            boxShadow: isSelectedMonth ? '0 0 12px rgba(99,102,241,0.5)' : 'none',
                                                                            border: isSelectedMonth ? '2px solid rgba(129,140,248,0.6)' : '2px solid transparent',
                                                                        }}
                                                                        onMouseEnter={(e) => {
                                                                            if (!isSelectedMonth) {
                                                                                e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                                                                                e.currentTarget.style.color = 'white';
                                                                            }
                                                                        }}
                                                                        onMouseLeave={(e) => {
                                                                            if (!isSelectedMonth) {
                                                                                e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                                                                                e.currentTarget.style.color = 'rgba(255,255,255,0.3)';
                                                                            }
                                                                        }}
                                                                    >
                                                                        {label}
                                                                    </motion.button>
                                                                    {index < arr.length - 1 && (
                                                                        <div style={{ width: '1px', height: '4px', background: 'rgba(255,255,255,0.1)' }} />
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    <div style={{ width: '1px', height: '6px', background: 'rgba(255,255,255,0.1)' }} />
                                                </div>
                                            )}
                                        </AnimatePresence>
                                    </div>
                                )
                            })}

                            <div style={{ width: '1px', height: '8px', background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />

                            <button
                                type="button"
                                aria-label="All time"
                                aria-pressed={activeSelectedYear === 'all-time'}
                                data-theme-part="tab"
                                data-state={activeSelectedYear === 'all-time' ? 'active' : 'inactive'}
                                onClick={() => handleYearChange('all-time')}
                                className="w-9 h-9 flex flex-col flex-shrink-0 items-center justify-center gap-0 leading-[0.9] transition-all duration-200"
                                style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '7px',
                                    fontWeight: 700,
                                    borderRadius: '999px',
                                    background: activeSelectedYear === 'all-time' ? 'white' : 'transparent',
                                    color: activeSelectedYear === 'all-time' ? 'black' : 'rgba(255,255,255,0.35)',
                                    boxShadow: activeSelectedYear === 'all-time' ? '0 0 12px rgba(255,255,255,0.3)' : 'none',
                                }}
                                onMouseEnter={(e) => {
                                    if (activeSelectedYear !== 'all-time') {
                                        e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                                        e.currentTarget.style.color = 'white';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (activeSelectedYear !== 'all-time') {
                                        e.currentTarget.style.background = 'transparent';
                                        e.currentTarget.style.color = 'rgba(255,255,255,0.35)';
                                    }
                                }}
                            >
                                <span>ALL</span>
                                <span>TIME</span>
                            </button>
                        </div>

                        {/* Mobile Toggle Button */}
                        <button
                            type="button"
                            aria-label={isMobileMenuOpen ? 'Hide periods' : 'Choose period'}
                            aria-expanded={isMobileMenuOpen}
                            data-theme-part="button"
                            className={`md:hidden w-10 h-10 flex items-center justify-center rounded-full transition-all ${isMobileMenuOpen ? 'mt-1 bg-white/5 text-rose-400 border border-rose-400/30' : 'bg-white/10 text-white hover:bg-white/20'}`}
                            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                        >
                            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <CalendarDays className="w-5 h-5" />}
                        </button>
                    </div>

                    {/* SECTION NAVIGATION - FLOATING LEFT PILL */}
                    <div className="fixed top-1/2 left-6 -translate-y-1/2 z-50 flex flex-col gap-3 p-2 bg-white/5 border border-white/10 shadow-2xl rounded-full hidden md:flex backdrop-blur-md items-center">
                        <button
                            type="button"
                            aria-label="Previous section"
                            data-theme-part="button"
                            onClick={() => handleScrollDirection('up')}
                            disabled={activeSection === sections[0].id}
                            className="text-white/40 hover:text-white disabled:opacity-20 disabled:hover:text-white/40 transition-colors p-1 mt-1"
                        >
                            <ChevronUp className="w-5 h-5" />
                        </button>

                        <div className="w-px h-2 bg-white/10" />

                        {sections.map(section => (
                            <div key={section.id} className="relative group flex items-center justify-center">
                                <button
                                    type="button"
                                    aria-label={section.label}
                                    aria-current={activeSection === section.id ? 'true' : undefined}
                                    data-theme-part="tab"
                                    data-state={activeSection === section.id ? 'active' : 'inactive'}
                                    onClick={() => scrollToSection(section.id)}
                                    className={`w-3 h-3 rounded-full transition-all duration-300 ${activeSection === section.id
                                        ? 'bg-white scale-125 shadow-[0_0_10px_rgba(255,255,255,0.5)]'
                                        : 'bg-white/20 hover:bg-white/60 hover:scale-110'
                                        }`}
                                />
                                {/* Tooltip */}
                                <div className="absolute left-6 px-3 py-1.5 bg-black/80 backdrop-blur border border-white/10 text-white text-xs font-bold uppercase rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                                    {section.label}
                                </div>
                            </div>
                        ))}

                        <div className="w-px h-2 bg-white/10" />

                        <button
                            type="button"
                            aria-label="Next section"
                            data-theme-part="button"
                            onClick={() => handleScrollDirection('down')}
                            disabled={activeSection === sections[sections.length - 1].id}
                            className="text-white/40 hover:text-white disabled:opacity-20 disabled:hover:text-white/40 transition-colors p-1 mb-1"
                        >
                            <ChevronDown className="w-5 h-5" />
                        </button>
                    </div>

                    <AnimatePresence mode="wait">
                        <motion.div
                            key={activeSelectedYear}
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 1.02 }}
                            transition={{ duration: 0.4, ease: "circOut" }}
                            className="pb-64"
                        >
                            <div id="section-hero"><ReplayHero data={replayData} userName={userName} /></div>
                            <div id="section-glance"><ReplayYearInNumbers data={replayData} /></div>
                            <div id="section-stats"><ReplayStats data={replayData} estimatedHours={replayData.estimatedHours} /></div>
                            <div id="section-titles"><ReplayTopTitles data={replayData} allTimeData={allTimeData} /></div>
                            {!isSpecificMonth && <div id="section-months"><ReplayMonths data={replayData} /></div>}
                            <div id="section-milestones"><ReplayMilestones data={replayData} /></div>
                            <div id="section-insights"><ReplayInsights data={replayData} /></div>
                            <div id="section-share" className="py-32">
                                <ReplayShareCard data={replayData} userName={userName} />
                            </div>
                        </motion.div>
                    </AnimatePresence>
                </div>


            </div>
        </div>
    )
}
