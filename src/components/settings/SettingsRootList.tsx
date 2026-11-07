import { Fragment } from 'react'
import { type LucideIcon, AlertTriangle, ChevronRight, KeyRound, Palette, User, Wrench, Zap } from 'lucide-react'
import { cn, getTimeAgo, maskedInitial } from '@/lib/utils'
import { useSyncStore } from '@/store/syncStore'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { useTheme } from '@/contexts/ThemeContext'
import { useNow } from '@/hooks/use-relative-time'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import {
    SETTINGS_GROUP_ORDER,
    SETTINGS_ROWS,
    type SettingsGroupId,
    type SettingsPageId,
    type SettingsPageSelection,
    type SettingsRowSpec,
} from './settings-model'

const ROW_ICONS: Record<SettingsPageId, LucideIcon> = {
    'account-sync': User,
    'appearance-privacy': Palette,
    keys: KeyRound,
    'updates-activity': Zap,
    'devices-maintenance': Wrench,
    'danger-zone': AlertTriangle,
}

export { ROW_ICONS }

interface SettingsRootListProps {
    activePage: SettingsPageSelection
    onSelect: (page: SettingsPageId) => void
    /** Pages matching the active search query; null when the query is empty. */
    filterPages: ReadonlySet<SettingsPageId> | null
    className?: string
}

export function SettingsRootList({ activePage, onSelect, filterPages, className }: SettingsRootListProps) {
    const auth = useSyncStore(s => s.auth)
    const maskLabel = useMaskedAccountLabel()
    const lastSyncedAt = useSyncStore(s => s.lastSyncedAt)
    const lastSyncCheckedAt = useSyncStore(s => s.lastSyncCheckedAt)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const accounts = useAccountStore(s => s.accounts)
    const { theme, getAllThemeOptions } = useTheme()
    useNow()

    const latestSyncAt = [lastSyncCheckedAt, lastSyncedAt].filter(Boolean).map(t => new Date(t as string).getTime()).reduce((a, b) => Math.max(a, b), 0)
    const syncLabel = latestSyncAt ? getTimeAgo(new Date(latestSyncAt)) : 'never'
    const themeLabel = getAllThemeOptions().find(option => option.id === theme)?.label ?? theme
    // Only counts keys already in the account store; never issues new requests.
    const savedKeyCount = accounts.filter(account => account.apiKey).length

    const rowsByGroup = new Map<SettingsGroupId, SettingsRowSpec[]>()
    for (const row of SETTINGS_ROWS) {
        if (filterPages && !filterPages.has(row.page)) continue
        const rows = rowsByGroup.get(row.group) ?? []
        rows.push(row)
        rowsByGroup.set(row.group, rows)
    }
    // The profile card IS the account-sync entry, so it obeys the same filter.
    const cardVisible = !filterPages || filterPages.has('account-sync')

    const renderRow = (page: SettingsPageId, title: string, value?: string) => {
        const Icon = ROW_ICONS[page]
        const isDanger = page === 'danger-zone'
        const isActive = activePage === page
        return (
            <button
                key={page}
                type="button"
                onClick={() => onSelect(page)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                    'flex min-h-[48px] w-full items-center gap-3 rounded-xl px-1.5 py-2.5 text-left transition-colors',
                    isActive ? 'bg-muted/45' : 'hover:bg-muted/25',
                    isDanger && 'text-destructive hover:bg-destructive/10',
                )}
            >
                <span
                    className={cn(
                        'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                        isDanger ? 'bg-destructive/10 text-destructive' : isActive ? 'bg-muted/60 text-foreground' : 'bg-muted/35 text-muted-foreground',
                    )}
                >
                    <Icon className="h-[15px] w-[15px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
                {value && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{value}</span>}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
            </button>
        )
    }

    return (
        <div className={cn('min-w-0', className)}>
            {cardVisible && (
                <button
                    type="button"
                    onClick={() => onSelect('account-sync')}
                    aria-current={activePage === 'account-sync' ? 'page' : undefined}
                    className={cn(
                        'flex w-full items-center gap-4 rounded-[1.25rem] border border-border/45 bg-card/80 p-4 text-left shadow-sm transition-colors',
                        activePage === 'account-sync' ? 'bg-muted/50' : 'hover:bg-muted/30',
                    )}
                >
                    <span data-theme-part="avatar" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-primary/25 bg-primary/10">
                        {auth.isAuthenticated && auth.avatar ? (
                            <img src={auth.avatar} alt="" className="h-full w-full object-cover" />
                        ) : auth.isAuthenticated ? (
                            <span className="text-lg font-bold text-primary">{maskedInitial(auth.name || auth.id, privacyLevelNames)}</span>
                        ) : (
                            <User className="h-5 w-5 text-muted-foreground" />
                        )}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-semibold">
                            {auth.isAuthenticated ? (auth.name ? maskLabel({ name: auth.name }) : 'Cloud account') : 'Cloud sync'}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {auth.isAuthenticated && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />}
                            {auth.isAuthenticated ? `Cloud sync \u00b7 authenticated \u00b7 synced ${syncLabel}` : 'Cloud sync \u00b7 not connected'}
                        </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
                </button>
            )}

            {SETTINGS_GROUP_ORDER.map(group => {
                const rows = rowsByGroup.get(group)
                if (!rows || rows.length === 0) return null
                return (
                    <section key={group} className="mt-4">
                        <div
                            className="rounded-2xl border border-border/45 bg-card/80 px-2.5 py-1 shadow-sm"
                        >
                            {rows.map((row, index) => (
                                <Fragment key={row.page}>
                                    {index > 0 && <div aria-hidden className="ml-14 h-px bg-border/40" />}
                                    {renderRow(
                                        row.page,
                                        row.title,
                                        row.page === 'appearance-privacy'
                                            ? themeLabel
                                            : row.page === 'keys' && savedKeyCount > 0
                                                ? `${savedKeyCount} account keys`
                                                : undefined,
                                    )}
                                </Fragment>
                            ))}
                        </div>
                    </section>
                )
            })}

            {!cardVisible && rowsByGroup.size === 0 && (
                <p className="mt-4 rounded-2xl border border-border/45 bg-card/80 px-3 py-4 text-center text-sm text-muted-foreground shadow-sm">No settings match</p>
            )}
        </div>
    )
}
