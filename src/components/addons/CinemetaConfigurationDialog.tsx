import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { useAccountStore, persistAccounts } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { mergeRemoteIntoHub } from '@/store/account/accountSync'
import { pushHubToStremio, updateActiveProfile } from '@/store/addon/addonDeployment'
import { addTombstones, restoreAddonDeletions } from '@/lib/addon-tombstones'
import { queueAddonActionDeletes, addonDeleteAcks } from '@/store/account/addonActions'
import { captureSyncOwnership } from '@/store/sync-store-helpers'
import { normalizeAddonUrl } from '@/lib/utils'
import { decrypt } from '@/lib/crypto'
import { stremioClient } from '@/api/stremio-client'
import { AddonDescriptor } from '@/types/addon'
import { CinemetaManifest, CinemetaConfigState, CinemetaPatchStatus } from '@/types/cinemeta'
import {
  detectAllPatches,
  applyCinemetaConfiguration,
  fetchOriginalCinemetaManifest,
  isCinemetaAddon,
} from '@/lib/cinemeta-utils'
import { AlertTriangle } from 'lucide-react'

interface CinemetaConfigurationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  addon: AddonDescriptor
  accountId: string
  accountAuthKey: string
  onSuccess?: () => void
}

export function CinemetaConfigurationDialog({
  open,
  onOpenChange,
  addon,
  accountId,
  accountAuthKey,
  onSuccess,
}: CinemetaConfigurationDialogProps) {
  const [config, setConfig] = useState<CinemetaConfigState>({
    removeSearchArtifacts: false,
    removeStandardCatalogs: false,
    removeMetaResource: false,
  })
  const [patchStatus, setPatchStatus] = useState<CinemetaPatchStatus | null>(null)
  const [applying, setApplying] = useState(false)
  const [resetting, setResetting] = useState(false)

  const { toast } = useToast()
  const syncAccount = useAccountStore((state) => state.syncAccount)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)

  useEffect(() => {
    if (open && addon) {
      const savedConfig = addon.metadata?.cinemetaConfig
      const manifest = addon.manifest as CinemetaManifest
      const status = detectAllPatches(manifest)
      setPatchStatus(status)

      // Initialize toggles to match saved state first, then current manifest state
      setConfig({
        removeSearchArtifacts: savedConfig ? savedConfig.removeSearchArtifacts : status.searchArtifactsPatched,
        removeStandardCatalogs: savedConfig ? savedConfig.removeStandardCatalogs : status.standardCatalogsPatched,
        removeMetaResource: savedConfig ? savedConfig.removeMetaResource : status.metaResourcePatched,
      })
    }
  }, [open, addon])

  const hasChanges =
    patchStatus &&
    (config.removeSearchArtifacts !== patchStatus.searchArtifactsPatched ||
      config.removeStandardCatalogs !== patchStatus.standardCatalogsPatched ||
      config.removeMetaResource !== patchStatus.metaResourcePatched)

  const hasPatches =
    patchStatus &&
    (patchStatus.searchArtifactsPatched ||
      patchStatus.standardCatalogsPatched ||
      patchStatus.metaResourcePatched)

  const OFFICIAL_CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json'

  const handleApplyConfiguration = async () => {
    if (!encryptionKey) {
      toast({
        title: 'Error',
        description: 'Encryption key not found',
        variant: 'destructive',
      })
      return
    }

    setApplying(true)
    try {
      const authKey = await decrypt(accountAuthKey, encryptionKey)

      const cleanManifest = await fetchOriginalCinemetaManifest(OFFICIAL_CINEMETA_URL)

      const platformRead = await stremioClient.getAddonCollection(authKey, accountId)

      // Serialize the authoritative hub read, fold, mutation, guarded write and commit
      // against every other account operation. syncAccount waits on the same
      // non-reentrant mutex, so it runs only after the release (DC-03).
      const { acquireSyncMutex } = await import('@/store/accountStore')
      const release = await acquireSyncMutex(accountId)
      try {
        const localAccount = useAccountStore.getState().accounts.find(a => a.id === accountId)
        // The hub is the collection's source of truth: platform rows only add, hub flags
        // and policy win regardless of freshness (R3-02, DC-01).
        const hubAddons = localAccount ? mergeRemoteIntoHub(localAccount, platformRead, { keepLocalFlags: true }) : [...platformRead]

        const cinemetaIndex = hubAddons.findIndex((a) =>
          a.manifest.id === addon.manifest.id ||
          isCinemetaAddon(a) ||
          a.transportUrl === addon.transportUrl
        )

        if (cinemetaIndex === -1) {
          throw new Error('Cinemeta addon not found in collection')
        }

        const modifiedManifest = applyCinemetaConfiguration(
          cleanManifest,
          config
        )

        hubAddons[cinemetaIndex] = {
          ...hubAddons[cinemetaIndex],
          manifest: modifiedManifest,
          metadata: {
            ...hubAddons[cinemetaIndex].metadata,
            ...addon.metadata,
            cinemetaConfig: config,
            lastUpdated: Date.now()
          },
        }

        await pushHubToStremio(accountId, authKey, hubAddons)

        // Commit the hub state the push just published against the current account
        // state, so concurrent changes survive and the active profile stays consistent.
        useAccountStore.setState(prev => {
          const current = prev.accounts.find(a => a.id === accountId)
          if (!current) return {}
          const updatedAccount = updateActiveProfile({ ...current, addons: hubAddons }, hubAddons)
          return { accounts: prev.accounts.map(a => a.id !== accountId ? a : updatedAccount) }
        })
        persistAccounts(useAccountStore.getState().accounts)
      } finally {
        release()
      }

      await syncAccount(accountId)

      toast({
        title: 'Configuration Applied',
        description: 'Cinemeta has been configured successfully',
      })

      onSuccess?.()
      onOpenChange(false)
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to apply configuration:', error)
      toast({
        title: 'Configuration Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setApplying(false)
    }
  }

  const handleReset = async () => {
    if (!encryptionKey) {
      toast({
        title: 'Error',
        description: 'Encryption key not found',
        variant: 'destructive',
      })
      return
    }

    setResetting(true)
    try {
      const originalManifest = await fetchOriginalCinemetaManifest(OFFICIAL_CINEMETA_URL)

      const authKey = await decrypt(accountAuthKey, encryptionKey)
      const platformRead = await stremioClient.getAddonCollection(authKey, accountId)

      // Same serialization as Apply: read, fold, mutate, guarded write and commit all
      // run under the account mutex; syncAccount follows only after the release (DC-03).
      const { acquireSyncMutex } = await import('@/store/accountStore')
      const release = await acquireSyncMutex(accountId)
      try {
        const localAccount = useAccountStore.getState().accounts.find(a => a.id === accountId)
        // The hub is the collection's source of truth: platform rows only add, hub flags
        // and policy win regardless of freshness (R3-02, DC-01).
        const hubAddons = localAccount ? mergeRemoteIntoHub(localAccount, platformRead, { keepLocalFlags: true }) : [...platformRead]

        // Use more robust matching: look for CINEMETA explicitly by typical IDs or transport URL
        const cinemetaIndex = hubAddons.findIndex((a) =>
          a.manifest.id === 'stremio-cinemeta' ||
          a.manifest.id === addon.manifest.id ||
          a.transportUrl.includes('v3-cinemeta.strem.io') ||
          a.transportUrl === addon.transportUrl
        )

        if (cinemetaIndex === -1) {
          throw new Error('Cinemeta addon not found in your Stremio collection. Try refreshing accounts first.')
        }

        const previousUrl = hubAddons[cinemetaIndex].transportUrl
        hubAddons[cinemetaIndex] = {
          ...hubAddons[cinemetaIndex],
          manifest: originalManifest,
          transportUrl: OFFICIAL_CINEMETA_URL, // Reset URL to official if it was modified
          metadata: {
            ...hubAddons[cinemetaIndex].metadata,
            cinemetaConfig: undefined,
            lastUpdated: Date.now() // Force local change preference
          }
        }
        // A changed URL is an explicit local replacement: exactly the retired normalized
        // URL may be tombstoned. An unchanged URL, or one still installed on another row,
        // is never retired (DC-04).
        const retiredUrl = normalizeAddonUrl(previousUrl)
        const retireUrl = retiredUrl && retiredUrl !== normalizeAddonUrl(OFFICIAL_CINEMETA_URL) &&
          !hubAddons.some((row, i) => i !== cinemetaIndex && normalizeAddonUrl(row.transportUrl) === retiredUrl)
          ? retiredUrl : null

        await pushHubToStremio(accountId, authKey, hubAddons)

        // After the confirmed write, commit against the current account state: the
        // explicit Reset acknowledges any observed deletion of the official URL, and the
        // retired URL gets a synced tombstone so a stale read or an older cloud copy
        // cannot bring it back (DC-04).
        useAccountStore.setState(prev => {
          const current = prev.accounts.find(a => a.id === accountId)
          if (!current) return {}
          const acknowledged = restoreAddonDeletions(current.deletedAddons, current.restoredAddons, [{ transportUrl: OFFICIAL_CINEMETA_URL }])
          const deletedAddons = retireUrl
            ? addTombstones(acknowledged.deletedAddons, [retireUrl], Date.now(), acknowledged.restoredAddons)
            : acknowledged.deletedAddons
          const updatedAccount = updateActiveProfile(
            { ...current, addons: hubAddons, deletedAddons, restoredAddons: acknowledged.restoredAddons },
            hubAddons
          )
          return { accounts: prev.accounts.map(a => a.id !== accountId ? a : updatedAccount) }
        })
        persistAccounts(useAccountStore.getState().accounts)
        if (retireUrl) {
          const tombstones = useAccountStore.getState().accounts.find(a => a.id === accountId)?.deletedAddons
          queueAddonActionDeletes(accountId, addonDeleteAcks(tombstones, [retireUrl]), captureSyncOwnership())
        }
      } finally {
        release()
      }

      await syncAccount(accountId)

      const status = detectAllPatches(originalManifest)
      setPatchStatus(status)

      setConfig({
        removeSearchArtifacts: false,
        removeStandardCatalogs: false,
        removeMetaResource: false,
      })

      toast({
        title: 'Cinemeta Reset',
        description: 'Original configuration restored',
      })

      onOpenChange(false)
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to reset configuration:', error)
      toast({
        title: 'Reset Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setResetting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure Cinemeta</DialogTitle>
          <DialogDescription>
            Customize your Cinemeta addon by removing unwanted features
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Label htmlFor="removeSearchArtifacts" className="cursor-pointer">
                    Remove Search Artifacts
                  </Label>
                  {patchStatus?.searchArtifactsPatched && (
                    <span data-theme-part="badge" className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                      Patched
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Removes search catalogs and search functionality from top catalogs
                </p>
              </div>
              <Switch
                id="removeSearchArtifacts"
                checked={config.removeSearchArtifacts}
                onCheckedChange={(checked) =>
                  setConfig({ ...config, removeSearchArtifacts: checked })
                }
                disabled={applying || resetting}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Label htmlFor="removeStandardCatalogs" className="cursor-pointer">
                    Remove Standard Catalogs
                  </Label>
                  {patchStatus?.standardCatalogsPatched && (
                    <span data-theme-part="badge" className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                      Patched
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Removes Popular, New, and Featured catalogs (if search is also removed, all
                  catalogs will be removed)
                </p>
              </div>
              <Switch
                id="removeStandardCatalogs"
                checked={config.removeStandardCatalogs}
                onCheckedChange={(checked) =>
                  setConfig({ ...config, removeStandardCatalogs: checked })
                }
                disabled={applying || resetting}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Label htmlFor="removeMetaResource" className="cursor-pointer">
                    Remove Metadata Resource
                  </Label>
                  {patchStatus?.metaResourcePatched && (
                    <span data-theme-part="badge" className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                      Patched
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Removes the meta resource from Cinemeta
                </p>
              </div>
              <Switch
                id="removeMetaResource"
                checked={config.removeMetaResource}
                onCheckedChange={(checked) => setConfig({ ...config, removeMetaResource: checked })}
                disabled={applying || resetting}
              />
            </div>
          </div>

          {config.removeMetaResource && (
            <div data-theme-tone="status" data-theme-part="panel" className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0" />
              <p className="text-sm text-warning">
                Warning: Removing the metadata resource may affect addon functionality
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {hasPatches && (
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={applying || resetting}
              className="sm:mr-auto"
            >
              {resetting ? 'Resetting...' : 'Reset to Original'}
            </Button>
          )}
          <Button
            onClick={handleApplyConfiguration}
            disabled={applying || resetting || !hasChanges}
          >
            {applying ? 'Applying...' : 'Apply Configuration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
