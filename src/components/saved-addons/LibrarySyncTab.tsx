import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { StatusChip } from '@/components/ui/status-chip'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, getLatestAddonVersion, isNewerVersion, getSyncScopeLabel } from '@/lib/utils'
import type { Account } from '@/types/account'
import type { Profile } from '@/types/profile'
import type { SavedAddon, SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import {
  ArrowUpCircle,
  Check,
  Layers,
  Link2,
  Link2Off,
  Loader2,
  MoreVertical,
  RefreshCw,
  User,
} from 'lucide-react'
import { SavedAddonIcon } from './SavedAddonIcon'
import { StaggerContainer, StaggerItem } from '@/components/ui/stagger'
import { getAccountEmail } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { maskNameLevel } from '@/lib/utils'
import { maskSecretUrl } from '@/lib/mask-secret-url'

type SyncFilter = 'all' | 'outOfSync'

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

export interface SyncDeploymentItem {
  addon: SavedAddon
  deployedAccounts: Account[]
}

interface LibrarySyncTabProps {
  syncOverviewData: SyncDeploymentItem[]
  notSyncingDeployed: SyncDeploymentItem[]
  latestVersions: Record<string, string>
  manifestChangeHints: Record<string, SavedAddonManifestChangeSummary>
  syncFilter: SyncFilter
  onSyncFilterChange: (filter: SyncFilter) => void
  lastCheckedLabel: string | null
  pushingUpdates: boolean
  enablingSyncIds: Set<string>
  disablingSyncIds: Set<string>
  profiles: Profile[]
  onBackToLibrary: () => void
  onPushAllUpdates: () => Promise<void>
  onPushAddonUpdate: (addon: SavedAddon) => Promise<void>
  onDisableSync: (addon: SavedAddon) => Promise<void>
  onEnableSync: (addon: SavedAddon) => Promise<void>
}

export function LibrarySyncTab({
  syncOverviewData,
  notSyncingDeployed,
  latestVersions,
  manifestChangeHints,
  syncFilter,
  onSyncFilterChange,
  lastCheckedLabel,
  pushingUpdates,
  enablingSyncIds,
  disablingSyncIds,
  profiles,
  onBackToLibrary,
  onPushAllUpdates,
  onPushAddonUpdate,
  onDisableSync,
  onEnableSync,
}: LibrarySyncTabProps) {
  const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
  const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
  const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
  const hasUpdate = (addon: SavedAddon) => {
    const latest = getLatestAddonVersion(latestVersions, {
      transportUrl: addon.installUrl,
      manifest: addon.manifest,
    })
    return !!((latest && isNewerVersion(addon.manifest.version, latest)) || manifestChangeHints[addon.id]?.hasManifestShapeChange)
  }

  const needsUpdateCount = syncOverviewData.filter(({ addon }) => hasUpdate(addon)).length
  const currentCount = syncOverviewData.length - needsUpdateCount
  const showFilterPills = needsUpdateCount > 0 && currentCount > 0
  const visibleSyncedAddons = syncOverviewData
    .filter(({ addon }) => {
      if (syncFilter === 'outOfSync') return hasUpdate(addon)
      return true
    })
    .sort((a, b) => {
      const aNeeds = hasUpdate(a.addon)
      const bNeeds = hasUpdate(b.addon)
      if (aNeeds && !bNeeds) return -1
      if (!aNeeds && bNeeds) return 1
      return 0
    })

  return (
    <div className="space-y-4">
      {syncOverviewData.length === 0 && notSyncingDeployed.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-3">
          <div className="relative w-14 h-14 flex items-center justify-center">
            <SquircleOverlay />
            <Link2 className="relative z-10 h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-lg font-semibold">No synced addons</p>
          <p className="text-sm text-muted-foreground max-w-xs">Enable "Keep in sync with installed versions" on any saved addon to start tracking its deployment state here.</p>
          <Button variant="outline" size="sm" onClick={onBackToLibrary}>Back to Library</Button>
        </div>
      )}

      {syncOverviewData.length > 0 && (
        <>
          <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-3 space-y-3 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <p className="text-sm font-semibold">Synced addons</p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip variant="success" icon={<Check />}>
                    <span className="font-semibold text-foreground">{currentCount}</span> current
                  </StatusChip>
                  <StatusChip variant={needsUpdateCount > 0 ? 'warning' : 'muted'} icon={<ArrowUpCircle />}>
                    <span className="font-semibold text-foreground">{needsUpdateCount}</span> needs update
                  </StatusChip>
                  {lastCheckedLabel && (
                    <span className="text-xs text-muted-foreground">
                      Checked {lastCheckedLabel}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {showFilterPills && (
                  <Tabs value={syncFilter} onValueChange={(value) => onSyncFilterChange(value as SyncFilter)}>
                    <TabsList className="h-8 rounded-xl bg-muted/35 p-0.5 shadow-none">
                      <TabsTrigger value="all" animated={false} className="h-7 px-3 text-xs">
                        All
                      </TabsTrigger>
                      <TabsTrigger value="outOfSync" animated={false} className="h-7 px-3 text-xs">
                        Needs Update
                        <span data-theme-part="badge" className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-xs font-bold leading-none text-warning">
                          {needsUpdateCount}
                        </span>
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}

                {needsUpdateCount > 0 && (
                  <Tooltip content="Re-fetches the latest manifest (version + metadata) for every out-of-date synced addon and propagates changes to all accounts where each addon is installed.">
                    <Button
                      size="sm"
                       variant="outline"
                       className="h-7 gap-1.5 px-2.5 text-xs font-medium"
                       disabled={pushingUpdates}
                       onClick={onPushAllUpdates}
                    >
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                      {pushingUpdates ? 'Pushing...' : `Push ${needsUpdateCount} Update${needsUpdateCount !== 1 ? 's' : ''}`}
                    </Button>
                  </Tooltip>
                )}
              </div>
            </div>

            <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleSyncedAddons.map(({ addon, deployedAccounts }) => {
                const isReadyToUpdate = hasUpdate(addon)
                const displayName = addon.metadata?.customName || addon.name
                return (
                  <StaggerItem
                    data-theme-part="panel"
                    key={addon.id}
                    className="rounded-xl border border-border/40 bg-card px-4 py-3 space-y-3 shadow-sm"
                  >
                    <div className="flex items-start gap-3">
                      <SavedAddonIcon
                        name={displayName}
                        addon={addon}
                        className="h-8 w-8"
                        textClassName="text-xs"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm leading-tight truncate">{displayName}</p>
                        <Tooltip content={maskSecretUrl(addon.installUrl)} side="top">
                          <p className="truncate font-mono text-xs text-muted-foreground/80">{hostOf(addon.installUrl)}</p>
                        </Tooltip>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>v{addon.manifest.version}</span>
                          <span>·</span>
                          <span>{deployedAccounts.length} account{deployedAccounts.length !== 1 ? 's' : ''}</span>
                          <span>·</span>
                          <span className={cn(addon.syncAccountIds?.length === 0 ? "text-destructive" : "")}>
                            {getSyncScopeLabel(addon.syncAccountIds)}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isReadyToUpdate ? (
                          <>
                            <StatusChip variant="warning" icon={<ArrowUpCircle />} className="hidden sm:inline-flex">
                              Needs Update
                            </StatusChip>
                            <Button size="sm" className="h-7 px-2.5 text-xs font-semibold gap-1" disabled={pushingUpdates} onClick={() => onPushAddonUpdate(addon)}>
                              <RefreshCw className="h-3 w-3" /> Update
                            </Button>
                          </>
                        ) : (
                          <StatusChip variant="success" icon={<Check />}>
                            In Sync
                          </StatusChip>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 flex items-center justify-center shrink-0 text-muted-foreground hover:text-foreground" disabled={disablingSyncIds.has(addon.id)}>
                            {disablingSyncIds.has(addon.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem className="gap-2" onClick={() => onDisableSync(addon)}>
                            <Link2Off className="h-4 w-4 shrink-0" />
                            Disable sync
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div data-theme-part="panel" className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-muted/30 px-2.5 py-2">
                      {deployedAccounts.map(account => (
                        <div key={account.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                          <span className="w-4 text-center leading-none shrink-0">
                            {account.emoji ? account.emoji : account.avatar ? <img src={account.avatar} alt="" className="h-full w-full rounded-full object-cover" /> : <User className="h-3 w-3 text-muted-foreground mx-auto" />}
                          </span>
                           <span className="truncate font-medium text-foreground/75 flex-1">{maskNameLevel(account.name || getAccountEmail(account) || '', namePrivacy)}</span>
                           <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', isReadyToUpdate ? 'bg-warning' : 'bg-success')} />
                        </div>
                      ))}
                    </div>
                  </StaggerItem>
                )
              })}
            </StaggerContainer>
          </div>

          <p className="text-center text-xs text-muted-foreground/60 px-4 pb-2">
            Updating a library addon's metadata or URL automatically propagates to every account listed above.
          </p>
        </>
      )}

      {notSyncingDeployed.length > 0 && (
        <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/50 p-3 space-y-3 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Not syncing</p>
              <p className="text-xs text-muted-foreground">{notSyncingDeployed.length} deployed addon{notSyncingDeployed.length !== 1 ? 's' : ''} installed without sync enabled. Changes to these will not propagate automatically.</p>
            </div>
            <StatusChip variant="muted" icon={<Link2Off />}>
              Sync Off
            </StatusChip>
          </div>
          <StaggerContainer className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {notSyncingDeployed.map(({ addon, deployedAccounts }) => {
              const displayName = addon.metadata?.customName || addon.name
              const profile = profiles.find(p => p.id === addon.profileId)
              return (
                <StaggerItem data-theme-part="panel" key={addon.id} className="rounded-xl border border-border/40 bg-card px-4 py-3 space-y-3">
                  <div className="flex items-start gap-3">
                    <SavedAddonIcon
                      name={displayName}
                      addon={addon}
                      className="h-8 w-8"
                      textClassName="text-xs"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-sm leading-tight truncate">{displayName}</span>
                        {addon.health && (
                          <Tooltip content={addon.health.isOnline ? 'Online' : (addon.health.error || 'Offline')} side="top">
                            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', addon.health.isOnline ? 'bg-success' : 'bg-destructive')} />
                          </Tooltip>
                        )}
                        {addon.tags.slice(0, 2).map(tag => (
                          <span key={tag} data-theme-part="badge" className="px-1.5 py-0 rounded-full text-xs font-medium bg-muted/60 text-muted-foreground border border-border/40 leading-5">{tag}</span>
                        ))}
                        {addon.tags.length > 2 && (
                          <span data-theme-part="badge" className="px-1.5 py-0 rounded-full text-xs font-medium bg-muted/60 text-muted-foreground border border-border/40 leading-5">+{addon.tags.length - 2}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap mt-0.5">
                        <span>v{addon.manifest.version}</span>
                        <span className="text-muted-foreground/60">·</span>
                        <Tooltip content={maskSecretUrl(addon.installUrl)} side="top">
                          <span className="truncate font-mono">{hostOf(addon.installUrl)}</span>
                        </Tooltip>
                        {profile && (
                          <>
                            <span className="text-muted-foreground/60">·</span>
                            <Layers className="h-3 w-3 shrink-0" />
                            <span className="truncate">{profile.name}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <Button
                      size="sm"
                       variant="outline"
                       className="gap-1 text-xs font-medium shrink-0 h-7 px-2.5"
                       disabled={enablingSyncIds.has(addon.id)}
                       onClick={() => onEnableSync(addon)}
                    >
                      {enablingSyncIds.has(addon.id) ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Enabling...
                        </>
                      ) : (
                        <>
                          <Link2 className="h-3 w-3" />
                          Enable
                        </>
                      )}
                    </Button>
                  </div>
                  <div data-theme-part="panel" className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-muted/30 px-2.5 py-2">
                    {deployedAccounts.map(account => (
                      <div key={account.id} className="flex items-center gap-1.5 text-xs min-w-0">
                        <span className="w-4 text-center leading-none shrink-0">
                          {account.emoji ? account.emoji : account.avatar ? <img src={account.avatar} alt="" className="h-full w-full rounded-full object-cover" /> : <User className="h-3 w-3 text-muted-foreground mx-auto" />}
                        </span>
                         <span className="truncate font-medium text-foreground/75 flex-1">{maskNameLevel(account.name || getAccountEmail(account) || '', namePrivacy)}</span>
                       </div>
                     ))}
                   </div>
                 </StaggerItem>
               )
             })}
           </StaggerContainer>
         </div>
       )}
    </div>
  )
}
