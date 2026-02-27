import { useState } from 'react'
import { motion } from 'framer-motion'
import { Clock } from 'lucide-react'
// GlassPill removed for performance
import { ReplayData } from '@/types/ReplayTypes'
import { openStremioDetail } from '@/lib/utils'
import { Poster } from '@/components/common/Poster'

interface ReplayTopTitlesProps {
    data: ReplayData
    allTimeData: ReplayData
}

export function ReplayTopTitles({ data, allTimeData }: ReplayTopTitlesProps) {
    const [view, setView] = useState<'year' | 'all-time'>('year')
    const currentData = view === 'year' ? data : allTimeData
    const top10 = currentData.topTitles.slice(0, 10)
    const hero = top10[0]
    const rest = top10.slice(1)

    const handleTitleClick = (item: { type: string, itemId: string }) => {
        openStremioDetail(item.type, item.itemId)
    }

    return (
        <section className="min-h-screen w-full flex flex-col items-center py-24 pb-48 px-6 relative">
            <div className="container max-w-4xl">
                <div className="flex flex-col md:flex-row md:items-end justify-between mb-16 gap-6">
                    <div>
                        <motion.h2
                            initial={{ opacity: 0, y: 10 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true, margin: "-100px" }}
                            className="text-5xl md:text-7xl font-black text-white tracking-[-0.04em] leading-tight"
                        >
                            Your Top Titles
                        </motion.h2>
                        <p className="text-white/70 font-bold mt-2 uppercase tracking-[0.2em] text-[12px]">The content that defined your journey</p>
                    </div>

                    {data.year !== 'all-time' && (
                        <div className="flex p-1.5 border border-white/10 rounded-full bg-white/5 shadow-xl">
                            {['year', 'all-time'].map((v) => (
                                <button
                                    key={v}
                                    onClick={() => setView(v as 'year' | 'all-time')}
                                    className={`px-6 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-all ${view === v ? 'bg-white text-black' : 'text-white/40 hover:text-white'
                                        }`}
                                >
                                    {v === 'year' ? (
                                        typeof data.year === 'string' && data.year.includes('-')
                                            ? `In ${new Date(Number(data.year.split('-')[0]), Number(data.year.split('-')[1]) - 1, 1).toLocaleString('default', { month: 'short' })} ${data.year.split('-')[0]}`
                                            : `In ${data.year}`
                                    ) : 'All Time'}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
                    {hero && (
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true, margin: "-100px" }}
                            className="bg-gradient-to-br from-[#2a1a08] to-[#151310] pb-0 p-8 md:p-12 rounded-[40px] flex flex-col items-center relative border border-white/10 shadow-2xl cursor-pointer group"
                            onClick={() => handleTitleClick(hero)}
                        >
                            <div className="absolute top-8 left-8 bg-yellow-500 text-black px-4 py-1 rounded-full text-xs font-black uppercase tracking-widest shadow-lg z-20">
                                #1 Most Watched
                            </div>

                            <div className="text-center space-y-4 relative z-10 mb-12 mt-8">
                                <h3 className="text-5xl md:text-7xl font-black text-white tracking-[-0.04em] leading-tight drop-shadow-lg">
                                    {hero.name}
                                </h3>
                                <div className="flex items-center justify-center mt-2">
                                    <span className="text-[11px] font-black uppercase tracking-[0.2em] px-3 py-1 rounded-full bg-white/10 text-white/70 border border-white/10">
                                        {hero.type === 'series' ? 'Series' : hero.type === 'movie' ? 'Movie' : hero.type}
                                    </span>
                                </div>
                                <div className="flex items-center justify-center gap-6 mt-4">
                                    <div className="flex items-center gap-2 text-white/80 font-bold text-sm bg-black/20 px-4 py-2 rounded-full border border-white/5">
                                        <Clock className="w-4 h-4 text-purple-400" />
                                        {Math.round(hero.totalHours)} Hours
                                    </div>
                                </div>
                                <p className="text-white/70 text-[11px] md:text-sm font-bold uppercase tracking-[0.2em] mt-4 max-w-md mx-auto">
                                    {Math.round((hero.totalHours / currentData.totalHours) * 100)}% of your total stream time
                                </p>
                            </div>

                            <div className="relative w-52 md:w-72 aspect-[2/3] rounded-3xl overflow-hidden shadow-2xl shadow-black/80 mt-auto transform group-hover:-translate-y-4 transition-transform duration-500 border border-white/10">
                                <Poster
                                    src={hero.poster}
                                    itemId={hero.itemId}
                                    itemType={hero.type}
                                    alt={hero.name}
                                    className="w-full h-full object-cover relative z-10"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-[#151310]/50 via-transparent to-transparent z-20" />
                            </div>
                        </motion.div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-20 mt-4">
                        {rest.map((title, i) => (
                            <motion.div
                                key={title.itemId}
                                initial={{ opacity: 0, scale: 0.95 }}
                                whileInView={{ opacity: 1, scale: 1 }}
                                viewport={{ once: true, margin: "-50px" }}
                                transition={{ delay: i * 0.05 }}
                                className="group cursor-pointer relative"
                                onClick={() => handleTitleClick(title)}
                                style={{ borderRadius: '24px', padding: '1px', background: i < 3 ? 'linear-gradient(135deg, rgba(99,102,241,0.5), rgba(244,114,182,0.3), rgba(139,92,246,0.5))' : 'rgba(255,255,255,0.08)' }}
                            >
                                {/* Hover glow */}
                                <div
                                    className="absolute inset-[-8px] rounded-[32px] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
                                    style={{ background: 'radial-gradient(circle at center, rgba(99,102,241,0.12) 0%, transparent 70%)', filter: 'blur(12px)' }}
                                />
                                <div
                                    className="flex items-center gap-4 relative z-10 overflow-hidden"
                                    style={{ borderRadius: '23px', padding: '16px', background: 'linear-gradient(135deg, #151520, #0a0a0f)' }}
                                >
                                    <div className="w-8 shrink-0 font-black text-2xl italic transition-colors text-center relative z-10" style={{ color: i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : i === 2 ? '#cd7f32' : 'rgba(255,255,255,0.15)' }}>
                                        {i + 2}
                                    </div>
                                    <div className="relative w-14 h-20 shrink-0 rounded-xl overflow-hidden shadow-lg border border-white/5 bg-black/50 z-10">
                                        <Poster
                                            src={title.poster}
                                            itemId={title.itemId}
                                            itemType={title.type}
                                            className="w-full h-full object-cover"
                                            alt=""
                                        />
                                    </div>
                                    <div className="flex-1 min-w-0 pr-4 relative z-10">
                                        <h4 className="text-white font-bold truncate tracking-tight text-lg">{title.name}</h4>
                                        <div className="flex flex-col items-start gap-1 mt-1">
                                            <span className="text-[11px] font-black text-white/70 uppercase tracking-[0.2em]">{Math.round(title.totalHours)} Hrs</span>
                                            <span className="text-[10px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-full bg-white/10 text-white/70 border border-white/10">
                                                {title.type === 'series' ? 'Series' : title.type === 'movie' ? 'Movie' : title.type}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    )
}
