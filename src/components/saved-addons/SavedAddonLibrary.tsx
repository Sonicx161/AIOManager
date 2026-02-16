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
import { SavedAddon } from '@/types/saved-addon'
import { ProfileReorderDialog } from '../profiles/ProfileReorderDialog'
import { Plus, Search, RefreshCw, X, Package, Layers, Trash2, FileDown, Settings, User, GripVertical, Pencil, Upload, UserMinus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SavedAddonCard } from './SavedAddonCard'
import { useProfileStore } from '@/store/profileStore'
import { ProfileDialog } from '../profiles/ProfileDialog'
import { cn, isNewerVersion } from '@/lib/utils'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { BulkEditDialog } from './BulkEditDialog'
import { AccountPickerDialog } from '../accounts/AccountPickerDialog'
import { TagInput } from '@/components/ui/tag-input'

export function SavedAddonLibrary() {

  const {
    library,
    getAllTags,
    initialize,
    loading,
    error,
    checkAllHealth,
    checkingHealth,
    createSavedAddon,
    updateSavedAddonManifest,
  } = useAddonStore()
  const [searchQuery, setSearchQuery] = useState('')
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
  const [updateProgress, setUpdateProgress] = useState({ current: 0, total: 0 })
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

  useEffect(() => {
    initProfiles()
  }, [initProfiles])

  const savedAddons = Object.values(library)
  const allTags = getAllTags()


  const handleRefresh = useCallback(async () => {
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
    setUpdateProgress({ current: 0, total: addonsWithUpdates.length })

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

      setUpdateProgress((prev) => ({ ...prev, current: prev.current + 1 }))
    }

    setUpdatingAll(false)

    toast({
      title: 'Bulk Update Complete',
      description: `Successfully updated ${successCount} addon${successCount !== 1 ? 's' : ''}. ${failCount > 0 ? `Failed: ${failCount}` : ''}`,
    })
  }, [savedAddons, latestVersions, updateSavedAddonManifest, toast])

  useEffect(() => {
    const init = async () => {
      await initialize()
      // Auto-check health on page load
      checkAllHealth()
    }
    init()
  }, [initialize, checkAllHealth])

  // Filter saved addons based on search and tag
  const filteredAddons = useMemo(() => {
    let filtered = savedAddons

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (addon) =>
          addon.name.toLowerCase().includes(query) ||
          addon.tags.some((tag) => tag.toLowerCase().includes(query))
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

    // Sort by lastUsed (most recent first), then by name
    return filtered.sort((a, b) => a.name.localeCompare(b.name))
  }, [savedAddons, searchQuery, selectedTag, selectedProfileId, profiles])

  // Bulk Selection State
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
      const addons = Array.from(selectedIds).map(id => library[id]).filter(Boolean)

      let totalSuccess = 0
      for (const accountId of accountIds) {
        try {
          // We use the account's authKey to perform the installs
          const account = accountStore.accounts.find(a => a.id === accountId)
          if (!account) continue

          for (const addon of addons) {
            await accountStore.installAddonToAccount(accountId, addon.installUrl)
          }
          totalSuccess++
        } catch (err) {
          console.error(`Failed to deploy to account ${accountId}:`, err)
        }
      }

      toast({
        title: 'Deployment Complete',
        description: `Successfully deployed to ${totalSuccess} of ${accountIds.length} accounts.`,
      })

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
      setAddError('Please enter an addon URL')
      return
    }

    setAdding(true)
    setAddError(null)
    try {
      const tags = addTags

      // createSavedAddon will fetch the manifest automatically
      await createSavedAddon(
        addName.trim() || '',
        addUrl.trim(),
        tags,
        selectedProfileId !== 'unassigned' ? selectedProfileId || undefined : undefined
      )

      toast({
        title: 'Saved to Library',
        description: 'Addon has been saved to your library',
      })
      setShowAddDialog(false)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add addon')
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
      <div className="w-full md:w-64 flex-shrink-0 space-y-4">
        <div className="flex items-center justify-between pr-2">
          <h2 className="text-lg font-semibold tracking-tight">Profiles</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowProfileReorderDialog(true)}
              disabled={profiles.length === 0}
              title="Reorder Profiles"
            >
              <GripVertical className="h-4 w-4" />
            </Button>
            <ProfileDialog trigger={
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                title="Create Profile"
              >
                <Plus className="h-4 w-4" />
              </Button>
            } />
          </div>
        </div>

        <ProfileReorderDialog
          open={showProfileReorderDialog}
          onOpenChange={setShowProfileReorderDialog}
        />

        <div className="space-y-1">
          <Button
            variant={selectedProfileId === null ? "secondary" : "ghost"}
            className="w-full justify-start font-normal"
            onClick={() => setSelectedProfileId(null)}
          >
            <Layers className="mr-2 h-4 w-4" />
            All Addons
          </Button>
          <Button
            variant={selectedProfileId === 'unassigned' ? "secondary" : "ghost"}
            className="w-full justify-start font-normal"
            onClick={() => setSelectedProfileId('unassigned')}
          >
            <Package className="mr-2 h-4 w-4 opacity-50" />
            Unassigned
          </Button>
        </div>

        <div className="space-y-1 pt-2 border-t">
          <h3 className="text-xs font-semibold text-muted-foreground px-2 pb-2 uppercase tracking-wider">User Profiles</h3>
          {profiles.map(profile => (
            <div key={profile.id} className="group flex items-center gap-1">
              <Button
                variant={selectedProfileId === profile.id ? "secondary" : "ghost"}
                className={cn(
                  "flex-1 justify-start font-normal truncate",
                  selectedProfileId === profile.id && "bg-secondary"
                )}
                onClick={() => setSelectedProfileId(profile.id)}
              >
                <User className="mr-2 h-4 w-4" />
                <span className="truncate">{profile.name}</span>
              </Button>
              <div className="opacity-0 group-hover:opacity-100 flex items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteProfileId(profile.id)
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
                <ProfileDialog
                  profile={profile}
                  trigger={
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
                      <Settings className="h-3 w-3" />
                    </Button>
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0 space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Saved Addon Library</h1>
            <p className="text-muted-foreground mt-1">
              Manage your curated collection of addons and profiles.
            </p>
            <div className="flex items-center gap-4 mt-2 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span>Online</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span>Offline</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-gray-400" />
                <span>Unchecked</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 w-full pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 w-full">
            <div className="w-full min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight truncate">
                {selectedProfileId === 'unassigned' ? 'Unassigned Addons' :
                  selectedProfileId ? profiles.find(p => p.id === selectedProfileId)?.name || 'Profile' :
                    'All Addons'}
              </h1>
              {selectedProfileId && selectedProfileId !== 'unassigned' && (
                <p className="text-muted-foreground mt-1 text-base break-all whitespace-pre-wrap max-w-full">
                  {profiles.find(p => p.id === selectedProfileId)?.description}
                </p>
              )}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 md:gap-4 mt-4 w-full">
                <div className="flex flex-row items-center gap-4">
                  <p className="text-sm md:text-base text-muted-foreground whitespace-nowrap">
                    {filteredAddons.length} saved addon{filteredAddons.length !== 1 ? 's' : ''}
                  </p>
                  {savedAddons.length > 0 && (
                    <div className="flex items-center gap-3 text-sm border-l pl-4 border-border">
                      {(checkingHealth || checkingUpdates) ? (
                        <span className="text-muted-foreground flex items-center gap-1">
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          {checkingUpdates ? 'Refreshing...' : 'Checking health...'}
                        </span>
                      ) : (
                        <div className="flex items-center gap-4 text-sm px-1">
                          <span className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                            {healthSummary.online} Online
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500" />
                            {healthSummary.offline} Offline
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Main Actions - Inline with Stats */}
                <div className="flex items-center gap-2 mt-2 sm:mt-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={checkingUpdates || checkingHealth || updatingAll || savedAddons.length === 0}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${checkingUpdates || checkingHealth ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                  {updatesCount > 0 && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleUpdateAll}
                      disabled={updatingAll}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      <FileDown className={`h-4 w-4 mr-2 ${updatingAll ? 'animate-spin' : ''}`} />
                      {updatingAll ? `Updating (${updateProgress.current}/${updateProgress.total})` : `Update ${updatesCount} Available`}
                    </Button>
                  )}
                  <Button
                    variant={isSelectionMode ? "secondary" : "outline"}
                    size="sm"
                    onClick={toggleSelectionMode}
                  >
                    {isSelectionMode ? 'Cancel' : 'Select'}
                  </Button>
                  <Button size="sm" onClick={handleOpenAddDialog}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Addon
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Bulk Selection Toolbar */}
          {isSelectionMode && (
            <div className="sticky top-4 z-50 bg-card border rounded-lg p-3 shadow-md flex items-center justify-between animate-in fade-in slide-in-from-top-2 w-full">
              <div className="flex items-center gap-3">
                <span className="font-medium text-sm ml-1">
                  {selectedIds.size} Selected
                </span>
                <Button variant="ghost" size="sm" onClick={handleSelectAll}>
                  {selectedIds.size === filteredAddons.length && filteredAddons.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0 || updatingManifests}
                  onClick={() => setShowUpdateManifestConfirmation(true)}
                  title="Update name/logo/version from source URL"
                  className="hidden md:flex"
                >
                  <FileDown className="h-4 w-4 mr-2" />
                  Update Manifests
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowAccountPicker(true)}
                  className="border-indigo-200 hover:bg-indigo-50 dark:border-indigo-900/30 dark:hover:bg-indigo-900/20"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Deploy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowRemoveAccountPicker(true)}
                  className="border-red-200 hover:bg-red-50 dark:border-red-900/30 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400"
                >
                  <UserMinus className="h-4 w-4 mr-2" />
                  Remove from Accts
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowBulkEditDialog(true)}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={selectedIds.size === 0}
                  onClick={() => setShowBulkDeleteConfirmation(true)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
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
              <p className="text-red-600 dark:text-red-400">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Search and Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, tags, or URL..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-accent rounded-full transition-colors"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        {/* Tag Filter Pills */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={selectedTag === null ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedTag(null)}
            >
              All tags
            </Button>
            {allTags.map((tag) => {
              const count = filteredAddons.filter((addon) => addon.tags.includes(tag)).length
              // Only show tags present in the current profile view
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
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading saved addons...</p>
          </div>
        )}

        {/* Empty State */}
        {!loading && filteredAddons.length === 0 && (
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

        {/* Saved Addon Grid */}
        {!loading && filteredAddons.length > 0 && (
          selectedProfileId !== null ? (
            // specific profile selected - show flat grid
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {filteredAddons.map((addon) => (
                <SavedAddonCard
                  key={addon.id}
                  savedAddon={addon}
                  latestVersion={latestVersions[addon.manifest.id]}
                  onUpdate={updateSavedAddonManifest}
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedIds.has(addon.id)}
                  onToggleSelect={handleToggleSelect}
                />
              ))}
            </div>
          ) : (
            // All Addons - Group by Profile
            <div className="space-y-8">
              {/* Profiles */}
              {profiles.map(profile => {
                const profileAddons = filteredAddons.filter(a => a.profileId === profile.id)
                if (profileAddons.length === 0) return null
                return (
                  <div key={profile.id} className="space-y-4">
                    <h3 className="text-xl font-semibold flex items-center gap-2 border-b pb-2">
                      <div className="flex items-center gap-2 flex-1">
                        <User className="h-5 w-5" />
                        {profile.name}
                        <span className="text-sm font-normal text-muted-foreground ml-2">
                          ({profileAddons.length})
                        </span>
                      </div>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      {profileAddons.map((addon) => (
                        <SavedAddonCard
                          key={addon.id}
                          savedAddon={addon}
                          latestVersion={latestVersions[addon.manifest.id]}
                          onUpdate={handleUpdateSavedAddon}
                          isSelectionMode={isSelectionMode}
                          isSelected={selectedIds.has(addon.id)}
                          onToggleSelect={handleToggleSelect}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}

              {/* Unassigned */}
              {(() => {
                const unassigned = filteredAddons.filter(a => !a.profileId || !profiles.some(p => p.id === a.profileId))
                if (unassigned.length === 0) return null
                return (
                  <div className="space-y-4">
                    <h3 className="text-xl font-semibold flex items-center gap-2 border-b pb-2">
                      <Package className="h-5 w-5" />
                      Unassigned
                      <span className="text-sm font-normal text-muted-foreground ml-2">
                        ({unassigned.length})
                      </span>
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      {unassigned.map((addon) => (
                        <SavedAddonCard
                          key={addon.id}
                          savedAddon={addon}
                          latestVersion={latestVersions[addon.manifest.id]}
                          onUpdate={handleUpdateSavedAddon}
                          isSelectionMode={isSelectionMode}
                          isSelected={selectedIds.has(addon.id)}
                          onToggleSelect={handleToggleSelect}
                        />
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          )
        )}
      </div>

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
              <Label htmlFor="addon-url">Addon URL *</Label>
              <Input
                id="addon-url"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://addon.example.com/manifest.json"
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
              <p className="text-sm text-red-600 dark:text-red-400">{addError}</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button onClick={handleAddAddon} disabled={adding}>
              {adding ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
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
    </div >
  )
}
