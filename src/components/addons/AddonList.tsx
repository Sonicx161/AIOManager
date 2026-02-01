import { checkAddonUpdates, reinstallAddon } from '@/api/addons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useAddons } from '@/hooks/useAddons'
import { decrypt } from '@/lib/crypto'
import { maskEmail } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { ArrowLeft, GripVertical, Library, RefreshCw, Save, Plus, ShieldCheck } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { updateAddons } from '@/api/addons'
import { AddonCard } from './AddonCard'
import { AddonReorderDialog } from './AddonReorderDialog'
import { InstallSavedAddonDialog } from './InstallSavedAddonDialog'
import { BulkSaveDialog } from './BulkSaveDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FailoverManager } from '@/components/accounts/FailoverManager'

interface AddonListProps {
  accountId: string
}

export function AddonList({ accountId }: AddonListProps) {
  const navigate = useNavigate()
  const { accounts } = useAccounts()
  const { addons, removeAddon, loading } = useAddons(accountId)
  const openAddAddonDialog = useUIStore((state) => state.openAddAddonDialog)
  const checkRules = useFailoverStore((state) => state.checkRules)
  const [reorderDialogOpen, setReorderDialogOpen] = useState(false)
  const [installFromLibraryOpen, setInstallFromLibraryOpen] = useState(false)

  const [bulkSaveOpen, setBulkSaveOpen] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean>>({})
  const latestVersions = useAddonStore((state) => state.latestVersions)
  const updateLatestVersions = useAccountStore((state) => state.updateLatestVersions)
  const [updatingAll, setUpdatingAll] = useState(false)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const syncAccount = useAccountStore((state) => state.syncAccount)
  const { toast } = useToast()

  const account = accounts.find((acc) => acc.id === accountId)
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)

  const updatesAvailable = addons.filter((addon) => {
    const latest = latestVersions[addon.manifest.id]
    return latest && latest !== addon.manifest.version
  })

  const handleCheckUpdates = useCallback(async () => {
    if (!account || !encryptionKey) return

    setCheckingUpdates(true)
    try {
      // First sync account to get the latest addons from the server
      await syncAccount(accountId)

      // Trigger failover check immediately
      await checkRules()

      const updateInfoList = await checkAddonUpdates(addons)
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
      await reinstallAddon(authKey, transportUrl)

      // Sync account to refresh addon list
      await syncAccount(accountId)
    },
    [account, encryptionKey, accountId, syncAccount]
  )

  const handleProtectAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    try {
      const authKey = await decrypt(account.authKey, encryptionKey)
      const protectedAddons = addons.map(addon => ({
        ...addon,
        flags: {
          ...addon.flags,
          protected: true
        }
      }))

      await updateAddons(authKey, protectedAddons)

      toast({
        title: 'Addons Protected',
        description: 'All addons have been marked as protected.'
      })

      // Refresh account to reflect changes
      await syncAccount(accountId)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to Protect Addons',
        description: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }, [account, encryptionKey, addons, toast, syncAccount, accountId])

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
          await reinstallAddon(authKey, item.url)
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
              {updatesAvailable.length > 0 && (
                <Button
                  onClick={handleUpdateAll}
                  disabled={updatingAll}
                  size="sm"
                  className="flex-1 sm:flex-none"
                >
                  <RefreshCw className={`h-4 w-4 ${updatingAll ? 'animate-spin' : ''}`} />
                  <span className="hidden xs:inline">
                    {updatingAll ? 'Updating...' : `Update all addons (${updatesAvailable.length})`}
                  </span>
                  <span className="inline xs:hidden">
                    {updatingAll ? '...' : `Update (${updatesAvailable.length})`}
                  </span>
                </Button>
              )}
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
                <span className="inline xs:hidden">Protect Addons</span>
              </Button>
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
              <Button
                onClick={() => setInstallFromLibraryOpen(true)}
                size="sm"
                variant="outline"
                className="flex-1 sm:flex-none"
              >
                <Library className="h-4 w-4" />
                <span className="hidden xs:inline">Saved Addons</span>
                <span className="inline xs:hidden">Saved Addons</span>
              </Button>
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
              {addons.map((addon) => (
                <AddonCard
                  key={addon.transportUrl}
                  addon={addon}
                  accountId={accountId}
                  accountAuthKey={account?.authKey || ''}
                  onRemove={removeAddon}
                  onUpdate={handleUpdateAddon}
                  latestVersion={latestVersions[addon.manifest.id]}
                  isOnline={healthStatus[addon.manifest.id]}
                  loading={loading}
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

      {account && (
        <InstallSavedAddonDialog
          accountId={accountId}
          accountAuthKey={account.authKey}
          open={installFromLibraryOpen}
          onOpenChange={setInstallFromLibraryOpen}
          installedAddons={addons}
        />
      )}

      <BulkSaveDialog
        open={bulkSaveOpen}
        onOpenChange={setBulkSaveOpen}
        addons={addons}
        accountId={accountId}
      />
    </div>
  )
}
