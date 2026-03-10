import { checkSavedAddonUpdates } from '@/api/addons'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { getHealthSummary } from '@/lib/addon-health'
import { useAddonStore } from '@/store/addonStore'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { SavedAddon } from '@/types/saved-addon'
import { ProfileReorderDialog } from '../profiles/ProfileReorderDialog'
import { TagManagerDialog } from './TagManagerDialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Plus, Search, X, Package, Layers, User,
  GripVertical, Pencil, Upload, UserMinus, Grid, List, ChevronDown,
  ArrowLeft, Link2, Wand2,
  Check
} from 'lucide-react'
import { AnimatedTrashIcon, AnimatedRefreshIcon, AnimatedSettingsIcon, AnimatedUpdateIcon } from '../ui/AnimatedIcons'
import { Textarea } from "@/components/ui/textarea"
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { SavedAddonCard } from './SavedAddonCard'
import { SavedAddonListRow } from './SavedAddonListRow'
import { useProfileStore } from '@/store/profileStore'
import { ProfileDialog } from '../profiles/ProfileDialog'
import { cn, isNewerVersion, normalizeAddonUrl } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { BulkEditDialog } from './BulkEditDialog'
import { AccountPickerDialog } from '../accounts/AccountPickerDialog'
import { TagInput } from '@/components/ui/tag-input'
import { BulkUrlReplaceDialog } from './BulkUrlReplaceDialog'

export function SavedAddonLibrary() {

  const {
    library,
    getAllTags,
    initialize,
    loading,
    isUpdatingAddon,
    error,
    checkAllHealth,
    checkingHealth,
    createSavedAddon,
    updateSavedAddonManifest,
    accountStates,
  } = useAddonStore()
  const accounts = useAccountStore(state => state.accounts)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = (val: string) => {
    setSearchQuery(val)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearchQuery(val)
    }, 150)
  }
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showProfileReorderDialog, setShowProfileReorderDialog] = useState(false)

  const [addUrl, setAddUrl] = useState('')
  const [addName, setAddName] = useState('')
  const [addTags, setAddTags] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const latestVersions = useAddonStore((state) => state.latestVersions)
  const updateLatestVersions = useAddonStore((state) => state.updateLatestVersions)
  const { toast } = useToast()

  // Profile Store
  const {
    profiles,
    initialize: initProfiles,
    deleteProfile
  } = useProfileStore()

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null) // null = all, 'unassigned' = no profile
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null)

  const { libraryViewMode: viewMode, setLibraryViewMode: setViewMode } = useUIStore()
  const isMounted = useRef(true)
  useEffect(() => {
    return () => { isMounted.current = false }
  }, [])
  const [collapsedProfiles, setCollapsedProfiles] = useState<Set<string>>(new Set())
  const [showTagManager, setShowTagManager] = useState(false)
  const [showBulkUrlReplaceDialog, setShowBulkUrlReplaceDialog] = useState(false)

  const toggleProfile = (id: string) => {
    setCollapsedProfiles(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    initProfiles()
  }, [initProfiles])

  const savedAddons = Object.values(library)
  const allTags = getAllTags()


  const handleRefresh = useCallback(async () => {
    if (checkingUpdates) return
    if (savedAddons.length === 0) return

    setCheckingUpdates(true)
    try {
      // 1. Check ALL Health
      await useAddonStore.getState().checkAllHealth()

      // 2. Check Updates
      const updateInfoList = await checkSavedAddonUpdates(savedAddons)
      const versions: Record<string, string> = {}

      // Update health from update check results (bonus)
      const healthUpdates = updateInfoList.map(info => ({
        id: info.addonId,
        isOnline: info.health.isOnline,
        error: info.health.error
      }))
      useAddonStore.getState().updateHealthStatus(healthUpdates)

      updateInfoList.forEach((info) => {
        const addon = savedAddons.find((a) => a.id === info.addonId)
        if (addon) {
          versions[addon.manifest.id] = info.latestVersion
        }
      })
      updateLatestVersions(versions)

      const updatesCount = updateInfoList.filter((info) => info.hasUpdate).length

      if (updatesCount > 0) {
        toast({
          title: 'Refresh Complete',
          description: `${updatesCount} addon${updatesCount !== 1 ? 's have' : ' has'} updates available.`,
        })
      } else {
        toast({
          title: 'Refresh Complete',
          description: 'All addons are up to date.',
        })
      }
    } catch (err) {
      toast({
        title: 'Refresh Failed',
        description: 'Failed to check for updates',
        variant: 'destructive',
      })
    } finally {
      setCheckingUpdates(false)
    }
  }, [savedAddons, toast, updateLatestVersions])

  const handleUpdateSavedAddon = useCallback(
    async (savedAddonId: string, addonName: string) => {
      try {
        await updateSavedAddonManifest(savedAddonId)
        toast({
          title: 'Addon Updated',
          description: `Successfully updated ${addonName} to the latest version`,
        })
      } catch (err) {
        toast({
          title: 'Update Failed',
          description: err instanceof Error ? err.message : 'Failed to update addon',
          variant: 'destructive',
        })
      }
    },
    [updateSavedAddonManifest, toast]
  )

  const handleUpdateAll = useCallback(async () => {
    const addonsWithUpdates = savedAddons.filter((addon) => {
      const latest = latestVersions[addon.manifest.id]
      return latest && isNewerVersion(addon.manifest.version, latest)
    })

    if (addonsWithUpdates.length === 0) return

    setUpdatingAll(true)

    let successCount = 0
    let failCount = 0

    for (const addon of addonsWithUpdates) {
      try {
        await updateSavedAddonManifest(addon.id)
        successCount++
      } catch (err) {
        console.error(`Failed to update ${addon.name}:`, err)
        failCount++
      }
    }

    setUpdatingAll(false)

    if (isMounted.current) {
      toast({
        title: 'Bulk Update Complete',
        description: `Successfully updated ${successCount} addon${successCount !== 1 ? 's' : ''}. ${failCount > 0 ? `Failed: ${failCount}` : ''}`,
      })
    }
  }, [savedAddons, latestVersions, updateSavedAddonManifest, toast])

  useEffect(() => {
    const init = async () => {
      await initialize()
      // Defer health check to prevent state update during mount warning
      setTimeout(() => checkAllHealth(), 0)
    }
    init()
  }, [initialize, checkAllHealth])

  // Filter saved addons based on search and tag
  const filteredAddons = useMemo(() => {
    let filtered = savedAddons

    // Filter by search query
    if (debouncedSearchQuery) {
      const query = debouncedSearchQuery.toLowerCase()
      filtered = filtered.filter(
        (addon) =>
          addon.name.toLowerCase().includes(query) ||
          addon.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          addon.installUrl.toLowerCase().includes(query)
      )
    }

    // Filter by selected profile
    if (selectedProfileId === 'unassigned') {
      filtered = filtered.filter((addon) => !addon.profileId || !profiles.some(p => p.id === addon.profileId))
    } else if (selectedProfileId) {
      filtered = filtered.filter((addon) => addon.profileId === selectedProfileId)
    }

    // Filter by selected tag
    if (selectedTag) {
      filtered = filtered.filter((addon) => addon.tags.includes(selectedTag))
    }

    // Sort alphabetically by name
    return filtered.sort((a, b) => a.name.localeCompare(b.name))
  }, [savedAddons, debouncedSearchQuery, selectedTag, selectedProfileId, profiles])


  // Selection State
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false)
  const [showBulkDeleteConfirmation, setShowBulkDeleteConfirmation] = useState(false)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [showRemoveAccountPicker, setShowRemoveAccountPicker] = useState(false)
  const [showUpdateManifestConfirmation, setShowUpdateManifestConfirmation] = useState(false)
  const [updatingManifests, setUpdatingManifests] = useState(false)

  // Calculate health summary
  const healthSummary = useMemo(() => {
    return getHealthSummary(savedAddons)
  }, [savedAddons])

  const updatesCount = useMemo(() => {
    return savedAddons.filter(addon => {
      const latest = latestVersions[addon.manifest.id]
      return latest && isNewerVersion(addon.manifest.version, latest)
    }).length
  }, [savedAddons, latestVersions])

  // Compute per-profile addon counts for sidebar display
  const profileAddonCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const addon of savedAddons) {
      if (addon.profileId) {
        counts[addon.profileId] = (counts[addon.profileId] || 0) + 1
      }
    }
    return counts
  }, [savedAddons])

  const unassignedCount = useMemo(() => {
    return savedAddons.filter(a => !a.profileId || !profiles.some(p => p.id === a.profileId)).length
  }, [savedAddons, profiles])



  const syncOverviewData = useMemo(() => {
    const syncingAddons = Object.values(library).filter(a => {
      const matchesSync = a.syncWithInstalled
      if (!matchesSync) return false

      if (selectedProfileId === 'unassigned') {
        return !a.profileId || !profiles.some(p => p.id === a.profileId)
      }
      if (selectedProfileId) {
        return a.profileId === selectedProfileId
      }
      return true
    })

    if (syncingAddons.length === 0) return []

    const results = syncingAddons.map(savedAddon => {
      const deployedAccounts = []
      for (const [accountId, accountState] of Object.entries(accountStates)) {
        const account = accounts.find(a => a.id === accountId)
        if (!account) continue

        const installed = accountState.installedAddons.find(a =>
          normalizeAddonUrl(a.installUrl).toLowerCase() === normalizeAddonUrl(savedAddon.installUrl).toLowerCase()
        )

        if (installed) {
          deployedAccounts.push({
            ...account
          })
        }
      }
      return { addon: savedAddon, deployedAccounts }
    })

    // Filter out addons with zero deployed accounts for the Sync Status view
    return results.filter(item => item.deployedAccounts.length > 0)
  }, [library, accountStates, accounts, selectedProfileId, profiles])

  // New Handlers for Enhancements
  const handleUpdateSelectedManifests = async () => {
    if (selectedIds.size === 0) return

    setUpdatingManifests(true)
    let successCount = 0
    let failCount = 0
    const total = selectedIds.size

    toast({
      title: 'Updating Manifests...',
      description: `Starting update for ${total} addons.`,
    })

    for (const id of selectedIds) {
      try {
        await updateSavedAddonManifest(id)
        successCount++
      } catch (err) {
        console.error(`Failed to update manifest for ${id}:`, err)
        failCount++
      }
    }

    toast({
      title: 'Manifest Update Complete',
      description: `Updated ${successCount} addons. ${failCount > 0 ? `Failed: ${failCount}` : ''}`,
    })

    setIsSelectionMode(false)
    setSelectedIds(new Set())
    setShowUpdateManifestConfirmation(false)
    setUpdatingManifests(false)
  }

  const handleRemoveFromAccounts = async (accountIds: string[]) => {
    if (selectedIds.size === 0 || accountIds.length === 0) return

    try {
      const { useAccountStore } = await import('@/store/accountStore')
      const accountStore = useAccountStore.getState()
      const addons = Array.from(selectedIds).map(id => library[id]).filter(Boolean)

      let totalSuccess = 0
      for (const accountId of accountIds) {
        const account = accountStore.accounts.find(a => a.id === accountId)
        if (!account) continue

        for (const addon of addons) {
          try {
            await accountStore.removeAddonFromAccount(accountId, addon.installUrl)
          } catch (e) {
            console.error(`Failed to remove ${addon.name} from ${account.name}`, e)
          }
        }
        totalSuccess++
      }

      toast({
        title: 'Removal Complete',
        description: `Removed selected addons from ${totalSuccess} accounts.`,
      })

      setIsSelectionMode(false)
      setSelectedIds(new Set())
      setShowRemoveAccountPicker(false)
    } catch (err) {
      toast({
        title: 'Removal Failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }



  // Selection Handlers
  const toggleSelectionMode = () => {
    setIsSelectionMode((prev) => {
      if (prev) {
        setSelectedIds(new Set()) // Clear selection when exiting
        return false
      }
      return true
    })
  }

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    const allIds = filteredAddons.map(a => a.id)
    if (selectedIds.size === allIds.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(allIds))
    }
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return

    await useAddonStore.getState().bulkDeleteSavedAddons(Array.from(selectedIds))

    toast({
      title: 'Bulk Delete Complete',
      description: `Deleted ${selectedIds.size} saved addons.`,
    })

    setIsSelectionMode(false)
    setSelectedIds(new Set())
    setShowBulkDeleteConfirmation(false)
  }

  const handleBulkEdit = async (data: { tags?: string[]; tagsRemove?: string[]; profileId?: string | null }) => {
    if (selectedIds.size === 0) return

    const updates: Partial<SavedAddon> & { tagsRemove?: string[] } = {}
    if (data.tags) {
      updates.tags = data.tags
    }
    if (data.tagsRemove) {
      updates.tagsRemove = data.tagsRemove
    }
    // Only include profileId if it was explicitly passed (changed)
    if (data.profileId !== undefined) {
      updates.profileId = data.profileId === null ? undefined : data.profileId
    }

    await useAddonStore.getState().bulkUpdateSavedAddons(Array.from(selectedIds), updates)

    toast({
      title: 'Bulk Update Complete',
      description: `Updated ${selectedIds.size} addons.`,
    })

    setIsSelectionMode(false)
    setSelectedIds(new Set())
    setShowBulkEditDialog(false)
  }

  const handleDeployToAccounts = async (accountIds: string[]) => {
    if (selectedIds.size === 0 || accountIds.length === 0) return

    try {
      const { useAccountStore } = await import('@/store/accountStore')
      const accountStore = useAccountStore.getState()

      // Prepare accounts list with authKeys (required for bulkApply)
      const targetAccounts = accountIds.map(id => {
        const account = accountStore.accounts.find(a => a.id === id)
        return account ? { id: account.id, authKey: account.authKey } : null
      }).filter(Boolean) as { id: string, authKey: string }[]

      if (targetAccounts.length === 0) return

      // Use the robust bulk applicator which preserves metadata/customizations
      const result = await useAddonStore.getState().bulkApplySavedAddons(
        Array.from(selectedIds),
        targetAccounts,
        true // allowProtected (deploying explicitly selected addons should override protection usually, or at least attempt to)
      )

      if (result.failed === 0) {
        toast({
          title: 'Deployment Complete',
          description: `Successfully deployed ${selectedIds.size} addons to ${result.success} accounts.`,
        })
      } else {
        toast({
          title: 'Deployment Completed with Errors',
          description: `Succeeded: ${result.success}, Failed: ${result.failed}. Check console for details.`,
          variant: 'destructive',
        })
      }

      setIsSelectionMode(false)
      setSelectedIds(new Set())
      setShowAccountPicker(false)
    } catch (err) {
      toast({
        title: 'Deployment Failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  const handleOpenAddDialog = () => {
    setAddUrl('')
    setAddName('')
    setAddTags([])
    setAddError(null)
    setShowAddDialog(true)
  }

  const handleAddAddon = async () => {
    if (!addUrl.trim()) {
      setAddError('Please enter at least one addon URL')
      return
    }

    setAdding(true)
    setAddError(null)
    try {
      const urls = addUrl.split(/[\n,]/).map(u => u.trim()).filter(Boolean)

      if (urls.length === 0) {
        setAddError('No valid URLs found')
        setAdding(false)
        return
      }

      let successCount = 0
      let lastError = null

      for (const url of urls) {
        try {
          // createSavedAddon will fetch the manifest automatically
          await createSavedAddon(
            urls.length === 1 ? addName.trim() : '', // Only apply custom name if single URL
            url,
            addTags,
            selectedProfileId !== 'unassigned' ? selectedProfileId || undefined : undefined
          )
          successCount++
        } catch (err) {
          console.error(`Failed to add ${url}:`, err)
          lastError = err
        }
      }

      if (successCount > 0) {
        toast({
          title: successCount === 1 ? 'Saved to Library' : 'Batch Addition Complete',
          description: successCount === 1
            ? 'Addon has been saved to your library'
            : `Successfully added ${successCount} addons to your library.`,
        })
        setShowAddDialog(false)
      } else if (lastError) {
        setAddError(lastError instanceof Error ? lastError.message : 'Failed to add addons')
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add addons')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteProfile = async () => {
    if (deleteProfileId) {
      // 1. Delete all addons in this profile
      await useAddonStore.getState().deleteSavedAddonsByProfile(deleteProfileId)

      // 2. Delete the profile itself
      await deleteProfile(deleteProfileId)

      if (selectedProfileId === deleteProfileId) {
        setSelectedProfileId(null)
      }

      setDeleteProfileId(null)
      toast({ title: 'Profile and associated addons deleted' })
    }
  }

  return (
    <div className="flex flex-col md:flex-row gap-6">
      {/* Sidebar - Profiles */}
      <div className="w-full md:w-56 flex-shrink-0">
        <div className="bg-muted/30 border border-border rounded-2xl p-3 space-y-1">
          {/* Header */}
          <div className="flex items-center justify-between px-2 py-1.5 mb-1">
            <span className="text-xs font-bold uppercase tracking-widest text-foreground/40">Profiles</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                onClick={() => setShowProfileReorderDialog(true)}
                disabled={profiles.length === 0}
                title="Reorder Profiles"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </Button>
              <ProfileDialog trigger={
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" title="Create Profile">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              } />
            </div>
          </div>

          <ProfileReorderDialog
            open={showProfileReorderDialog}
            onOpenChange={setShowProfileReorderDialog}
          />

          {/* All Addons */}
          <button
            className={cn(
              "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium transition-colors text-left",
              selectedProfileId === null
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
            onClick={() => setSelectedProfileId(null)}
          >
            <Layers className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate">All Addons</span>
            <span className={cn(
              "text-[10px] font-bold tabular-nums",
              selectedProfileId === null ? "text-primary-foreground/70" : "text-foreground/30"
            )}>{savedAddons.length}</span>
          </button>

          {/* Unassigned */}
          <button
            className={cn(
              "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium transition-colors text-left",
              selectedProfileId === 'unassigned'
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            )}
            onClick={() => setSelectedProfileId('unassigned')}
          >
            <Package className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="flex-1 truncate">Unassigned</span>
            {unassignedCount > 0 && (
              <span className={cn(
                "text-[10px] font-bold tabular-nums",
                selectedProfileId === 'unassigned' ? "text-primary-foreground/70" : "text-foreground/30"
              )}>{unassignedCount}</span>
            )}
          </button>

          {/* Divider */}
          {profiles.length > 0 && (
            <div className="pt-2 mt-1 border-t border-border/50">
              <div
                className={cn(
                  "space-y-0.5 overflow-hidden transition-all",
                  "max-h-[calc(100vh-400px)] overflow-y-auto pr-0.5 custom-scrollbar"
                )}
              >
                {profiles.map(profile => (
                  <div key={profile.id} className="group flex items-center gap-1">
                    <button
                      className={cn(
                        "flex-1 flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm font-medium transition-colors text-left min-w-0",
                        selectedProfileId === profile.id
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      )}
                      onClick={() => setSelectedProfileId(profile.id)}
                    >
                      <User className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate flex-1">{profile.name}</span>
                      {(profileAddonCounts[profile.id] || 0) > 0 && (
                        <span className={cn(
                          "text-[10px] font-bold tabular-nums shrink-0",
                          selectedProfileId === profile.id ? "text-primary-foreground/70" : "text-foreground/30"
                        )}>{profileAddonCounts[profile.id]}</span>
                      )}
                    </button>
                    <div className="opacity-0 group-hover:opacity-100 flex items-center shrink-0 transition-opacity">
                      <ProfileDialog
                        profile={profile}
                        trigger={
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground">
                            <AnimatedSettingsIcon className="h-3 w-3" />
                          </Button>
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); setDeleteProfileId(profile.id) }}
                      >
                        <AnimatedTrashIcon className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col min-w-0 space-y-6 w-full flex-1">
        {/* Header — removed standalone title, shown inline in content area */}

        <div className="flex flex-col gap-4 w-full pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 w-full">
            <div className="w-full min-w-0">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 w-full">
                <div className="flex flex-row items-center gap-4 overflow-hidden">
                  {selectedProfileId ? (
                    <div className="flex items-start gap-3 min-w-0 mt-0.5">
                      <Button variant="ghost" size="icon" onClick={() => setSelectedProfileId(null)} className="h-8 w-8 text-muted-foreground hover:text-foreground shrink-0 -ml-2" title="All Addons">
                        <ArrowLeft className="h-4 w-4" />
                      </Button>
                      <div className="flex flex-col min-w-0">
                        <h1 className="text-2xl md:text-3xl font-bold tracking-tight truncate flex items-center gap-3">
                          <span className="truncate">
                            {selectedProfileId === 'sync-status' ? 'Sync Overview' :
                              selectedProfileId === 'unassigned' ? 'Unassigned Addons' :
                                profiles.find(p => p.id === selectedProfileId)?.name || 'Profile'}
                          </span>
                        </h1>
                        {/* Profile Description */}
                        {(() => {
                          if (selectedProfileId === 'unassigned') return null;
                          const p = profiles.find(p => p.id === selectedProfileId);
                          if (p?.description && p.description.trim() !== '' && p.description.trim() !== p.name.trim()) {
                            return <p className="break-words mt-1.5 max-w-2xl text-muted-foreground/50" style={{ fontSize: '12px', fontFamily: '"DM Sans", sans-serif' }}>{p.description}</p>
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 min-w-0">
                      <h1 className="text-2xl md:text-3xl font-bold tracking-tight truncate">
                        All Addons
                      </h1>
                      <p className="text-sm md:text-base text-muted-foreground whitespace-nowrap hidden sm:block">
                        {filteredAddons.length} saved addon{filteredAddons.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Selection Toolbar */}
          {isSelectionMode && (
            <div className="sticky top-[96px] md:top-[186px] z-40 bg-card border rounded-lg p-3 shadow-md flex flex-col md:flex-row items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 w-full">
              <div className="flex items-center justify-between md:justify-start w-full md:w-auto gap-3">
                <span className="font-medium text-sm ml-1">
                  {selectedIds.size} Selected
                </span>
                <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                  {selectedIds.size === filteredAddons.length && filteredAddons.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center justify-end gap-2 w-full md:w-auto">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0 || updatingManifests}
                  onClick={() => setShowUpdateManifestConfirmation(true)}
                  title="Update name/logo/version from source URL"
                  className="hidden md:flex"
                >
                  <AnimatedUpdateIcon className="h-4 w-4 mr-2" />
                  Update Manifests
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowAccountPicker(true)}
                  className="w-full sm:w-auto border-primary/20 hover:bg-primary/5"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Deploy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowRemoveAccountPicker(true)}
                  className="w-full sm:w-auto border-destructive/30 hover:bg-destructive/10 text-destructive"
                >
                  <UserMinus className="h-4 w-4 mr-2" />
                  Remove from Accts
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowBulkEditDialog(true)}
                  className="w-full sm:w-auto"
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowBulkDeleteConfirmation(true)}
                  className="w-full sm:w-auto"
                >
                  <AnimatedTrashIcon className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <Card className="border-red-500">
            <CardContent className="pt-6">
              <p className="text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="library" className="w-full">
          <TabsList className="flex flex-wrap h-auto bg-transparent p-0 gap-2 justify-start w-full pb-2 mb-4">
            <TabsTrigger
              value="library"
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm relative transition-all"
            >
              Library
            </TabsTrigger>
            {syncOverviewData.length > 0 && (
              <TabsTrigger
                value="sync-status"
                className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm relative transition-all gap-2"
              >
                Syncing
                <span className="ml-2 w-5 h-5 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-black shrink-0 shadow-sm">
                  {syncOverviewData.length}
                </span>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="library" className="space-y-6">
            {isUpdatingAddon && (
              <div className="flex items-center gap-2 text-sm text-primary animate-pulse bg-primary/5 p-2 rounded-md border border-primary/20">
                <AnimatedRefreshIcon className="h-4 w-4" isAnimating={true} />
                Updating addon...
              </div>
            )}
            {!loading && (
              <div className="flex flex-col gap-6 animate-in fade-in duration-500">
                {/* Actions & Stats Row */}
                <div className="bg-card border rounded-xl p-3 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 w-full mb-2">
                  {/* Left: health summary */}
                  <div className="flex items-center gap-4">
                    {savedAddons.length > 0 && (
                      <div className="flex items-center gap-4 text-sm px-1">
                        <span className="flex items-center gap-1.5 focus-ring rounded-md">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_6px_#22c55e]" />
                          <span className="font-bold text-foreground">{healthSummary.online}</span>
                          <span className="text-muted-foreground text-xs">Online</span>
                        </span>
                        <span className="flex items-center gap-1.5 focus-ring rounded-md">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_6px_#ef4444]" />
                          <span className="font-bold text-foreground">{healthSummary.offline}</span>
                          <span className="text-muted-foreground text-xs">Offline</span>
                        </span>
                      </div>
                    )}
                    {(checkingHealth || checkingUpdates) && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5 animate-pulse bg-muted/30 px-2 py-0.5 rounded-full border border-border/50">
                        <AnimatedRefreshIcon className="h-3 w-3" isAnimating={true} />
                        {checkingUpdates ? 'Checking updates...' : 'Checking health...'}
                      </span>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div className="flex flex-wrap items-center justify-end gap-2 w-full md:w-auto">
                    {/* View Toggle */}
                    <div className="flex items-center bg-muted/50 rounded-lg p-0.5 border border-border/50 gap-0.5 mr-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("h-7 w-7 p-0", viewMode === 'grid' ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                        onClick={() => { setViewMode('grid'); setCollapsedProfiles(new Set()) }}
                      >
                        <Grid className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("h-7 w-7 p-0", viewMode === 'list' ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
                        onClick={() => { setViewMode('list'); setCollapsedProfiles(new Set()) }}
                      >
                        <List className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={handleRefresh}
                      disabled={checkingUpdates || checkingHealth || updatingAll || savedAddons.length === 0}
                    >
                      <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={checkingUpdates || checkingHealth} />
                      Refresh
                    </Button>

                    {updatesCount > 0 && (
                      <Button
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={handleUpdateAll}
                        disabled={updatingAll}
                      >
                        <AnimatedUpdateIcon className="h-3.5 w-3.5" isAnimating={updatingAll} />
                        Update {updatesCount}
                      </Button>
                    )}

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={() => setShowBulkUrlReplaceDialog(true)}
                      title="Bulk URL Fragment Replace"
                    >
                      <Wand2 className="h-3.5 w-3.5" />
                      Bulk Replace
                    </Button>

                    <Button
                      variant={isSelectionMode ? "secondary" : "outline"}
                      size="sm"
                      className="h-8 gap-1.5"
                      onClick={toggleSelectionMode}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {isSelectionMode ? 'Cancel' : 'Select'}
                    </Button>

                    <Button
                      size="sm"
                      className="h-8 gap-1.5 shadow-sm"
                      onClick={handleOpenAddDialog}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Addon
                    </Button>
                  </div>
                </div>

                {/* Search and Filters */}
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="relative w-full">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={(() => {
                        if (!selectedProfileId) return 'Search by name, tags, or URL...';
                        if (selectedProfileId === 'unassigned') return 'Search unassigned addons...';
                        const p = profiles.find(p => p.id === selectedProfileId);
                        if (!p) return "Search...";
                        const possessive = p.name.endsWith('s') ? `${p.name}'` : `${p.name}'s`;
                        return `Search ${possessive} addons...`;
                      })()}
                      value={searchQuery}
                      onChange={(e) => handleSearchChange(e.target.value)}
                      className="pl-10 pr-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => handleSearchChange('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-accent rounded-full transition-colors"
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Tag Filter Pills */}
                <div className="flex flex-wrap gap-2 items-center">
                  {allTags.length > 0 && (
                    <>
                      <Button
                        variant={selectedTag === null ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSelectedTag(null)}
                      >
                        All tags
                      </Button>
                      {allTags.map((tag) => {
                        const count = filteredAddons.filter((addon) => addon.tags.includes(tag)).length
                        if (count === 0 && selectedTag !== tag) return null
                        return (
                          <Button
                            key={tag}
                            variant={selectedTag === tag ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
                          >
                            {tag} ({count})
                          </Button>
                        )
                      })}
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-8 gap-1.5 text-muted-foreground hover:text-primary"
                    onClick={() => setShowTagManager(true)}
                  >
                    <AnimatedSettingsIcon className="h-3.5 w-3.5" />
                    Manage Tags
                  </Button>
                </div>
              </div>
            )}

            {/* Empty State */}
            {filteredAddons.length === 0 && (
              <Card>
                <CardContent className="py-12 text-center">
                  {searchQuery || selectedTag || selectedProfileId ? (
                    <div>
                      <p className="text-lg font-medium mb-2">No saved addons found</p>
                      <p className="text-muted-foreground mb-4">Try adjusting your search, filters, or selected profile</p>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setSearchQuery('')
                          setSelectedTag(null)
                          setSelectedProfileId(null)
                        }}
                      >
                        Clear All Filters
                      </Button>
                    </div>
                  ) : (
                    <div>
                      <div className="flex justify-center mb-6">
                        <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center">
                          <Plus className="h-10 w-10 text-muted-foreground" />
                        </div>
                      </div>
                      <p className="text-2xl font-bold tracking-tight mb-2">No saved addons yet</p>
                      <p className="text-muted-foreground max-w-sm mx-auto mb-8 text-balance">
                        Build your persistent library. Configure an addon once and save it here to deploy to any account instantly.
                      </p>
                      <Button size="lg" onClick={handleOpenAddDialog} className="px-8">
                        <Plus className="mr-2 h-4 w-4" />
                        Add Your First Addon
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {filteredAddons.length > 0 && (
              <div className={cn(
                "transition-opacity duration-200",
                isUpdatingAddon ? "opacity-60 pointer-events-none" : "opacity-100"
              )}>
                {selectedProfileId !== null ? (
                  // specific profile selected - show flat flat
                  <div className={cn(
                    "animate-in fade-in slide-in-from-bottom-4 duration-500",
                    viewMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "w-full flex flex-col rounded-md overflow-hidden border border-border/10"
                  )}>
                    {filteredAddons.map((addon) => {
                      const profile = profiles.find(p => p.id === addon.profileId)
                      if (viewMode === 'list') {
                        return (
                          <SavedAddonListRow
                            key={addon.id}
                            savedAddon={addon}
                            latestVersion={latestVersions[addon.manifest.id]}
                            onUpdate={handleUpdateSavedAddon}
                            isSelectionMode={isSelectionMode}
                            isSelected={selectedIds.has(addon.id)}
                            onToggleSelect={handleToggleSelect}
                            onLongPress={(id) => {
                              setIsSelectionMode(true)
                              handleToggleSelect(id)
                            }}
                            profileName={profile?.name}
                          />
                        )
                      }
                      return (
                        <SavedAddonCard
                          key={addon.id}
                          savedAddon={addon}
                          latestVersion={latestVersions[addon.manifest.id]}
                          onUpdate={handleUpdateSavedAddon}
                          isSelectionMode={isSelectionMode}
                          isSelected={selectedIds.has(addon.id)}
                          onToggleSelect={handleToggleSelect}
                          onLongPress={(id) => {
                            setIsSelectionMode(true)
                            handleToggleSelect(id)
                          }}
                          profileName={profile ? profile.name : undefined}
                        />
                      )
                    })}
                  </div>
                ) : (
                  // All Addons - Group by Profile
                  <div className="space-y-8 w-full">
                    {/* Profiles */}
                    {profiles.map(profile => {
                      const profileAddons = filteredAddons.filter(a => a.profileId === profile.id)
                      if (profileAddons.length === 0) return null
                      const isExpanded = !collapsedProfiles.has(profile.id)
                      return (
                        <div key={profile.id} className="space-y-4">
                          <div className="flex items-center gap-3 pt-2 first:pt-0">
                            <button
                              className="flex items-center gap-2 group"
                              onClick={() => toggleProfile(profile.id)}
                            >
                              <ChevronDown className={cn(
                                "h-3.5 w-3.5 text-foreground/30 transition-transform shrink-0",
                                collapsedProfiles.has(profile.id) && "-rotate-90"
                              )} />
                              <span className="text-sm font-semibold text-foreground/60 group-hover:text-foreground/80 transition-colors flex items-center gap-2">
                                <User className="h-3.5 w-3.5 shrink-0" />
                                {profile.name}
                              </span>
                            </button>
                            <span className="text-xs text-foreground/25 font-medium tabular-nums">
                              {profileAddons.length}
                            </span>
                            <div className="flex-1 h-px bg-border/40" />
                          </div>

                          {isExpanded && (
                            <div className={cn(
                              "animate-in fade-in slide-in-from-top-2 duration-300",
                              viewMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "w-full flex flex-col rounded-md overflow-hidden border border-border/10"
                            )}>
                              {profileAddons.map((addon) => {
                                if (viewMode === 'list') {
                                  return (
                                    <SavedAddonListRow
                                      key={addon.id}
                                      savedAddon={addon}
                                      latestVersion={latestVersions[addon.manifest.id]}
                                      onUpdate={handleUpdateSavedAddon}
                                      isSelectionMode={isSelectionMode}
                                      isSelected={selectedIds.has(addon.id)}
                                      onToggleSelect={handleToggleSelect}
                                      onLongPress={(id) => {
                                        setIsSelectionMode(true)
                                        handleToggleSelect(id)
                                      }}
                                      profileName={profile.name}
                                    />
                                  )
                                }
                                return (
                                  <SavedAddonCard
                                    key={addon.id}
                                    savedAddon={addon}
                                    latestVersion={latestVersions[addon.manifest.id]}
                                    onUpdate={handleUpdateSavedAddon}
                                    isSelectionMode={isSelectionMode}
                                    isSelected={selectedIds.has(addon.id)}
                                    onToggleSelect={handleToggleSelect}
                                    onLongPress={(id) => {
                                      setIsSelectionMode(true)
                                      handleToggleSelect(id)
                                    }}
                                    profileName={profile.name}
                                  />
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Unassigned */}
                    {(() => {
                      const unassigned = filteredAddons.filter(a => !a.profileId || !profiles.some(p => p.id === a.profileId))
                      if (unassigned.length === 0) return null
                      const isExpanded = !collapsedProfiles.has('unassigned')
                      return (
                        <div className="space-y-4">
                          <div className="flex items-center gap-3 pt-2 first:pt-0">
                            <button
                              className="flex items-center gap-2 group"
                              onClick={() => toggleProfile('unassigned')}
                            >
                              <ChevronDown className={cn(
                                "h-3.5 w-3.5 text-foreground/30 transition-transform shrink-0",
                                collapsedProfiles.has('unassigned') && "-rotate-90"
                              )} />
                              <span className="text-sm font-semibold text-foreground/60 group-hover:text-foreground/80 transition-colors flex items-center gap-2">
                                <Package className="h-3.5 w-3.5 shrink-0" />
                                Unassigned
                              </span>
                            </button>
                            <span className="text-xs text-foreground/25 font-medium tabular-nums">
                              {unassigned.length}
                            </span>
                            <div className="flex-1 h-px bg-border/40" />
                          </div>

                          {isExpanded && (
                            <div className={cn(
                              "animate-in fade-in slide-in-from-top-2 duration-300",
                              viewMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" : "flex flex-col rounded-md overflow-hidden border border-border"
                            )}>
                              {unassigned.map((addon) => {
                                if (viewMode === 'list') {
                                  return (
                                    <SavedAddonListRow
                                      key={addon.id}
                                      savedAddon={addon}
                                      latestVersion={latestVersions[addon.manifest.id]}
                                      onUpdate={handleUpdateSavedAddon}
                                      isSelectionMode={isSelectionMode}
                                      isSelected={selectedIds.has(addon.id)}
                                      onToggleSelect={handleToggleSelect}
                                      onLongPress={(id) => {
                                        setIsSelectionMode(true)
                                        handleToggleSelect(id)
                                      }}
                                    />
                                  )
                                }
                                return (
                                  <SavedAddonCard
                                    key={addon.id}
                                    savedAddon={addon}
                                    latestVersion={latestVersions[addon.manifest.id]}
                                    onUpdate={handleUpdateSavedAddon}
                                    isSelectionMode={isSelectionMode}
                                    isSelected={selectedIds.has(addon.id)}
                                    onToggleSelect={handleToggleSelect}
                                    onLongPress={(id) => {
                                      setIsSelectionMode(true)
                                      handleToggleSelect(id)
                                    }}
                                  />
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="sync-status" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Sync Dashboard Header */}
            <div className="flex items-center justify-between px-1">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{syncOverviewData.length}</span>
                {' '}library addon{syncOverviewData.length !== 1 ? 's are' : ' is'} actively syncing to installed accounts.
              </p>
            </div>

            <div className="grid gap-4">
              {syncOverviewData.map(({ addon, deployedAccounts }) => (
                <Card key={addon.id} className="overflow-hidden border-primary/10 bg-card/50">
                  <div className="p-4 border-b bg-muted/30 flex items-center gap-4">
                    <div className="h-10 w-10 rounded-lg overflow-hidden border bg-background shrink-0 p-1">
                      <img
                        src={addon.metadata?.customLogo || addon.manifest.logo || "https://placehold.co/40x40?text=?"}
                        className="h-full w-full object-contain"
                        alt=""
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-lg truncate">{addon.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {deployedAccounts.length} Connected {deployedAccounts.length === 1 ? 'Account' : 'Accounts'}
                      </p>
                    </div>
                    <Link2 className="h-5 w-5 text-primary opacity-50" />
                  </div>
                  <CardContent className="p-4">
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Installed On</div>
                      <div className="grid gap-2">
                        {deployedAccounts.map(account => {
                          const isReadyToUpdate = latestVersions[addon.manifest.id] && isNewerVersion(addon.manifest.version, latestVersions[addon.manifest.id])
                          return (
                            <div key={account.id} className="flex items-center justify-between p-2.5 rounded-lg border bg-background/50 text-sm">
                              <div className="flex items-center gap-2 min-w-0">
                                <User className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="font-medium truncate">{account.name || account.email}</span>
                              </div>
                              {isReadyToUpdate ? (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 text-[10px] font-bold border border-amber-500/20 uppercase tracking-tight">
                                  Update Ready
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 text-[10px] font-bold border border-green-500/20 uppercase tracking-tight">
                                  In Sync
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <p className="text-center text-xs text-muted-foreground px-4">
              When you update a library addon's metadata or version, it automatically propagates to every account listed above.
            </p>
          </TabsContent>
        </Tabs>

        {/* Add by URL Dialog */}
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Addon by URL</DialogTitle>
              <DialogDescription>
                Enter an addon URL to add it to your library. It will be added to the currently selected profile.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="addon-url">Addon URL(s) *</Label>
                <Textarea
                  id="addon-url"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="Paste one or more manifest URLs (one per line or comma-separated)"
                  className="min-h-[120px] bg-muted/30 border-border"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="addon-name">Name (optional)</Label>
                <Input
                  id="addon-name"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="Leave blank to use addon's name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="addon-tags">Tags</Label>
                <TagInput
                  value={addTags}
                  onChange={setAddTags}
                  placeholder="Add tags... (e.g. Movies, Series)"
                  suggestions={allTags}
                />
              </div>

              {addError && (
                <p className="text-sm text-destructive">{addError}</p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
              <Button onClick={handleAddAddon} disabled={adding}>
                {adding ? <AnimatedRefreshIcon className="mr-2 h-4 w-4" isAnimating={true} /> : <Plus className="mr-2 h-4 w-4" />}
                Add Addon
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Profile Management Dialogs */}
        <ConfirmationDialog
          open={!!deleteProfileId}
          onOpenChange={(open) => !open && setDeleteProfileId(null)}
          title="Delete Profile?"
          description={
            <>
              This will permanently delete the profile <b>"{profiles.find(p => p.id === deleteProfileId)?.name}"</b> AND <b>{Object.values(library).filter(a => a.profileId === deleteProfileId).length}</b> associated addons. This action cannot be undone.
            </>
          }
          confirmText="Delete Everything"
          isDestructive={true}
          onConfirm={handleDeleteProfile}
        />

        <BulkEditDialog
          open={showBulkEditDialog}
          onOpenChange={setShowBulkEditDialog}
          selectedCount={selectedIds.size}
          availableTags={allTags}
          onSave={handleBulkEdit}
        />

        <BulkUrlReplaceDialog
          open={showBulkUrlReplaceDialog}
          onOpenChange={setShowBulkUrlReplaceDialog}
        />

        <ConfirmationDialog
          open={showBulkDeleteConfirmation}
          onOpenChange={setShowBulkDeleteConfirmation}
          title={`Delete ${selectedIds.size} Saved Addons?`}
          description="This will permanently delete these addons from your library. This action cannot be undone."
          confirmText="Delete"
          isDestructive={true}
          onConfirm={handleBulkDelete}
          isLoading={loading}
        />

        <AccountPickerDialog
          open={showAccountPicker}
          onOpenChange={setShowAccountPicker}
          title={`Deploy ${selectedIds.size} Addon${selectedIds.size !== 1 ? 's' : ''}`}
          description="Select the accounts where you want to install these addons."
          onConfirm={handleDeployToAccounts}
        />

        <AccountPickerDialog
          open={showRemoveAccountPicker}
          onOpenChange={setShowRemoveAccountPicker}
          title="Remove from Accounts"
          description={`Select accounts to REMOVE the ${selectedIds.size} selected addons from.`}
          onConfirm={handleRemoveFromAccounts}
        />

        <ConfirmationDialog
          open={showUpdateManifestConfirmation}
          onOpenChange={setShowUpdateManifestConfirmation}
          title={`Update ${selectedIds.size} Manifests?`}
          description="This will refresh the name, logo, and version of the selected addons from their source URLs. Your custom tags and profile assignments will be preserved."
          confirmText="Update Manifests"
          onConfirm={handleUpdateSelectedManifests}
        />
        <TagManagerDialog isOpen={showTagManager} onClose={() => setShowTagManager(false)} />
      </div>
    </div>
  )
}
