import { useEffect, useState, useRef } from 'react'
import { motion, animate, useInView } from 'framer-motion'
// GlassCard removed for performance
import { ReplayData } from '@/types/ReplayTypes'

interface ReplayStatsProps {
    data: ReplayData
}

export function ReplayStats({ data }: ReplayStatsProps) {
    const stats = [
        { label: 'Titles Watched', value: data.totalTitles, sub: 'Total Discoveries' },
        { label: 'Hours Streamed', value: data.totalHours, sub: 'Days equivalent: ' + Math.floor(data.totalHours / 24) },
        { label: 'Longest Binge', value: data.longestStreak, sub: 'Consecutive day streak' },
        { label: 'Monthly Avg', value: data.avgTitlesPerMonth, sub: 'Steady engagement' }
    ]

    return (
        <section className="min-h-screen w-full flex flex-col items-center justify-center py-24 px-6 relative">
            <div className="container max-w-5xl">
                <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    className="mb-16"
                >
                    <h2 className="text-5xl md:text-7xl font-extrabold text-white tracking-tight leading-tight">By the Numbers</h2>
                    <p className="text-white/70 font-bold mt-2 uppercase tracking-[0.2em] text-[12px]">Your streaming metrics, codified</p>
                </motion.div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                    {stats.map((stat, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true, margin: "-50px" }}
                            transition={{ delay: i * 0.1, duration: 0.8 }}
                            className="p-8 rounded-[32px] flex flex-col justify-between group hover:scale-[1.02] transition-transform relative overflow-hidden"
                        >
                            <div className="absolute inset-0 z-[-1] bg-white/5 shadow-2xl rounded-[32px] border border-white/10" />
                            <div className="space-y-1 relative z-10">
                                <span className="text-white/70 text-[11px] font-black uppercase tracking-widest">{stat.label}</span>
                                <div className="text-5xl md:text-7xl font-extrabold text-white tracking-tight leading-[0.85]">
                                    <Counter value={stat.value} />
                                </div>
                            </div>
                            <div className="mt-8 text-xs font-bold text-white/50 group-hover:text-primary transition-colors uppercase tracking-tight">
                                {stat.sub}
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    )
}

function Counter({ value }: { value: number }) {
    const [display, setDisplay] = useState(0)
    const ref = useRef(null)
    const isInView = useInView(ref, { once: true, margin: "-100px" })

    useEffect(() => {
        if (!isInView) return

        const controls = animate(0, value, {
            duration: 1.5,
            ease: [0.23, 1, 0.32, 1],
            onUpdate: (latest) => setDisplay(Math.floor(latest))
        })
        return () => controls.stop()
    }, [value, isInView])

    return <span ref={ref}>{display.toLocaleString()}</span>
}
