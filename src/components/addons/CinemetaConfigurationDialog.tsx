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
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { decrypt } from '@/lib/crypto'
import { stremioClient } from '@/api/stremio-client'
import { AddonDescriptor } from '@/types/addon'
import { CinemetaManifest, CinemetaConfigState, CinemetaPatchStatus } from '@/types/cinemeta'
import {
  detectAllPatches,
  applyCinemetaConfiguration,
  fetchOriginalCinemetaManifest,
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

  // Detect patches on open
  useEffect(() => {
    if (open && addon) {
      const manifest = addon.manifest as CinemetaManifest
      const status = detectAllPatches(manifest)
      setPatchStatus(status)

      // Initialize toggles to match current state
      setConfig({
        removeSearchArtifacts: status.searchArtifactsPatched,
        removeStandardCatalogs: status.standardCatalogsPatched,
        removeMetaResource: status.metaResourcePatched,
      })
    }
  }, [open, addon])

  // Check if configuration has changed from current state
  const hasChanges =
    patchStatus &&
    (config.removeSearchArtifacts !== patchStatus.searchArtifactsPatched ||
      config.removeStandardCatalogs !== patchStatus.standardCatalogsPatched ||
      config.removeMetaResource !== patchStatus.metaResourcePatched)

  // Check if any patches are currently applied
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
      // 1. Decrypt auth key
      const authKey = await decrypt(accountAuthKey, encryptionKey)

      // 2. Click "Apply", so we fetch the CLEAN manifest first
      const cleanManifest = await fetchOriginalCinemetaManifest(OFFICIAL_CINEMETA_URL)

      // 3. Get current addon collection
      const currentAddons = await stremioClient.getAddonCollection(authKey)

      // 4. Find Cinemeta index (match by ID is safest)
      const cinemetaIndex = currentAddons.findIndex((a) => a.manifest.id === addon.manifest.id)
      if (cinemetaIndex === -1) {
        throw new Error('Cinemeta addon not found in collection')
      }

      // 5. Apply configuration transformations to the CLEAN manifest
      const modifiedManifest = applyCinemetaConfiguration(
        cleanManifest,
        config
      )

      // 6. Update addon in collection (maintain original transport URL if needed, but manifest is updated)
      const updatedAddons = [...currentAddons]
      updatedAddons[cinemetaIndex] = {
        ...currentAddons[cinemetaIndex],
        manifest: modifiedManifest,
      }

      // 7. Sync to Stremio API
      await stremioClient.setAddonCollection(authKey, updatedAddons)

      // 8. Sync account state (refresh local data)
      await syncAccount(accountId)

      toast({
        title: 'Configuration Applied',
        description: 'Cinemeta has been configured successfully',
      })

      onSuccess?.()
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to apply configuration:', error)
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
      // 1. Fetch original manifest from OFFICIAL source
      const originalManifest = await fetchOriginalCinemetaManifest(OFFICIAL_CINEMETA_URL)

      // 2. Update addon collection with original manifest
      const authKey = await decrypt(accountAuthKey, encryptionKey)
      const currentAddons = await stremioClient.getAddonCollection(authKey)
      const cinemetaIndex = currentAddons.findIndex((a) => a.manifest.id === addon.manifest.id)

      if (cinemetaIndex === -1) {
        throw new Error('Cinemeta addon not found in collection')
      }

      const updatedAddons = [...currentAddons]
      updatedAddons[cinemetaIndex] = {
        ...currentAddons[cinemetaIndex],
        manifest: originalManifest,
      }

      await stremioClient.setAddonCollection(authKey, updatedAddons)
      await syncAccount(accountId)

      // 4. Reset toggles
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
      console.error('Failed to reset configuration:', error)
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure Cinemeta</DialogTitle>
          <DialogDescription>
            Customize your Cinemeta addon by removing unwanted features
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Configuration Toggles */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Label htmlFor="removeSearchArtifacts" className="cursor-pointer">
                    Remove Search Artifacts
                  </Label>
                  {patchStatus?.searchArtifactsPatched && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
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
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
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
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
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

          {/* Warning Banner */}
          {config.removeMetaResource && (
            <div className="flex items-center gap-2 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
              <p className="text-sm text-yellow-500">
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
