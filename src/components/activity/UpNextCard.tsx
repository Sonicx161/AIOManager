import { motion } from 'framer-motion'
import { PlayCircle, X } from 'lucide-react'
import { Poster } from '@/components/common/Poster'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { PlatformSourceBadge } from '@/components/activity/PlatformSourceBadge'
import type { ActivityItem } from '@/types/activity'
import type { Account } from '@/types/account'

interface UpNextCardProps {
    item: ActivityItem
    account?: Account
    watcherName?: string
    peerLabel?: string | null
    index: number
    preferredPoster?: string
    onOpen: () => void
    onDismiss: () => void
}

export function UpNextCard({ item, account, watcherName, peerLabel, index, preferredPoster, onOpen, onDismiss }: UpNextCardProps) {
    const progress = Math.round(item.progress)
    const isEpisode = (item.type === 'series' || item.type === 'anime') && item.episode !== undefined
    const live = item.mediaObservation?.kind === 'live' ? (item.mediaObservation.isPaused ? 'Paused' : 'Playing') : null

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.25, ease: 'easeOut' }}
            className="group relative w-[16.5rem] shrink-0 cursor-pointer sm:w-60"
            onClick={onOpen}
        >
            <button
                type="button"
                data-theme-part="button"
                aria-label={`Remove ${item.name} from Continue Watching`}
                className="absolute -right-1.5 -top-1.5 z-20 flex h-5.5 w-5.5 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground opacity-0 shadow-sm transition-all hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                    e.stopPropagation()
                    onDismiss()
                }}
            >
                <X className="h-3 w-3" />
            </button>
            <div className="relative flex h-[7.5rem] gap-2.5 overflow-hidden rounded-2xl border border-border/40 bg-neutral-900 p-2.5 shadow-sm transition-[border-color,box-shadow] duration-200 group-hover:border-primary/50 group-hover:shadow-lg">
                <div aria-hidden className="pointer-events-none absolute -inset-5">
                    <Poster
                        src={item.poster}
                        itemId={item.itemId}
                        itemType={item.type}
                        tmdbId={item.tmdbId}
                        name={item.name}
                        displayWidth={64}
                        preferredSrc={preferredPoster}
                        alt=""
                        className="h-full w-full scale-110 object-cover blur-xl brightness-[.45] saturate-150"
                    />
                </div>
                <div className="relative aspect-[2/3] h-full shrink-0 overflow-hidden rounded-xl shadow-lg ring-1 ring-white/10">
                    <Poster
                        src={item.poster}
                        itemId={item.itemId}
                        itemType={item.type}
                        tmdbId={item.tmdbId}
                        name={item.name}
                        alt=""
                        displayWidth={68}
                        preferredSrc={preferredPoster}
                        className="h-full w-full object-cover"
                        loading="lazy"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
                        <PlayCircle className="h-7 w-7 text-white" />
                    </div>
                </div>
                <div className="relative flex min-w-0 flex-1 flex-col justify-between py-0.5 pr-5">
                    <div className="min-w-0">
                        <p className="line-clamp-2 text-[13px] font-bold leading-tight text-white" title={item.name}>{item.name}</p>
                        {(isEpisode || live) && (
                            <p className="mt-1 truncate text-xs text-white/75">
                                {isEpisode && <span className="font-mono">S{item.season ?? 1} E{item.episode}</span>}
                                {isEpisode && live && <span className="text-white/45"> · </span>}
                                {live && <span>{live}</span>}
                            </p>
                        )}
                    </div>
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-white/75">
                            {account && <AccountAvatar account={account} size="xs" showStatus={false} className="!h-6 !w-6 md:!h-7 md:!w-7 shrink-0 [&_span]:!text-[11px]" />}
                            {watcherName && <span className="min-w-0 truncate">{watcherName}</span>}
                            {peerLabel && <span className="shrink-0 truncate text-[10px] text-white/60" title={`Watched on ${peerLabel}`}>· {peerLabel}</span>}
                            <span className="ml-auto shrink-0 tabular-nums">{progress}%</span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/20">
                            <div className="h-full rounded-full bg-white/90" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
                        </div>
                    </div>
                </div>
                {item.source && (
                    <PlatformSourceBadge source={item.source} label={item.mediaObservation?.productName} mediaSources={item.mediaSources} className="left-auto right-2 top-2" />
                )}
            </div>
        </motion.div>
    )
}
