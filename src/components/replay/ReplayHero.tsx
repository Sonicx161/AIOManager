import { useState, useEffect } from 'react'
import { motion, animate } from 'framer-motion'
import { Sparkles, Clock, Film, Flame } from 'lucide-react'
import { ReplayData } from '@/types/ReplayTypes'
import { useReplayDisplayMeta } from '@/hooks/useReplayDisplayMeta'
import { Poster } from '@/components/common/Poster'

interface ReplayHeroProps {
    data: ReplayData
    userName?: string
}


function AnimatedNumber({ target, duration, delay = 0 }: { target: number, duration: number, delay?: number }) {
    const [count, setCount] = useState(0);

    useEffect(() => {
        const controls = animate(0, target, {
            duration: duration / 1000,
            delay: delay / 1000,
            ease: [0.16, 1, 0.3, 1], // quartic ease-out equivalent
            onUpdate: (value) => {
                setCount(Math.round(value));
            }
        });

        return controls.stop;
    }, [target, duration, delay]);

    return <>{count}</>;
}

export function ReplayHero({ data, userName }: ReplayHeroProps) {
    const { displayYear, displayMonth, isCurrentYear } = useReplayDisplayMeta(data.year)

    const posters = (data.heroPosterArt || []).filter(Boolean).slice(0, 48); // Cap to 48 posters to prevent DOM bloat

    const statPills = [
        { icon: Film, label: `${data.totalTitles} Titles` },
        { icon: Clock, label: `${data.totalHours} hrs` },
        { icon: Sparkles, label: `${data.totalUniqueDiscoveries} New` },
        { icon: Flame, label: `${data.longestStreak}-Day Streak` }
    ];

    const subtitleText = userName && userName.startsWith('All Accounts')
        ? "This is the definitive story of your cinematic obsessions and digital escapes."
        : (
            <>
                Welcome back, <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 700 }}>{userName || 'Cinemaphile'}</span>.
                This is the definitive story of your cinematic obsessions and digital escapes.
            </>
        );

    // Mount states for pure CSS transitions per design spec
    const [statsVisible, setStatsVisible] = useState(false);
    const [readyMosaic, setReadyMosaic] = useState(false);
    const [readyPills, setReadyPills] = useState(false);
    const [readyIndicator, setReadyIndicator] = useState(false);

    useEffect(() => {
        const t0 = setTimeout(() => setStatsVisible(true), 100);
        const t1 = setTimeout(() => setReadyMosaic(true), 50);
        const t2 = setTimeout(() => setReadyPills(true), 1100);
        const t3 = setTimeout(() => setReadyIndicator(true), 2400);
        return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); }
    }, []);

    return (
        <section
            className="relative min-h-[100vh] w-full flex flex-col items-center justify-center overflow-hidden pt-32 pb-44"
            style={{ fontFamily: '"DM Sans", sans-serif' }}
        >

            {/* Background Mosaic */}
            <div className="absolute inset-0 z-0 pointer-events-none" style={{ contain: 'layout style paint', willChange: 'transform', transform: 'translateZ(0)', isolation: 'isolate' }}>
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(8, 1fr)',
                        gap: '6px',
                        padding: '6px',
                        transform: 'translateZ(0) scale(1.08) rotate(-1deg)',
                        willChange: 'transform',
                        opacity: 0.25, // Lowered opacity replaces expensive expensive blur(2px)
                        height: '100%'
                    }}
                >
                    {posters.map((poster, i) => (
                        <div
                            key={i}
                            style={{
                                opacity: readyMosaic ? 1 : 0,
                                transition: `opacity 1s ease ${i * 40}ms`,
                                aspectRatio: '2/3',
                                borderRadius: '8px',
                                overflow: 'hidden',
                                contentVisibility: 'auto'
                            }}
                        >
                            <Poster
                                src={poster}
                                loading="lazy"
                                decoding="async"
                                className="w-full h-full object-cover"
                                fallback={false}
                            />
                        </div>
                    ))}
                </div>
                {/* Gradient Overlays */}
                <div style={{ background: 'linear-gradient(to top, #08080f 0%, rgba(8,8,15,0.7) 40%, rgba(8,8,15,0.3) 70%, rgba(8,8,15,0.5) 100%)' }} className="absolute inset-0" />
                <div style={{ background: 'radial-gradient(ellipse at center, transparent 30%, #08080f 80%)' }} className="absolute inset-0" />
            </div>

            {/* Ambient Glow Orbs */}
            <div style={{ left: '20%', top: '30%', width: '600px', height: '600px', background: 'radial-gradient(circle, rgba(79,70,229,0.15), transparent 60%)', borderRadius: '50%', willChange: 'transform', transform: 'translateZ(0)', pointerEvents: 'none' }} className="absolute z-0" />
            <div style={{ left: '80%', top: '20%', width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(124,58,237,0.1), transparent 60%)', borderRadius: '50%', willChange: 'transform', transform: 'translateZ(0)', pointerEvents: 'none' }} className="absolute z-0" />
            <div style={{ left: '50%', top: '80%', width: '400px', height: '400px', background: 'radial-gradient(circle, rgba(190,24,93,0.08), transparent 60%)', borderRadius: '50%', willChange: 'transform', transform: 'translateZ(0)', pointerEvents: 'none' }} className="absolute z-0" />

            {/* Content Container */}
            <div className="relative z-10 w-full max-w-5xl px-6 flex flex-col items-center text-center">

                {/* Top Badge Pill */}
                <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.2 }}
                    className="flex items-center gap-2 mb-8"
                    style={{
                        background: 'rgba(99,102,241,0.25)',
                        border: '1px solid rgba(99,102,241,0.45)',
                        boxShadow: '0 0 24px rgba(99,102,241,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
                        borderRadius: '999px',
                        padding: '10px 22px',
                        fontFamily: '"DM Mono", monospace',
                        fontSize: '12px',
                        fontWeight: 700,
                        letterSpacing: '0.2em',
                        textTransform: 'uppercase',
                        color: '#c7d2fe'
                    }}
                >
                    <div className="flex-shrink-0 animate-pulse-dot" style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#a5b4fc', boxShadow: '0 0 10px rgba(129,140,248,0.8)' }} />
                    ✦ Uncover Your Viewing Legacy
                </motion.div>

                {/* Hero Headline Block */}
                <motion.div
                    initial={{ opacity: 0, y: 40 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 1, ease: [0.23, 1, 0.32, 1], delay: 0.1 }}
                    className="flex flex-col items-center relative z-10"
                >
                    {/* Line 1 - The Year */}
                    <div
                        className="animate-shimmer-bg"
                        style={{
                            fontSize: 'clamp(80px, 16vw, 160px)',
                            fontWeight: 800,
                            lineHeight: 0.85,
                            letterSpacing: '-0.02em',
                            background: 'linear-gradient(135deg, #818cf8 0%, #a78bfa 25%, #f472b6 50%, #a78bfa 75%, #818cf8 100%)',
                            backgroundSize: '200% auto',
                            backgroundClip: 'text',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                        }}
                    >
                        {displayYear}
                    </div>

                    {/* Line 2 - Replay */}
                    <div className="flex flex-col items-center mt-2 relative">
                        <div
                            style={{
                                fontSize: 'clamp(80px, 16vw, 160px)',
                                fontWeight: 800,
                                lineHeight: 0.85,
                                letterSpacing: '-0.02em',
                                color: 'white',
                                position: 'relative',
                                display: 'inline-block'
                            }}
                        >
                            Replay.
                            {isCurrentYear && (
                                <motion.div
                                    initial={{ scale: 0, y: 6, rotate: 12, opacity: 0 }}
                                    animate={{
                                        scale: 1,
                                        y: 0,
                                        rotate: 12,
                                        opacity: 1
                                    }}
                                    transition={{
                                        type: "spring", stiffness: 280, damping: 15, delay: 1.1
                                    }}
                                    style={{
                                        position: 'absolute',
                                        bottom: '-18px',
                                        right: '-24px',
                                        background: '#1a1a30',
                                        border: '1px solid rgba(255,255,255,0.2)',
                                        boxShadow: '0 4px 24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.15)',
                                        padding: '5px 13px',
                                        borderRadius: '10px',
                                        fontFamily: '"DM Sans", sans-serif',
                                        fontSize: 'clamp(14px, 2.5vw, 22px)',
                                        fontWeight: 900,
                                        color: '#fbbf24',
                                        letterSpacing: '-0.02em',
                                        whiteSpace: 'nowrap',
                                        transformOrigin: 'bottom left'
                                    }}
                                >
                                    so far!
                                </motion.div>
                            )}
                        </div>

                        {displayMonth && (
                            <div
                                style={{
                                    fontSize: 'clamp(32px, 5vw, 56px)',
                                    letterSpacing: '0.15em',
                                    fontWeight: 800,
                                    color: 'rgba(255,255,255,0.6)',
                                    textTransform: 'uppercase',
                                    marginTop: '8px'
                                }}
                            >
                                {displayMonth}
                            </div>
                        )}
                    </div>
                </motion.div>

                {/* Subtitle */}
                <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.9, ease: "easeOut", delay: 0.7 }}
                    className="mt-8 mx-auto"
                    style={{
                        maxWidth: '560px',
                        fontSize: '20px',
                        fontWeight: 600,
                        lineHeight: 1.6,
                        color: 'rgba(255,255,255,0.7)'
                    }}
                >
                    {subtitleText}
                </motion.div>

                {/* Live Counter Tiles */}
                <div
                    className="flex flex-wrap justify-center mt-16 transition-all duration-700"
                    style={{
                        gap: '2px',
                        opacity: statsVisible ? 1 : 0,
                        transform: statsVisible ? 'scale(1)' : 'scale(0.94)',
                        transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
                        transitionDelay: '100ms'
                    }}
                >
                    <div
                        className="flex flex-col justify-center items-center"
                        style={{
                            borderRadius: '24px 4px 4px 24px',
                            padding: '16px 20px',
                            minWidth: '120px',
                            background: 'rgba(255,255,255,0.12)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRightWidth: '0px',
                            boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)'
                        }}
                    >
                        <div style={{ fontSize: '48px', fontWeight: 800, letterSpacing: '-0.03em', color: 'white', lineHeight: 1 }}>
                            <AnimatedNumber target={data.totalTitles} duration={1800} delay={700} />
                        </div>
                        <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '12px', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                            Titles Watched
                        </div>
                    </div>

                    <div
                        className="flex flex-col justify-center items-center"
                        style={{
                            borderRadius: '4px 24px 24px 4px',
                            padding: '16px 20px',
                            minWidth: '120px',
                            background: 'rgba(255,255,255,0.12)',
                            border: '1px solid rgba(255,255,255,0.15)',
                            boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)'
                        }}
                    >
                        <div style={{ fontSize: '48px', fontWeight: 800, letterSpacing: '-0.03em', color: 'white', lineHeight: 1 }}>
                            <AnimatedNumber target={data.totalHours} duration={2000} delay={900} />
                        </div>
                        <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '12px', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginTop: '8px' }}>
                            Hours Streamed
                        </div>
                    </div>
                </div>

                {/* Stat Pills */}
                <div className="flex flex-wrap justify-center gap-4 mt-8 relative z-10 w-full max-w-3xl">
                    {statPills.map((pill, i) => (
                        <div
                            key={i}
                            className="flex items-center gap-3"
                            style={{
                                background: 'rgba(255,255,255,0.18)',
                                border: '1px solid rgba(255,255,255,0.18)',
                                boxShadow: '0 8px 32px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.12)',
                                borderRadius: '999px',
                                padding: '14px 28px',
                                transform: readyPills ? 'translateY(0)' : 'translateY(20px)',
                                opacity: readyPills ? 1 : 0,
                                transition: `all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 100}ms`
                            }}
                        >
                            <pill.icon style={{ width: '18px', height: '18px', color: 'rgba(255,255,255,0.6)' }} />
                            <span
                                style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '12px',
                                    fontWeight: 700,
                                    letterSpacing: '0.15em',
                                    textTransform: 'uppercase',
                                    color: 'white'
                                }}
                            >
                                {pill.label}
                            </span>
                        </div>
                    ))}
                </div>

            </div>

            {/* Scroll Indicator */}
            <style>
                {`
                @keyframes scrollBob {
                    0%, 100% { transform: translateY(0); }
                    50% { transform: translateY(10px); }
                }
                `}
            </style>
            <div
                style={{
                    position: 'absolute',
                    bottom: '32px',
                    left: 0,
                    right: 0,
                    display: 'flex',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                    opacity: readyIndicator ? 0.75 : 0,
                    transition: 'opacity 1s ease'
                }}
            >
                <div style={{ animationName: 'scrollBob', animationDuration: '2s', animationIterationCount: 'infinite' }} className="flex flex-col items-center gap-3">
                    <div
                        style={{
                            fontFamily: '"DM Mono", monospace',
                            fontSize: '11px',
                            fontWeight: 700,
                            letterSpacing: '0.3em',
                            textTransform: 'uppercase',
                            color: 'white',
                        }}
                    >
                        Scroll to explore
                    </div>
                    <div style={{ width: '1px', height: '40px', background: 'linear-gradient(to bottom, rgba(255,255,255,0.8), transparent)' }} />
                </div>
            </div>

        </section >
    )
}
