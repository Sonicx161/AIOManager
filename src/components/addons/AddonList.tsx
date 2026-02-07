import { checkAddonUpdates, reinstallAddon } from '@/api/addons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useAddons } from '@/hooks/useAddons'
import { decrypt } from '@/lib/crypto'
import { maskEmail, isNewerVersion } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { ArrowLeft, GripVertical, Library, RefreshCw, Save, Plus, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AddonCard } from './AddonCard'
import { AddonReorderDialog } from './AddonReorderDialog'
import { InstallSavedAddonDialog } from './InstallSavedAddonDialog'
import { BulkSaveDialog } from './BulkSaveDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FailoverManager } from '@/components/accounts/FailoverManager'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'

interface AddonListProps {
  accountId: string
}

export function AddonList({ accountId }: AddonListProps) {
  const navigate = useNavigate()
  const { accounts } = useAccounts()
  const account = accounts.find((acc) => acc.id === accountId)
  const { addons, removeAddonByIndex, loading } = useAddons(accountId)
  const openAddAddonDialog = useUIStore((state) => state.openAddAddonDialog)
  const { checkRules, pullServerState } = useFailoverStore()
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const syncAccount = useAccountStore((state) => state.syncAccount)

  const [reorderDialogOpen, setReorderDialogOpen] = useState(false)
  const [installFromLibraryOpen, setInstallFromLibraryOpen] = useState(false)

  const [bulkSaveOpen, setBulkSaveOpen] = useState(false)

  // Selection Mode State
  const [selectedAddonUrls, setSelectedAddonUrls] = useState<Set<string>>(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)

  const toggleAddonSelection = (addonUrl: string) => {
    setSelectedAddonUrls((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(addonUrl)) {
        newSet.delete(addonUrl)
      } else {
        newSet.add(addonUrl)
      }
      return newSet
    })
  }

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode)
    if (isSelectionMode) {
      setSelectedAddonUrls(new Set())
    }
  }

  // Auto-sync on mount to reflect server-side Autopilot swaps
  useEffect(() => {
    if (accountId && encryptionKey) {
      syncAccount(accountId, false).then(() => {
        pullServerState()
      })
    }
  }, [accountId, syncAccount, pullServerState, encryptionKey])

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [protectedInSelection, setProtectedInSelection] = useState(0)

  const handleBulkDeleteClick = () => {
    if (selectedAddonUrls.size === 0) return

    // Count how many protected addons are selected
    const protectedCount = addons.filter((addon, index) => {
      const compositeId = `${addon.transportUrl}::${index}`
      return selectedAddonUrls.has(compositeId) && addon.flags?.protected
    }).length

    setProtectedInSelection(protectedCount)
    setShowDeleteConfirm(true)
  }

  const handleBulkDeleteConfirm = async () => {
    if (selectedAddonUrls.size === 0 || !account) return

    try {
      setUpdatingAll(true)

      // Filter current addons based on selected composite IDs (url::index)
      const updatedAddons = addons.filter((_, index) => {
        const compositeId = `${addons[index].transportUrl}::${index}`
        return !selectedAddonUrls.has(compositeId)
      })

      // Push the entire updated list to preserve order
      await useAccountStore.getState().reorderAddons(accountId, updatedAddons)

      toast({ title: 'Addons Deleted', description: `Successfully deleted selected addons.` })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
      setShowDeleteConfirm(false)
      await syncAccount(accountId)
    } catch (e) {
      toast({ variant: 'destructive', title: 'Delete Failed', description: 'Could not delete selected addons.' })
    } finally {
      setUpdatingAll(false)
    }
  }

  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean>>({})
  const latestVersions = useAddonStore((state) => state.latestVersions)
  const updateLatestVersions = useAccountStore((state) => state.updateLatestVersions)
  const [updatingAll, setUpdatingAll] = useState(false)
  const { toast } = useToast()

  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)

  const updatesAvailable = addons.filter((addon) => {
    const latest = latestVersions[addon.manifest.id]
    return latest && isNewerVersion(addon.manifest.version, latest)
  })

  const handleCheckUpdates = useCallback(async () => {
    if (!account || !encryptionKey) return

    setCheckingUpdates(true)
    try {
      // First sync account to get the latest addons from the server
      await syncAccount(accountId)

      // Sync with server-side autopilot state and local health
      await pullServerState()
      await checkRules()

      const updateInfoList = await checkAddonUpdates(addons, accountId)
      const versions: Record<string, string> = {}
      const health: Record<string, boolean> = {}

      updateInfoList.forEach((info) => {
        versions[info.addonId] = info.latestVersion
        health[info.addonId] = info.isOnline
      })
      updateLatestVersions(versions)
      setHealthStatus(prev => ({ ...prev, ...health }))

      const updatesCount = updateInfoList.filter((info) => info.hasUpdate).length
      const offlineCount = updateInfoList.filter((info) => !info.isOnline).length

      let description = ''
      if (updatesCount > 0) {
        description = `${updatesCount} addon${updatesCount !== 1 ? 's have' : ' has'} updates available`
      } else {
        description = 'All addons are up to date'
      }
      if (offlineCount > 0) {
        description += `. ${offlineCount} addon${offlineCount !== 1 ? 's are' : ' is'} offline`
      }

      toast({
        title: 'Refresh Complete',
        description,
      })
    } catch (error) {
      toast({
        title: 'Refresh Failed',
        description: 'Failed to refresh addons',
        variant: 'destructive',
      })
    } finally {
      setCheckingUpdates(false)
    }
  }, [account, encryptionKey, addons, toast, updateLatestVersions, syncAccount, accountId, checkRules])

  const handleUpdateAddon = useCallback(
    async (_accountId: string, transportUrl: string) => {
      if (!account || !encryptionKey) return

      const authKey = await decrypt(account.authKey, encryptionKey)
      await reinstallAddon(authKey, transportUrl, accountId)

      // Sync account to refresh addon list
      await syncAccount(accountId)
    },
    [account, encryptionKey, accountId, syncAccount]
  )

  const handleProtectAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    try {
      await useAccountStore.getState().bulkProtectAddons(accountId, true)

      toast({
        title: 'Addons Protected',
        description: 'All addons have been marked as protected.'
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to Protect Addons',
        description: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }, [account, encryptionKey, accountId, toast])

  const handleUpdateAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    const addonsToUpdate = updatesAvailable.map((addon) => ({ id: addon.manifest.id, url: addon.transportUrl }))
    if (addonsToUpdate.length === 0) return

    setUpdatingAll(true)
    try {
      const authKey = await decrypt(account.authKey, encryptionKey)

      let successCount = 0
      for (const item of addonsToUpdate) {
        try {
          await reinstallAddon(authKey, item.url, accountId)
          successCount++
        } catch (error) {
          console.warn(`Failed to update addon ${item.id}:`, error)
        }
      }

      // Sync account to refresh addon list
      await syncAccount(accountId)

      toast({
        title: 'Updates Complete',
        description: `Successfully updated ${successCount} of ${addonsToUpdate.length} addons`,
      })
    } catch (error) {
      toast({
        title: 'Update Failed',
        description: 'Failed to update addons',
        variant: 'destructive',
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, encryptionKey, updatesAvailable, accountId, syncAccount, toast])

  if (!account) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Account not found</p>
        <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="mt-4">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  const isNameCustomized = account.name !== account.email && account.name !== 'Stremio Account'
  const displayName =
    isPrivacyModeEnabled && !isNameCustomized
      ? account.name.includes('@')
        ? maskEmail(account.name)
        : '********'
      : account.name

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="h-8 w-8 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-xl md:text-2xl font-bold truncate">{displayName}</h2>
            <p className="text-xs md:text-sm text-muted-foreground">
              {addons.length} addon{addons.length !== 1 ? 's' : ''} installed
              {updatesAvailable.length > 0 && (
                <span className="ml-2 text-blue-600 dark:text-blue-400">
                  ({updatesAvailable.length} update{updatesAvailable.length !== 1 ? 's' : ''}{' '}
                  available)
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="addons" className="space-y-4">
        <TabsList>
          <TabsTrigger value="addons">Installed Addons</TabsTrigger>
          <TabsTrigger value="failover">Failover Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="addons" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-wrap gap-2 w-full sm:w-auto ml-auto">
              {/* 1. Refresh */}
              <Button
                onClick={handleCheckUpdates}
                disabled={addons.length === 0 || checkingUpdates}
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
              >
                <RefreshCw className={`h-4 w-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
                <span className="hidden xs:inline">
                  {checkingUpdates ? 'Refreshing...' : 'Refresh'}
                </span>
                <span className="inline xs:hidden">{checkingUpdates ? '...' : 'Refresh'}</span>
              </Button>

              {/* 2. Select / Bulk Actions (Moved here for better flow) */}
              <Button
                variant={isSelectionMode ? "secondary" : "outline"}
                size="sm"
                onClick={toggleSelectionMode}
                className="flex-1 sm:flex-none"
              >
                {isSelectionMode ? "Cancel" : "Select"}
              </Button>

              {isSelectionMode && selectedAddonUrls.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDeleteClick}
                  disabled={updatingAll}
                  className="flex-1 sm:flex-none"
                >
                  Delete ({selectedAddonUrls.size})
                </Button>
              )}

              {/* 3. Updates Available (Conditional) */}
              {updatesAvailable.length > 0 && (
                <Button
                  onClick={handleUpdateAll}
                  disabled={updatingAll}
                  size="sm"
                  variant="default"
                  className="flex-1 sm:flex-none"
                >
                  <RefreshCw className={`h-4 w-4 ${updatingAll ? 'animate-spin' : ''}`} />
                  <span className="hidden xs:inline">
                    {updatingAll ? 'Updating...' : `Update all (${updatesAvailable.length})`}
                  </span>
                  <span className="inline xs:hidden">
                    {updatingAll ? '...' : `Update (${updatesAvailable.length})`}
                  </span>
                </Button>
              )}

              {/* 4. Reorder */}
              <Button
                onClick={() => setReorderDialogOpen(true)}
                disabled={addons.length === 0}
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
              >
                <GripVertical className="h-4 w-4" />
                <span className="hidden xs:inline">Reorder</span>
                <span className="inline xs:hidden">Reorder</span>
              </Button>

              {/* 5. Protect */}
              <Button
                onClick={handleProtectAll}
                disabled={addons.length === 0}
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
                title="Protect all addons from updates/changes"
              >
                <ShieldCheck className="h-4 w-4" />
                <span className="hidden xs:inline">Protect Addons</span>
                <span className="inline xs:hidden">Protect</span>
              </Button>

              {/* 6. Save All */}
              <Button
                onClick={() => setBulkSaveOpen(true)}
                disabled={addons.length === 0}
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
              >
                <Save className="h-4 w-4" />
                <span className="hidden xs:inline">Save All</span>
                <span className="inline xs:hidden">Save All</span>
              </Button>

              {/* 7. Saved Addons */}
              <Button
                onClick={() => setInstallFromLibraryOpen(true)}
                size="sm"
                variant="outline"
                className="flex-1 sm:flex-none"
              >
                <Library className="h-4 w-4" />
                <span className="hidden xs:inline">Saved Addons</span>
                <span className="inline xs:hidden">Saved</span>
              </Button>

              {/* 8. Install */}
              <Button
                onClick={() => openAddAddonDialog(accountId)}
                size="sm"
                className="flex-1 sm:flex-none"
              >
                <Plus className="h-4 w-4" />
                <span className="hidden xs:inline">Install</span>
                <span className="inline xs:hidden">Install</span>
              </Button>
            </div>
          </div>

          {addons.length === 0 ? (
            <div className="text-center py-12 border border-dashed rounded-lg">
              <p className="text-muted-foreground mb-4">No addons installed</p>
              <Button onClick={() => openAddAddonDialog(accountId)}>Install Your First Addon</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {addons.map((addon, index) => (
                <AddonCard
                  key={`${addon.transportUrl}-${index}`}
                  index={index}
                  addon={addon}
                  accountId={accountId}
                  accountAuthKey={account?.authKey || ''}
                  // For now, removing one instance removes all duplicates (limitation of Stremio API)
                  onRemove={async () => {
                    await removeAddonByIndex(accountId, index)
                  }}
                  onUpdate={handleUpdateAddon}
                  latestVersion={latestVersions[addon.manifest.id]}
                  isOnline={healthStatus[addon.manifest.id]}
                  loading={loading}
                  isSelectionMode={isSelectionMode}
                  onToggleSelect={toggleAddonSelection}
                  // Use composite ID for selection tracking
                  selectionId={`${addon.transportUrl}::${index}`}
                  isSelected={selectedAddonUrls.has(`${addon.transportUrl}::${index}`)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="failover">
          <FailoverManager accountId={accountId} />
        </TabsContent>
      </Tabs>

      <AddonReorderDialog
        accountId={accountId}
        addons={addons}
        open={reorderDialogOpen}
        onOpenChange={setReorderDialogOpen}
      />

      {
        account && (
          <InstallSavedAddonDialog
            accountId={accountId}
            accountAuthKey={account.authKey}
            open={installFromLibraryOpen}
            onOpenChange={setInstallFromLibraryOpen}
            installedAddons={addons}
          />
        )
      }

      <BulkSaveDialog
        open={bulkSaveOpen}
        onOpenChange={setBulkSaveOpen}
        addons={addons}
        accountId={accountId}
      />

      <ConfirmationDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={`Delete ${selectedAddonUrls.size} Addons?`}
        description={
          <>
            Are you sure you want to delete {selectedAddonUrls.size} selected addons? This action cannot be undone.
            {protectedInSelection > 0 && (
              <p className="mt-2 p-2 bg-destructive/10 text-destructive text-xs rounded border border-destructive/20 font-medium">
                Note: This includes {protectedInSelection} protected addon{protectedInSelection !== 1 ? 's' : ''}.
              </p>
            )}
          </>
        }
        confirmText="Delete Addons"
        isDestructive={true}
        onConfirm={handleBulkDeleteConfirm}
        isLoading={updatingAll}
        disabled={updatingAll}
      />
    </div >
  )
}
