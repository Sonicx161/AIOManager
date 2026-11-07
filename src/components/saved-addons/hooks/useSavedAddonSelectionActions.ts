import { useCallback, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { useAddonStore } from '@/store/addonStore'
import { getStremioAuthKey } from '@/store/accountStore'
import type { SavedAddon } from '@/types/saved-addon'
import { describeDeployOutcomes, getDeploymentSummary } from '@/lib/deploy-summary'
import { maskAccountLabel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'

interface BulkEditData {
  tags?: string[]
  tagsRemove?: string[]
  profileId?: string | null
  syncWithInstalled?: boolean
}

interface UseSavedAddonSelectionActionsOptions {
  filteredAddons: SavedAddon[]
  library: Record<string, SavedAddon>
}

export function useSavedAddonSelectionActions({
  filteredAddons,
  library,
}: UseSavedAddonSelectionActionsOptions) {
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false)
  const [showBulkDeleteConfirmation, setShowBulkDeleteConfirmation] = useState(false)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [showRemoveAccountPicker, setShowRemoveAccountPicker] = useState(false)


  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setIsSelectionMode(false)
  }, [])

  const closeDeployFlow = useCallback(() => {
    clearSelection()
    setShowAccountPicker(false)
  }, [clearSelection])

  const closeRemoveFlow = useCallback(() => {
    clearSelection()
    setShowRemoveAccountPicker(false)
  }, [clearSelection])

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true)
  }, [])

  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => {
      if (prev) {
        setSelectedIds(new Set())
        return false
      }
      return true
    })
  }, [])

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // Toggles the visible (filtered) set only. Ids selected under a different filter stay
  // selected, so narrowing a filter never silently drops hidden selections.
  const handleSelectAll = useCallback(() => {
    const visibleIds = filteredAddons.map(a => a.id)
    setSelectedIds(prev => {
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id)
      } else {
        for (const id of visibleIds) next.add(id)
      }
      return next
    })
  }, [filteredAddons])



  const handleRemoveFromAccounts = useCallback(async (accountIds: string[]) => {
    if (selectedIds.size === 0 || accountIds.length === 0) {
      closeRemoveFlow()
      return
    }

    try {
      const { useAccountStore } = await import('@/store/accountStore')
      const accountStore = useAccountStore.getState()
      const targetAccounts = accountIds.map(accountId => {
        const account = accountStore.accounts.find(a => a.id === accountId)
        return account ? { id: account.id, authKey: getStremioAuthKey(account) } : null
      }).filter(Boolean) as { id: string, authKey: string }[]

      if (targetAccounts.length === 0) {
        closeRemoveFlow()
        return
      }

      const addonUrls = Array.from(selectedIds)
        .map(id => library[id]?.installUrl)
        .filter(Boolean) as string[]

      if (addonUrls.length === 0) {
        closeRemoveFlow()
        return
      }

      const result = await useAddonStore.getState().bulkRemoveAddons(addonUrls, targetAccounts, false)
      const removalSummary = getDeploymentSummary(result.details)

      if (result.failed === 0) {
        toast({
          title: 'Removal Complete',
          description: `${removalSummary} across ${result.success} account${result.success !== 1 ? 's' : ''}.`,
        })
      } else {
        toast({
          title: 'Removal Completed with Errors',
          description: `${removalSummary}. Succeeded: ${result.success}, failed: ${result.failed}.`,
          variant: 'destructive',
        })
      }

      closeRemoveFlow()
    } catch (err) {
      toast({
        title: 'Removal Failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }, [selectedIds, library, closeRemoveFlow])

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return

    await useAddonStore.getState().bulkDeleteSavedAddons(Array.from(selectedIds))

    toast({
      title: 'Bulk Delete Complete',
      description: `Deleted ${selectedIds.size} saved addon${selectedIds.size !== 1 ? 's' : ''}.`,
    })

    setIsSelectionMode(false)
    setSelectedIds(new Set())
    setShowBulkDeleteConfirmation(false)
  }, [selectedIds])

  const handleBulkEdit = useCallback(async (data: BulkEditData) => {
    if (selectedIds.size === 0) return

    const updates: Partial<SavedAddon> & { tagsRemove?: string[] } = {}
    if (data.tags) {
      updates.tags = data.tags
    }
    if (data.tagsRemove) {
      updates.tagsRemove = data.tagsRemove
    }
    if (data.profileId !== undefined) {
      updates.profileId = data.profileId === null ? undefined : data.profileId
    }
    if (data.syncWithInstalled !== undefined) {
      updates.syncWithInstalled = data.syncWithInstalled
    }

    await useAddonStore.getState().bulkUpdateSavedAddons(Array.from(selectedIds), updates)

    toast({
      title: 'Bulk Update Complete',
      description: `Updated ${selectedIds.size} addon${selectedIds.size !== 1 ? 's' : ''}.`,
    })

    setIsSelectionMode(false)
    setSelectedIds(new Set())
    setShowBulkEditDialog(false)
  }, [selectedIds])

  const handleDeployToAccounts = useCallback(async (accountIds: string[]) => {
    if (selectedIds.size === 0 || accountIds.length === 0) {
      closeDeployFlow()
      return
    }

    try {
      const { useAccountStore } = await import('@/store/accountStore')
      const accountStore = useAccountStore.getState()

      const targetAccounts = accountIds.map(id => {
        const account = accountStore.accounts.find(a => a.id === id)
        return account ? { id: account.id, authKey: getStremioAuthKey(account) } : null
      }).filter(Boolean) as { id: string, authKey: string }[]

      if (targetAccounts.length === 0) {
        closeDeployFlow()
        return
      }

      const result = await useAddonStore.getState().bulkApplySavedAddons(
        Array.from(selectedIds),
        targetAccounts,
        true
      )
      const deploymentSummary = getDeploymentSummary(result.details)
      const ui = useUIStore.getState()
      const accountLabel = (id: string) => maskAccountLabel(accountStore.accounts.find(a => a.id === id), ui.isPrivacyModeEnabled ? ui.privacyLevelNames : 0, ui.isPrivacyModeEnabled ? ui.privacyLevelEmail : 0)
      const outcomeLines = describeDeployOutcomes(result.details, accountLabel)
      const stopped = result.cancelled ? ` Stopped before ${result.cancelled} account${result.cancelled !== 1 ? 's' : ''}.` : ''

      if (result.failed === 0) {
        toast({
          title: 'Deployment Complete',
          description: [`${deploymentSummary} across ${result.success} account${result.success !== 1 ? 's' : ''}.${stopped}`, ...outcomeLines].join(' '),
        })
      } else {
        const firstError = result.errors[0]?.error || ''
        toast({
          title: 'Deployment Completed with Errors',
          description: `${deploymentSummary}. Succeeded: ${result.success}, failed: ${result.failed}.${firstError ? ` Error: ${firstError}` : ''}`,
          variant: 'destructive',
        })
      }

      closeDeployFlow()
    } catch (err) {
      toast({
        title: 'Deployment Failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }, [selectedIds, closeDeployFlow])

  const handleReinstallLibraryEntries = useCallback(async () => {
    if (selectedIds.size === 0) return

    let updated = 0
    let unchanged = 0
    let failed = 0
    let notSyncing = 0
    const versionBumps: string[] = []
    const count = selectedIds.size
    const toastId = toast({
      title: `Reinstalling ${count} entr${count !== 1 ? 'ies' : 'y'}...`,
      description: 'Fetching each manifest from its source URL.',
      duration: Infinity,
      history: false,
    })

    for (const id of selectedIds) {
      const entry = library[id]
      if (!entry) continue
      if (!entry.syncWithInstalled) notSyncing += 1
      try {
        const result = await useAddonStore.getState().updateSavedAddonManifest(id)
        if (result.versionChanged) {
          updated += 1
          versionBumps.push(`${entry.name}: v${result.previousVersion} → v${result.latestVersion}`)
        } else {
          unchanged += 1
        }
      } catch (err) {
        failed += 1
        if (import.meta.env.DEV) console.error(`Reinstall failed for ${entry.name}:`, err)
      }
    }

    const total = updated + unchanged + failed
    if (failed > 0) {
      toast({
        id: toastId,
        title: 'Reinstall Completed with Errors',
        description: `Reinstalled ${total - failed} of ${total} entr${total !== 1 ? 'ies' : 'y'} (${failed} failed).${notSyncing > 0 ? ` ${notSyncing} not syncing.` : ''}`,
        variant: 'destructive',
      })
    } else {
      const bumpText = versionBumps.length > 0 && versionBumps.length <= 3 ? ` ${versionBumps.join(', ')}.` : updated > 0 ? ` ${updated} version update${updated !== 1 ? 's' : ''}.` : ' No version changes.'
      toast({
        id: toastId,
        title: 'Reinstall Complete',
        description: `Reinstalled ${total} entr${total !== 1 ? 'ies' : 'y'}; sync pushed any changes to enabled accounts.${bumpText}${notSyncing > 0 ? ` ${notSyncing} not syncing.` : ''}`,
      })
    }

    clearSelection()
  }, [selectedIds, library, clearSelection])

  return {
    isSelectionMode,
    selectedIds,
    setSelectedIds,
    showBulkEditDialog,
    setShowBulkEditDialog,
    showBulkDeleteConfirmation,
    setShowBulkDeleteConfirmation,
    showAccountPicker,
    setShowAccountPicker,
    showRemoveAccountPicker,
    setShowRemoveAccountPicker,
    clearSelection,
    enterSelectionMode,
    toggleSelectionMode,
    handleToggleSelect,
    handleSelectAll,
    handleRemoveFromAccounts,
    handleBulkDelete,
    handleBulkEdit,
    handleDeployToAccounts,
    handleReinstallLibraryEntries,
  }
}
