import { useMemo, useState, useEffect, useRef, startTransition } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Sparkles, AlertCircle, ChevronUp, ChevronDown, Search, Check, Users, CalendarDays, X } from 'lucide-react'
import { useLibraryCache } from '@/store/libraryCache'
import { useAccountStore } from '@/store/accountStore'
import { computeReplayData } from '@/lib/compute-replay-data'
import { ReplayHero } from '@/components/replay/ReplayHero'
import { ReplayStats } from '@/components/replay/ReplayStats'
import { ReplayYearInNumbers } from '@/components/replay/ReplayYearInNumbers'
import { ReplayTopTitles } from '@/components/replay/ReplayTopTitles'
import { ReplayMonths } from '@/components/replay/ReplayMonths'
import { ReplayMilestones } from '@/components/replay/ReplayMilestones'
import { ReplayInsights } from '@/components/replay/ReplayInsights'
import { ReplayShareCard } from '@/components/replay/ReplayShareCard'
import { StremioAccount } from '@/types/account'
import { cn, ACCOUNT_COLORS } from '@/lib/utils'
// GlassPill removed for performance

interface AccountSwitcherProps {
    accounts: StremioAccount[]
    selectedAccountId: string
    onSelect: (id: string) => void
}

function AccountSwitcher({ accounts, selectedAccountId, onSelect }: AccountSwitcherProps) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Close on outside click
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false)
                setQuery('')
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Focus search input when panel opens
    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50)
    }, [open])

    // Close on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setQuery('') } }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    const filtered = accounts.filter(a =>
        a.name.toLowerCase().includes(query.toLowerCase()) ||
        ((a as any).email ?? '').toLowerCase().includes(query.toLowerCase())
    )

    // Derive label for the trigger button
    const triggerLabel = selectedAccountId === 'all'
        ? 'All Accounts'
        : accounts.find(a => a.id === selectedAccountId)?.name ?? 'All Accounts'

    const triggerColor = selectedAccountId === 'all'
        ? null
        : ACCOUNT_COLORS[accounts.findIndex(a => a.id === selectedAccountId) % ACCOUNT_COLORS.length]

    const getInitials = (name: string) =>
        name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)

    return (
        <div ref={containerRef} style={{ position: 'relative' }} className="shrink-0 pointer-events-auto">

            {/* TRIGGER BUTTON */}
            <button
                onClick={() => setOpen(v => !v)}
                style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 14px 8px 10px',
                    background: open ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.06)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: open
                        ? '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12)'
                        : '0 4px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
                    borderRadius: 999,
                    cursor: 'pointer',
                    transition: 'all 200ms ease',
                    maxWidth: 240,
                }}
            >
                {/* Avatar dot or Users icon */}
                {triggerColor ? (
                    <div style={{
                        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                        background: triggerColor,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, fontWeight: 900, color: 'white',
                        fontFamily: '"DM Mono", monospace',
                    }}>
                        {getInitials(triggerLabel)}
                    </div>
                ) : (
                    <div style={{
                        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                        background: 'rgba(255,255,255,0.1)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <Users style={{ width: 12, height: 12, color: 'rgba(255,255,255,0.6)' }} />
                    </div>
                )}

                {/* Label */}
                <span style={{
                    fontFamily: '"DM Sans", sans-serif',
                    fontSize: 12, fontWeight: 700,
                    color: 'rgba(255,255,255,0.85)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    maxWidth: 160,
                }}>
                    {triggerLabel}
                </span>

                {/* Account count badge — only in "all" mode */}
                {selectedAccountId === 'all' && accounts.length > 1 && (
                    <span style={{
                        fontFamily: '"DM Mono", monospace',
                        fontSize: 9, fontWeight: 700,
                        color: 'rgba(255,255,255,0.35)',
                        background: 'rgba(255,255,255,0.08)',
                        borderRadius: 999, padding: '2px 7px',
                        flexShrink: 0,
                    }}>
                        {accounts.length}
                    </span>
                )}

                {/* Chevron */}
                <ChevronDown style={{
                    width: 14, height: 14, flexShrink: 0,
                    color: 'rgba(255,255,255,0.4)',
                    transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 200ms ease',
                }} />
            </button>

            {/* DROPDOWN PANEL */}
            {open && (
                <div style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 280,
                    background: 'rgba(12,12,22,0.97)',
                    backdropFilter: 'blur(40px)',
                    WebkitBackdropFilter: 'blur(40px)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: '0 24px 64px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08)',
                    borderRadius: 20,
                    overflow: 'hidden',
                    zIndex: 200,
                    animation: 'dropdownFadeIn 150ms cubic-bezier(0.34, 1.56, 0.64, 1)',
                }}>

                    {/* Search bar */}
                    <div style={{
                        padding: '12px 12px 8px',
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 12, padding: '8px 12px',
                        }}>
                            <Search style={{ width: 13, height: 13, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }} />
                            <input
                                ref={inputRef}
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Search accounts..."
                                style={{
                                    background: 'transparent', border: 'none', outline: 'none',
                                    color: 'white', fontSize: 12, fontFamily: '"DM Sans", sans-serif',
                                    fontWeight: 500, width: '100%',
                                }}
                            />
                            {query && (
                                <button onClick={() => setQuery('')} style={{
                                    background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '50%',
                                    width: 16, height: 16, cursor: 'pointer', color: 'rgba(255,255,255,0.5)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 10, flexShrink: 0,
                                }}>✕</button>
                            )}
                        </div>
                    </div>

                    {/* Account list */}
                    <div style={{ maxHeight: 320, overflowY: 'auto', padding: '6px' }} className="no-scrollbar">

                        {/* All Accounts row — only show when not filtering */}
                        {!query && (
                            <button
                                onClick={() => { onSelect('all'); setOpen(false); setQuery('') }}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                                    padding: '9px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                                    background: selectedAccountId === 'all'
                                        ? 'rgba(255,255,255,0.1)'
                                        : 'transparent',
                                    transition: 'background 150ms ease',
                                    marginBottom: 2,
                                }}
                                onMouseEnter={e => { if (selectedAccountId !== 'all') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)' }}
                                onMouseLeave={e => { if (selectedAccountId !== 'all') (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                            >
                                <div style={{
                                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                    background: 'rgba(255,255,255,0.08)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                }}>
                                    <Users style={{ width: 13, height: 13, color: 'rgba(255,255,255,0.5)' }} />
                                </div>
                                <div style={{ flex: 1, textAlign: 'left' }}>
                                    <div style={{
                                        fontFamily: '"DM Sans", sans-serif', fontSize: 13, fontWeight: 700,
                                        color: 'white',
                                    }}>All Accounts</div>
                                    <div style={{
                                        fontFamily: '"DM Mono", monospace', fontSize: 9, fontWeight: 600,
                                        color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', marginTop: 1,
                                    }}>{accounts.length} ACCOUNTS • COMBINED DATA</div>
                                </div>
                                {selectedAccountId === 'all' && (
                                    <Check style={{ width: 13, height: 13, color: '#a5b4fc', flexShrink: 0 }} />
                                )}
                            </button>
                        )}

                        {/* Divider — only when not filtering */}
                        {!query && (
                            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0 6px' }} />
                        )}

                        {/* Individual account rows */}
                        {filtered.length === 0 ? (
                            <div style={{
                                padding: '24px 12px', textAlign: 'center',
                                fontFamily: '"DM Mono", monospace', fontSize: 11,
                                color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em',
                            }}>NO ACCOUNTS FOUND</div>
                        ) : (
                            filtered.map((acc) => {
                                const colorIndex = accounts.indexOf(acc) % ACCOUNT_COLORS.length
                                const color = ACCOUNT_COLORS[colorIndex]
                                const isSelected = selectedAccountId === acc.id
                                const initials = getInitials(acc.name)

                                return (
                                    <button
                                        key={acc.id}
                                        onClick={() => { onSelect(acc.id); setOpen(false); setQuery('') }}
                                        style={{
                                            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '8px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                                            background: isSelected ? color : 'transparent',
                                            transition: 'background 150ms ease',
                                            marginBottom: 2,
                                        }}
                                        onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)' }}
                                        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                                    >
                                        {/* Color-coded initials avatar */}
                                        <div style={{
                                            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                            background: color,
                                            border: `1px solid rgba(255,255,255,0.1)`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontFamily: '"DM Mono", monospace',
                                            fontSize: 9, fontWeight: 900, color: 'white',
                                        }}>
                                            {initials}
                                        </div>

                                        {/* Name + email */}
                                        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                                            <div style={{
                                                fontFamily: '"DM Sans", sans-serif', fontSize: 13, fontWeight: 700,
                                                color: isSelected ? 'white' : 'rgba(255,255,255,0.8)',
                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>{acc.name}</div>
                                            {(acc as any).email && (
                                                <div style={{
                                                    fontFamily: '"DM Mono", monospace', fontSize: 9, fontWeight: 500,
                                                    color: 'rgba(255,255,255,0.25)', letterSpacing: '0.05em',
                                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                    marginTop: 1,
                                                }}>{(acc as any).email}</div>
                                            )}
                                        </div>

                                        {/* Checkmark for selected */}
                                        {isSelected && (
                                            <Check style={{ width: 13, height: 13, color: 'white', flexShrink: 0 }} />
                                        )}
                                    </button>
                                )
                            })
                        )}
                    </div>

                    {/* Footer count — only visible when list is long */}
                    {accounts.length > 8 && !query && (
                        <div style={{
                            borderTop: '1px solid rgba(255,255,255,0.06)',
                            padding: '8px 16px',
                            fontFamily: '"DM Mono", monospace', fontSize: 9,
                            color: 'rgba(255,255,255,0.2)', letterSpacing: '0.15em', textAlign: 'center',
                        }}>
                            {accounts.length} ACCOUNTS TOTAL
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export function ReplayPage() {
    const navigate = useNavigate()
    const containerRef = useRef<HTMLDivElement>(null)
    const { items, loading, ensureLoaded } = useLibraryCache()
    const { accounts } = useAccountStore()
    const [userSelectedYear, setUserSelectedYear] = useState<number | string | null>(null)
    const [selectedAccountId, setSelectedAccountId] = useState<string>('all')
    const [activeSection, setActiveSection] = useState('hero')
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

    // Only show accounts that have watch history (matches Metrics & Activity behavior)
    const activeAccounts = useMemo(() => {
        const activeIds = new Set(items.map(item => item.accountId))
        return accounts.filter(acc => activeIds.has(acc.id))
    }, [accounts, items])

    const filteredItems = useMemo(() => {
        if (selectedAccountId === 'all') return items
        return items.filter(item => item.accountId === selectedAccountId)
    }, [items, selectedAccountId])

    const [allTimeData, setAllTimeData] = useState<any>(null)
    const [replayData, setReplayData] = useState<any>(null)

    useEffect(() => {
        if (!filteredItems.length) return
        startTransition(() => {
            setAllTimeData(computeReplayData(filteredItems, 'all-time'))
        })
    }, [filteredItems])

    const activeSelectedYear = userSelectedYear ?? (allTimeData?.availableYears?.[0] ?? 'all-time')
    const isSpecificMonth = typeof activeSelectedYear === 'string' && activeSelectedYear !== 'all-time' && activeSelectedYear.includes('-')

    useEffect(() => {
        if (!filteredItems.length || !allTimeData) return
        startTransition(() => {
            setReplayData(computeReplayData(filteredItems, activeSelectedYear))
        })
    }, [filteredItems, activeSelectedYear, allTimeData])

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

    // Scroll Spy for active section updating
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
        if (selectedAccountId !== 'all') {
            const acc = accounts.find(a => a.id === selectedAccountId)
            return acc?.name || 'Unknown'
        }
        if (accounts.length === 0) return ''
        if (accounts.length === 1) return accounts[0].name
        return `All Accounts (+${accounts.length})`
    }, [accounts, selectedAccountId])

    useEffect(() => {
        ensureLoaded(accounts)
    }, [accounts, ensureLoaded])


    const handleYearChange = (year: number | string) => {
        setUserSelectedYear(year)
        // Correctly target the internal container for reset
        if (containerRef.current) {
            containerRef.current.scrollTo({ top: 0, behavior: 'auto' })
        }
    }


    if ((loading && items.length === 0) || !replayData || !allTimeData) {
        return (
            <div className="min-h-screen mesh-gradient flex flex-col items-center justify-center p-8 text-center">
                <motion.div
                    animate={{ rotate: 360, scale: [1, 1.1, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                    className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center border border-white/20 mb-8"
                >
                    <Sparkles className="text-white w-8 h-8" />
                </motion.div>
                <h1 className="text-3xl font-black text-white tracking-tighter uppercase">Curating Your Reel</h1>
                <p className="text-white/40 mt-2 font-bold max-w-xs">{loading ? "We're indexing your watch history..." : "Computing powerful analytics..."}</p>
            </div>
        )
    }

    if (items.length === 0) {
        return (
            <div className="min-h-screen mesh-gradient flex flex-col items-center justify-center p-8 text-center">
                <div className="p-4 bg-red-500/10 rounded-2xl border border-red-500/20 mb-8">
                    <AlertCircle className="text-red-500 w-8 h-8" />
                </div>
                <h1 className="text-3xl font-black text-white tracking-tighter uppercase">No History Found</h1>
                <p className="text-white/40 mt-2 font-bold max-w-sm mb-12">
                    We couldn't find any watch history for your accounts. Start watching something on Stremio to see your Replay!
                </p>
                <button
                    onClick={() => navigate('/metrics')}
                    className="bg-[#151520] shadow-xl border border-white/10 px-8 py-4 rounded-full text-white font-black uppercase tracking-widest flex items-center gap-3 hover:bg-white/10 transition-all"
                >
                    <ArrowLeft className="w-5 h-5" />
                    Back to Metrics
                </button>
            </div>
        )
    }

    return (
        <div className="relative h-screen w-full bg-[#08080f] text-white selection:bg-primary/30 overflow-hidden fixed inset-0 z-[50]">

            {/* FIXED PERFORMANCE BACKGROUND */}
            <div className="absolute inset-0 z-0 mesh-gradient opacity-60 pointer-events-none" />
            <div className="noise-overlay" />
            <div className="vignette-overlay" />

            {/* TOP NAVIGATION OVERLAY / ACCOUNT SELECTOR */}
            <div className="fixed top-0 inset-x-0 h-20 md:h-24 z-[100] flex items-center justify-between px-4 md:px-8 bg-gradient-to-b from-[#08080f]/95 to-transparent pointer-events-none pt-2 md:pt-0">
                <div className="w-1/4 md:w-1/3 flex justify-start pointer-events-auto">
                    <button
                        onClick={() => navigate('/metrics')}
                        className="bg-white/5 md:bg-[#151520] backdrop-blur-md shadow-xl border border-white/10 p-2.5 md:p-3 rounded-full md:rounded-2xl text-white/40 hover:text-white transition-all flex items-center gap-3 group"
                    >
                        <ArrowLeft className="w-5 h-5 md:w-5 md:h-5 group-hover:-translate-x-1 transition-transform" />
                        <span className="font-bold text-[10px] uppercase tracking-widest hidden lg:block">Exit Replay</span>
                    </button>
                </div>

                <div className="flex-1 md:w-1/3 flex justify-center pointer-events-auto">
                    <AccountSwitcher
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

            {/* MAIN SCROLL CONTAINER - FREE SCROLL ENABLED */}
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
                                        onClick={() => handleYearChange(year)}
                                        className="w-9 h-9 flex flex-shrink-0 items-center justify-center transition-all duration-200"
                                        style={{
                                            fontFamily: '"DM Mono", monospace',
                                            fontSize: '10px',
                                            fontWeight: 900,
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
                                                                    onClick={() => handleYearChange(monthStr)}
                                                                    className="w-9 h-9 flex flex-shrink-0 items-center justify-center transition-all duration-200"
                                                                    style={{
                                                                        fontFamily: '"DM Mono", monospace',
                                                                        fontSize: '8px',
                                                                        fontWeight: 900,
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
                            onClick={() => handleYearChange('all-time')}
                            className="w-9 h-9 flex flex-col flex-shrink-0 items-center justify-center gap-0 leading-[0.9] transition-all duration-200"
                            style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '7px',
                                fontWeight: 900,
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
                        className={`md:hidden w-10 h-10 flex items-center justify-center rounded-full transition-all ${isMobileMenuOpen ? 'mt-1 bg-white/5 text-rose-400 border border-rose-400/30' : 'bg-white/10 text-white hover:bg-white/20'}`}
                        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                    >
                        {isMobileMenuOpen ? <X className="w-5 h-5" /> : <CalendarDays className="w-5 h-5" />}
                    </button>
                </div>

                {/* SECTION NAVIGATION - FLOATING LEFT PILL */}
                <div className="fixed top-1/2 left-6 -translate-y-1/2 z-50 flex flex-col gap-3 p-2 bg-white/5 border border-white/10 shadow-2xl rounded-full hidden md:flex backdrop-blur-md items-center">
                    <button
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
                                onClick={() => scrollToSection(section.id)}
                                className={`w-3 h-3 rounded-full transition-all duration-300 ${activeSection === section.id
                                    ? 'bg-white scale-125 shadow-[0_0_10px_rgba(255,255,255,0.5)]'
                                    : 'bg-white/20 hover:bg-white/60 hover:scale-110'
                                    }`}
                            />
                            {/* Tooltip */}
                            <div className="absolute left-6 px-3 py-1.5 bg-black/80 backdrop-blur border border-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                                {section.label}
                            </div>
                        </div>
                    ))}

                    <div className="w-px h-2 bg-white/10" />

                    <button
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
                        <div id="section-stats"><ReplayStats data={replayData} /></div>
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

            {/* Bottom weird bar removed */}
        </div>
    )
}
