import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { inflateSync, strFromU8 } from 'fflate'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { ReplayData } from '@/types/ReplayTypes'
import { ReplayHero } from '@/components/replay/ReplayHero'
import { ReplayYearInNumbers } from '@/components/replay/ReplayYearInNumbers'
import { ReplayStats } from '@/components/replay/ReplayStats'
import { ReplayTopTitles } from '@/components/replay/ReplayTopTitles'
import { ReplayMonths } from '@/components/replay/ReplayMonths'
import { ReplayMilestones } from '@/components/replay/ReplayMilestones'
import { ReplayInsights } from '@/components/replay/ReplayInsights'
import { ReplayShareCard } from '@/components/replay/ReplayShareCard'

const MILESTONE_TEMPLATES = [
    { id: 'titles-50', icon: '🎬', title: 'Cineplex Pass', description: 'Watched 50 unique titles', threshold: 50 },
    { id: 'titles-100', icon: '🏅', title: 'Century Club', description: 'Watched 100 unique titles', threshold: 100 },
    { id: 'titles-250', icon: '🏆', title: 'Quarter Thousand', description: 'Watched 250 unique titles', threshold: 250 },
    { id: 'titles-500', icon: '👑', title: 'Half Millennium', description: 'Watched 500 unique titles', threshold: 500 },
    { id: 'hours-100', icon: '⏱️', title: 'Centurion', description: 'Streamed 100+ hours', threshold: 100 },
    { id: 'hours-500', icon: '🔥', title: 'Dedicated Viewer', description: 'Streamed 500+ hours', threshold: 500 },
    { id: 'hours-1000', icon: '💎', title: 'Legendary Status', description: 'Streamed 1,000+ hours', threshold: 1000 },
    { id: 'streak-7', icon: '📅', title: 'Week Warrior', description: 'Binge streak of 7+ days', threshold: 7 },
    { id: 'streak-14', icon: '🎯', title: 'Fortnight Force', description: 'Binge streak of 14+ days', threshold: 14 },
    { id: 'streak-30', icon: '⚡', title: 'Monthly Marathon', description: 'Binge streak of 30+ days', threshold: 30 },
    { id: 'discoveries-25', icon: '🔍', title: 'Trailblazer', description: 'Discovered 25+ new titles', threshold: 25 },
]

function decodeShareToken(token: string): { data: ReplayData; userName?: string } | null {
    try {
        const bin = atob(token.replace(/-/g, '+').replace(/_/g, '/'))
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
        const json = strFromU8(inflateSync(bytes))
        if (!json) return null
        const payload = JSON.parse(json)
        if (!payload) return null

        // Support Universal Positional Array (Full 1:1 Data Parity)
        if (Array.isArray(payload) && (payload[0] === 5 || payload[0] === 6)) {
            const isLatest = payload[0] === 6
            const [
                _v, y, u, tt, th, tg, ls, apm, dp, tud, p, pd,
                tp, t, ds, mt, hg, g, hpa, mb, m, hd, dd, yoy, ph, pdb
            ] = payload

            const pool = (tp || []).map((item: any) => ({
                itemId: 'tt' + item[0],
                name: item[1],
                type: item[2] === 1 ? 'series' : 'movie',
                poster: `https://images.metahub.space/poster/small/tt${item[0]}/img`,
                id: 'tt' + item[0],
                uniqueItemId: 'tt' + item[0],
                watchCount: 0,
                totalHours: 0,
                rank: 0
            }))

            const data: ReplayData = {
                year: y,
                totalTitles: tt,
                totalHours: th,
                totalGenres: tg,
                longestStreak: ls,
                avgTitlesPerMonth: apm,
                topTitles: (t || []).map((item: any, i: number) => {
                    const base = pool[item[0]]
                    return base ? { ...base, totalHours: item[1], watchCount: isLatest ? item[2] : 0, rank: i + 1 } : null
                }).filter(Boolean),
                topGenres: (g || []).map((item: any) => ({
                    genre: item[0],
                    count: item[1],
                    percentage: item[2],
                    color: item[3]
                })),
                monthlyBreakdown: (mb || []).map((item: any, i: number) => {
                    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
                    const year = y || new Date().getFullYear()
                    const mTitles = (item[2] || []).map((idx: number, r: number) => {
                        const base = pool[idx]
                        return base ? { ...base, rank: r + 1 } : null
                    }).filter(Boolean)

                    return {
                        month: monthNames[i] || 'Unknown',
                        monthKey: `${year}-${String(i + 1).padStart(2, '0')}`,
                        totalTitles: item[0],
                        totalHours: item[1],
                        topTitle: mTitles[0] || null,
                        top3Titles: mTitles,
                        isHighActivity: item[3] === 1
                    }
                }),
                discoveries: (ds || []).map((idx: number) => pool[idx]).filter(Boolean),
                marathonTitles: (mt || []).map((idx: number) => pool[idx]).filter(Boolean),
                hiddenGems: (hg || []).map((idx: number) => pool[idx]).filter(Boolean),
                availableYears: [],
                availableMonths: [],
                heroPosterArt: (hpa || []).map((id: string) => `https://images.metahub.space/poster/small/tt${id}/img`),
                persona: p ?? '',
                personaDescription: pd ?? '',
                milestones: MILESTONE_TEMPLATES.map((tmpl, i) => {
                    // 'm' is an array of [unlocked, value]
                    const milestoneData = isLatest ? (m || [])[i] : null
                    return {
                        ...tmpl,
                        unlocked: isLatest ? milestoneData?.[0] === 1 : (m || []).includes(tmpl.id),
                        value: isLatest ? milestoneData?.[1] ?? 0 : 0
                    }
                }),
                hourlyDistribution: (hd || []).map((item: any, h: number) => ({
                    hour: h,
                    percentage: isLatest ? item[0] : item,
                    count: isLatest ? item[1] : 0
                })),
                dailyDistribution: (dd || []).map((item: any, d: number) => ({
                    day: d,
                    dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d],
                    percentage: isLatest ? item[0] : item,
                    count: isLatest ? item[1] : 0,
                    hours: isLatest ? item[2] : 0
                })),
                yearOverYear: yoy ? {
                    prevYear: yoy[0],
                    currentYear: yoy[1],
                    titlesDelta: yoy[2],
                    hoursDelta: yoy[3],
                    loyaltyDelta: yoy[4],
                    streakDelta: yoy[5],
                    prevTitles: isLatest ? yoy[6] : 0,
                    prevHours: isLatest ? yoy[7] : 0,
                    currentTitles: isLatest ? yoy[8] : 0,
                    currentHours: isLatest ? yoy[9] : 0
                } : null,
                peakHour: ph ?? 0,
                peakDay: pdb ?? '',
                discoveryPercentage: dp ?? 0,
                totalUniqueDiscoveries: tud ?? 0,
            }
            return { data, userName: u }
        }

        return null
    } catch (e) {
        console.error('[ShareDecode] Error:', e)
        return null
    }
}

export function ReplaySharePage() {
    const { token } = useParams<{ token: string }>()
    const [decoded, setDecoded] = useState<{ data: ReplayData; userName?: string } | null | 'error' | 'loading'>('loading')
    const [activeSection, setActiveSection] = useState('hero')
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    const sections = [
        { id: 'hero', label: 'Overview' },
        { id: 'glance', label: 'At a Glance' },
        { id: 'stats', label: 'Stats' },
        { id: 'titles', label: 'Top Titles' },
        { id: 'months', label: 'Timeline' },
        { id: 'milestones', label: 'Milestones' },
        { id: 'insights', label: 'Insights' },
        { id: 'share', label: 'Share Card' },
    ]

    const scrollToSection = (id: string) => {
        document.getElementById(`section-${id}`)?.scrollIntoView({
            behavior: 'smooth', block: 'start'
        })
        setActiveSection(id)
    }

    const handleScrollDirection = (direction: 'up' | 'down') => {
        const currentIndex = sections.findIndex(s => s.id === activeSection)
        if (direction === 'up' && currentIndex > 0)
            scrollToSection(sections[currentIndex - 1].id)
        else if (direction === 'down' && currentIndex < sections.length - 1)
            scrollToSection(sections[currentIndex + 1].id)
    }

    const observerRef = useRef<IntersectionObserver | null>(null)

    useEffect(() => {
        const timer = setTimeout(() => {
            if (observerRef.current) observerRef.current.disconnect()
            observerRef.current = new IntersectionObserver(
                (entries) => {
                    const visible = entries.filter(e => e.isIntersecting)
                    if (visible.length > 0) {
                        const id = visible[0].target.id.replace('section-', '')
                        requestAnimationFrame(() => setActiveSection(id))
                    }
                },
                { rootMargin: '-20% 0px -40% 0px', threshold: 0.1 }
            )
            sections.forEach(s => {
                const el = document.getElementById(`section-${s.id}`)
                if (el) observerRef.current?.observe(el)
            })
        }, 500)
        return () => { clearTimeout(timer); observerRef.current?.disconnect() }
    }, [])

    useEffect(() => {
        if (!token) { setDecoded('error'); return }
        const result = decodeShareToken(token)
        setDecoded(result ?? 'error')
    }, [token])

    if (decoded === 'loading') {
        return (
            <div style={{ minHeight: '100vh', background: '#08080f' }} />
        )
    }

    if (!decoded || decoded === 'error') {
        return (
            <div style={{ minHeight: '100vh', background: '#08080f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '24px' }}>
                <div style={{ fontSize: '48px' }}>🎬</div>
                <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '12px', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)' }}>
                    This replay link is invalid or has expired
                </div>
                <a href="/" style={{ marginTop: '8px', fontFamily: '"DM Sans", sans-serif', fontSize: '14px', fontWeight: 700, color: '#818cf8', textDecoration: 'none' }}>
                    Open AIOManager →
                </a>
            </div>
        )
    }

    const { data, userName } = decoded

    return (
        <div className="relative min-h-screen w-full bg-[#08080f] text-white selection:bg-primary/30">
            {/* PERFORMANCE BACKGROUND - Now part of the natural scroll flow */}
            <div className="fixed inset-0 z-0 mesh-gradient opacity-60 pointer-events-none" />
            <div className="fixed inset-0 z-0 noise-overlay pointer-events-none" />
            <div className="fixed inset-0 z-0 vignette-overlay pointer-events-none" />

            {/* Top bar - Now with solid/frosted background */}
            <div className="fixed top-0 inset-x-0 h-16 md:h-20 z-[100] flex items-center justify-between px-6 md:px-8 bg-[#08080f]/80 backdrop-blur-xl border-b border-white/5 pt-2 md:pt-0">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img src="/logo.png" alt="" style={{ width: '20px', height: '20px', objectFit: 'contain' }} />
                    <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '11px', fontWeight: 900, letterSpacing: '0.1em', color: 'white', textTransform: 'uppercase' }}>AIOManager</span>
                </div>
                <a href="/" style={{ fontFamily: '"DM Sans", sans-serif', fontSize: '13px', fontWeight: 700, color: '#818cf8', textDecoration: 'none', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '999px', padding: '6px 16px' }}>
                    Try AIOManager
                </a>
            </div>

            {/* Floating nav pill */}
            <div className="fixed top-1/2 left-6 -translate-y-1/2 z-50 flex flex-col 
                gap-3 p-2 bg-white/5 border border-white/10 shadow-2xl rounded-full 
                hidden md:flex backdrop-blur-md items-center">
                <button
                    onClick={() => handleScrollDirection('up')}
                    disabled={activeSection === sections[0].id}
                    className="text-white/40 hover:text-white disabled:opacity-20 
                        disabled:hover:text-white/40 transition-colors p-1 mt-1"
                >
                    <ChevronUp className="w-5 h-5" />
                </button>
                <div className="w-px h-2 bg-white/10" />
                {sections.map(section => (
                    <div key={section.id}
                        className="relative group flex items-center justify-center">
                        <button
                            onClick={() => scrollToSection(section.id)}
                            className={`w-3 h-3 rounded-full transition-all duration-300 ${activeSection === section.id
                                ? 'bg-white scale-125 shadow-[0_0_10px_rgba(255,255,255,0.5)]'
                                : 'bg-white/20 hover:bg-white/60 hover:scale-110'
                                }`}
                        />
                        <div className="absolute left-6 px-3 py-1.5 bg-black/80 backdrop-blur 
                            border border-white/10 text-white text-[10px] font-black uppercase 
                            tracking-widest rounded-lg opacity-0 group-hover:opacity-100 
                            transition-opacity pointer-events-none whitespace-nowrap">
                            {section.label}
                        </div>
                    </div>
                ))}
                <div className="w-px h-2 bg-white/10" />
                <button
                    onClick={() => handleScrollDirection('down')}
                    disabled={activeSection === sections[sections.length - 1].id}
                    className="text-white/40 hover:text-white disabled:opacity-20 
                        disabled:hover:text-white/40 transition-colors p-1 mb-1"
                >
                    <ChevronDown className="w-5 h-5" />
                </button>
            </div>

            {/* MAIN SCROLL CONTAINER - Now using natural browser scrolling */}
            <div
                ref={scrollContainerRef}
                className="relative z-10 w-full no-scrollbar"
            >
                <div style={{ paddingTop: '20px' }}>
                    <div id="section-hero"><ReplayHero data={data} userName={userName} /></div>
                    <div id="section-glance"><ReplayYearInNumbers data={data} /></div>
                    <div id="section-stats"><ReplayStats data={data} /></div>
                    <div id="section-titles"><ReplayTopTitles data={data} /></div>
                    {data.monthlyBreakdown?.length > 0 &&
                        <div id="section-months"><ReplayMonths data={data} /></div>}
                    <div id="section-milestones"><ReplayMilestones data={data} /></div>
                    <div id="section-insights"><ReplayInsights data={data} /></div>
                    <div id="section-share" className="py-32">
                        <ReplayShareCard data={data} userName={userName} hideButtons={true} />
                    </div>
                </div>

                {/* Bottom CTA */}
                <div style={{ padding: '80px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '9px', fontWeight: 700, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'rgba(99,102,241,0.8)' }}>✦ Want your own Replay?</div>
                    <div style={{ fontFamily: '"DM Sans", sans-serif', fontSize: 'clamp(28px, 5vw, 48px)', fontWeight: 900, letterSpacing: '-0.03em', color: 'white', lineHeight: 1.1 }}>
                        Manage your Stremio.<br />
                        <span style={{ background: 'linear-gradient(135deg, #818cf8, #f472b6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>Your way.</span>
                    </div>
                    <p style={{ fontFamily: '"DM Sans", sans-serif', fontSize: '16px', color: 'rgba(255,255,255,0.5)', maxWidth: '400px', lineHeight: 1.6 }}>
                        AIOManager is a free, open-source tool for managing your Stremio accounts, addons, and watch history.
                    </p>
                    <a href="https://github.com/Sonicx161/AIOManager" target="_blank" rel="noopener noreferrer" style={{ marginTop: '8px', fontFamily: '"DM Sans", sans-serif', fontSize: '15px', fontWeight: 700, color: 'white', textDecoration: 'none', background: 'linear-gradient(135deg, rgba(99,102,241,0.8), rgba(244,114,182,0.8))', borderRadius: '999px', padding: '14px 32px', boxShadow: '0 8px 32px rgba(99,102,241,0.3)' }}>
                        Get AIOManager →
                    </a>
                </div>
            </div>
        </div>
    )
}
