import { useEffect, useRef, useState } from 'react'
import { motion, animate, useInView } from 'framer-motion'
import { ReplayData } from '@/types/ReplayTypes'
import { useReplayDisplayMeta } from '@/hooks/useReplayDisplayMeta'

interface ReplayYearInNumbersProps {
    data: ReplayData
}

function MiniCounter({ value, suffix = '' }: { value: number; suffix?: string }) {
    const [display, setDisplay] = useState(0)
    const ref = useRef(null)
    const isInView = useInView(ref, { once: true, margin: '-50px' })

    useEffect(() => {
        if (!isInView) return
        const controls = animate(0, value, {
            duration: 1.8,
            ease: [0.23, 1, 0.32, 1],
            onUpdate: (latest) => setDisplay(Math.floor(latest)),
        })
        return () => controls.stop()
    }, [value, isInView])

    return <span ref={ref}>{display.toLocaleString()}{suffix}</span>
}

function formatHour(hour: number) {
    if (hour === 0) return '12 AM'
    if (hour === 12) return '12 PM'
    return hour > 12 ? `${hour - 12} PM` : `${hour} AM`
}

export function ReplayYearInNumbers({ data }: ReplayYearInNumbersProps) {
    const { displayYear } = useReplayDisplayMeta(data.year)
    const discoveryPct = data.discoveryPercentage ?? 0

    const items = [
        { label: 'Airtime', value: Math.round(data.totalHours), suffix: 'h', icon: '⏱️' },
        { label: 'New Finds', value: Math.round(discoveryPct), suffix: '%', icon: '✦' },
        { label: 'Prime Time', value: 0, suffix: '', icon: '🌙', text: formatHour(data.peakHour) },
        { label: 'Binge Day', value: 0, suffix: '', icon: '🚀', text: data.peakDay },
        { label: 'Avg / Mo', value: data.avgTitlesPerMonth, suffix: '', icon: '📊' },
    ]

    return (
        <section className="w-full flex flex-col items-center py-8 px-4 relative overflow-visible">
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.8, ease: [0.23, 1, 0.32, 1] }}
                className="container max-w-5xl"
            >
                {/* Header */}
                <div className="text-center mb-8">
                    <span
                        style={{
                            fontFamily: '"DM Mono", monospace',
                            fontSize: '11px',
                            letterSpacing: '0.3em',
                            textTransform: 'uppercase',
                            color: 'rgba(99,102,241,0.9)',
                        }}
                    >
                        ✦ your {displayYear} at a glance
                    </span>
                </div>

                {/* Horizontal strip */}
                <div
                    className="flex justify-center gap-1 md:gap-2 flex-wrap"
                    style={{ contain: 'layout' }}
                >
                    {items.map((item, i) => (
                        <motion.div
                            key={item.label}
                            initial={{ opacity: 0, y: 16 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: i * 0.08, duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                            className="flex flex-col items-center gap-1 px-4 md:px-6 py-4 md:py-5 flex-1 min-w-[80px] max-w-[160px]"
                            style={{
                                borderRadius: '20px',
                                background: 'rgba(255,255,255,0.03)',
                                border: '1px solid rgba(255,255,255,0.06)',
                            }}
                        >
                            <span style={{ fontSize: '18px', lineHeight: 1 }}>{item.icon}</span>
                            <span
                                style={{
                                    fontFamily: '"DM Sans", sans-serif',
                                    fontSize: 'clamp(20px, 3vw, 28px)',
                                    fontWeight: 900,
                                    color: 'white',
                                    letterSpacing: '-0.03em',
                                    lineHeight: 1.1,
                                }}
                            >
                                {item.text ? item.text : <MiniCounter value={item.value} suffix={item.suffix} />}
                            </span>
                            <span
                                style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    letterSpacing: '0.2em',
                                    textTransform: 'uppercase',
                                    color: 'rgba(255,255,255,0.6)',
                                }}
                            >
                                {item.label}
                            </span>
                        </motion.div>
                    ))}
                </div>
            </motion.div>
        </section>
    )
}
