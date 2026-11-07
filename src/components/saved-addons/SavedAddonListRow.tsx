import type { SavedAddon, SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import type { Account } from '@/types/account'
import { getAddonConfigureUrl, cn, getTimeAgo, getSyncScopeLabel } from '@/lib/utils'
import { useLongPress } from '@/hooks/useLongPress'
import { Copy, FileEdit, Layers, MoreVertical, Pencil, Check, Send, Tag, Link2, ArrowUpCircle } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { AnimatedSettingsIcon, AnimatedTrashIcon, AnimatedUpdateIcon } from '../ui/AnimatedIcons'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUIStore } from '@/store/uiStore'
import { memo } from 'react'
import { SavedAddonEditDialog, SavedAddonDeleteConfirm } from './SavedAddonEditDialog'
import { getTagColor } from '@/lib/tag-utils'
import { Button } from '@/components/ui/button'
import { SavedAddonDeploymentBadge } from './SavedAddonDeploymentBadge'
import { PlatformSourceChip } from '@/components/addons/PlatformSourceChip'
import { SavedAddonIcon } from './SavedAddonIcon'
import { StatusDot } from '@/components/common/StatusDot'
import { useSavedAddonActions } from './hooks/useSavedAddonActions'
import { SourceUrlBox } from '@/components/addons/SourceUrlBox'
import { extractAddonParams } from '@/lib/addon-params'

interface SavedAddonListRowProps {
    savedAddon: SavedAddon
    latestVersion?: string
    onUpdate?: (savedAddonId: string, addonName: string) => Promise<void>
    onDeploy?: (savedAddonId: string) => void
    isSelectionMode?: boolean
    isSelected?: boolean
    onToggleSelect?: (id: string) => void
    onLongPress?: (id: string) => void
    profileName?: string
    deployedAccounts?: Account[]
    manifestChange?: SavedAddonManifestChangeSummary
}

export const SavedAddonListRow = memo(function SavedAddonListRow({
    savedAddon,
    latestVersion,
    onUpdate,
    onDeploy,
    isSelectionMode,
    isSelected,
    onToggleSelect,
    onLongPress,
    profileName,
    deployedAccounts = [],
    manifestChange,
}: SavedAddonListRowProps) {
    const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)

    const {
        showDetails,
        setShowDetails,
        showDeleteDialog,
        setShowDeleteDialog,
        updating,
        hasUpdate,
        hasVersionUpdate,
        hasManifestShapeChange,
        manifestChangeLabel,
        handleConfirmDelete,
        handleCopyUrl,
        handleUpdate,
        handleReplaceUrl,
        getHealthTooltip,
    } = useSavedAddonActions({ savedAddon, latestVersion, manifestChange, onUpdate })

    const handleOpenConfiguration = (e: React.MouseEvent) => {
        e.stopPropagation()
        const configUrl = getAddonConfigureUrl(savedAddon.installUrl)
        window.open(configUrl, '_blank', 'noopener,noreferrer')
    }

    const { isLongPressTriggered, ...longPressProps } = useLongPress(() => {
        if (!isSelectionMode && onLongPress) {
            onLongPress(savedAddon.id)
        }
    })

    return (
        <>
            <div
                data-theme-part="addon-card"
                data-selected={Boolean(isSelected)}
                {...longPressProps}
                className={cn(
                    "group flex items-center gap-2 px-3 py-3 rounded-2xl border transition-[transform,opacity,box-shadow] duration-150 sm:gap-3 sm:px-4",
                    isSelected
                        ? "bg-primary/5 border-primary/30 shadow-[inset_3px_0_0_hsl(var(--primary))]"
                        : "bg-card border-border/40 hover:border-border/70 hover:shadow-md",
                    isSelectionMode && "cursor-pointer"
                )}
                onClick={() => {
                    if (isLongPressTriggered) return
                    if (isSelectionMode && onToggleSelect) onToggleSelect(savedAddon.id)
                }}
            >
                {isSelectionMode && (
                    <div data-theme-part="checkbox" data-state={isSelected ? 'checked' : 'unchecked'} className={cn(
                        "shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors",
                        isSelected ? "bg-primary border-primary" : "border-border/40"
                    )}>
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                    </div>
                )}


                <div className="relative w-9 h-9 shrink-0">
                    <SavedAddonIcon
                        name={savedAddon.name}
                        addon={savedAddon}
                        alt={savedAddon.name}
                        className="h-full w-full"
                        textClassName="text-sm"
                    />
                    {savedAddon.health && (
                        <StatusDot
                            tone={savedAddon.health.isOnline ? 'success' : 'destructive'}
                            label={savedAddon.health.isOnline ? 'Online' : 'Offline'}
                            tooltip={getHealthTooltip()}
                            pulse={savedAddon.health.isOnline}
                        />
                    )}
                </div>


                <div className="flex-1 min-w-0">

                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold truncate">{savedAddon.name}</span>
                        <span className="hidden text-xs text-muted-foreground/60 shrink-0 min-[380px]:inline">v{savedAddon.manifest.version}</span>
                        {(savedAddon.manifest.behaviorHints?.configurable || savedAddon.manifest.behaviorHints?.configurationRequired) && (
                            <Tooltip content="Configure">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={handleOpenConfiguration}
                                    className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
                                    aria-label="Configure"
                                >
                                    <AnimatedSettingsIcon className="h-3 w-3" />
                                </Button>
                            </Tooltip>
                        )}
                        {savedAddon.syncWithInstalled && (
                            hasUpdate ? (
                                <Tooltip content={`${manifestChangeLabel || 'A newer version is available to push to your installed accounts'} (${getSyncScopeLabel(savedAddon.syncAccountIds)})`} side="top">
                                    <span aria-label="Update ready" data-theme-part="badge" className="inline-flex items-center justify-center rounded-full border p-1 border-warning/20 bg-warning/10 text-warning shrink-0">
                                        <ArrowUpCircle className="h-3 w-3" />
                                    </span>
                                </Tooltip>
                            ) : (
                                <Tooltip content={`In sync with your installed accounts (${getSyncScopeLabel(savedAddon.syncAccountIds)})`} side="top">
                                    <span aria-label="In sync" data-theme-part="badge" className="inline-flex items-center justify-center rounded-full border p-1 border-success/20 bg-success/10 text-success shrink-0">
                                        <Link2 className="h-3 w-3" />
                                    </span>
                                </Tooltip>
                            )
                        )}
                        {hasManifestShapeChange && (
                            <Tooltip content={manifestChangeLabel || 'Manifest catalogs or resources changed'} side="top">
                                <span aria-label={manifestChangeLabel || 'Manifest catalogs or resources changed'} data-theme-part="badge" className="inline-flex items-center justify-center rounded-full border p-1 border-warning/20 bg-warning/10 text-warning">
                                    <FileEdit className="h-3 w-3" />
                                </span>
                            </Tooltip>
                        )}
                        {hasUpdate && onUpdate && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleUpdate}
                                disabled={updating}
                                className="h-5 px-1.5 py-0 text-xs font-bold uppercase bg-warning/10 text-warning border border-warning/30 hover:bg-warning/20 hover:text-warning gap-1 shrink-0"
                            >
                                <AnimatedUpdateIcon className="h-2.5 w-2.5" isAnimating={updating} />
                                {updating ? '...' : hasVersionUpdate ? 'Update' : 'Refresh'}
                            </Button>
                        )}
                    </div>


                    <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground/60 min-w-0">
                        <SourceUrlBox
                            url={savedAddon.installUrl}
                            manifest={savedAddon.manifest}
                            privacyMode={isPrivacyModeEnabled}
                            variant="compact"
                            disabled={updating}
                            onReplace={handleReplaceUrl}
                            successDescription="Library entry, installed copies, and Autopilot rules were updated."
                            className="max-w-[180px] shrink basis-[150px] py-0.5 sm:max-w-[260px] sm:basis-[220px]"
                        />
                        {savedAddon.tags.length > 0 && (
                            <>
                                <span className="hidden shrink-0 sm:inline">·</span>
                                <div
                                    className="hidden items-center gap-1 min-w-0 overflow-hidden sm:flex"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {savedAddon.tags.slice(0, 2).map((tag) => {
                                        const color = getTagColor(tag)
                                        return (
                                            <span
                                                key={tag}
                                                data-theme-part="badge"
                                                className="text-xs pointer-events-none px-1.5 py-0 rounded-full shrink-0 leading-5 font-medium"
                                                style={{ background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
                                            >
                                                {tag}
                                            </span>
                                        )
                                    })}
                                    {savedAddon.tags.length > 2 && (
                                        <span className="text-xs text-muted-foreground/60 shrink-0">+{savedAddon.tags.length - 2}</span>
                                    )}
                                </div>
                            </>
                        )}
                        {profileName && (
                            <>
                                <span className="hidden shrink-0 sm:inline">·</span>
                                <span className="hidden truncate text-foreground/60 sm:inline">{profileName}</span>
                            </>
                        )}
                        {(() => { const p = extractAddonParams(savedAddon.installUrl).params; if (!p.tag && !p.variant) return null; return (
                            <>
                                <span className="hidden shrink-0 sm:inline">·</span>
                                <span data-theme-part="badge" className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 text-[11px] font-medium text-primary">
                                    {p.tag ? <Tag className="h-2.5 w-2.5" /> : <Layers className="h-2.5 w-2.5" />}
                                    {p.tag || p.variant}
                                </span>
                            </>
                        ) })()}
                        {deployedAccounts.length > 0 && (
                            <>
                                <span className="hidden shrink-0 sm:inline">·</span>
                                {/* Platforms the accounts that contain this addon sync it
                                    to — derived only from matching configured URLs. */}
                                <PlatformSourceChip accounts={deployedAccounts} addon={{ transportUrl: savedAddon.installUrl }} scope="addon" className="hidden sm:inline-flex" />
                                <span className="hidden shrink-0 sm:inline">·</span>
                                <SavedAddonDeploymentBadge accounts={deployedAccounts} className="hidden sm:inline-flex" />
                            </>
                        )}
                        <span className="hidden shrink-0 min-[380px]:inline">·</span>
                        <span className="hidden shrink-0 min-[380px]:inline">Saved {getTimeAgo(new Date(savedAddon.createdAt))}</span>
                    </div>
                </div>

                <div className="shrink-0">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="More options"
                                onClick={(e) => e.stopPropagation()}
                                className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground"
                            >
                                <MoreVertical className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" sideOffset={4} collisionPadding={8} className="w-56 max-w-[calc(100vw-2rem)]">
                            <div className="px-2 py-1.5 text-xs font-medium uppercase text-muted-foreground">Manage Saved Addon</div>
                            <DropdownMenuItem onClick={handleCopyUrl} className="gap-2">
                                <Copy className="h-4 w-4" />
                                Copy URL
                            </DropdownMenuItem>
                            {(savedAddon.manifest.behaviorHints?.configurable || savedAddon.manifest.behaviorHints?.configurationRequired) && (
                                <DropdownMenuItem onClick={handleOpenConfiguration} className="gap-2">
                                    <AnimatedSettingsIcon className="h-4 w-4" />
                                    Configure
                                </DropdownMenuItem>
                            )}
                            {onDeploy && (
                                <DropdownMenuItem onClick={() => onDeploy(savedAddon.id)} className="gap-2">
                                    <Send className="h-4 w-4" />
                                    Deploy
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => setShowDetails(true)} className="gap-2">
                                <Pencil className="h-4 w-4" />
                                Customize
                            </DropdownMenuItem>
                            <DropdownMenuItem destructive onClick={() => setShowDeleteDialog(true)} className="gap-2 text-destructive focus:text-destructive">
                                <AnimatedTrashIcon className="h-4 w-4" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <SavedAddonEditDialog
                savedAddon={savedAddon}
                deployedAccounts={deployedAccounts}
                open={showDetails}
                onOpenChange={setShowDetails}
            />

            <SavedAddonDeleteConfirm
                savedAddon={savedAddon}
                open={showDeleteDialog}
                onOpenChange={setShowDeleteDialog}
                onConfirm={handleConfirmDelete}
            />
        </>
    )
})
