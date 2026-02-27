import { checkAddonUpdates } from '@/api/addons'
import { HealthStatus } from '@/lib/addon-health'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useAddons } from '@/hooks/useAddons'
import { maskEmail, isNewerVersion, cn } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { ArrowLeft, GripVertical, Library, Save, Plus, Search, X, Layers, Trash2, ChevronDown, ChevronLeft, ChevronRight, Zap, Check } from 'lucide-react'
import { AnimatedRefreshIcon, AnimatedUpdateIcon, AnimatedShieldIcon } from '../ui/AnimatedIcons'
import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Input } from '@/components/ui/input'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AddonCard } from './AddonCard'
import { AddonReorderDialog } from './AddonReorderDialog'
import { InstallSavedAddonDialog } from './InstallSavedAddonDialog'
import { BulkSaveDialog } from './BulkSaveDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FailoverManager } from '@/components/accounts/FailoverManager'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AddonChangelog } from '@/components/accounts/AddonChangelog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'


interface AddonListProps {
  accountId: string
}

export function AddonList({ accountId }: AddonListProps) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { accounts } = useAccounts()
  const account = accounts.find((acc) => acc.id === accountId)
  const { addons, removeAddonByIndex } = useAddons(accountId)
  const openAddAddonDialog = useUIStore((state) => state.openAddAddonDialog)
  const { checkRules, pullServerState } = useFailoverStore()
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const syncAccount = useAccountStore((state) => state.syncAccount)

  const [reorderDialogOpen, setReorderDialogOpen] = useState(false)
  const [installFromLibraryOpen, setInstallFromLibraryOpen] = useState(false)

  const [bulkSaveOpen, setBulkSaveOpen] = useState(false)

  const activeTab = searchParams.get('tab') || 'addons'

  const handleTabChange = (val: string) => {
    setSearchParams({ tab: val }, { replace: true })
  }

  // Selection Mode State
  const [selectedAddonUrls, setSelectedAddonUrls] = useState<Set<string>>(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

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
  const [healthStatus, setHealthStatus] = useState<Record<string, HealthStatus>>({})
  const latestVersions = useAddonStore((state) => state.latestVersions)
  const updateLatestVersions = useAccountStore((state) => state.updateLatestVersions)
  const [updatingAll, setUpdatingAll] = useState(false)
  const { toast } = useToast()



  // Filter addons based on search query
  const filteredAddons = useMemo(() => {
    if (!searchQuery.trim()) return addons
    const query = searchQuery.toLowerCase()
    return addons.filter((addon) =>
      addon.manifest.name?.toLowerCase().includes(query) ||
      addon.manifest.id?.toLowerCase().includes(query) ||
      addon.manifest.description?.toLowerCase().includes(query)
    )
  }, [addons, searchQuery])

  const selectAllAddons = useCallback(() => {
    // Select visible filtered addons
    const newSelected = new Set<string>()
    filteredAddons.forEach(addon => {
      const originalIndex = addons.indexOf(addon)
      if (originalIndex !== -1) {
        newSelected.add(`${addon.transportUrl}::${originalIndex}`)
      }
    })
    setSelectedAddonUrls(newSelected)
  }, [filteredAddons, addons])

  // Keyboard shortcut: Esc exits selection mode, S to save selected, Ctrl+A to select all
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isSelectionMode) {
        setIsSelectionMode(false)
        setSelectedAddonUrls(new Set())
      }

      // 'S' key for saving selected to library
      if ((e.key === 's' || e.key === 'S') && isSelectionMode && selectedAddonUrls.size > 0 && !bulkSaveOpen) {
        setBulkSaveOpen(true)
      }

      // 'A' key for selecting all (when in selection mode)
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && isSelectionMode) {
        e.preventDefault()
        selectAllAddons()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSelectionMode, selectedAddonUrls, bulkSaveOpen, filteredAddons, selectAllAddons])

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
      const health: Record<string, HealthStatus> = {}

      updateInfoList.forEach((info) => {
        versions[info.addonId] = info.latestVersion
        health[info.addonId] = info.health
      })
      updateLatestVersions(versions)
      setHealthStatus(prev => ({ ...prev, ...health }))

      const updatesCount = updateInfoList.filter((info) => info.hasUpdate).length
      const offlineCount = updateInfoList.filter((info) => !info.health.isOnline).length

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
  }, [account, encryptionKey, addons, toast, updateLatestVersions, syncAccount, accountId, checkRules, pullServerState])

  const handleUpdateAddon = useCallback(
    async (_accountId: string, transportUrl: string) => {
      if (!account) return
      await useAccountStore.getState().reinstallAddon(accountId, transportUrl)
    },
    [account, accountId]
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

  const handleUnprotectAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    try {
      await useAccountStore.getState().bulkProtectAddons(accountId, false)

      toast({
        title: 'Addons Unprotected',
        description: 'All addons have been unprotected.'
      })
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Failed to Unprotect Addons',
        description: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }, [account, encryptionKey, accountId, toast])

  const handleEnableAll = useCallback(async () => {
    if (!account || addons.length === 0) return
    const allUrls = addons.map(a => a.transportUrl)
    try {
      await useAccountStore.getState().bulkToggleAddonEnabled(accountId, allUrls, true)
      toast({ title: 'All Addons Enabled', description: `Enabled ${allUrls.length} addons.` })
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: 'Could not enable addons.' })
    }
  }, [account, addons, accountId, toast])

  const handleDisableAll = useCallback(async () => {
    if (!account || addons.length === 0) return
    const allUrls = addons.map(a => a.transportUrl)
    try {
      await useAccountStore.getState().bulkToggleAddonEnabled(accountId, allUrls, false)
      toast({ title: 'All Addons Disabled', description: `Disabled ${allUrls.length} addons.` })
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: 'Could not disable addons.' })
    }
  }, [account, addons, accountId, toast])

  const handleProtectSelected = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return

    try {
      // Extract transport URLs from composite IDs (url::index)
      const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])
      await useAccountStore.getState().bulkProtectSelectedAddons(accountId, urls, true)

      toast({
        title: 'Selection Protected',
        description: `Marked ${selectedAddonUrls.size} selected addons as protected.`
      })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Protection Failed',
        description: 'Could not protect selected addons.'
      })
    }
  }, [account, accountId, selectedAddonUrls, toast])

  const handleUnprotectSelected = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return

    try {
      const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])
      await useAccountStore.getState().bulkProtectSelectedAddons(accountId, urls, false)

      toast({
        title: 'Selection Unprotected',
        description: `Unprotected ${selectedAddonUrls.size} selected addons.`
      })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Unprotection Failed',
        description: 'Could not unprotect selected addons.'
      })
    }
  }, [account, accountId, selectedAddonUrls, toast])

  const handleBulkEnable = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return
    const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])
    try {
      await useAccountStore.getState().bulkToggleAddonEnabled(accountId, urls, true)
      toast({ title: 'Addons Enabled', description: `Enabled ${urls.length} addons.` })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: 'Could not enable addons.' })
    }
  }, [account, accountId, selectedAddonUrls, toast])

  const handleBulkDisable = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return
    const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])
    try {
      await useAccountStore.getState().bulkToggleAddonEnabled(accountId, urls, false)
      toast({ title: 'Addons Disabled', description: `Disabled ${urls.length} addons.` })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed', description: 'Could not disable addons.' })
    }
  }, [account, accountId, selectedAddonUrls, toast])

  const searchInputRef = useRef<HTMLInputElement>(null)

  const handleCreateRule = useCallback(async () => {
    if (!account || selectedAddonUrls.size < 2) {
      toast({
        variant: 'destructive',
        title: 'Selection too small',
        description: 'Please select at least 2 addons to create a failover chain.'
      })
      return
    }

    try {
      // Extract transport URLs from composite IDs (url::index)
      const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])

      const { useFailoverStore } = await import('@/store/failoverStore')
      const failoverStore = useFailoverStore.getState()

      await failoverStore.addRule(accountId, urls)

      toast({
        title: 'Autopilot Rule Created',
        description: `Created a new rule with ${urls.length} addons. Switching to configuration...`
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
  }, [account, accountId, selectedAddonUrls, toast, setSearchParams])

  const handleUpdateAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    const addonsToUpdate = updatesAvailable.map((addon) => ({ id: addon.manifest.id, url: addon.transportUrl }))
    if (addonsToUpdate.length === 0) return

    setUpdatingAll(true)
    try {

      let successCount = 0
      for (const item of addonsToUpdate) {
        try {
          await useAccountStore.getState().reinstallAddon(accountId, item.url)
          successCount++
        } catch (error) {
          console.warn(`Failed to update addon ${item.id}:`, error)
        }
      }


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
  }, [account, encryptionKey, updatesAvailable, accountId, toast])

  const handleReinstallSelected = useCallback(async () => {
    if (!account || selectedAddonUrls.size === 0) return

    setUpdatingAll(true)
    try {
      const urls = Array.from(selectedAddonUrls).map(id => id.split('::')[0])

      let successCount = 0
      for (const url of urls) {
        try {
          await useAccountStore.getState().reinstallAddon(accountId, url)
          successCount++
        } catch (error) {
          console.warn(`Failed to reinstall addon ${url}:`, error)
        }
      }

      toast({
        title: 'Reinstallation Complete',
        description: `Successfully reinstalled ${successCount} of ${urls.length} addons.`,
      })

      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
      await syncAccount(accountId)
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Reinstall Failed',
        description: 'Failed to reinstall selected addons.'
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, accountId, selectedAddonUrls, toast, syncAccount])

  const handleReinstallAll = useCallback(async () => {
    if (!account || !encryptionKey) return

    setUpdatingAll(true)
    try {
      await useAddonStore.getState().bulkReinstallAllOnAccount(accountId, account.authKey)

      toast({
        title: 'Collection Reinstalled',
        description: `All addons have been refreshed from their source URLs.`,
      })
    } catch (error) {
      toast({
        title: 'Reinstall Failed',
        description: error instanceof Error ? error.message : 'Failed to reinstall addons',
        variant: 'destructive',
      })
    } finally {
      setUpdatingAll(false)
    }
  }, [account, encryptionKey, accountId, toast])

  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const selectedAddons = useMemo(() => {
    return addons.filter((_, index) => selectedAddonUrls.has(`${addons[index].transportUrl}::${index}`))
  }, [addons, selectedAddonUrls])

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

  const allEnabled = selectedAddons.length > 0 && selectedAddons.every(a => a.flags?.enabled !== false)
  const allProtected = selectedAddons.length > 0 && selectedAddons.every(a => a.flags?.protected)

  const currentIndex = accounts.findIndex(a => a.id === accountId)
  const prevAccount = accounts.length > 1 ? (currentIndex > 0 ? accounts[currentIndex - 1] : accounts[accounts.length - 1]) : null
  const nextAccount = accounts.length > 1 ? (currentIndex < accounts.length - 1 ? accounts[currentIndex + 1] : accounts[0]) : null

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
              {updatesAvailable.length > 0 && (
                <span className="text-blue-600 dark:text-blue-400">
                  {updatesAvailable.length} update{updatesAvailable.length !== 1 ? 's' : ''}{' '}
                  available
                </span>
              )}
            </p>
          </div>
        </div>

        {accounts.length > 1 && (
          <div className="flex items-center gap-2 self-end sm:self-auto order-first sm:order-last border border-border/50 rounded-lg p-1 bg-muted/20">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => prevAccount && navigate(`/account/${prevAccount?.id}?tab=${activeTab}`)}
              title={`Previous: ${prevAccount?.name || prevAccount?.email}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="px-2 py-0.5 bg-background rounded border text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
              {currentIndex + 1} / {accounts.length}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => nextAccount && navigate(`/account/${nextAccount?.id}?tab=${activeTab}`)}
              title={`Next: ${nextAccount?.name || nextAccount?.email}`}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="flex h-auto bg-transparent p-0 gap-2 justify-start w-full whitespace-nowrap overflow-x-auto scrollbar-hide pb-2">
          <TabsTrigger value="addons" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm relative">
            Installed Addons
            {addons.length > 0 && (
              <span className="ml-2 w-5 h-5 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-black shrink-0 shadow-sm">
                {addons.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="failover" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm">
            Failover Rules
          </TabsTrigger>
          <TabsTrigger value="changelog" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm">
            Recent Changes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="addons" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            {/* Left: Search Filter */}
            {addons.length > 0 && (
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search addons..."
                  className="pl-10 pr-10 h-10 w-full bg-background/50 border-muted focus:bg-background transition-colors"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-search-focus
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
            )}

            <div className="flex flex-wrap gap-2 w-full sm:w-auto ml-auto items-center">

              {/* 1. Refresh */}
              {!isSelectionMode && (
                <Button
                  onClick={handleCheckUpdates}
                  disabled={addons.length === 0 || checkingUpdates}
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none h-10"
                >
                  <AnimatedRefreshIcon className="h-4 w-4 mr-0.5" isAnimating={checkingUpdates} />
                  <span className="hidden xs:inline">
                    {checkingUpdates ? 'Refreshing...' : 'Refresh'}
                  </span>
                  <span className="inline xs:hidden">{checkingUpdates ? '...' : 'Refresh'}</span>
                </Button>
              )}

              {/* 2. Primary Actions */}
              {!isSelectionMode && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setReorderDialogOpen(true)}
                    className="flex-1 sm:flex-none h-10"
                  >
                    <GripVertical className="h-4 w-4 mr-1.5" />
                    <span className="hidden xs:inline">Reorder</span>
                    <span className="inline xs:hidden">Reorder</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInstallFromLibraryOpen(true)}
                    className="flex-1 sm:flex-none h-10"
                  >
                    <Library className="h-4 w-4 mr-1.5" />
                    <span className="hidden xs:inline text-nowrap">Install from Library</span>
                    <span className="inline xs:hidden text-nowrap">Library</span>
                  </Button>
                </>
              )}

              {/* 3. Bulk Actions Dropdown */}
              {!isSelectionMode && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1 flex-1 sm:flex-none h-10">
                      <Layers className="h-4 w-4" />
                      Bulk Actions
                      {updatesAvailable.length > 0 && (
                        <span className="ml-1 w-5 h-5 flex items-center justify-center text-[10px] font-bold bg-blue-500 text-white rounded-full shrink-0">
                          {updatesAvailable.length}
                        </span>
                      )}
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {updatesAvailable.length > 0 && (
                      <DropdownMenuItem onClick={handleUpdateAll} disabled={updatingAll}>
                        <AnimatedUpdateIcon className="h-4 w-4 mr-2" isAnimating={updatingAll} />
                        Update All ({updatesAvailable.length})
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={handleReinstallAll} disabled={updatingAll}>
                      <Zap className="h-4 w-4 mr-2 text-emerald-500" />
                      Force Reinstall All
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setBulkSaveOpen(true)}>
                      <Save className="h-4 w-4 mr-2" />
                      Save All to Library
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {addons.some(a => !a.flags?.protected) ? (
                      <DropdownMenuItem onClick={handleProtectAll}>
                        <AnimatedShieldIcon className="h-4 w-4 mr-2 text-blue-500" />
                        Protect All
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={handleUnprotectAll}>
                        <AnimatedShieldIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                        Unprotect All
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleEnableAll}>
                      <Zap className="h-4 w-4 mr-2 text-emerald-500" />
                      Enable All
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDisableAll}>
                      <X className="h-4 w-4 mr-2 text-red-500" />
                      Disable All
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* 3. Select Mode */}
              <Button
                variant={isSelectionMode ? "secondary" : "outline"}
                size="sm"
                onClick={toggleSelectionMode}
                className="flex-1 sm:flex-none h-10 px-4"
              >
                <Check className="h-4 w-4 mr-2" />
                {isSelectionMode ? "Cancel" : "Select"}
              </Button>

              {isSelectionMode && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selectAllAddons}
                    className="flex-1 sm:flex-none"
                  >
                    {selectedAddonUrls.size === filteredAddons.length && filteredAddons.length > 0 ? 'Deselect All' : 'Select All'}
                  </Button>
                  {selectedAddonUrls.size > 0 && (
                    <>
                      <div className="flex gap-1 flex-1 sm:flex-none">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={allEnabled ? handleBulkDisable : handleBulkEnable}
                          className={cn(
                            "flex-1",
                            allEnabled
                              ? "border-red-200 hover:bg-red-50 dark:border-red-900/30 dark:hover:bg-red-900/20"
                              : "border-emerald-200 hover:bg-emerald-50 dark:border-emerald-900/30 dark:hover:bg-emerald-900/20"
                          )}
                        >
                          {allEnabled ? (
                            <>
                              <X className="h-4 w-4 mr-1.5 text-red-500" />
                              Disable
                            </>
                          ) : (
                            <>
                              <Zap className="h-4 w-4 mr-1.5 text-emerald-600" />
                              Enable
                            </>
                          )}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={allProtected ? handleUnprotectSelected : handleProtectSelected}
                          className={cn(
                            "flex-1",
                            allProtected
                              ? ""
                              : "border-blue-200 hover:bg-blue-50 dark:border-blue-900/30 dark:hover:bg-blue-900/20"
                          )}
                        >
                          {allProtected ? (
                            <>
                              <AnimatedShieldIcon className="h-4 w-4 mr-1.5" />
                              Unprotect
                            </>
                          ) : (
                            <>
                              <AnimatedShieldIcon className="h-4 w-4 mr-1.5" />
                              Protect
                            </>
                          )}
                        </Button>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleReinstallSelected}
                        disabled={updatingAll}
                        className="flex-1 sm:flex-none border-emerald-200 hover:bg-emerald-50 dark:border-emerald-900/30 dark:hover:bg-emerald-900/20"
                      >
                        <AnimatedUpdateIcon className="h-4 w-4 mr-1.5" isAnimating={updatingAll} />
                        Reinstall ({selectedAddonUrls.size})
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setBulkSaveOpen(true)}
                        className="flex-1 sm:flex-none border-amber-200 hover:bg-amber-50 dark:border-amber-900/30 dark:hover:bg-amber-900/20"
                      >
                        <Save className="h-4 w-4 mr-1.5" />
                        Save
                      </Button>

                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleBulkDeleteClick}
                        disabled={updatingAll}
                        className="flex-1 sm:flex-none"
                      >
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        Delete
                      </Button>

                      {selectedAddonUrls.size >= 2 && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={handleCreateRule}
                          className="flex-1 sm:flex-none bg-gradient-to-r from-primary to-violet-600 hover:from-primary/90 hover:to-violet-700 text-white shadow-primary/20 dark:shadow-none"
                        >
                          <Zap className="h-4 w-4 mr-1.5 text-yellow-300" />
                          Autopilot
                        </Button>
                      )}
                    </>
                  )}
                </>
              )}

              {/* 4. Library & Install */}
              {!isSelectionMode && (
                <div className="flex gap-2 flex-1 sm:flex-none">


                  <Button
                    onClick={() => openAddAddonDialog(accountId)}
                    size="sm"
                    className="flex-1"
                  >
                    <Plus className="h-4 w-4" />
                    <span className="hidden xs:inline">Install</span>
                    <span className="inline xs:hidden text-[10px]">Install</span>
                  </Button>
                </div>
              )}
            </div>
          </div>

          {addons.length === 0 ? (
            <div className="text-center py-12 border border-dashed rounded-lg">
              <p className="text-muted-foreground mb-4">No addons installed</p>
              <Button onClick={() => openAddAddonDialog(accountId)}>Install Your First Addon</Button>
            </div>
          ) : filteredAddons.length === 0 ? (
            <div className="text-center py-12 border border-dashed rounded-lg">
              <p className="text-lg font-medium mb-2">No addons match your search</p>
              <p className="text-muted-foreground mb-4">Try a different search term</p>
              <Button variant="outline" onClick={() => setSearchQuery('')}>Clear Search</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAddons.map((addon) => {
                const originalIndex = addons.indexOf(addon)
                return (
                  <AddonCard
                    key={`${addon.transportUrl}-${originalIndex}`}
                    index={originalIndex}
                    addon={addon}
                    accountId={accountId}
                    accountAuthKey={account?.authKey || ''}
                    onRemove={async () => {
                      await removeAddonByIndex(accountId, originalIndex)
                    }}
                    onUpdate={handleUpdateAddon}
                    latestVersion={latestVersions[addon.manifest.id]}
                    isOnline={healthStatus[addon.manifest.id]?.isOnline}
                    healthError={healthStatus[addon.manifest.id]?.error}
                    isSelectionMode={isSelectionMode}
                    onToggleSelect={toggleAddonSelection}
                    selectionId={`${addon.transportUrl}::${originalIndex}`}
                    isSelected={selectedAddonUrls.has(`${addon.transportUrl}::${originalIndex}`)}
                  />
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="failover">
          <FailoverManager accountId={accountId} />
        </TabsContent>

        <TabsContent value="changelog">
          <AddonChangelog accountId={accountId} />
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
          <>
            <InstallSavedAddonDialog
              accountId={accountId}
              accountAuthKey={account.authKey}
              open={installFromLibraryOpen}
              onOpenChange={setInstallFromLibraryOpen}
              installedAddons={addons}
            />
          </>
        )
      }

      <BulkSaveDialog
        open={bulkSaveOpen}
        onOpenChange={setBulkSaveOpen}
        addons={isSelectionMode && selectedAddonUrls.size > 0
          ? addons.filter((_, index) => selectedAddonUrls.has(`${addons[index].transportUrl}::${index}`))
          : addons}
        accountId={accountId}
        title={isSelectionMode && selectedAddonUrls.size > 0 ? `Save ${selectedAddonUrls.size} Selected` : 'Save Addons to Library'}
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
