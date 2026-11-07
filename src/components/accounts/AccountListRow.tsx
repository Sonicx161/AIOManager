import { memo, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { prefetchAccountDetail } from '@/lib/account-prefetch'
import { Account } from '@/types/account'
import { Tooltip } from '@/components/ui/tooltip'
import { AccountAvatar, AccountMenuHeader } from './AccountAvatar'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import { AccountMediaPlayback } from './AccountMedia'
import { useJellyfinActivity } from '@/hooks/useJellyfinActivity'
import { accountMediaPlayback, mergeMediaItems } from '@/lib/jellyfin/activity'
import { PlatformSourceChip } from '@/components/addons/PlatformSourceChip'
import { accountPlatformSources } from '@/components/addons/platform-source'
import { AccountStatChips } from './AccountStatChips'
import { addonCountLabel, addonCountTooltip, isSyncStale } from './account-stat-chips'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, maskEmailLevel, maskNameLevel, getTimeAgo } from '@/lib/utils'
import { AlertTriangle, Pencil, RefreshCw, ChevronRight, StickyNote, AlertCircle, MoreVertical, RotateCw, Trash, Play } from 'lucide-react'
import { useLibraryCache } from '@/store/libraryCache'
import { activityForAccount } from '@/lib/account-activity-index'
import { useAccountStore, getAccountEmail, getStremioAuthKey, hasPlatformConnection } from '@/store/accountStore'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '@/store/uiStore'
import { useToast } from '@/hooks/use-toast'

interface AccountListRowProps {
    account: Account
    isPrivacyMode?: boolean
    isSelected?: boolean
    isSelectionMode?: boolean
    onToggleSelect?: (accountId: string) => void
    onDelete?: (accountId: string) => void
}

/** Rows only show the latest-watched entry and live playback, so they read the head and skip archive walks. */
const CARD_MEDIA_OPTIONS = { archive: false } as const

export const AccountListRow = memo(function AccountListRow({
    account,
    isPrivacyMode = false,
    isSelected = false,
    isSelectionMode = false,
    onToggleSelect,
    onDelete,
}: AccountListRowProps) {
    const navigate = useNavigate()
    const { toast } = useToast()
    const syncAccount = useAccountStore((state) => state.syncAccount)
    const repairAccount = useAccountStore((state) => state.repairAccount)
    const loading = useAccountStore((state) => state.loadingAccounts.has(account.id))
    const openAddAccountDialog = useUIStore((state) => state.openAddAccountDialog)
    const privacyLevelNames = useUIStore((state) => state.privacyLevelNames)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const phone = usePhoneViewport()

    const accountEmail = getAccountEmail(account)
    const isNameCustomized = account.name !== accountEmail && account.name !== 'Account' && account.name !== 'Stremio Account'
    const privacyLevel = isPrivacyMode ? privacyLevelNames : 0
    const displayName = isNameCustomized
        ? maskNameLevel(account.name, privacyLevel)
        : account.name && account.name.includes('@')
            ? maskEmailLevel(account.name, privacyLevel)
            : maskNameLevel(account.name || accountEmail || 'Unnamed Account', privacyLevel)

    const protectedCount = useMemo(
        () => account.addons.filter(a => a.flags?.protected).length,
        [account.addons]
    )

    const media = useJellyfinActivity(account.id, true, CARD_MEDIA_OPTIONS)
    const cachedAccountItems = useLibraryCache(
        useShallow((state) => activityForAccount(state.items, account.id))
    )
    const accountItems = useMemo(() => mergeMediaItems(cachedAccountItems, media.history), [cachedAccountItems, media.history])
    const lastWatched = useMemo(() => {
        if (accountItems.length === 0) return null
        return [...accountItems].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
    }, [accountItems])
    const mediaPlayback = accountMediaPlayback(media.playback, lastWatched)

    const isStale = isSyncStale(account.lastSync, Date.now())
    const hasPlatformSources = accountPlatformSources(account).length > 0
    const hasAccentColor = account.accentColor && account.accentColor !== 'none'
    const accentColor = hasAccentColor ? account.accentColor! : null

    const handleCardClick = () => {
        if (isMenuOpen) return
        if (isSelectionMode) {
            onToggleSelect?.(account.id)
            return
        }
        navigate(`/account/${account.id}`)
    }

    return (
        <>
        <div
            data-account-row={account.id}
            data-theme-part="panel"
            data-selected={Boolean(isSelected)}
            role="button"
            tabIndex={0}
            aria-pressed={isSelectionMode ? isSelected : undefined}
            onClick={handleCardClick}
            onMouseEnter={() => { if (!isSelectionMode) prefetchAccountDetail(account.id) }}
            onFocus={() => { if (!isSelectionMode) prefetchAccountDetail(account.id) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick() } }}
            className={cn(
                'group relative flex cursor-pointer items-center gap-2 rounded-[1.35rem] border border-border/45 bg-card/80 px-3 py-3 shadow-sm transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:gap-3 sm:px-4',
                isSelected && 'border-primary/45 bg-primary/8 shadow-[0_0_0_1px_hsl(var(--primary)/0.18)]',
                isMenuOpen && 'z-40'
            )}
        >
            {isSelectionMode && (
                <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleSelect?.(account.id)}
                        aria-label={isPrivacyMode ? 'Select account' : `Select ${displayName}`}
                    />
                </div>
            )}


            <div className="relative shrink-0">
                <AccountAvatar account={account} size="md" accentColor={accentColor} />
            </div>


            <div className="flex-1 min-w-0">

                <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-semibold tracking-tight">{displayName}</span>
                    {account.status === 'error' && (
                        <Tooltip content="Try syncing again. If it keeps failing, open account settings and update credentials." side="top">
                            <span data-theme-part="badge" aria-label="Sync failed" className="inline-flex items-center justify-center rounded-full border p-1 border-destructive/20 bg-destructive/10 text-destructive shrink-0">
                                <AlertTriangle className="h-3 w-3" />
                            </span>
                        </Tooltip>
                    )}
                    {account.status === 'expired' && (
                        <Tooltip content="A session token was rejected. Re-authenticate this account to refresh it." side="top">
                            <span data-theme-part="badge" aria-label="Session expired" className="inline-flex items-center justify-center rounded-full border p-1 border-warning/20 bg-warning/10 text-warning shrink-0">
                                <AlertCircle className="h-3 w-3" />
                            </span>
                        </Tooltip>
                    )}
                </div>


                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {!account.hidePlatformLogos && hasPlatformSources && (
                        <span className="inline-flex shrink-0 items-center border-r border-border/50 pr-2">
                            <PlatformSourceChip account={account} />
                        </span>
                    )}
                    {!hasPlatformSources && (
                        <span className="shrink-0 border-r border-border/50 pr-2 text-[11px]">Local</span>
                    )}
                    <Tooltip content={addonCountTooltip(account.addons.length, protectedCount)} side="top">
                        <span className="shrink-0 whitespace-nowrap">{addonCountLabel(account.addons.length)}</span>
                    </Tooltip>
                    {!account.hideLastWatched && mediaPlayback && <AccountMediaPlayback playback={mediaPlayback} compact />}
                    {!account.hideLastWatched && !mediaPlayback && lastWatched && (
                        <>
                            <span className="hidden shrink-0 sm:inline">·</span>
                            <span className="min-w-0 truncate">
                                <Play className="mr-1 inline h-3 w-3 text-muted-foreground/60" /><span className="font-medium text-foreground/80">{lastWatched.name}</span>
                                <span className="ml-1 text-[11px]">{getTimeAgo(new Date(lastWatched.timestamp))}</span>
                            </span>
                        </>
                    )}
                    {isStale && (
                        <>
                            <span className="shrink-0">·</span>
                            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-warning">
                                <AlertTriangle className="h-3 w-3" />
                                Last synced {getTimeAgo(new Date(account.lastSync))}
                            </span>
                        </>
                    )}
                </div>
            </div>


            <div className="hidden items-center gap-2.5 shrink-0 text-xs sm:flex">
                <AccountStatChips account={account} />
                {account.note && (
                    <Tooltip content={`Note: ${account.note.slice(0, 60)}${account.note.length > 60 ? '…' : ''}`} side="top">
                        <StickyNote className="w-3.5 h-3.5 text-primary" />
                    </Tooltip>
                )}
            </div>


            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <Tooltip content="Sync" side="top">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="hidden h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground sm:inline-flex"
                        onClick={async (e) => {
                            e.stopPropagation()
                            try {
                                toast({ title: 'Syncing...', description: `Refreshing ${displayName}` })
                                await syncAccount(account.id, true, 'user')
                                toast({ title: 'Sync Complete', description: `Successfully synced ${displayName}`, accountId: account.id })
                            } catch (err) {
                                toast({ variant: 'destructive', title: 'Sync Failed', description: `Could not sync ${displayName}: ${err instanceof Error ? err.message : 'unknown error'}`, accountId: account.id })
                            }
                        }}
                        disabled={loading}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                </Tooltip>
                <Tooltip content="Edit" side="top">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="hidden h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground sm:inline-flex"
                        onClick={(e) => {
                            e.stopPropagation()
                            openAddAccountDialog(account)
                        }}
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                </Tooltip>
                <DropdownMenu onOpenChange={(open) => {
                    setIsMenuOpen(open)
                }}>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-muted/45 hover:text-foreground max-sm:-mr-2 max-sm:h-11 max-sm:w-11" onClick={(e) => e.stopPropagation()}>
                            <MoreVertical className="h-3.5 w-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52 max-w-[calc(100vw-2rem)] z-50" sheetHeader={<AccountMenuHeader account={account} name={displayName} />}>
                        {!phone && <div className="px-2 py-1.5 text-xs font-medium uppercase text-muted-foreground">Manage Account</div>}
                        {account.status === 'expired' && (
                            <DropdownMenuItem className="gap-2 text-warning focus:text-warning" onClick={(e) => { e.stopPropagation(); openAddAccountDialog(account); setIsMenuOpen(false) }}>
                                <AlertCircle className="h-4 w-4 shrink-0" /> Fix Session
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem className="gap-2 sm:hidden" onClick={(e) => { e.stopPropagation(); openAddAccountDialog(account); setIsMenuOpen(false) }}>
                            <Pencil className="h-4 w-4 shrink-0" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2 sm:hidden" onClick={async (e) => {
                            e.stopPropagation()
                            try {
                                toast({ title: 'Syncing...', description: `Refreshing ${displayName}` })
                                await syncAccount(account.id, true, 'user')
                                toast({ title: 'Sync Complete', description: `Successfully synced ${displayName}`, accountId: account.id })
                            } catch (err) {
                                toast({ variant: 'destructive', title: 'Sync Failed', description: `Could not sync ${displayName}: ${err instanceof Error ? err.message : 'unknown error'}`, accountId: account.id })
                            }
                        }} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 shrink-0 ${loading ? 'animate-spin' : ''}`} /> Sync
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2" onClick={async (e) => {
                            e.stopPropagation()
                            try {
                                toast({ title: 'Repairing...', description: `Deep refreshing ${displayName}` })
                                await repairAccount(account.id)
                                toast({ title: 'Repair Complete', description: `${displayName} is now healthy` })
                            } catch {
                                toast({ variant: 'destructive', title: 'Repair Failed', description: `Failed to repair ${displayName}` })
                            }
                        }} disabled={loading}>
                            <RefreshCw className="h-4 w-4 shrink-0 text-warning" /> Repair
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2" onClick={async (e) => {
                            e.stopPropagation()
                            if (!hasPlatformConnection(account)) return
                            try {
                                toast({ title: 'Refreshing...', description: `Reinstalling all addons on ${displayName}` })
                                const { useAddonStore } = await import('@/store/addonStore')
                                await useAddonStore.getState().bulkReinstallAllOnAccount(account.id, getStremioAuthKey(account))
                                toast({ title: 'Refresh Complete', description: `All addons on ${displayName} reinstalled` })
                            } catch {
                                toast({ variant: 'destructive', title: 'Refresh Failed', description: `Could not reinstall addons on ${displayName}` })
                            }
                        }} disabled={loading}>
                            <RotateCw className="h-4 w-4 shrink-0 text-primary" /> Refresh Addons
                        </DropdownMenuItem>
                        {onDelete && (
                            <DropdownMenuItem className="gap-2 text-destructive focus:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(account.id) }}>
                                <Trash className="h-4 w-4 shrink-0" /> Delete
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground sm:block" />
        </div>

        </>
    )
})
