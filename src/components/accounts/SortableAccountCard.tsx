import { memo } from 'react'
import { AccountCard } from './AccountCard'
import { AccountAvatar } from './AccountAvatar'
import { Account } from '@/types/account'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertCircle, GripVertical, ShieldCheck } from 'lucide-react'
import { getAccountEmail } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { cn, getTimeAgo, maskEmailLevel, maskNameLevel } from '@/lib/utils'

interface SortableAccountCardProps {
    account: Account
    isSelected?: boolean
    onToggleSelect?: (accountId: string) => void
    onLongPress?: (accountId: string) => void
    onDelete?: () => void
    isSelectionMode?: boolean
    isPrivacyMode?: boolean
    compact?: boolean
}

interface AccountReorderRowProps {
    account: Account
    dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
    isDragging?: boolean
    isOverlay?: boolean
    isPrivacyMode?: boolean
    setNodeRef?: (node: HTMLDivElement | null) => void
    style?: React.CSSProperties
}

export const AccountReorderRow = memo(function AccountReorderRow({
    account,
    dragHandleProps,
    isDragging = false,
    isOverlay = false,
    isPrivacyMode = false,
    setNodeRef,
    style,
}: AccountReorderRowProps) {
    const accountEmail = getAccountEmail(account)
    const privacyLevelNames = useUIStore((state) => state.privacyLevelNames)
    const isNameCustomized = account.name !== accountEmail && account.name !== 'Account' && account.name !== 'Stremio Account'
    const privacyLevel = isPrivacyMode ? privacyLevelNames : 0
    const displayName = isNameCustomized
        ? maskNameLevel(account.name, privacyLevel)
        : account.name && account.name.includes('@')
            ? maskEmailLevel(account.name, privacyLevel)
            : maskNameLevel(account.name || accountEmail || 'Unnamed Account', privacyLevel)
    const protectedCount = account.addons.filter(addon => addon.flags?.protected).length
    const timeStr = getTimeAgo(new Date(account.lastSync))
    const hasAccentColor = account.accentColor && account.accentColor !== 'none'
    const accentColor = hasAccentColor ? account.accentColor! : null

    return (
        <div
            ref={setNodeRef}
            style={style}
            data-theme-part="card"
            className={cn(
                'group relative flex min-h-[76px] w-full items-center gap-2 rounded-[1.35rem] border border-border/45 bg-card/80 px-3 py-3 shadow-sm sm:gap-3 sm:px-4',
                !isDragging ? 'transition-[transform,opacity,box-shadow,border-color] duration-200' : '',
                isOverlay
                    ? 'cursor-grabbing border-primary/60 bg-card shadow-2xl ring-2 ring-primary/20'
                    : isDragging
                        ? 'opacity-0'
                        : 'hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md'
            )}
        >
            <div
                {...dragHandleProps}
                className={cn(
                    'shrink-0 rounded-xl p-2 text-muted-foreground transition-colors',
                    isOverlay ? 'cursor-grabbing' : 'cursor-grab hover:bg-muted/50 hover:text-foreground active:cursor-grabbing'
                )}
                style={{ touchAction: 'none' }}
            >
                <GripVertical className="h-4 w-4" />
            </div>

            <div className="relative shrink-0">
                <AccountAvatar account={account} size="md" accentColor={accentColor} />
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-semibold leading-tight tracking-tight">{displayName}</p>
                    {account.status === 'error' && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-destructive">
                            <AlertCircle className="h-3 w-3" /> Sync failed
                        </span>
                    )}
                    {account.status === 'expired' && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
                            <AlertCircle className="h-3 w-3" /> Session expired
                        </span>
                    )}
                </div>

                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {accountEmail && accountEmail !== account.name && (
                        <span className="min-w-0 truncate sm:max-w-[160px]">
                            {maskEmailLevel(accountEmail, privacyLevel)}
                        </span>
                    )}
                    {accountEmail && accountEmail !== account.name && (
                        <span className="hidden shrink-0 min-[380px]:inline">·</span>
                    )}
                    <span className="hidden shrink-0 min-[380px]:inline">Synced {timeStr}</span>
                </div>
            </div>

            <div className="hidden shrink-0 items-center gap-2 sm:flex">
                <span className="inline-flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{account.addons.length}</span> addons
                    {protectedCount > 0 && (
                        <>
                            <span className="text-border">/</span>
                            <ShieldCheck className="h-3 w-3 shrink-0 text-success/80" />
                            <span className="font-semibold text-foreground">{protectedCount}</span>
                        </>
                    )}
                </span>
            </div>

            <span data-theme-part="badge" className="shrink-0 rounded-full border border-border/40 bg-muted/50 px-1.5 py-0.5 text-xs font-semibold text-muted-foreground sm:hidden">
                {account.addons.length}
            </span>
        </div>
    )
})

export const SortableAccountCard = memo(function SortableAccountCard({
    account,
    isSelected,
    onToggleSelect,
    onLongPress,
    onDelete,
    isSelectionMode,
    isPrivacyMode,
    compact = false,
}: SortableAccountCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: account.id,
    })

    const dragHandleProps = { ...attributes, ...listeners }

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: !compact && isDragging ? 0.5 : undefined,
        zIndex: isDragging ? 50 : 'auto',
        position: 'relative' as const,
    }
    if (compact) {
        return (
            <AccountReorderRow
                account={account}
                dragHandleProps={dragHandleProps}
                isDragging={isDragging}
                isPrivacyMode={isPrivacyMode}
                setNodeRef={setNodeRef}
                style={style}
            />
        )
    }

    return (
        <div ref={setNodeRef} style={style} className="h-full">
            <AccountCard
                account={account}
                isSelected={isSelected}
                onToggleSelect={onToggleSelect}
                onLongPress={onLongPress}
                onDelete={onDelete}
                dragHandleProps={dragHandleProps}
                isSelectionMode={isSelectionMode}

                isPrivacyMode={isPrivacyMode}
            />
        </div>
    )
})
