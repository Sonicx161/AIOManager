import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calendar, Clock, PlayCircle, ArrowRight } from 'lucide-react'
// GlassCard removed for performance
import { ReplayData, MonthStat } from '@/types/ReplayTypes'
import { openStremioDetail } from '@/lib/utils'
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from '@/components/ui/dialog'
import { Poster } from '@/components/common/Poster'

interface ReplayMonthsProps {
    data: ReplayData
}

export function ReplayMonths({ data }: ReplayMonthsProps) {
    const [selectedMonth, setSelectedMonth] = useState<MonthStat | null>(null)

    if (data.year === 'all-time') return null

    const handleTitleClick = (item: { type: string, itemId: string }) => {
        openStremioDetail(item.type, item.itemId)
    }

    return (
        <section className="min-h-[100vh] w-full flex flex-col justify-center py-24 relative overflow-hidden">
            <div className="container max-w-6xl px-6 mx-auto">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: "-100px" }}
                    className="mb-16"
                >
                    <h2 className="text-5xl md:text-7xl font-black text-white tracking-[-0.04em] leading-tight">Month by Month</h2>
                    <p className="text-white/70 font-bold mt-2 uppercase tracking-[0.2em] text-[12px]">The cadence of your year</p>
                </motion.div>
            </div>

            {/* Grid Container */}
            <div className="relative w-full z-10 px-6 max-w-7xl mx-auto">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {data.monthlyBreakdown.map((month, i) => (
                        <motion.div
                            key={month.monthKey}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.05 }}
                            className={`transition-all duration-300 cursor-pointer ${month.isHighActivity ? 'scale-[1.02] z-10 shadow-2xl shadow-primary/10' : 'opacity-80 hover:opacity-100 hover:scale-[1.01]'
                                }`}
                            onClick={() => setSelectedMonth(month)}
                        >
                            <div className={`p-8 rounded-[40px] h-full flex flex-col justify-between border-2 transition-colors hover:border-primary/30 bg-white/5 shadow-xl ${month.isHighActivity ? 'border-primary/50' : 'border-white/10'
                                }`}>
                                <div className="space-y-6">
                                    <div className="flex justify-between items-start">
                                        <div className="space-y-1">
                                            <span className="text-white/60 text-[11px] font-black uppercase tracking-widest">{month.monthKey}</span>
                                            <h3 className="text-3xl font-black text-white">{month.month}</h3>
                                        </div>
                                        {month.isHighActivity && (
                                            <div className="bg-primary/20 text-primary p-2 rounded-2xl">
                                                <Calendar className="w-5 h-5" />
                                            </div>
                                        )}
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1">
                                            <div className="text-white/70 text-[11px] font-black uppercase tracking-widest">Titles</div>
                                            <div className="text-2xl font-black text-white">{month.totalTitles}</div>
                                        </div>
                                        <div className="space-y-1">
                                            <div className="text-white/70 text-[11px] font-black uppercase tracking-widest">Hours</div>
                                            <div className="text-2xl font-black text-white">{Math.round(month.totalHours)}</div>
                                        </div>
                                    </div>
                                </div>

                                <div
                                    className="mt-12 pt-6 border-t border-white/10 flex items-center justify-between group"
                                >
                                    <span className="text-[12px] font-black uppercase text-white/70 group-hover:text-primary transition-colors">Details</span>
                                    <ArrowRight className="w-4 h-4 text-white/20 group-hover:text-primary transition-all translate-x-0 group-hover:translate-x-1" />
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>

            <Dialog open={!!selectedMonth} onOpenChange={(open) => !open && setSelectedMonth(null)}>
                <DialogContent
                    className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[95vw] md:w-[600px] max-w-[95vw] bg-[#0d0d15]/80 backdrop-blur-3xl border border-white/10 text-white p-0 rounded-[40px] max-h-[85vh] overflow-y-auto no-scrollbar z-[200] shadow-2xl"
                >
                    {/* Hero Header */}
                    <div className="relative w-full p-6 md:p-8 pt-12 md:pt-16">
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-[300px] bg-gradient-to-b from-primary/10 via-primary/5 to-transparent pointer-events-none" />
                        <div className="relative z-10 flex items-center gap-4 w-full">
                            <div className="bg-primary/10 backdrop-blur-md text-primary p-3 md:p-4 rounded-2xl border border-primary/20 shadow-xl flex-shrink-0">
                                <Calendar className="w-6 h-6 md:w-8 md:h-8" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-white/50 font-black uppercase tracking-widest text-[11px] mb-1 truncate">Monthly Summary</p>
                                <DialogTitle className="text-3xl md:text-5xl font-black truncate leading-tight text-white">
                                    {selectedMonth?.month} {selectedMonth?.monthKey?.split('-')[0]}
                                </DialogTitle>
                            </div>
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className="p-6 md:p-8 pt-0 space-y-6 md:space-y-8">
                        {/* Stats Row */}
                        <div className="flex gap-4">
                            <div className="flex-1 bg-white/5 backdrop-blur-md p-5 rounded-[24px] border border-white/5 relative overflow-hidden group">
                                <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                <div className="text-[12px] font-black text-white/70 uppercase tracking-widest mb-1 relative z-10">Titles</div>
                                <div className="text-3xl md:text-4xl font-black relative z-10">{selectedMonth?.totalTitles}</div>
                            </div>
                            <div className="flex-1 bg-white/5 backdrop-blur-md p-5 rounded-[24px] border border-white/5 relative overflow-hidden group">
                                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                <div className="text-[12px] font-black text-white/70 uppercase tracking-widest mb-1 relative z-10">Hours</div>
                                <div className="text-3xl md:text-4xl font-black relative z-10">{Math.round(selectedMonth?.totalHours || 0)}</div>
                            </div>
                        </div>

                        {/* Top Titles Grid */}
                        <div>
                            <div className="flex items-center gap-2 mb-4 px-2">
                                <PlayCircle className="w-4 h-4 text-primary" />
                                <h4 className="text-[12px] font-black text-white/90 uppercase tracking-widest">Top Highlights</h4>
                            </div>
                            <div className="grid grid-cols-3 gap-3 md:gap-4">
                                {selectedMonth?.top3Titles?.map((title, i) => (
                                    <div
                                        key={title.itemId}
                                        onClick={() => handleTitleClick(title)}
                                        className="relative group cursor-pointer aspect-[2/3] rounded-[20px] overflow-hidden border border-white/10 shadow-lg"
                                    >
                                        <Poster
                                            src={title.poster}
                                            itemId={title.itemId}
                                            itemType={title.type}
                                            className="w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-110"
                                            alt=""
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-[#0d0d15]/90 via-[#0d0d15]/20 to-transparent opacity-90 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300" />

                                        <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-md text-white px-2 py-0.5 rounded-lg text-[12px] font-black italic shadow-md border border-white/10">
                                            #{i + 1}
                                        </div>

                                        <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-2 md:translate-y-4 md:opacity-0 group-hover:translate-y-0 opacity-100 md:group-hover:opacity-100 transition-all duration-300">
                                            <div className="text-[10px] md:text-xs font-bold leading-tight line-clamp-2 text-shadow-sm">
                                                {title.name}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {(!selectedMonth?.top3Titles || selectedMonth.top3Titles.length === 0) && (
                                    <div className="col-span-3 flex flex-col items-center justify-center py-12 text-white/20 font-black italic border border-dashed border-white/5 rounded-2xl bg-white/5">
                                        <Clock className="w-8 h-8 mb-2 opacity-20" />
                                        <div className="text-xs uppercase tracking-widest">No history found</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </section >
    )
}
