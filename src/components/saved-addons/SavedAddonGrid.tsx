import { useCallback } from 'react'
import { StaggerContainer, StaggerItem } from '@/components/ui/stagger'
import { Button } from '@/components/ui/button'
import { StatusChip } from '@/components/ui/status-chip'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, getLatestAddonVersion } from '@/lib/utils'
import type { SavedAddon, SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import type { Profile } from '@/types/profile'
import { ChevronDown, GripVertical, Package, User } from 'lucide-react'
import { SavedAddonCard } from './SavedAddonCard'
import { SavedAddonListRow } from './SavedAddonListRow'
import type { SavedAddonDeploymentSummary } from './hooks/useSavedAddonLibraryData'

interface SavedAddonGridProps {
  addons: SavedAddon[]
  profiles: Profile[]
  selectedProfileId: string | null
  collapsedProfiles: Set<string>
  onToggleProfile: (id: string) => void
  viewMode: 'grid' | 'list'
  latestVersions: Record<string, string>
  manifestChangeHints: Record<string, SavedAddonManifestChangeSummary>
  deploymentSummaryByAddonId: Record<string, SavedAddonDeploymentSummary>
  onUpdate: (savedAddonId: string, addonName: string) => Promise<void>
  onDeploy: (savedAddonId: string) => void
  isSelectionMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onEnterSelectionMode: () => void
  onReorderSection?: (sectionId: string) => void
  highlight?: string
}

const EMPTY_DEPLOYED_ACCOUNTS: SavedAddonDeploymentSummary['deployedAccounts'] = []

export function SavedAddonGrid({
  addons,
  profiles,
  selectedProfileId,
  collapsedProfiles,
  onToggleProfile,
  viewMode,
  latestVersions,
  manifestChangeHints,
  deploymentSummaryByAddonId,
  onUpdate,
  onDeploy,
  isSelectionMode,
  selectedIds,
  onToggleSelect,
  onEnterSelectionMode,
  onReorderSection,
  highlight,
}: SavedAddonGridProps) {
  const onLongPress = useCallback((id: string) => {
    onEnterSelectionMode()
    onToggleSelect(id)
  }, [onEnterSelectionMode, onToggleSelect])

  const itemClassName = viewMode === 'list' ? 'content-auto-addon-row' : 'content-auto-addon-card'
  const renderAddon = (addon: SavedAddon, profileName?: string, showHighlight = false) => {
    if (viewMode === 'list') {
      return (
        <StaggerItem key={addon.id} contentAutoClass={itemClassName}>
          <SavedAddonListRow
            savedAddon={addon}
            latestVersion={getLatestAddonVersion(latestVersions, {
              transportUrl: addon.installUrl,
              manifest: addon.manifest,
            })}
            manifestChange={manifestChangeHints[addon.id]}
            onUpdate={onUpdate}
            onDeploy={onDeploy}
            isSelectionMode={isSelectionMode}
            isSelected={selectedIds.has(addon.id)}
            onToggleSelect={onToggleSelect}
            onLongPress={onLongPress}
            profileName={profileName}
            deployedAccounts={deploymentSummaryByAddonId[addon.id]?.deployedAccounts ?? EMPTY_DEPLOYED_ACCOUNTS}
          />
        </StaggerItem>
      )
    }

    return (
      <StaggerItem key={addon.id} contentAutoClass={itemClassName}>
        <SavedAddonCard
          savedAddon={addon}
          latestVersion={getLatestAddonVersion(latestVersions, {
            transportUrl: addon.installUrl,
            manifest: addon.manifest,
          })}
          manifestChange={manifestChangeHints[addon.id]}
          onUpdate={onUpdate}
          onDeploy={onDeploy}
          isSelectionMode={isSelectionMode}
          isSelected={selectedIds.has(addon.id)}
          onToggleSelect={onToggleSelect}
          onLongPress={onLongPress}
          profileName={profileName}
          deployedAccounts={deploymentSummaryByAddonId[addon.id]?.deployedAccounts ?? EMPTY_DEPLOYED_ACCOUNTS}
          highlight={showHighlight ? highlight : undefined}
        />
      </StaggerItem>
    )
  }

  const reorderButton = (sectionId: string, count: number) =>
    onReorderSection ? (
      <Tooltip content="Reorder this section" side="top">
        <Button
          variant="outline"
          size="icon"
          ripple={false}
          onClick={(e) => { e.stopPropagation(); onReorderSection(sectionId) }}
          disabled={count < 2}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label="Reorder this section"
          data-ctrl="group-reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    ) : null

  if (selectedProfileId !== null) {
    return (
      <StaggerContainer className={cn(
        viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'w-full flex flex-col gap-2'
      )}>
        {addons.map((addon) => {
          const profile = profiles.find(p => p.id === addon.profileId)
          return renderAddon(addon, profile?.name, true)
        })}
      </StaggerContainer>
    )
  }

  return (
    <div className="space-y-4 w-full">
      {profiles.map(profile => {
        const profileAddons = addons.filter(a => a.profileId === profile.id)
        if (profileAddons.length === 0) return null
        const isExpanded = !collapsedProfiles.has(profile.id)

        return (
          <div key={profile.id} data-theme-part="panel" data-ctrl="group" className="rounded-2xl border border-border/40 bg-card/50 p-3 space-y-3 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Button
                variant="ghost"
                ripple={false}
                className="h-auto justify-start flex items-center gap-2.5 px-2 py-1 rounded-full group hover:bg-muted/50 transition-[transform,opacity,box-shadow] [&_svg]:!size-3.5"
                onClick={() => onToggleProfile(profile.id)}
                data-ctrl="group-chevron"
                aria-label={`Collapse ${profile.name}`}
              >
                <ChevronDown className={cn(
                  'h-3.5 w-3.5 text-foreground/60 transition-transform shrink-0',
                  collapsedProfiles.has(profile.id) && '-rotate-90'
                )} />
                <span data-ctrl="group-name" className="text-sm font-semibold text-foreground/70 group-hover:text-foreground transition-colors flex items-center gap-2">
                  <User data-ctrl="group-icon" className="h-3.5 w-3.5 shrink-0" />
                  {profile.name}
                </span>
              </Button>
              <div className="flex items-center gap-1.5">
                {reorderButton(profile.id, profileAddons.length)}
                <StatusChip variant="muted">
                  {profileAddons.length} addon{profileAddons.length !== 1 ? 's' : ''}
                </StatusChip>
              </div>
            </div>

            {isExpanded && (
              <StaggerContainer className={cn(
                viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3' : 'w-full flex flex-col gap-2'
              )}>
                {profileAddons.map((addon) => renderAddon(addon, profile.name))}
              </StaggerContainer>
            )}
          </div>
        )
      })}

      {(() => {
        const unassigned = addons.filter(a => !a.profileId || !profiles.some(p => p.id === a.profileId))
        if (unassigned.length === 0) return null
        const isExpanded = !collapsedProfiles.has('unassigned')

        return (
          <div data-theme-part="panel" data-ctrl="group" className="rounded-2xl border border-border/40 bg-card/50 p-3 space-y-3 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Button
                variant="ghost"
                ripple={false}
                className="h-auto justify-start flex items-center gap-2.5 px-2 py-1 rounded-full group hover:bg-muted/50 transition-[transform,opacity,box-shadow] [&_svg]:!size-3.5"
                onClick={() => onToggleProfile('unassigned')}
                data-ctrl="group-chevron"
                aria-label="Collapse Unassigned"
              >
                <ChevronDown className={cn(
                  'h-3.5 w-3.5 text-foreground/60 transition-transform shrink-0',
                  collapsedProfiles.has('unassigned') && '-rotate-90'
                )} />
                <span data-ctrl="group-name" className="text-sm font-semibold text-foreground/60 group-hover:text-foreground/80 transition-colors flex items-center gap-2">
                  <Package data-ctrl="group-icon" className="h-3.5 w-3.5 shrink-0" />
                  Unassigned
                </span>
              </Button>
              <div className="flex items-center gap-1.5">
                {reorderButton('__unassigned__', unassigned.length)}
                <StatusChip variant="muted">
                  {unassigned.length} addon{unassigned.length !== 1 ? 's' : ''}
                </StatusChip>
              </div>
            </div>

            {isExpanded && (
              <StaggerContainer className={cn(
                viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3' : 'flex flex-col gap-2'
              )}>
                {unassigned.map((addon) => renderAddon(addon))}
              </StaggerContainer>
            )}
          </div>
        )
      })()}
    </div>
  )
}
