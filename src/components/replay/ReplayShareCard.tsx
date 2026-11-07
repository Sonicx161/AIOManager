import { motion } from 'framer-motion'
import { ReplayData } from '@/types/ReplayTypes'
import { useTheme } from '@/contexts/ThemeContext'
import { useReplayDisplayMeta } from '@/hooks/useReplayDisplayMeta'
import { Poster } from '@/components/common/Poster'
import { useState } from 'react'
import { Link2, Check } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { buildReplayShareUrl } from '@/lib/replay-share-codec'

interface ReplayShareCardProps {
    data: ReplayData
    userName?: string
    hideButtons?: boolean
}

function ShareButtons({ data }: { data: ReplayData }) {
    const [copied, setCopied] = useState(false)
    const { toast } = useToast()

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(buildReplayShareUrl(window.location.origin, data))
            setCopied(true)
            toast({ title: 'Link copied', description: 'Share your Replay with anyone' })
            setTimeout(() => setCopied(false), 2500)
        } catch (e) {
            if (import.meta.env.DEV) console.error('[Share] Compression error:', e)
            toast({ variant: 'destructive', title: 'Copy failed', description: 'Could not copy to clipboard' })
        }
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
            <button
                type="button"
                data-theme-part="button"
                onClick={handleCopyLink}
                style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '10px 24px',
                    background: copied ? 'rgba(34,197,94,0.15)' : 'rgba(99,102,241,0.15)',
                    border: copied ? '1px solid rgba(34,197,94,0.4)' : '1px solid rgba(99,102,241,0.4)',
                    borderRadius: '999px', cursor: 'pointer', transition: 'all 300ms ease',
                    fontFamily: '"Inter", sans-serif', fontSize: '13px', fontWeight: 700,
                    color: copied ? 'rgba(134,239,172,0.9)' : 'rgba(165,180,252,0.9)',
                }}
            >
                {copied ? <Check style={{ width: 14, height: 14 }} /> : <Link2 style={{ width: 14, height: 14 }} />}
                {copied ? 'Copied!' : 'Copy Share Link'}
            </button>
            <p style={{ fontFamily: '"Inter", monospace', fontSize: '10px', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em', margin: 0 }}>
                SNAP A SCREENSHOT OR SHARE THE LINK
            </p>
        </div>
    )
}

export function ReplayShareCard({ data, userName, hideButtons }: ReplayShareCardProps) {
    const { displayYear, displayMonth } = useReplayDisplayMeta(data.year)
    const { isLight } = useTheme()

    return (
        <section className="w-full flex flex-col items-center justify-start py-8 px-6 relative overflow-hidden">
            <div className="container relative z-10 max-w-5xl flex flex-col items-center gap-6">

                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    className="flex flex-col items-center text-center gap-2"
                >
                    <span style={{ fontFamily: '"Inter", monospace', fontSize: '9px', letterSpacing: '0.3em', textTransform: 'uppercase', color: 'rgba(99,102,241,0.8)' }}>
                        ✦ {hideButtons ? 'A Cinematic Legacy' : 'Cinematic Summary'}
                    </span>
                    <h2 style={{ fontFamily: '"Inter", sans-serif', fontSize: 'clamp(42px, 6vw, 84px)', fontWeight: 700, letterSpacing: '-0.04em', color: 'white', lineHeight: 1.1 }}>
                        {hideButtons ? 'Snapshot of a' : 'Share Your'}<br />
                        <span style={{ background: 'linear-gradient(135deg, #818cf8, #f472b6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                            {displayMonth ? `${displayMonth} ${displayYear}` : displayYear} Replay
                        </span>
                    </h2>
                </motion.div>



                <div className="w-full relative flex justify-center py-6 px-4" style={{ minWidth: 0 }}>
                    <div
                        className="relative inline-block group transition-transform duration-700 origin-top"
                        style={{
                            flexShrink: 0,
                            // Dynamic scale based on viewport width (for < 400px devices)
                            transform: 'var(--card-scale, scale(1))'
                        }}
                    >

                        <style dangerouslySetInnerHTML={{
                            __html: `
                            @media (max-width: 400px) {
                                #section-share .group { --card-scale: scale(0.85); }
                            }
                            @media (max-width: 360px) {
                                #section-share .group { --card-scale: scale(0.78); }
                            }
                        `}} />


                        <div className="absolute inset-[-40px] rounded-[100px] opacity-40 group-hover:opacity-100 transition-opacity duration-700 ease-in-out pointer-events-none" style={{ background: `radial-gradient(circle, rgba(99,102,241,${isLight ? '0.2' : '0.08'}) 0%, transparent 70%)`, filter: 'blur(40px)' }} />


                        <div
                            id="replay-share-card-ui"
                            className="overflow-hidden relative z-20"
                            style={{
                                width: '380px',
                                height: '675px',
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

                {!hideButtons && <ShareButtons data={data} />}
            </div>
        </section>
    )
}

function CardContent({ data, userName }: { data: ReplayData, userName?: string }) {
    const { displayYear, displayMonth } = useReplayDisplayMeta(data.year)
    // Map "All Accounts (+N)" to "Unified Library" for a more premium feel
    const isCombined = userName?.toLowerCase().includes('all accounts')

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: '16px 14px', position: 'relative' }}>

            <div style={{
                position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
                backgroundColor: '#0d0d18'
            }} />
            <div className="noise-overlay" style={{ opacity: 0.02, zIndex: 1 }} />


            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexShrink: 0, position: 'relative', zIndex: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img
                        src="/logo.png"
                        alt=""
                        loading="lazy"
                        style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                    />
                    <span style={{ fontFamily: '"Inter", monospace', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', color: 'white', textTransform: 'uppercase' }}>
                        AIOManager
                    </span>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '999px', padding: '4px 12px', fontFamily: '"Inter", monospace', fontSize: '10px', fontWeight: 700, color: 'rgba(255,255,255,0.8)', letterSpacing: '0.1em' }}>
                    REPLAY {displayMonth ? `${displayMonth.toUpperCase()} ${displayYear}` : displayYear}
                </div>
            </div>


            <div className="flex flex-col items-center gap-4 flex-1 justify-center w-full" style={{ margin: '8px 0', flex: 1, minHeight: 0, position: 'relative', zIndex: 10 }}>
                {data.topTitles[0] && (
                    <>
                        <div style={{ overflow: 'hidden', borderRadius: '20px', display: 'inline-flex', boxShadow: '0 20px 50px rgba(0,0,0,0.6)', alignSelf: 'center' }}>
                            <Poster
                                src={data.topTitles[0].poster}
                                itemId={data.topTitles[0].itemId}
                                itemType={data.topTitles[0].type}
                                alt=""
                                className="w-auto h-auto max-h-[380px] object-cover"
                                style={{
                                    maxWidth: '100%',
                                    aspectRatio: '2/3',
                                }}
                            />
                        </div>
                        <div style={{ textAlign: 'center', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <div style={{ fontFamily: '"Inter", sans-serif', fontSize: '22px', fontWeight: 700, color: 'white', letterSpacing: '-0.03em', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.15 }}>
                                {data.topTitles[0].name}
                            </div>
                            <div style={{ fontFamily: '"Inter", monospace', fontSize: '11px', color: 'rgba(255,255,255,0.45)', letterSpacing: '0.25em', textTransform: 'uppercase', marginTop: '8px' }}>
                                #1 Most Watched
                            </div>
                        </div>
                    </>
                )}
            </div>


            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderRadius: '24px', overflow: 'hidden', width: '100%', flexShrink: 0, position: 'relative', zIndex: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {[
                    { label: 'Airtime', value: data.totalHours + 'h' },
                    { label: 'Titles', value: data.totalTitles },
                    { label: 'Discovery', value: data.discoveryPercentage + '% New' },
                    { label: 'Persona', value: data.persona }
                ].map((stat, i) => (
                    <div key={i} style={{
                        padding: '14px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        borderRight: i % 2 === 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                        borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                        minWidth: 0
                    }}>
                        <span style={{ fontFamily: '"Inter", monospace', fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>
                            {stat.label}
                        </span>
                        <span style={{
                            fontFamily: '"Inter", sans-serif',
                            fontSize: stat.label === 'Persona' ? '14px' : '22px',
                            fontWeight: 700,
                            color: 'white',
                            letterSpacing: '-0.02em',
                            lineHeight: 1.1,
                            whiteSpace: stat.label === 'Persona' ? 'normal' : 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            display: '-webkit-box',
                            WebkitLineClamp: stat.label === 'Persona' ? 2 : 1,
                            WebkitBoxOrient: 'vertical'
                        }}>
                            {stat.value}
                        </span>
                    </div>
                ))}
            </div>


            <div style={{
                flexShrink: 0,
                position: 'relative',
                zIndex: 10,
                fontFamily: '"Inter", monospace',
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
