import { motion } from 'framer-motion'
import { ReplayData } from '@/types/ReplayTypes'
import { useReplayDisplayMeta } from '@/hooks/useReplayDisplayMeta'
import { Poster } from '@/components/common/Poster'

interface ReplayShareCardProps {
    data: ReplayData
    userName?: string
}

export function ReplayShareCard({ data, userName }: ReplayShareCardProps) {
    const { displayYear, displayMonth } = useReplayDisplayMeta(data.year)

    return (
        <section className="w-full flex flex-col items-center justify-start py-8 px-6 relative overflow-hidden">
            <div className="container relative z-10 max-w-5xl flex flex-col items-center gap-6">
                {/* Section header */}
                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    className="flex flex-col items-center text-center gap-2"
                >
                    <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '9px', letterSpacing: '0.3em', textTransform: 'uppercase', color: 'rgba(99,102,241,0.8)' }}>
                        ✦ Your Cinematic Summary
                    </span>
                    <h2 style={{ fontFamily: '"DM Sans", sans-serif', fontSize: 'clamp(42px, 6vw, 84px)', fontWeight: 900, letterSpacing: '-0.04em', color: 'white', lineHeight: 1.1 }}>
                        Share Your<br />
                        <span style={{ background: 'linear-gradient(135deg, #818cf8, #f472b6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                            {displayMonth || displayYear}
                        </span>
                    </h2>
                </motion.div>


                {/* The Card wrapper enclosed in a scrollable mobile context */}
                <div className="w-full overflow-x-auto pb-6 pt-10 -mt-10 flex justify-center scrollbar-hide" style={{ maxWidth: '100vw' }}>
                    <div className="relative inline-block group group-hover:scale-[1.01] transition-transform duration-700" style={{ margin: '0 auto', flexShrink: 0 }}>
                        {/* Hover glow behind card */}
                        <div className="absolute inset-[-40px] rounded-[100px] opacity-40 group-hover:opacity-100 transition-opacity duration-700 ease-in-out pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.2) 0%, transparent 70%)', filter: 'blur(40px)' }} />

                        {/* The Card UI Display */}
                        <div
                            id="replay-share-card-ui"
                            className="w-full h-full p-4 overflow-hidden relative z-20"
                            style={{
                                width: '380px',
                                height: '675px',
                                overflow: 'hidden',
                                borderRadius: '32px',
                                background: '#0d0d18',
                                boxShadow: '0 20px 80px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,255,255,0.1)',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                position: 'relative',
                                zIndex: 10,
                                transition: 'all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
                            }}
                        >
                            <CardContent data={data} userName={userName} />
                        </div>
                    </div>
                </div>

                <p style={{ fontFamily: '"DM Mono", monospace', fontSize: '10px', color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em', marginTop: '12px' }}>
                    SNAP A SCREENSHOT TO SHARE
                </p>
            </div>
        </section>
    )
}

function CardContent({ data, userName }: { data: ReplayData, userName?: string }) {
    const { displayYear } = useReplayDisplayMeta(data.year)
    // Map "All Accounts (+N)" to "Unified Library" for a more premium feel
    const isCombined = userName?.toLowerCase().includes('all accounts')

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: '24px', position: 'relative' }}>
            {/* Background Layer */}
            <div style={{
                position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                backgroundColor: '#0d0d18'
            }} />
            <div className="noise-overlay" style={{ opacity: 0.02, zIndex: 1 }} />

            {/* Header Row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexShrink: 0, position: 'relative', zIndex: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img
                        src="/logo.png"
                        alt=""
                        style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                    />
                    <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '11px', fontWeight: 900, letterSpacing: '0.1em', color: 'white', textTransform: 'uppercase' }}>
                        AIOManager
                    </span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '999px', padding: '4px 12px', fontFamily: '"DM Mono", monospace', fontSize: '10px', fontWeight: 700, color: 'rgba(255,255,255,0.8)', letterSpacing: '0.1em' }}>
                    REPLAY {displayYear}
                </div>
            </div>

            {/* Top title poster */}
            <div className="flex flex-col items-center gap-4 flex-1 justify-center w-full" style={{ margin: '8px 0', flex: 1, minHeight: 0, position: 'relative', zIndex: 10 }}>
                {data.topTitles[0] && (
                    <>
                        <div style={{ overflow: 'hidden', borderRadius: '20px', display: 'flex', justifyContent: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.6)' }}>
                            <Poster
                                src={data.topTitles[0].poster}
                                itemId={data.topTitles[0].itemId}
                                itemType={data.topTitles[0].type}
                                alt=""
                                style={{
                                    width: 'auto',
                                    maxWidth: '100%',
                                    maxHeight: '380px',
                                    aspectRatio: '2/3',
                                    objectFit: 'cover'
                                }}
                            />
                        </div>
                        <div style={{ textAlign: 'center', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <div style={{ fontFamily: '"DM Sans", sans-serif', fontSize: '22px', fontWeight: 800, color: 'white', letterSpacing: '-0.03em', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.15 }}>
                                {data.topTitles[0].name}
                            </div>
                            <div style={{ fontFamily: '"DM Mono", monospace', fontSize: '11px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.25em', textTransform: 'uppercase', marginTop: '8px' }}>
                                #1 Most Watched
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderRadius: '24px', overflow: 'hidden', width: '100%', flexShrink: 0, position: 'relative', zIndex: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {[
                    { label: 'Airtime', value: data.totalHours + 'h' },
                    { label: 'Titles', value: data.totalTitles },
                    { label: 'Discovery', value: data.discoveryPercentage + '% New' },
                    { label: 'Persona', value: data.persona }
                ].map((stat, i) => (
                    <div key={i} style={{
                        padding: '16px 18px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        borderRight: i % 2 === 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                        borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                    }}>
                        <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '11px', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
                            {stat.label}
                        </span>
                        <span style={{
                            fontFamily: '"DM Sans", sans-serif',
                            fontSize: stat.label === 'Persona' ? '16px' : '24px',
                            fontWeight: 800,
                            color: 'white',
                            letterSpacing: '-0.02em',
                            lineHeight: 1.2,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                        }}>
                            {stat.value}
                        </span>
                    </div>
                ))}
            </div>

            {/* Footer Attribution */}
            <div style={{
                flexShrink: 0,
                position: 'relative',
                zIndex: 10,
                fontFamily: '"DM Mono", monospace',
                fontSize: '11px',
                color: 'rgba(255,255,255,0.45)',
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                textAlign: 'center',
                marginTop: '16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
            }}>
                <div style={{ height: '1px', flex: 1, background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.08))' }} />
                <span style={{ fontWeight: 600 }}>{isCombined ? 'Unified Library' : userName}</span>
                <div style={{ height: '1px', flex: 1, background: 'linear-gradient(to left, transparent, rgba(255,255,255,0.08))' }} />
            </div>
        </div>
    )
}
