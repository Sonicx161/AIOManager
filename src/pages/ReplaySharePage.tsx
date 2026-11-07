import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { ReplayHero } from '@/components/replay/ReplayHero'
import { ReplayYearInNumbers } from '@/components/replay/ReplayYearInNumbers'
import { ReplayStats } from '@/components/replay/ReplayStats'
import { ReplayTopTitles } from '@/components/replay/ReplayTopTitles'
import { ReplayMonths } from '@/components/replay/ReplayMonths'
import { ReplayMilestones } from '@/components/replay/ReplayMilestones'
import { ReplayInsights } from '@/components/replay/ReplayInsights'
import { ReplayShareCard } from '@/components/replay/ReplayShareCard'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { decodeReplayShare, shareTokenFromLocation, stripShareIdParam, type DecodedReplayShare } from '@/lib/replay-share-codec'

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

export function ReplaySharePage() {
    useDocumentTitle('Replay')
    const { token } = useParams<{ token: string }>()
    const [decoded, setDecoded] = useState<DecodedReplayShare | null | 'error' | 'loading'>('loading')
    const [activeSection, setActiveSection] = useState('hero')
    const scrollContainerRef = useRef<HTMLDivElement>(null)

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
        const shareToken = shareTokenFromLocation(token, window.location.hash)
        if (!shareToken) { setDecoded('error'); return }
        setDecoded(decodeReplayShare(shareToken) ?? 'error')
    }, [token])

    // The app re-adds the bookmark ?id= after its own effects run, so strip on the next tick.
    useEffect(() => {
        const timer = setTimeout(() => {
            const next = stripShareIdParam(window.location.href)
            if (next) window.history.replaceState(window.history.state, '', next)
        }, 0)
        return () => clearTimeout(timer)
    })

    if (decoded === 'loading') {
        return (
            <div style={{ minHeight: '100vh', background: '#08080f' }} />
        )
    }

    if (!decoded || decoded === 'error') {
        return (
            <div style={{ minHeight: '100vh', background: '#08080f', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '24px' }}>
                <div style={{ fontSize: '48px' }}>🎬</div>
                <div style={{ fontFamily: '"Inter", monospace', fontSize: '12px', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)' }}>
                    This replay link is invalid or has expired
                </div>
                <a href="/" style={{ marginTop: '8px', fontFamily: '"Inter", sans-serif', fontSize: '14px', fontWeight: 700, color: '#818cf8', textDecoration: 'none' }}>
                    Open AIOManager →
                </a>
            </div>
        )
    }

    const { data, userName } = decoded

    return (
        <div className="relative min-h-screen w-full bg-[#08080f] text-white selection:bg-primary/30">
            <div className="fixed inset-0 z-0 mesh-gradient opacity-60 pointer-events-none" />
            <div className="fixed inset-0 z-0 noise-overlay pointer-events-none" />
            <div className="fixed inset-0 z-0 vignette-overlay pointer-events-none" />

            <div className="fixed top-0 inset-x-0 h-16 md:h-20 z-[100] flex items-center justify-between px-6 md:px-8 bg-[#08080f]/80 backdrop-blur-xl border-b border-white/5 pt-2 md:pt-0">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img src="/logo.png" alt="" loading="lazy" style={{ width: '20px', height: '20px', objectFit: 'contain' }} />
                    <span style={{ fontFamily: '"Inter", monospace', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', color: 'white', textTransform: 'uppercase' }}>AIOManager</span>
                </div>
                <a href="/" style={{ fontFamily: '"Inter", sans-serif', fontSize: '13px', fontWeight: 700, color: '#818cf8', textDecoration: 'none', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '999px', padding: '6px 16px' }}>
                    Try AIOManager
                </a>
            </div>

            {/* Floating nav pill */}
            <div className="fixed top-1/2 left-6 -translate-y-1/2 z-50 flex flex-col 
                gap-3 p-2 bg-white/5 border border-white/10 shadow-2xl rounded-full 
                hidden md:flex backdrop-blur-md items-center">
                <button
                    type="button"
                    aria-label="Previous section"
                    data-theme-part="button"
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
                        <div className="absolute left-6 px-3 py-1.5 bg-black/80 backdrop-blur 
                            border border-white/10 text-white text-xs font-bold uppercase 
                            rounded-lg opacity-0 group-hover:opacity-100 
                            transition-opacity pointer-events-none whitespace-nowrap">
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
                    <div style={{ fontFamily: '"Inter", monospace', fontSize: '9px', fontWeight: 700, letterSpacing: '0.3em', textTransform: 'uppercase', color: 'rgba(99,102,241,0.8)' }}>✦ Want your own Replay?</div>
                    <div style={{ fontFamily: '"Inter", sans-serif', fontSize: 'clamp(28px, 5vw, 48px)', fontWeight: 700, letterSpacing: '-0.03em', color: 'white', lineHeight: 1.1 }}>
                        Manage your streaming.<br />
                        <span style={{ background: 'linear-gradient(135deg, #818cf8, #f472b6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>Your way.</span>
                    </div>
                    <p style={{ fontFamily: '"Inter", sans-serif', fontSize: '16px', color: 'rgba(255,255,255,0.5)', maxWidth: '400px', lineHeight: 1.6 }}>
                        AIOManager is a free, open-source tool for managing your streaming accounts, addons, and watch history.
                    </p>
                    <a href="https://github.com/Sonicx161/AIOManager" target="_blank" rel="noopener noreferrer" style={{ marginTop: '8px', fontFamily: '"Inter", sans-serif', fontSize: '15px', fontWeight: 700, color: 'white', textDecoration: 'none', background: 'linear-gradient(135deg, rgba(99,102,241,0.8), rgba(244,114,182,0.8))', borderRadius: '999px', padding: '14px 32px', boxShadow: '0 8px 32px rgba(99,102,241,0.3)' }}>
                        Get AIOManager →
                    </a>
                </div>
            </div>
        </div>
    )
}
