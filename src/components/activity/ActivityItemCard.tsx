
import { useTheme } from '@/contexts/ThemeContext'
import { ActivityItem } from '@/types/activity'
import { formatDistanceToNow } from 'date-fns'
import { PlayCircle, Trash2, Check } from 'lucide-react'
import { memo, useMemo, useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip } from '@/components/ui/tooltip'

import { cn, openStremioDetail, maskNameLevel, maskEmailLevel } from '@/lib/utils'
import { resolveWatchBadgePct, formatSavedEpisodeRanges, MIN_PLAUSIBLE_WATCH_MS } from '@/lib/activity-utils'
import { continueWatchingPosterFor } from '@/lib/activity-cw-poster'
import { formatEpisodeRange } from '@/lib/episode-resolution'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { Poster } from '@/components/common/Poster'
import { PlatformSourceBadge } from '@/components/activity/PlatformSourceBadge'
import { SwipeActionRow } from '@/components/activity/SwipeActionRow'
import { isReadOnlyMediaActivity, isTimeApproximate, type ActivityNowStatus } from '@/lib/jellyfin/activity'
import { formatRelative } from '@/hooks/use-relative-time'

const AVATAR_COLORS = [
  'bg-blue-500/20 text-blue-400',
  'bg-purple-500/20 text-purple-400',
  'bg-green-500/20 text-green-400',
  'bg-yellow-500/20 text-yellow-400',
  'bg-rose-500/20 text-rose-400',
  'bg-cyan-500/20 text-cyan-400',
  'bg-orange-500/20 text-orange-400',
  'bg-pink-500/20 text-pink-400',
] as const

interface ActivityItemCardProps {
    entry: ActivityItem
    nowStatus?: ActivityNowStatus
    viewMode: 'grid' | 'list'
    isSelected: boolean
    isBulkMode: boolean
    cwPosterIndex?: ReadonlyMap<string, string>
    onToggleSelect?: (id: string | string[]) => void
    onDelete?: (id: string | string[], removeFromLibrary: boolean) => void
    onOpenDetail?: (item: ActivityItem) => void
}

export const ActivityItemCard = memo(({
    entry,
    nowStatus,
    viewMode,
    isSelected,
    isBulkMode,
    cwPosterIndex,
    onToggleSelect,
    onDelete,
    onOpenDetail
}: ActivityItemCardProps) => {
    const { isLight } = useTheme()
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const privacyLevelEmail = useUIStore(s => s.privacyLevelEmail)
    const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0

    const item = entry
    const preferredPoster = continueWatchingPosterFor(cwPosterIndex, item.itemId)
    const isEpisodeLike = item.type === 'series' || item.type === 'anime' || item.type === 'episode'
    // Imported saved watch state: bitfield-aggregate series carry a verified episode summary
    // (no watch dates, no resume); flagged-only movies keep their positive watched badge.
    const savedState = item.importedSavedState === true
    const hasEpisode = Number.isInteger(item.episode) && (item.episode ?? 0) > 0
    const episodeLabel = isEpisodeLike
        ? hasEpisode
            ? `S${item.season ?? 1} E${item.episode}`
            : item.episodeRange
                ? formatEpisodeRange(item.episodeRange)
                : savedState ? null : 'Episode unknown'
        : null
    const episodeUnknown = isEpisodeLike && !hasEpisode && !item.episodeRange && !savedState
    const episodeTitle = episodeUnknown ? 'The source recorded this show but not which episode was played' : episodeLabel ?? undefined
    // Legacy series aggregates can contain a zero episode and no measured playback.
    // Keep the history visible without claiming a 0% or completed episode.
    const badgePct = isEpisodeLike && !hasEpisode && !(item.duration > 0) && !(item.progress > 0)
        ? undefined : resolveWatchBadgePct(item)
    const savedRanges = savedState && isEpisodeLike ? formatSavedEpisodeRanges(item.savedEpisodes) : []
    const savedCount = savedState ? item.savedEpisodes?.episodeCount : undefined

    const rawName = item.accountName || 'Unknown User'
    const userName = rawName.includes('@')
        ? (maskEmailLevel(rawName, privacyLevel) || rawName)
        : maskNameLevel(rawName, privacyLevel)

    const account = useAccountStore(s => s.accounts.find(a => a.id === item.accountId))
    const originId = item.sourceConnectionId || item.mediaObservation?.connectionId
    const origin = account?.connections?.find(connection => connection.id === originId)
    const peers = (account?.connections || []).filter(connection => connection.platform === (item.source || 'stremio') && connection.connectionType !== 'hydra-outbound')
    const connectionName = (connection?: typeof origin) => connection?.displayName || connection?.mediaServer?.userName || connection?.credentials?.email
    const originName = connectionName(origin)
    const maskedOrigin = originName?.includes('@')
        ? maskEmailLevel(originName, isPrivacyModeEnabled ? privacyLevelEmail : 0)
        : originName ? maskNameLevel(originName, privacyLevel) : ''
    const originNameIsUnique = !!originName && peers.filter(peer => connectionName(peer) === originName).length === 1
    let connectionLabel = ''
    if (origin && peers.length > 1) connectionLabel = maskedOrigin && originNameIsUnique
        ? maskedOrigin
        : `${maskedOrigin ? `${maskedOrigin} · ` : ''}Connection ${peers.findIndex(peer => peer.id === origin.id) + 1}`
    else if (originId && !origin) connectionLabel = 'Unlinked connection'
    else if (peers.length > 1) connectionLabel = 'Legacy history · connection unknown'
    const [avatarFailed, setAvatarFailed] = useState(false)
    useEffect(() => { setAvatarFailed(false) }, [account?.avatar])
    const showAvatar = !!account?.avatar && !avatarFailed

    const itemDate = useMemo(() => {
        const d = new Date(item.timestamp)
        // Placeholder watch dates (Stremio rows with missing/zero lastWatched) render as unknown
        // instead of "December 31, 2000" / "over 2025 years ago".
        return isNaN(d.getTime()) || d.getTime() < MIN_PLAUSIBLE_WATCH_MS ? null : d
    }, [item.timestamp])

    // Saved watch state has no watch date to claim: the slot labels the state itself,
    // never a fabricated watch or import date.
    const dateLabel = savedState
        ? 'Saved watch history'
        : (itemDate ? formatDistanceToNow(itemDate, { addSuffix: true }) : 'Unknown date')
    const approximate = !savedState && !!itemDate && isTimeApproximate(item)
    const shortDateLabel = itemDate ? formatRelative(itemDate) ?? dateLabel : dateLabel

    const readOnly = isReadOnlyMediaActivity(item)
    const isLive = !!nowStatus
    const nowDescription = nowStatus === 'playing' ? 'Playing now' : 'Latest unfinished activity updated within the last 5 minutes'

    const remainingMinutes = useMemo(() => item.duration && item.watched
        ? Math.max(0, Math.round((item.duration - item.watched) / 60000))
        : 0, [item.duration, item.watched])

    const getAvatarColor = (index: number) => {
        return AVATAR_COLORS[index % AVATAR_COLORS.length]
    }

    const handleClick = () => {
        if ((isBulkMode || isSelected) && !readOnly) {
            onToggleSelect?.(item.id)
            return
        }
        if (onOpenDetail) {
            onOpenDetail(item)
        } else {
            openStremioDetail(item.type, item.itemId)
        }
    }

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (!readOnly) onDelete?.(item.id, true)
    }


    if (viewMode === 'grid') {
        return (
            <div
                className="group flex min-w-0 flex-col gap-1.5 cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                role="button"
                tabIndex={0}
                onClick={handleClick}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } }}
            >

                <div className={cn(
                    "relative aspect-[2/3] rounded-2xl overflow-hidden border transition-[transform,opacity,box-shadow] duration-200 shadow-sm group-hover:shadow-lg",
                    isSelected ? `border-primary ring-2 ${isLight ? 'ring-primary/20' : 'ring-primary/10'} scale-[0.98]` : 'border-transparent group-hover:border-primary/40'
                )}>

                    {isSelected && (
                        <div className="absolute top-2 left-2 z-30 w-6 h-6 rounded-full border-2 border-background shadow-lg flex items-center justify-center animate-in zoom-in-50 duration-200" style={{ background: 'hsl(var(--primary))' }}>
                            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                    )}

                    <Poster
                        src={item.poster}
                        itemId={item.itemId}
                        itemType={item.type}
                        tmdbId={item.tmdbId}
                        name={item.name}
                        preferredSrc={preferredPoster}
                        alt={item.name}
                        sizes="(min-width: 1536px) 296px, (min-width: 1280px) 244px, (min-width: 1024px) 242px, (min-width: 768px) 238px, (min-width: 640px) 232px, (min-width: 480px) 288px, 204px"
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                        loading="lazy"
                    />

                    {item.source && <PlatformSourceBadge source={item.source} label={item.mediaObservation?.productName} mediaSources={item.mediaSources} />}


                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />


                    {!isBulkMode && !isSelected && (
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                            <div className="rounded-full border border-white/25 bg-black/75 p-3 shadow-xl">
                                <PlayCircle className={`w-7 h-7 text-white ${isLight ? 'drop-shadow-lg' : 'drop-shadow-sm'}`} />
                            </div>
                        </div>
                    )}


                    {item.progress > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                            <div className="h-full bg-primary transition-[transform,opacity,box-shadow] duration-500" style={{ width: `${item.progress}%` }} />
                        </div>
                    )}


                    {isLive && (
                        <div className="absolute top-2 right-2 z-20">
                            <Tooltip content={nowDescription} side="top">
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/65 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-white shadow-xl">
                                    <span className="h-1.5 w-1.5 rounded-full bg-success" /> Now
                                </span>
                            </Tooltip>
                        </div>
                    )}


                    {(episodeLabel || (savedState && isEpisodeLike) || (badgePct !== undefined && !isLive)) && (
                        <div className="absolute bottom-2 left-2 right-2 z-10 flex items-center gap-1.5">
                            {episodeLabel && (
                                <span
                                    title={episodeTitle}
                                    className={cn(
                                        "min-w-0 truncate text-xs px-1.5 py-0.5 rounded-full bg-black/75",
                                        episodeUnknown ? 'font-medium text-white/70' : cn('font-bold', getAvatarColor(item.accountColorIndex).split(' ')[1])
                                    )}
                                >
                                    {episodeLabel}
                                </span>
                            )}

                            {savedState && isEpisodeLike && !episodeLabel && (
                                <span className="min-w-0 truncate text-xs font-bold px-1.5 py-0.5 rounded-full bg-black/75 text-white/95">
                                    {savedCount ? `${savedCount} episodes saved` : 'Saved episodes'}
                                </span>
                            )}

                            {badgePct !== undefined && !isLive && (
                                badgePct >= 100 ? (
                                    <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background/85 text-success shadow-sm backdrop-blur-sm">
                                        <Check className="h-3.5 w-3.5 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)]" strokeWidth={3} />
                                    </span>
                                ) : (
                                    <span className="ml-auto shrink-0 text-xs font-bold text-foreground bg-background/85 rounded-full px-1.5 py-0.5 ring-1 ring-black/20 shadow-sm backdrop-blur-sm">
                                        {badgePct}%
                                    </span>
                                )
                            )}
                        </div>
                    )}
                </div>


                <div className="px-0.5 space-y-0.5">
                    <p className="font-bold text-xs text-foreground leading-snug line-clamp-1 truncate">{item.name}</p>
                    <div className="flex min-w-0 items-center gap-1.5">
                        <div
                            data-theme-part="account-avatar"
                            className="relative w-6 h-6 md:w-7 md:h-7 shrink-0 flex items-center justify-center overflow-hidden rounded-md"
                        >
                            {/* Same muted backdrop the global SquircleOverlay paints, kept local so skins
                                can suppress the fixed squircle clip with --theme-avatar-filter and apply
                                the theme radius instead (mirrors accounts/AccountAvatar). */}
                            <div
                                data-theme-part="account-avatar-surface"
                                className="absolute inset-0 rounded-[inherit] bg-muted"
                                style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                            />
                            {showAvatar ? (
                                <img
                                    src={account.avatar}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    onError={() => setAvatarFailed(true)}
                                    data-theme-part="account-avatar-image"
                                    className="absolute inset-0 h-full w-full rounded-[inherit] object-cover z-10"
                                    style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                                />
                            ) : (
                                <span className="relative z-10 text-xs font-bold text-muted-foreground">
                                    {account?.emoji ? account.emoji : userName[0]?.toUpperCase()}
                                </span>
                            )}
                        </div>
                        <span className="min-w-0 truncate text-xs leading-snug text-muted-foreground font-medium" title={connectionLabel ? `${userName} · ${connectionLabel}` : undefined}>
                            {userName}
                        </span>
                        {!isLive && (
                            <span
                                className="ml-auto shrink-0 whitespace-nowrap font-mono text-xs leading-snug text-muted-foreground/60"
                                title={approximate ? 'Time approximate: these episodes were marked watched together' : itemDate && !savedState ? itemDate.toLocaleString() : undefined}
                            >
                                {savedState ? 'Saved' : `${approximate ? '~' : ''}${shortDateLabel}`}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <SwipeActionRow
            id={item.id}
            disabled={readOnly || isBulkMode}
            onDelete={onDelete ? () => onDelete(item.id, true) : undefined}
        >
        <div
            role="button"
            tabIndex={0}
            data-theme-part="card"
            className={cn(
                'group flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-2xl border bg-card/70 p-3 shadow-sm transition-[transform,opacity,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background md:gap-4 md:p-4',
                isSelected
                    ? `border-primary ring-2 ${isLight ? 'ring-primary/20' : 'ring-primary/10'} bg-primary/5`
                    : 'border-border/40 hover:border-border hover:bg-muted/25 hover:shadow-md'
            )}
            onClick={handleClick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick() } }}
        >

            {isSelected && (
                <div className="shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-[transform,opacity,box-shadow] bg-primary border-primary">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                </div>
            )}


            <div className="relative h-24 w-16 shrink-0 overflow-hidden rounded-2xl bg-muted shadow-sm md:h-28 md:w-20">
                <Poster
                    src={item.poster}
                    itemId={item.itemId}
                    itemType={item.type}
                    tmdbId={item.tmdbId}
                    name={item.name}
                    preferredSrc={preferredPoster}
                    sizes="(min-width: 768px) 80px, 64px"
                    className="w-full h-full object-cover"
                    loading="lazy"
                />
                {item.source && <PlatformSourceBadge source={item.source} label={item.mediaObservation?.productName} mediaSources={item.mediaSources} />}
                {isLive && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                        <div className={`w-2 h-2 rounded-full bg-success animate-pulse ${isLight ? 'shadow-lg shadow-success/50' : 'shadow-sm shadow-success/20'}`} />
                    </div>
                )}
                {item.progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                        <div className="h-full bg-primary transition-[transform,opacity,box-shadow] duration-500" style={{ width: `${item.progress}%` }} />
                    </div>
                )}
            </div>


            <div className="min-w-0 flex-1 space-y-1.5">

                <div className="flex items-start justify-between gap-2">
                    <h4 className="min-w-0 line-clamp-2 break-words text-base font-bold leading-tight tracking-tight md:line-clamp-1 md:text-lg" title={item.name}>{item.name}</h4>
                    {isLive && (
                        <Tooltip content={nowDescription} side="top">
                            <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-xs font-semibold uppercase text-success">
                                <span className="h-1.5 w-1.5 rounded-full bg-success" /> Now
                            </span>
                        </Tooltip>
                    )}
                </div>


                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">

                    <span data-theme-part="badge" className="inline-flex items-center rounded-full border border-border/40 bg-muted/45 px-2 py-0.5 text-xs font-semibold uppercase text-muted-foreground">
                        {item.type}
                    </span>

                    {episodeLabel && (
                        <span title={episodeTitle} className={cn('text-xs font-mono text-muted-foreground', episodeUnknown ? 'font-medium opacity-70' : 'font-bold')}>
                            {episodeLabel}
                        </span>
                    )}

                </div>


                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                        <div
                            data-theme-part="account-avatar"
                            className="relative w-6 h-6 md:w-7 md:h-7 shrink-0 flex items-center justify-center overflow-hidden rounded-md"
                        >
                            {/* Same muted backdrop the global SquircleOverlay paints, kept local so skins
                                can suppress the fixed squircle clip with --theme-avatar-filter and apply
                                the theme radius instead (mirrors accounts/AccountAvatar). */}
                            <div
                                data-theme-part="account-avatar-surface"
                                className="absolute inset-0 rounded-[inherit] bg-muted"
                                style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                            />
                            {showAvatar ? (
                                <img
                                    src={account.avatar}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    onError={() => setAvatarFailed(true)}
                                    data-theme-part="account-avatar-image"
                                    className="absolute inset-0 h-full w-full rounded-[inherit] object-cover z-10"
                                    style={{ filter: 'var(--theme-avatar-filter, url(#squircle))' }}
                                />
                            ) : (
                                <span className="relative z-10 text-xs font-bold text-muted-foreground">
                                    {account?.emoji ? account.emoji : userName[0]?.toUpperCase()}
                                </span>
                            )}
                        </div>
                        <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground" title={connectionLabel ? `${userName} · ${connectionLabel}` : undefined}>{userName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground/60 font-mono">
                        {nowStatus === 'playing' ? 'Watching now' : nowStatus === 'recent' ? 'Recently updated' : dateLabel}
                    </span>
                </div>


                {badgePct !== undefined && (
                    <div className="flex items-center gap-2 max-w-xs">
                        <Progress value={badgePct} className="h-1 flex-1" />
                        {badgePct >= 100 ? (
                            <span className="flex items-center gap-1 text-xs font-bold text-success">
                                <Check className="h-3.5 w-3.5" strokeWidth={3} />
                                Completed
                            </span>
                        ) : (
                            <span className="text-xs font-bold text-muted-foreground/60 tabular-nums">
                                {badgePct}%{item.progress > 0 && remainingMinutes > 0 && ` · ${remainingMinutes}m`}
                            </span>
                        )}
                    </div>
                )}

                {savedState && isEpisodeLike && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span className="font-semibold text-foreground/80">
                            {savedCount ? `${savedCount} episodes saved` : 'Saved episode history'}
                        </span>
                        {savedRanges.length > 0 && (
                            <span className="font-mono font-bold text-muted-foreground/70">
                                {savedRanges.join(' · ')}
                            </span>
                        )}
                        <span className="text-muted-foreground/60">watch dates unavailable</span>
                    </div>
                )}

            </div>

            {!readOnly && <Button
                variant="ghost"
                size="icon"
                className="inline-flex h-8 w-8 shrink-0 text-muted-foreground transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                onClick={handleDelete}
                aria-label="Delete activity item"
            >
                <Trash2 className="h-4 w-4" />
            </Button>}
        </div>
        </SwipeActionRow>
    )
})

ActivityItemCard.displayName = 'ActivityItemCard'
