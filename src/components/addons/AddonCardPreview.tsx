import { List, MoreVertical, Pencil, RefreshCw, Settings } from 'lucide-react'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { AddonIcon } from '@/components/ui/addon-icon'
import { PlatformSourceChip } from './PlatformSourceChip'
import { addonPlatformChipState } from './platform-source'
import { SourceUrlBox } from './SourceUrlBox'
import type { AddonDescriptor } from '@/types/addon'

const PREVIEW_ACTIONS = [
    { icon: Settings, label: 'Configure' },
    { icon: List, label: 'Catalogs' },
    { icon: Pencil, label: 'Customize' },
    { icon: RefreshCw, label: 'Reinstall' },
] as const

interface AddonCardPreviewProps {
    addon: AddonDescriptor
    accountId: string
    /** Live draft values so the replica tracks the editor fields. */
    name: string
    logo?: string
    description: string
}

// Read-only replica of the account AddonCard for the "Dashboard Preview":
// the real card's classes and pieces with every control inert and the
// action pills dimmed. On narrow viewports it collapses to the compact
// header row plus description (URL row and pills are hidden below md).
export function AddonCardPreview({ addon, accountId, name, logo, description }: AddonCardPreviewProps) {
    const account = useAccountStore((state) => state.accounts.find(a => a.id === accountId))
    const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)

    const displayName = name || addon.manifest.name
    const descriptionText = description || addon.manifest.description || ''
    const enabled = addon.flags?.enabled !== false
    const chipState = addonPlatformChipState(account, addon)
    const showPlatformSource = !!account && !account.hidePlatformLogos && chipState.total > 0

    return (
        <div
            aria-hidden="true"
            inert
            className="pointer-events-none select-none rounded-2xl border border-border/40 bg-card p-3 text-card-foreground shadow-sm sm:p-5"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-3">
                    <AddonIcon
                        name={displayName}
                        logo={logo || addon.metadata?.customLogo || addon.manifest.logo}
                        alt=""
                        className="h-11 w-11 shrink-0"
                        textClassName="text-sm"
                    />
                    <div className="flex min-w-0 flex-col">
                        <span className="truncate text-base font-semibold leading-tight">{displayName}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                            <span className="truncate">v{addon.manifest.version}</span>
                            {showPlatformSource && (
                                <PlatformSourceChip
                                    account={account}
                                    addon={addon}
                                    scope="addon"
                                    ofTotal={chipState.total}
                                    failing={chipState.failing}
                                    className="ml-1"
                                />
                            )}
                        </span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <span
                        className={`mr-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent px-0.5 ${enabled ? 'justify-end bg-success' : 'justify-start bg-muted-foreground/25 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]'}`}
                    >
                        <span className={`block h-5 w-5 rounded-full shadow-lg ${enabled ? 'bg-background' : 'bg-foreground/70'}`} />
                    </span>
                    <span className="-mr-1 flex h-8 w-7 items-center justify-center text-muted-foreground">
                        <MoreVertical className="h-4 w-4" />
                    </span>
                </div>
            </div>

            {descriptionText && (
                <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                    {descriptionText}
                </p>
            )}

            <div className="hidden md:block">
                <SourceUrlBox
                    addon={addon}
                    accountId={accountId}
                    privacyMode={isPrivacyModeEnabled}
                    variant="full"
                    disabled
                    className="mt-3"
                />
                <div className="mt-3 grid grid-cols-2 gap-1.5 opacity-50">
                    {PREVIEW_ACTIONS.map(({ icon: Icon, label }) => (
                        <span
                            key={label}
                            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border/40 bg-muted/40 px-3 text-xs font-semibold text-foreground/70 shadow-none"
                        >
                            <Icon className="h-3.5 w-3.5" />
                            {label}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    )
}
