import { motion } from 'framer-motion'
import { ReplayData } from '@/types/ReplayTypes'

interface ReplayInsightsProps {
    data: ReplayData
}

// Format hour number to human-readable
const formatHour = (hour: number): string => {
    if (hour === 0) return '12 AM'
    if (hour === 12) return '12 PM'
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`
}

export function ReplayInsights({ data }: ReplayInsightsProps) {
    const yoy = data.yearOverYear

    return (
        <section className="min-h-screen w-full flex flex-col items-center justify-center py-24 px-6 relative">
            <div className="container max-w-5xl">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    className="mb-16 text-center"
                >
                    <h2 className="text-5xl md:text-7xl font-black text-white tracking-[-0.04em] leading-tight">Deep Insights</h2>
                    <p className="text-white/70 font-bold mt-2 uppercase tracking-[0.2em] text-[12px]">Patterns hidden in your viewing behavior</p>
                </motion.div>

                <div className="space-y-8">

                    {/* ── Row 1: Time-of-Day + Day-of-Week ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* Time-of-Day Radial Visualization */}
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8 }}
                            className="relative overflow-hidden"
                            style={{
                                borderRadius: '32px',
                                padding: '32px',
                                background: 'linear-gradient(160deg, rgba(15,15,30,0.9), rgba(10,10,20,0.95))',
                                border: '1px solid rgba(255,255,255,0.08)',
                                boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                            }}
                        >
                            <div style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 700,
                                letterSpacing: '0.25em',
                                textTransform: 'uppercase',
                                color: 'rgba(255,255,255,0.6)',
                                marginBottom: '12px',
                            }}>Peak Viewing Hours</div>

                            <div style={{
                                fontFamily: '"DM Sans", sans-serif',
                                fontSize: '28px',
                                fontWeight: 900,
                                color: 'white',
                                letterSpacing: '-0.03em',
                                marginBottom: '4px',
                            }}>{formatHour(data.peakHour)}</div>
                            <div style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.6)',
                                letterSpacing: '0.1em',
                                marginBottom: '24px',
                            }}>YOUR PRIME TIME</div>

                            {/* Hourly bar chart */}
                            <div className="flex items-end gap-[2px]" style={{ height: '100px' }}>
                                {data.hourlyDistribution.map((h, i) => (
                                    <motion.div
                                        key={h.hour}
                                        initial={{ height: 0 }}
                                        whileInView={{ height: `${Math.max(h.percentage, 3)}%` }}
                                        viewport={{ once: true }}
                                        transition={{ duration: 0.8, delay: i * 0.02, ease: [0.23, 1, 0.32, 1] }}
                                        className="flex-1 rounded-t-sm relative group cursor-default"
                                        style={{
                                            background: h.hour === data.peakHour
                                                ? 'linear-gradient(to top, #818cf8, #a78bfa)'
                                                : h.hour >= 18 || h.hour <= 5
                                                    ? 'rgba(139,92,246,0.3)'
                                                    : 'rgba(255,255,255,0.12)',
                                            minHeight: '2px',
                                            borderRadius: '2px 2px 0 0',
                                        }}
                                    >
                                        {/* Tooltip */}
                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-black/90 backdrop-blur rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10"
                                            style={{ fontFamily: '"DM Mono", monospace', fontSize: '11px', fontWeight: 700, color: 'white' }}
                                        >
                                            {formatHour(h.hour)}: {h.count}
                                        </div>
                                    </motion.div>
                                ))}
                            </div>

                            {/* Hour axis labels */}
                            <div className="flex justify-between mt-2" style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '10px',
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.4)',
                            }}>
                                <span>12AM</span>
                                <span>6AM</span>
                                <span>12PM</span>
                                <span>6PM</span>
                                <span>12AM</span>
                            </div>
                        </motion.div>

                        {/* Day-of-Week Heatmap */}
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8, delay: 0.1 }}
                            className="relative overflow-hidden"
                            style={{
                                borderRadius: '32px',
                                padding: '32px',
                                background: 'linear-gradient(160deg, rgba(15,15,30,0.9), rgba(10,10,20,0.95))',
                                border: '1px solid rgba(255,255,255,0.08)',
                                boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                            }}
                        >
                            <div style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 700,
                                letterSpacing: '0.25em',
                                textTransform: 'uppercase',
                                color: 'rgba(255,255,255,0.6)',
                                marginBottom: '12px',
                            }}>Weekly Pattern</div>

                            <div style={{
                                fontFamily: '"DM Sans", sans-serif',
                                fontSize: '28px',
                                fontWeight: 900,
                                color: 'white',
                                letterSpacing: '-0.03em',
                                marginBottom: '4px',
                            }}>{data.peakDay}</div>
                            <div style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.6)',
                                letterSpacing: '0.1em',
                                marginBottom: '24px',
                            }}>YOUR BINGE DAY</div>

                            {/* Day bars */}
                            <div className="space-y-3">
                                {data.dailyDistribution.map((d, i) => {
                                    const isPeak = d.dayName === data.peakDay
                                    return (
                                        <motion.div
                                            key={d.day}
                                            initial={{ opacity: 0, x: -20 }}
                                            whileInView={{ opacity: 1, x: 0 }}
                                            viewport={{ once: true }}
                                            transition={{ delay: i * 0.05 }}
                                            className="flex items-center gap-3"
                                        >
                                            <div style={{
                                                fontFamily: '"DM Mono", monospace',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                color: isPeak ? '#a5b4fc' : 'rgba(255,255,255,0.7)',
                                                width: '32px',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.05em',
                                            }}>{d.dayName.slice(0, 3)}</div>
                                            <div className="flex-1 h-5 bg-white/5 rounded-full overflow-hidden">
                                                <motion.div
                                                    initial={{ width: 0 }}
                                                    whileInView={{ width: `${d.percentage}%` }}
                                                    viewport={{ once: true }}
                                                    transition={{ duration: 1, delay: i * 0.05, ease: [0.23, 1, 0.32, 1] }}
                                                    className="h-full rounded-full relative"
                                                    style={{
                                                        background: isPeak
                                                            ? 'linear-gradient(90deg, #818cf8, #a78bfa)'
                                                            : 'rgba(255,255,255,0.12)',
                                                        boxShadow: isPeak ? '0 0 12px rgba(129,140,248,0.4)' : 'none',
                                                    }}
                                                />
                                            </div>
                                            <div style={{
                                                fontFamily: '"DM Mono", monospace',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                color: isPeak ? 'white' : 'rgba(255,255,255,0.7)',
                                                width: '48px',
                                                textAlign: 'right',
                                            }}>{d.hours}h</div>
                                        </motion.div>
                                    )
                                })}
                            </div>
                        </motion.div>
                    </div>

                    {/* ── Row 2: Year-over-Year + Discovery Stats ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                        {/* Year-over-Year */}
                        {yoy ? (
                            <motion.div
                                initial={{ opacity: 0, y: 30 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ duration: 0.8 }}
                                className="relative overflow-hidden"
                                style={{
                                    borderRadius: '32px',
                                    padding: '32px',
                                    background: 'linear-gradient(160deg, rgba(15,15,30,0.9), rgba(10,10,20,0.95))',
                                    border: '1px solid rgba(255,255,255,0.08)',
                                    boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                                }}
                            >
                                <div style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    letterSpacing: '0.25em',
                                    textTransform: 'uppercase',
                                    color: 'rgba(255,255,255,0.6)',
                                    marginBottom: '16px',
                                }}>Year Over Year</div>

                                <div style={{
                                    fontFamily: '"DM Sans", sans-serif',
                                    fontSize: '20px',
                                    fontWeight: 900,
                                    color: 'white',
                                    letterSpacing: '-0.02em',
                                    marginBottom: '20px',
                                }}>{yoy.prevYear} → {yoy.currentYear}</div>

                                <div className="grid grid-cols-2 gap-4">
                                    {[
                                        { label: 'Titles', delta: yoy.titlesDelta, prev: yoy.prevTitles, curr: yoy.currentTitles },
                                        { label: 'Hours', delta: yoy.hoursDelta, prev: yoy.prevHours, curr: yoy.currentHours },
                                        { label: 'Streak', delta: yoy.streakDelta, prev: null, curr: null, isSuffix: true, suffix: ' days' },
                                        { label: 'Loyalty', delta: yoy.loyaltyDelta, prev: null, curr: null },
                                    ].map((stat, i) => (
                                        <motion.div
                                            key={stat.label}
                                            initial={{ opacity: 0, y: 10 }}
                                            whileInView={{ opacity: 1, y: 0 }}
                                            viewport={{ once: true }}
                                            transition={{ delay: i * 0.08 }}
                                            className="p-4 rounded-2xl"
                                            style={{
                                                background: 'rgba(255,255,255,0.03)',
                                                border: '1px solid rgba(255,255,255,0.05)',
                                            }}
                                        >
                                            <div style={{
                                                fontFamily: '"DM Mono", monospace',
                                                fontSize: '11px',
                                                fontWeight: 700,
                                                letterSpacing: '0.2em',
                                                textTransform: 'uppercase',
                                                color: 'rgba(255,255,255,0.6)',
                                                marginBottom: '8px',
                                            }}>{stat.label}</div>
                                            <div className="flex items-baseline gap-2">
                                                <span style={{
                                                    fontFamily: '"DM Sans", sans-serif',
                                                    fontSize: '24px',
                                                    fontWeight: 900,
                                                    color: stat.delta > 0 ? '#34d399' : stat.delta < 0 ? '#f87171' : 'rgba(255,255,255,0.5)',
                                                }}>
                                                    {stat.delta > 0 ? '+' : ''}{stat.delta}{stat.label === 'Streak' ? '' : '%'}
                                                </span>
                                            </div>
                                            {stat.prev !== null && (
                                                <div style={{
                                                    fontFamily: '"DM Mono", monospace',
                                                    fontSize: '11px',
                                                    fontWeight: 600,
                                                    color: 'rgba(255,255,255,0.6)',
                                                    marginTop: '4px',
                                                }}>{stat.prev} → {stat.curr}</div>
                                            )}
                                        </motion.div>
                                    ))}
                                </div>
                            </motion.div>
                        ) : (
                            <motion.div
                                initial={{ opacity: 0, y: 30 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ duration: 0.8 }}
                                className="relative overflow-hidden flex flex-col items-center justify-center text-center"
                                style={{
                                    borderRadius: '32px',
                                    padding: '32px',
                                    background: 'rgba(255,255,255,0.02)',
                                    border: '1px solid rgba(255,255,255,0.05)',
                                    minHeight: '280px',
                                }}
                            >
                                <div style={{ fontSize: '36px', marginBottom: '12px', opacity: 0.3 }}>📊</div>
                                <div style={{
                                    fontFamily: '"DM Sans", sans-serif',
                                    fontSize: '14px',
                                    fontWeight: 800,
                                    color: 'rgba(255,255,255,0.3)',
                                }}>Year-over-Year</div>
                                <div style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    color: 'rgba(255,255,255,0.5)',
                                    marginTop: '6px',
                                    maxWidth: '200px',
                                }}>Select a specific year with prior data to unlock comparisons</div>
                            </motion.div>
                        )}

                        {/* Discovery Stats */}
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.8, delay: 0.1 }}
                            className="relative overflow-hidden"
                            style={{
                                borderRadius: '32px',
                                padding: '32px',
                                background: 'linear-gradient(160deg, rgba(8,20,15,0.9), rgba(10,10,20,0.95))',
                                border: '1px solid rgba(52,211,153,0.15)',
                                boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
                            }}
                        >
                            <div style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 700,
                                letterSpacing: '0.25em',
                                textTransform: 'uppercase',
                                color: 'rgba(52,211,153,0.8)',
                                marginBottom: '12px',
                            }}>Discovery Radar</div>

                            {/* Big number */}
                            <div className="flex items-baseline gap-3 mb-2">
                                <span style={{
                                    fontFamily: '"DM Sans", sans-serif',
                                    fontSize: '56px',
                                    fontWeight: 900,
                                    color: '#34d399',
                                    lineHeight: 1,
                                    letterSpacing: '-0.04em',
                                }}>{data.totalUniqueDiscoveries}</span>
                                <span style={{
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '12px',
                                    fontWeight: 700,
                                    color: 'rgba(52,211,153,0.8)',
                                    letterSpacing: '0.1em',
                                    textTransform: 'uppercase',
                                }}>New titles</span>
                            </div>

                            <div style={{
                                fontFamily: '"DM Sans", sans-serif',
                                fontSize: '16px',
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.7)',
                                lineHeight: 1.6,
                                marginBottom: '24px',
                            }}>
                                <span style={{ color: '#34d399', fontWeight: 900 }}>{data.discoveryPercentage}%</span> of your watches were brand new discoveries you'd never seen before.
                            </div>

                            {/* Discovery breakdown visual */}
                            <div className="flex gap-[2px] h-6 rounded-full overflow-hidden">
                                <motion.div
                                    initial={{ width: 0 }}
                                    whileInView={{ width: `${data.discoveryPercentage}%` }}
                                    viewport={{ once: true }}
                                    transition={{ duration: 1.2, ease: [0.23, 1, 0.32, 1] }}
                                    style={{ background: 'linear-gradient(90deg, #34d399, #10b981)' }}
                                    className="h-full rounded-l-full flex items-center justify-center"
                                >
                                    {data.discoveryPercentage > 15 && (
                                        <span style={{
                                            fontFamily: '"DM Mono", monospace',
                                            fontSize: '8px',
                                            fontWeight: 900,
                                            color: 'rgba(0,0,0,0.6)',
                                            letterSpacing: '0.1em',
                                        }}>NEW</span>
                                    )}
                                </motion.div>
                                <div
                                    className="flex-1 h-full rounded-r-full flex items-center justify-center"
                                    style={{ background: 'rgba(255,255,255,0.06)' }}
                                >
                                    {(100 - data.discoveryPercentage) > 15 && (
                                        <span style={{
                                            fontFamily: '"DM Mono", monospace',
                                            fontSize: '8px',
                                            fontWeight: 900,
                                            color: 'rgba(255,255,255,0.15)',
                                            letterSpacing: '0.1em',
                                        }}>REWATCHED</span>
                                    )}
                                </div>
                            </div>

                            {/* Persona badge */}
                            <div className="mt-6 flex items-center gap-3 p-4 rounded-2xl"
                                style={{
                                    background: 'rgba(52,211,153,0.08)',
                                    border: '1px solid rgba(52,211,153,0.1)',
                                }}
                            >
                                <div style={{ fontSize: '20px' }}>✦</div>
                                <div>
                                    <div style={{
                                        fontFamily: '"DM Sans", sans-serif',
                                        fontSize: '13px',
                                        fontWeight: 900,
                                        color: '#34d399',
                                    }}>{data.persona}</div>
                                    <div style={{
                                        fontFamily: '"DM Sans", sans-serif',
                                        fontSize: '12px',
                                        fontWeight: 500,
                                        color: 'rgba(255,255,255,0.6)',
                                        marginTop: '2px',
                                    }}>{data.personaDescription}</div>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                </div>
            </div>
        </section>
    )
}
