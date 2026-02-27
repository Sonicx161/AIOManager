import { motion } from 'framer-motion'
import { ReplayData } from '@/types/ReplayTypes'

interface ReplayMilestonesProps {
    data: ReplayData
}

export function ReplayMilestones({ data }: ReplayMilestonesProps) {
    const unlocked = data.milestones.filter(m => m.unlocked)
    const locked = data.milestones.filter(m => !m.unlocked)

    // Sort unlocked by threshold descending (biggest achievements first)
    const sortedUnlocked = [...unlocked].sort((a, b) => b.threshold - a.threshold)
    // Show the next 3 locked milestones (closest to being unlocked)
    const nextUp = [...locked].sort((a, b) => {
        const aProgress = a.value / a.threshold
        const bProgress = b.value / b.threshold
        return bProgress - aProgress
    }).slice(0, 3)

    return (
        <section className="min-h-screen w-full flex flex-col items-center justify-center py-24 px-6 relative">
            <div className="container max-w-5xl">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    className="mb-16 text-center"
                >
                    <h2 className="text-5xl md:text-7xl font-black text-white tracking-[-0.04em] leading-tight">Milestones</h2>
                    <p className="text-white/70 font-bold mt-2 uppercase tracking-[0.2em] text-[12px]">
                        {unlocked.length} of {data.milestones.length} achievements unlocked
                    </p>
                </motion.div>

                {/* Unlocked Milestones */}
                {sortedUnlocked.length > 0 && (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-12">
                        {sortedUnlocked.map((milestone, i) => (
                            <motion.div
                                key={milestone.id}
                                initial={{ opacity: 0, scale: 0.85, y: 20 }}
                                whileInView={{ opacity: 1, scale: 1, y: 0 }}
                                viewport={{ once: true, margin: "-30px" }}
                                transition={{ delay: i * 0.06, duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                                className="group relative overflow-hidden"
                                style={{
                                    borderRadius: '28px',
                                    padding: '28px 20px',
                                    background: 'linear-gradient(145deg, rgba(99,102,241,0.15), rgba(139,92,246,0.08))',
                                    border: '1px solid rgba(99,102,241,0.25)',
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
                                    textAlign: 'center',
                                }}
                            >
                                {/* Glow effect */}
                                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                                    style={{ background: 'radial-gradient(circle at center, rgba(99,102,241,0.15) 0%, transparent 70%)' }}
                                />
                                <div className="relative z-10">
                                    <div style={{ fontSize: '36px', lineHeight: 1 }} className="mb-3">{milestone.icon}</div>
                                    <div style={{
                                        fontFamily: '"DM Sans", sans-serif',
                                        fontSize: '14px',
                                        fontWeight: 900,
                                        color: 'white',
                                        letterSpacing: '-0.02em',
                                    }}>{milestone.title}</div>
                                    <div style={{
                                        fontFamily: '"DM Mono", monospace',
                                        fontSize: '11px',
                                        fontWeight: 600,
                                        color: 'rgba(255,255,255,0.65)',
                                        letterSpacing: '0.1em',
                                        textTransform: 'uppercase',
                                        marginTop: '6px',
                                    }}>{milestone.description}</div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                )}

                {/* Next Up - Locked Milestones */}
                {nextUp.length > 0 && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            className="mb-6 text-center"
                        >
                            <span style={{
                                fontFamily: '"DM Mono", monospace',
                                fontSize: '11px',
                                fontWeight: 700,
                                letterSpacing: '0.2em',
                                textTransform: 'uppercase',
                                color: 'rgba(255,255,255,0.5)',
                            }}>Next Milestones</span>
                        </motion.div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {nextUp.map((milestone, i) => {
                                const progress = Math.min(Math.round((milestone.value / milestone.threshold) * 100), 99)
                                return (
                                    <motion.div
                                        key={milestone.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        whileInView={{ opacity: 1, y: 0 }}
                                        viewport={{ once: true }}
                                        transition={{ delay: i * 0.08 }}
                                        className="relative overflow-hidden"
                                        style={{
                                            borderRadius: '24px',
                                            padding: '24px',
                                            background: 'rgba(255,255,255,0.03)',
                                            border: '1px solid rgba(255,255,255,0.06)',
                                        }}
                                    >
                                        <div className="flex items-start gap-4">
                                            <div style={{ fontSize: '28px', opacity: 0.4, marginTop: '2px' }}>{milestone.icon}</div>
                                            <div className="flex-1 min-w-0">
                                                <div style={{
                                                    fontFamily: '"DM Sans", sans-serif',
                                                    fontSize: '14px',
                                                    fontWeight: 800,
                                                    color: 'rgba(255,255,255,0.8)',
                                                }}>{milestone.title}</div>
                                                <div style={{
                                                    fontFamily: '"DM Sans", sans-serif',
                                                    fontSize: '12px',
                                                    fontWeight: 500,
                                                    color: 'rgba(255,255,255,0.6)',
                                                    marginTop: '3px',
                                                    lineHeight: 1.4,
                                                }}>{milestone.description}</div>
                                                <div style={{
                                                    fontFamily: '"DM Mono", monospace',
                                                    fontSize: '11px',
                                                    fontWeight: 600,
                                                    color: 'rgba(255,255,255,0.5)',
                                                    letterSpacing: '0.1em',
                                                    textTransform: 'uppercase',
                                                    marginTop: '6px',
                                                }}>{milestone.value} / {milestone.threshold}</div>
                                                {/* Progress bar */}
                                                <div className="mt-3 h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                                                    <motion.div
                                                        initial={{ width: 0 }}
                                                        whileInView={{ width: `${progress}%` }}
                                                        transition={{ duration: 1.2, ease: [0.23, 1, 0.32, 1] }}
                                                        style={{ background: 'linear-gradient(90deg, rgba(99,102,241,0.6), rgba(139,92,246,0.4))' }}
                                                        className="h-full rounded-full"
                                                    />
                                                </div>
                                            </div>
                                            <div style={{
                                                fontFamily: '"DM Mono", monospace',
                                                fontSize: '12px',
                                                fontWeight: 900,
                                                color: 'rgba(255,255,255,0.6)',
                                            }}>{progress}%</div>
                                        </div>
                                    </motion.div>
                                )
                            })}
                        </div>
                    </>
                )}

                {unlocked.length === 0 && (
                    <div className="text-center py-20 text-white/20 font-black italic">
                        Keep watching to unlock your first milestone!
                    </div>
                )}
            </div>
        </section>
    )
}
