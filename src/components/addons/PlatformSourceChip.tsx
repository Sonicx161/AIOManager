import { useMemo } from 'react'
import { getPlatformEntry } from '@/lib/platform-registry'
import { Tooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'
import { useRelativeTime } from '@/hooks/use-relative-time'
import {
    accountForAddonTargets,
    aggregateAccountPlatforms,
    aggregatePlatformSources,
    platformShortName,
    ZERO_PLATFORM_REACH_HOVER_TEXT,
    type PlatformMediaTarget,
    type PlatformSourceAccount,
    type PlatformSyncTarget,
} from './platform-source'
import type { AddonDescriptor } from '@/types/addon'

export function platformName(id: string): string {
    return getPlatformEntry(id)?.name || id
}

// Chip/row display name: the registry's real name for addon platforms, plain "Jellyfin"
// for the media platform (its registry entry is a long setup-compatibility label).
function chipPlatformName(id: string): string {
    return id === 'jellyfin' ? platformShortName(id) : platformName(id)
}

function TinyPlatformLogo({ platform }: { platform: string }) {
    const entry = getPlatformEntry(platform)
    if (entry) {
        return <img data-theme-part="image-tile" src={entry.logo} alt="" loading="lazy" className="h-3.5 w-3.5 shrink-0 rounded-full object-contain" />
    }
    return (
        <span data-theme-part="image-tile" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-bold text-muted-foreground">
            {platform[0]?.toUpperCase() || '?'}
        </span>
    )
}

// Honest per-target state line. Never claims the addon is verified there: connectivity and
// last sync state only describe where the collection is mirrored when sync succeeds.
function targetStateLine(target: PlatformSyncTarget, formatRelative: (input: number | Date | null | undefined) => string | null): string {
    const rel = target.lastSync ? formatRelative(target.lastSync) : null
    switch (target.status) {
        case 'active':
            if (target.implicit) return rel ? `Session synced ${rel}` : 'Session not synced yet'
            return rel ? `Synced ${rel}` : 'Not synced yet. Installation is unverified.'
        case 'pending':
            return rel ? `Last synced ${rel}. Waiting to sync again.` : 'Waiting for first sync'
        case 'degraded':
            return rel ? `Degraded. Last synced ${rel}.` : 'Degraded. Not synced yet.'
        case 'error':
            return `Last sync failed${target.lastError ? `: ${target.lastError}` : ''}`
        case 'expired':
            return 'Session expired. Reconnect to resume syncing.'
    }
}

function targetStateClass(target: PlatformSyncTarget): string {
    switch (target.status) {
        case 'active':
            return target.lastSync ? 'text-muted-foreground' : 'text-muted-foreground/80'
        case 'pending':
            return 'text-muted-foreground/80'
        case 'degraded':
            return 'text-warning'
        case 'error':
        case 'expired':
            return 'text-destructive'
    }
}

// Honest per-connection state line for a media row: the verified remote user and the
// last verification time. Only display-safe fields reach here — never credentials,
// user IDs, or addresses. Paused media stays honest too: paused is not disconnected.
function mediaStateLine(target: PlatformMediaTarget, formatRelative: (input: number | Date | null | undefined) => string | null): string {
    const rel = target.lastVerified ? formatRelative(target.lastVerified) : null
    switch (target.status) {
        case 'active':
            if (target.userName) return rel ? `Signed in as ${target.userName} · verified ${rel}` : `Signed in as ${target.userName} · not verified yet`
            return rel ? `Verified ${rel}` : 'Connected. Not verified yet.'
        case 'pending':
            return rel ? `Verifying · last checked ${rel}` : 'Waiting for first verification'
        case 'paused':
            return target.userName ? `Paused · still connected as ${target.userName}` : 'Paused · still connected'
        case 'degraded':
            return rel ? `Degraded · last verified ${rel}` : 'Degraded. Not verified yet.'
        case 'error':
            return `Last check failed${target.lastError ? `: ${target.lastError}` : ''}`
        case 'expired':
            return 'Session expired. Reconnect to restore access.'
    }
}

function mediaStateClass(target: PlatformMediaTarget): string {
    switch (target.status) {
        case 'active':
            return target.lastVerified ? 'text-muted-foreground' : 'text-muted-foreground/80'
        case 'pending':
        case 'paused':
            return 'text-muted-foreground/80'
        case 'degraded':
            return 'text-warning'
        case 'error':
        case 'expired':
            return 'text-destructive'
    }
}

interface PlatformSourceChipProps {
    // Single owning account (surfaces inside one account's addon list).
    account?: PlatformSourceAccount | null
    // Several accounts. e.g. every account whose recorded list contains one saved addon.
    // Their targets are aggregated per platform (freshest sync, worst status).
    accounts?: Array<PlatformSourceAccount | null | undefined>
    // Copy context for the details popover: 'account' explains one account's connections
    // (addon sync targets AND media platforms — Jellyfin counts as one platform there),
    // 'addon' explains a saved addon's recorded homes (addon platforms only, never media).
    // Defaults to 'account'.
    scope?: 'account' | 'addon'
    addon?: Pick<AddonDescriptor, 'transportUrl' | 'destinations'>
    // Account platform count; when larger than the addon's reach the label reads "2 of 3 platforms".
    ofTotal?: number
    failing?: boolean
    className?: string
}

// Shows which platform(s) an addon collection lives on, derived from the owning account's
// connections (or, for a saved addon, from the accounts whose recorded lists contain it).
// Account scope counts every connected platform once — including Jellyfin-compatible
// media servers — in one chip; addon scope stays addon-only. One platform renders a named
// chip (a single unambiguous media connection may name its actual product, e.g.
// AIOMetadata); several render stacked logos with the full list on hover. Paused
// platforms still show for either kind: pausing never removes anything. Focus/tap opens
// an accessible "Sync targets" popover grouped into "Addon sync" and "Playback & library"
// (account scope), with honest last synced / last verified / paused / error states.
export function PlatformSourceChip({ account, accounts, scope = 'account', addon, ofTotal, failing = false, className }: PlatformSourceChipProps) {
    const list = useMemo(
        () => (accounts ?? (account ? [account] : []))
            .filter((a): a is PlatformSourceAccount => !!a)
            .map(a => scope === 'addon' && addon ? accountForAddonTargets(a, addon) : a),
        [account, accounts, scope, addon]
    )
    // Account scope layers media platforms on top of the untouched addon-only summary;
    // addon scope must stay addon-only, so it keeps aggregatePlatformSources verbatim.
    const { platforms, targets, paused, media } = useMemo(
        () =>
            scope === 'account'
                ? aggregateAccountPlatforms(list)
                : { ...aggregatePlatformSources(list), media: [] as PlatformMediaTarget[] },
        [list, scope]
    )
    const formatRelative = useRelativeTime()

    // Zero reach: the account has platforms but this addon is excluded from all of them,
    // so keep a muted "0 of N" pill instead of vanishing. No ofTotal (account scope,
    // saved-addon aggregation) keeps returning null.
    const zeroReach = platforms.length === 0 && !!ofTotal && ofTotal > 0
    if (platforms.length === 0 && !zeroReach) return null

    const isAccountScope = scope === 'account'
    const names = platforms.map(chipPlatformName)
    const hoverText = zeroReach
        ? ZERO_PLATFORM_REACH_HOVER_TEXT
        : `${isAccountScope ? 'Connected to' : 'Syncs to'} ${names.join(', ')}${failing ? '. A sync target is failing' : ''}`

    // A single media-only platform may name its actual product when exactly one
    // connection makes it unambiguous; otherwise keep the plain platform name.
    const singleMediaLabel =
        isAccountScope &&
        platforms.length === 1 &&
        platforms[0] === 'jellyfin' &&
        media.length === 1 &&
        (media[0].connectionCount ?? 1) === 1
            ? media[0].product
            : null
    const singleLabel = platforms.length === 1 ? singleMediaLabel ?? names[0] : null
    const partial = !!ofTotal && ofTotal > platforms.length
    const countLabel = partial ? `${platforms.length} of ${ofTotal} platforms` : `${platforms.length} platforms`

    const hasAddonPlatforms = targets.length > 0 || paused.length > 0
    const intro = zeroReach
        ? 'This addon is excluded from every platform on this account. Nothing receives it under its saved destination rules.'
        : scope === 'addon'
            ? 'These platforms receive this addon under its saved destination rules. Changes apply on sync. Installation on each platform has not been verified.'
            : hasAddonPlatforms
              ? "Addon platforms receive this account's addon collection. Jellyfin-compatible platforms provide playback and library for the signed-in remote user; they do not receive addons."
              : 'This Jellyfin-compatible platform provides playback and library for the signed-in remote user. It does not receive addons.'

    const renderTarget = (target: PlatformSyncTarget) => (
        <li key={target.platform} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
                <TinyPlatformLogo platform={target.platform} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-foreground">{chipPlatformName(target.platform)}</span>
                <span className={cn('block text-[11px] leading-snug', targetStateClass(target))}>
                    {targetStateLine(target, formatRelative)}
                    {target.accountCount && target.accountCount > 1 ? ` · ${target.accountCount} accounts` : ''}
                </span>
            </span>
        </li>
    )

    const renderMediaTarget = (target: PlatformMediaTarget, key: string) => (
        <li key={key} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
                <TinyPlatformLogo platform={target.platform} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                    {target.product}
                    {target.serverName ? <span className="font-normal text-muted-foreground"> · {target.serverName}</span> : null}
                </span>
                <span className={cn('block text-[11px] leading-snug', mediaStateClass(target))}>
                    {mediaStateLine(target, formatRelative)}
                    {target.connectionCount && target.connectionCount > 1 ? ` · ${target.connectionCount} connections` : ''}
                </span>
            </span>
        </li>
    )

    return (
        <Popover>
            <Tooltip content={hoverText}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        data-theme-part="badge"
                        aria-label={`${hoverText}. Sync target details`}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={cn(
                            "relative inline-flex h-5 min-w-0 cursor-pointer items-center gap-1 rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 max-sm:after:absolute max-sm:after:-inset-x-1 max-sm:after:-inset-y-3 max-sm:after:content-['']",
                            failing ? 'border-destructive/35 bg-destructive/10 hover:bg-destructive/15' : 'border-border/40 bg-muted/30 hover:bg-muted/60',
                            platforms.length === 1 && !partial ? 'pl-1 pr-1.5' : 'px-1.5',
                            className
                        )}
                    >
                        {platforms.length === 1 && !partial ? (
                            <>
                                <TinyPlatformLogo platform={platforms[0]} />
                                <span className={cn('min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide', failing ? 'text-destructive' : 'text-muted-foreground')}>{singleLabel}</span>
                            </>
                        ) : (
                            <>
                                <span className="flex -space-x-1 shrink-0">
                                    {platforms.slice(0, 3).map(id => (
                                        <span key={id} className="rounded-full ring-1 ring-card">
                                            <TinyPlatformLogo platform={id} />
                                        </span>
                                    ))}
                                </span>
                                <span className={cn('min-w-0 truncate text-[10px] font-semibold', failing ? 'text-destructive' : 'text-muted-foreground')}>{countLabel}</span>
                            </>
                        )}
                        {failing && <AlertTriangle className="h-2.5 w-2.5 shrink-0 text-destructive" aria-hidden="true" />}
                    </button>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent side="top" className="w-72 max-w-[calc(100vw-1.5rem)] p-3 text-left">
                <p className="text-xs font-semibold text-foreground">Sync targets</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{intro}</p>
                {isAccountScope && media.length > 0 ? (
                    <>
                        {hasAddonPlatforms && (
                            <section className="mt-2">
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Addon sync</p>
                                {targets.length === 0 ? (
                                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                                        No active sync targets. Every connection is paused.
                                    </p>
                                ) : (
                                    <ul className="mt-1.5 space-y-1.5">{targets.map(renderTarget)}</ul>
                                )}
                                {paused.length > 0 && (
                                    <p className="mt-2 border-t border-border/40 pt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
                                        Sync paused for {paused.map(chipPlatformName).join(', ')}. Existing installations there are unchanged.
                                    </p>
                                )}
                            </section>
                        )}
                        <section className={cn(hasAddonPlatforms && 'mt-2 border-t border-border/40 pt-2')}>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Playback &amp; library</p>
                            <ul className="mt-1.5 space-y-1.5">
                                {media.map((target, i) => renderMediaTarget(target, `${target.platform}-${i}`))}
                            </ul>
                        </section>
                    </>
                ) : (
                    <>
                        {targets.length === 0 ? (
                            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                                {zeroReach ? 'No sync targets: this addon is not sent to any platform.' : 'No active sync targets. Every connection is paused.'}
                            </p>
                        ) : (
                            <ul className="mt-2 space-y-1.5">{targets.map(renderTarget)}</ul>
                        )}
                        {paused.length > 0 && (
                            <p className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed text-muted-foreground/80">
                                Sync paused for {paused.map(chipPlatformName).join(', ')}. Existing installations there are unchanged.
                            </p>
                        )}
                    </>
                )}
            </PopoverContent>
        </Popover>
    )
}
