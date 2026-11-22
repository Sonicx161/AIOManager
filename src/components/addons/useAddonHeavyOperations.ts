import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useAccountStore } from '@/store/accountStore'
import { mapConcurrent } from '@/lib/concurrency'
import { bulkDeployToAllResult, deployToAllCopy, newDeployToastId, runBulkDeployToAll } from '@/lib/deploy-to-all'
import type { OperationStatus } from '@/components/ui/operation-progress'
import type { AddonDescriptor } from '@/types/addon'

const ADDON_REINSTALL_CONCURRENCY = 4
const BULK_ACCOUNT_CONCURRENCY = 5
const BULK_ADDON_FETCH_CONCURRENCY = 4

const extractTransportUrl = (id: string) => {
  const idx = id.lastIndexOf('::')
  return idx > 0 ? id.substring(0, idx) : id
}

type RefreshProgressState = { status: OperationStatus; current: number; total: number; label: string; detail?: string }

interface AddonHeavyOperationsParams {
  accountId: string
  account: unknown
  addons: AddonDescriptor[]
  updatesAvailable: AddonDescriptor[]
  selectedAddonUrls: Set<string>
  setSearchParams: (next: Record<string, string>, options?: { replace?: boolean }) => void
  setUpdatingAll: (value: boolean) => void
  setRefreshProgress: Dispatch<SetStateAction<RefreshProgressState>>
  setIsSelectionMode: (value: boolean) => void
  setSelectedAddonUrls: (urls: Set<string>) => void
  setIsBulkActionLoading: (value: boolean) => void
  setShowBulkAccountPicker: (value: boolean) => void
}

export function useAddonHeavyOperations({
  accountId,
  account,
  addons,
  updatesAvailable,
  selectedAddonUrls,
  setSearchParams,
  setUpdatingAll,
  setRefreshProgress,
  setIsSelectionMode,
  setSelectedAddonUrls,
  setIsBulkActionLoading,
  setShowBulkAccountPicker,
}: AddonHeavyOperationsParams) {
  const { toast } = useToast()

  const handleCreateRule = useCallback(async () => {
    if (!account || selectedAddonUrls.size < 2) {
      toast({
        variant: 'destructive',
        title: 'Selection too small',
        description: 'Select at least 2 addons to create an autopilot chain.'
      })
      return
    }

    try {
      const urls = Array.from(selectedAddonUrls).map(extractTransportUrl)

      const { useFailoverStore } = await import('@/store/failoverStore')
      const failoverStore = useFailoverStore.getState()

      await failoverStore.addRule(accountId, urls)

      toast({
        title: 'Autopilot Rule Created',
        description: `Created a new rule with ${urls.length} addon${urls.length !== 1 ? 's' : ''}. Switching to configuration...`
      })

      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())

      setSearchParams({ tab: 'failover' }, { replace: true })

    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Rule Creation Failed',
        description: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }, [account, accountId, selectedAddonUrls, toast, setSearchParams, setIsSelectionMode, setSelectedAddonUrls])

  const handleUpdateAll = useCallback(async () => {
    if (!account) return

    const addonsToUpdate = updatesAvailable.map((addon) => ({ id: addon.manifest.id, url: addon.transportUrl }))
    if (addonsToUpdate.length === 0) {
      toast({ title: 'No Updates', description: 'All addons are already up to date.' })
      return
    }

    setUpdatingAll(true)
    setRefreshProgress({ status: 'running', current: 0, total: addonsToUpdate.length, label: 'Updating addons', detail: `Reinstalling ${addonsToUpdate.length} addon${addonsToUpdate.length !== 1 ? 's' : ''}...` })
    try {

      const { successCount } = await useAccountStore.getState().reinstallAddons(
        accountId,
        addonsToUpdate.map(item => item.url),
        ADDON_REINSTALL_CONCURRENCY,
        (current, total) => setRefreshProgress(prev => ({ ...prev, current, total, detail: `${current} of ${total} addons updated` }))
      )

      setRefreshProgress({ status: 'complete', current: addonsToUpdate.length, total: addonsToUpdate.length, label: 'Updates complete', detail: `Successfully updated ${successCount} of ${addonsToUpdate.length}` })
      setTimeout(() => setRefreshProgress({ status: 'idle', current: 0, total: 0, label: '' }), 3000)
      toast({
        title: 'Updates Complete',
        description: `Successfully updated ${successCount} of ${addonsToUpdate.length} addon${addonsToUpdate.length !== 1 ? 's' : ''}`,
      })
    } catch (error) {
      setRefreshProgress({ status: 'error', current: 0, total: addonsToUpdate.length, label: 'Update failed', detail: 'Failed to update addons' })
      setTimeout(() => setRefreshProgress({ status: 'idle', current: 0, total: 0, label: '' }), 5000)
      toast({
        title: 'Update Failed',
        description: 'Failed to update addons',
        variant: 'destructive',
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, updatesAvailable, accountId, toast, setUpdatingAll, setRefreshProgress])

  const handleReinstallSelected = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return

    setUpdatingAll(true)
    try {
      const urls = Array.from(selectedAddonUrls).map(extractTransportUrl)
      const { successCount } = await useAccountStore.getState().reinstallAddons(
        accountId,
        urls,
        ADDON_REINSTALL_CONCURRENCY
      )

      toast({
        title: 'Reinstallation Complete',
        description: `Successfully reinstalled ${successCount} of ${urls.length} addon${urls.length !== 1 ? 's' : ''}.`,
      })

      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Reinstall Failed',
        description: 'Failed to reinstall selected addons.'
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, accountId, selectedAddonUrls, toast, setUpdatingAll, setIsSelectionMode, setSelectedAddonUrls])

  const handleReinstallAll = useCallback(async () => {
    if (!account) return
    setUpdatingAll(true)
    try {
      const urls = addons.map(a => a.transportUrl)
      const { successCount } = await useAccountStore.getState().reinstallAddons(
        accountId,
        urls,
        ADDON_REINSTALL_CONCURRENCY
      )
      toast({
        title: 'Reinstallation Complete',
        description: `Successfully reinstalled ${successCount} of ${urls.length} addon${urls.length !== 1 ? 's' : ''}.`,
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Reinstall Failed',
        description: 'Failed to reinstall addons.'
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, accountId, addons, toast, setUpdatingAll])

  const handleBulkCloneToAccounts = useCallback(async (targetAccountIds: string[]) => {
    if (targetAccountIds.length === 0 || selectedAddonUrls.size === 0) return

    setIsBulkActionLoading(true)
    let successCount = 0
    let failCount = 0

    const selectedAddonsList = addons.filter((_, index) => selectedAddonUrls.has(`${addons[index].transportUrl}::${index}`))
    const selectedAddonUrlsToInstall = selectedAddonsList.map(addon => addon.transportUrl)

    await mapConcurrent(targetAccountIds, BULK_ACCOUNT_CONCURRENCY, async (targetId) => {
      try {
        const result = await useAccountStore.getState().installAddonsToAccount(
          targetId,
          selectedAddonUrlsToInstall,
          BULK_ADDON_FETCH_CONCURRENCY
        )
        successCount += result.successCount
        failCount += result.failCount
      } catch (err) {
        if (import.meta.env.DEV) console.error(`Failed to deploy addons to ${targetId}:`, err)
        failCount += selectedAddonsList.length
      }
    })

    toast({
      title: 'Bulk Clone Complete',
      description: `Successfully processed ${successCount} installation${successCount !== 1 ? 's' : ''}. ${failCount > 0 ? `Failed: ${failCount}` : ''}`,
    })
    setIsBulkActionLoading(false)
    setShowBulkAccountPicker(false)
    setIsSelectionMode(false)
    setSelectedAddonUrls(new Set())
  }, [selectedAddonUrls, addons, toast, setIsBulkActionLoading, setShowBulkAccountPicker, setIsSelectionMode, setSelectedAddonUrls])

  const handleBulkDeployToAll = useCallback(async (targetAccountIds: string[], addonUrls: string[], addonLabel: string) => {
    const copy = deployToAllCopy(addonLabel, targetAccountIds.length)
    const toastId = newDeployToastId()
    toast({ id: toastId, title: copy.runningTitle, description: copy.runningDescription, history: false, duration: 120_000 })
    setIsBulkActionLoading(true)
    try {
      const tally = await runBulkDeployToAll(targetAccountIds, addonUrls, (targetId, urls) =>
        useAccountStore.getState().installAddonsToAccount(targetId, urls, BULK_ADDON_FETCH_CONCURRENCY), BULK_ACCOUNT_CONCURRENCY)
      toast({ id: toastId, ...bulkDeployToAllResult(addonLabel, tally) })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } finally {
      setIsBulkActionLoading(false)
    }
  }, [toast, setIsBulkActionLoading, setIsSelectionMode, setSelectedAddonUrls])

  return {
    handleCreateRule,
    handleUpdateAll,
    handleReinstallSelected,
    handleReinstallAll,
    handleBulkCloneToAccounts,
    handleBulkDeployToAll,
  }
}
