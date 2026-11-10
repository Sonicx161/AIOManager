import { triggerSync } from '@/lib/sync-trigger'
import type { SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import { checkAddonUpdates } from '@/api/addons'
import { HealthStatus } from '@/lib/addon-health'
import { Button } from '@/components/ui/button'
import { OperationProgress, type OperationStatus } from '@/components/ui/operation-progress'
import { useToast } from '@/hooks/use-toast'
import { useAccounts } from '@/hooks/useAccounts'
import { useAddons } from '@/hooks/useAddons'
import { getLatestAddonVersion, maskEmailLevel, maskNameLevel, isNewerVersion, cn } from '@/lib/utils'
import { AccountSwitcher } from '@/components/common/AccountSwitcher'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { useAccountStore, getAccountEmail, getStremioAuthKey, hasPlatformConnection } from '@/store/accountStore'
import { pushAddonsToPlatform } from '@/lib/account-compat'
import { buildSavedAddonIndex } from '@/lib/saved-addon-index'
import type { AddonDescriptor } from '@/types/addon'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { ArrowLeft, GripVertical, Library, Save, Plus, Search, X, Layers, Trash2, ChevronDown, Zap, Check, Shield, EyeOff, Copy, Download, User, Edit2, LayoutGrid, List, Wand2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { AnimatedRefreshIcon, AnimatedUpdateIcon, AnimatedShieldIcon } from '../ui/AnimatedIcons'
import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense } from "react"
import { Input } from '@/components/ui/input'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AddonCard } from './AddonCard'
import { ResurrectedNotice } from './ResurrectedNotice'
import { useProfileOperations } from './useProfileOperations'
import { useAddonFlagOperations } from './useAddonFlagOperations'
import { useAddonHeavyOperations } from './useAddonHeavyOperations'
import { StaggerContainer, StaggerItem } from '@/components/ui/stagger'
import { AccountPickerDialog } from '../accounts/AccountPickerDialog'
import { AddonReorderDialog } from './AddonReorderDialog'
import { InstallSavedAddonDialog } from './InstallSavedAddonDialog'
import { BulkSaveDialog } from './BulkSaveDialog'
import { BulkUrlReplaceDialog } from '@/components/saved-addons/BulkUrlReplaceDialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
const FailoverManager = React.lazy(() =>
  import('@/components/accounts/FailoverManager').then((m) => ({ default: m.FailoverManager }))
)
type FailoverView = import('@/components/accounts/FailoverManager').FailoverView
import { ConnectionManager } from '@/components/providers/ConnectionManager'

import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AddonChangelog } from '@/components/accounts/AddonChangelog'
import { FloatingActionBar } from '@/components/ui/floating-action-bar'
import { Tooltip } from '@/components/ui/tooltip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { AccountSetupCreateDialog } from '@/components/accounts/AccountSetupCreateDialog'
import { SYNCED_SETTINGS_EVENT } from '@/lib/synced-settings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

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
  const addonListView = useUIStore((state) => state.addonListView)
  const setAddonListView = useUIStore((state) => state.setAddonListView)
  const [isDesktopAddonListViewport, setIsDesktopAddonListViewport] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 768px)').matches
  })
  const effectiveAddonListView = addonListView === 'list' && isDesktopAddonListViewport ? 'list' : 'grid'
  const checkRules = useFailoverStore((state) => state.checkRules)
  const pullServerState = useFailoverStore((state) => state.pullServerState)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const syncAccount = useAccountStore(state => state.syncAccount)
  const { toast } = useToast()
  const {
    profileToDelete,
    setProfileToDelete,
    profileToEdit,
    setProfileToEdit,
    profileEditName,
    setProfileEditName,
    profileEditLoading,
    isCreateProfileOpen,
    setIsCreateProfileOpen,
    handleSwitchProfile,
    handleDeleteProfile,
    handleSaveProfile,
    handleCreateProfileConfirm,
  } = useProfileOperations(accountId)

  const failoverRules = useFailoverStore(
    useShallow((state) => state.rules.filter(r => r.accountId === accountId))
  )

  const linkedRuleMap = useMemo(() => {
    const map = new Map<string, typeof failoverRules[number]>()
    for (const r of failoverRules) {
      for (let i = 1; i < r.priorityChain.length; i++) {
        map.set(r.priorityChain[i].toLowerCase(), r)
      }
    }
    return map
  }, [failoverRules])

  const primaryRuleMap = useMemo(() => {
    const map = new Map<string, typeof failoverRules[number]>()
    for (const r of failoverRules) {
      if (r.priorityChain[0]) {
        map.set(r.priorityChain[0].toLowerCase(), r)
      }
    }
    return map
  }, [failoverRules])

  const addonUrlMap = useMemo(() => {
    const map = new Map<string, typeof addons[number]>()
    for (const a of addons) {
      map.set(a.transportUrl.toLowerCase(), a)
    }
    return map
  }, [addons])

  const [visibleCount, setVisibleCount] = useState(200)
  const [reorderDialogOpen, setReorderDialogOpen] = useState(false)
  const [installFromLibraryOpen, setInstallFromLibraryOpen] = useState(false)

  const [bulkSaveOpen, setBulkSaveOpen] = useState(false)
  const [bulkUrlReplaceOpen, setBulkUrlReplaceOpen] = useState(false)

  const tabParam = searchParams.get('tab')
  const validTabs = ['addons', 'failover', 'failover-history', 'failover-webhooks', 'changelog', 'connections'] as const
  type AccountTab = typeof validTabs[number]
  const activeTab: AccountTab = validTabs.includes(tabParam as AccountTab) ? tabParam as AccountTab : 'addons'
  const activeAccountTab = activeTab === 'failover-history' || activeTab === 'failover-webhooks' ? 'failover' : activeTab
  const failoverViewByTab: Record<Extract<AccountTab, 'failover' | 'failover-history' | 'failover-webhooks'>, FailoverView> = {
    failover: 'rules',
    'failover-history': 'history',
    'failover-webhooks': 'webhooks',
  }
  const failoverTabByView: Record<FailoverView, AccountTab> = {
    rules: 'failover',
    history: 'failover-history',
    webhooks: 'failover-webhooks',
  }

  const handleTabChange = (val: string) => {
    // Focus and pointer events can arrive before the router renders the new tab.
    const currentTab = new URLSearchParams(window.location.search).get('tab') || 'addons'
    if (val === currentTab || !validTabs.includes(val as AccountTab)) return
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.set('tab', val)
      return next
    }, { preventScrollReset: true })
  }

  const handleFailoverViewChange = (view: FailoverView) => {
    handleTabChange(failoverTabByView[view])
  }

  const [selectedAddonUrls, setSelectedAddonUrls] = useState<Set<string>>(new Set())
  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [hideDisabled, setHideDisabled] = useState(() => {
    try { return localStorage.getItem('aioman:hide-disabled-addons') === 'true' } catch { return false }
  })
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const handleSyncedSettings = (event: Event) => {
      const value = (event as CustomEvent<{ hideDisabledAddons?: boolean }>).detail?.hideDisabledAddons
      if (typeof value === 'boolean') setHideDisabled(value)
    }

    window.addEventListener(SYNCED_SETTINGS_EVENT, handleSyncedSettings)
    return () => window.removeEventListener(SYNCED_SETTINGS_EVENT, handleSyncedSettings)
  }, [])

  const handleSearchChange = (val: string) => {
    setSearchQuery(val)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearchQuery(val)
    }, 150)
  }

  const toggleHideDisabled = () => {
    setHideDisabled(v => {
      const next = !v
      try {
        localStorage.setItem('aioman:hide-disabled-addons', String(next))
        triggerSync()
      } catch (e) { /* localStorage unavailable */ }
      return next
    })
  }

  const toggleAddonSelection = useCallback((addonUrl: string) => {
    setSelectedAddonUrls((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(addonUrl)) {
        newSet.delete(addonUrl)
      } else {
        newSet.add(addonUrl)
      }
      return newSet
    })
  }, [])

  const handleAddonLongPress = useCallback((id: string) => {
    setIsSelectionMode(true)
    toggleAddonSelection(id)
  }, [toggleAddonSelection])

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode)
    if (isSelectionMode) {
      setSelectedAddonUrls(new Set())
    }
  }


  // Sync first, then reconcile Autopilot so a fresh Stremio pull cannot
  // re-enable backup addons after the server says a different URL is active.
  // lastSync is read via getState() so background syncs of the open account do not re-run this effect.
  useEffect(() => {
    if (!accountId || !encryptionKey) return

    let cancelled = false
    const reconcile = async () => {
      const lastSyncValue = useAccountStore.getState().accounts.find(acc => acc.id === accountId)?.lastSync
      const lastSync = lastSyncValue ? new Date(lastSyncValue).getTime() : 0
      const isStale = Date.now() - lastSync > 2 * 60 * 1000
      if (isStale) {
        await syncAccount(accountId, false)
      }
      if (!cancelled) {
        await pullServerState()
      }
    }

    reconcile().catch((error) => {
      if (import.meta.env.DEV) console.warn('[AddonList] Autopilot reconciliation failed:', error)
    })

    return () => {
      cancelled = true
    }
  }, [accountId, syncAccount, encryptionKey, pullServerState])

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false)
  const [protectedInSelection, setProtectedInSelection] = useState(0)

  const [deleteConfirmationNames, setDeleteConfirmationNames] = useState<string[]>([])

  const handleBulkDeleteClick = () => {
    if (selectedAddonUrls.size === 0) return

    const protectedCount = addons.filter((addon, index) => {
      const compositeId = `${addon.transportUrl}::${index}`
      return selectedAddonUrls.has(compositeId) && addon.flags?.protected
    }).length

    setProtectedInSelection(protectedCount)
    const names = filteredAddons.filter((addon) => {
      const originalIndex = addonIndexMap.get(addon)
      if (originalIndex === undefined) return false
      return selectedAddonUrls.has(`${addon.transportUrl}::${originalIndex}`)
    }).map(a => a.manifest.name || a.manifest.id || 'Unknown').slice(0, 10)
    setDeleteConfirmationNames(names)
    setShowDeleteConfirm(true)
  }

  const handleBulkDeleteConfirm = async () => {
    if (selectedAddonUrls.size === 0 || !account) return

    try {
      setUpdatingAll(true)

      const updatedAddons = addons.filter((_, index) => {
        const compositeId = `${addons[index].transportUrl}::${index}`
        return !selectedAddonUrls.has(compositeId)
      })
      const removedUrls = addons
        .filter((_, index) => selectedAddonUrls.has(`${addons[index].transportUrl}::${index}`))
        .map(a => a.transportUrl)

      await useAccountStore.getState().bulkDeleteAddons(accountId, updatedAddons, removedUrls)

      toast({ title: 'Addons Deleted', description: `Successfully deleted selected addons.` })
      setIsSelectionMode(false)
      setSelectedAddonUrls(new Set())
      setShowDeleteConfirm(false)
      await syncAccount(accountId, true, 'user')
    } catch (e) {
      const msg = (e as Error)?.message || ''
      if (msg.includes('Anti-wipe guard')) {
        toast({ variant: 'destructive', title: 'Cannot Delete All Addons', description: 'Anti-wipe protection prevents removing every addon. Keep at least one installed to protect your addon collection.' })
      } else {
        toast({ variant: 'destructive', title: 'Delete Failed', description: 'Could not delete selected addons.' })
      }
    } finally {
      setUpdatingAll(false)
    }
  }

  const handleClearAllAddons = useCallback(async () => {
    if (!account) return
    if (account?.addons?.length === 0) return
    if (!hasPlatformConnection(account)) {
      toast({ variant: 'destructive', title: 'Not available', description: 'Clear All Addons requires a platform connection.' })
      setShowClearAllConfirm(false)
      return
    }
    try {
      setUpdatingAll(true)
      await pushAddonsToPlatform(account, [], account.id, {
        allowCollectionShrink: true,
        previousCollection: account.addons,
      })
      await useAccountStore.getState().reorderAddons(account.id, [], { explicitInstallUrls: [] })
      toast({ title: 'All Addons Cleared', description: `Removed ${account.addons.length} addons from ${account.name}.` })
      setShowClearAllConfirm(false)
      await syncAccount(account.id)
    } catch (e) {
      toast({ variant: 'destructive', title: 'Clear Failed', description: (e as Error)?.message || 'Could not clear addons.' })
      setShowClearAllConfirm(false)
    } finally {
      setUpdatingAll(false)
    }
  }, [account, syncAccount, toast])

  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState<{ status: OperationStatus; current: number; total: number; label: string; detail?: string }>({ status: 'idle', current: 0, total: 0, label: '' })
  const [healthStatus, setHealthStatus] = useState<Record<string, HealthStatus>>({})
  const latestVersions = useAddonStore((state) => state.latestVersions)
  const manifestChangeHints = useAddonStore((state) => state.manifestChangeHints)
  const library = useAddonStore(useShallow((state) => state.library))
  const accountAuthKey = useMemo(() => (account ? getStremioAuthKey(account) : ''), [account])
  const isSavedAddon = useMemo(() => buildSavedAddonIndex(Object.values(library)), [library])
  const installedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const saved of Object.values(library)) {
      keys.add(`${saved.manifest.id}::${saved.installUrl}`)
    }
    return keys
  }, [library])
  const updateLatestVersions = useAccountStore((state) => state.updateLatestVersions)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [showBulkAccountPicker, setShowBulkAccountPicker] = useState(false)
  const [isBulkActionLoading, setIsBulkActionLoading] = useState(false)

  const addonIndexMap = useMemo(() => {
    const map = new Map<AddonDescriptor, number>()
    addons.forEach((addon, i) => map.set(addon, i))
    return map
  }, [addons])

  const filteredAddons = useMemo(() => {
    let result = addons
    if (hideDisabled) result = result.filter(a => a.flags?.enabled !== false)
    if (!debouncedSearchQuery.trim()) {
      return result
    }
    const query = debouncedSearchQuery.toLowerCase()
    return result.filter((addon) =>
      addon.manifest.name?.toLowerCase().includes(query) ||
      addon.manifest.id?.toLowerCase().includes(query) ||
      addon.manifest.description?.toLowerCase().includes(query) ||
      addon.transportUrl?.toLowerCase().includes(query)
    )
  }, [addons, debouncedSearchQuery, hideDisabled])

  const selectAllAddons = useCallback(() => {
    const newSelected = new Set<string>()
    filteredAddons.forEach(addon => {
      const originalIndex = addonIndexMap.get(addon)
      if (originalIndex !== undefined) {
        newSelected.add(`${addon.transportUrl}::${originalIndex}`)
      }
    })
    setSelectedAddonUrls(newSelected)
  }, [filteredAddons, addonIndexMap])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement
      const isInput = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape' && isSelectionMode) {
        setIsSelectionMode(false)
        setSelectedAddonUrls(new Set())
      }

      if ((e.key === 's' || e.key === 'S') && isSelectionMode && selectedAddonUrls.size > 0 && !bulkSaveOpen && !isInput) {
        setBulkSaveOpen(true)
      }

      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && isSelectionMode) {
        e.preventDefault()
        selectAllAddons()
      }

      if (e.key === '/' && !isSelectionMode && !isInput) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSelectionMode, selectedAddonUrls, bulkSaveOpen, filteredAddons, selectAllAddons])

  const updatesAvailable = useMemo(() => addons.filter((addon) => {
    const latest = getLatestAddonVersion(latestVersions, addon)
    return latest && isNewerVersion(addon.manifest.version, latest)
  }), [addons, latestVersions])

  const handleCheckUpdates = useCallback(async () => {
    if (checkingUpdates) return
    if (!account) return

    setCheckingUpdates(true)

    const platforms: string[] = []
    if (getStremioAuthKey(account)) platforms.push('Stremio')
    for (const conn of account.connections || []) {
        if (!conn.enabled) continue
        if (conn.platform === 'nuvio' && !platforms.includes('Nuvio')) platforms.push('Nuvio')
        else if (conn.platform === 'realstream' && !platforms.includes('RealStream')) platforms.push('RealStream')
        else if ((conn.connectionType === 'hydra-outbound' || conn.platform === 'hydra') && !platforms.includes('Hydra')) platforms.push('Hydra')
    }
    const platformText = platforms.length > 0 ? platforms.join(', ') : 'Stremio'

    setRefreshProgress({ status: 'running', current: 0, total: 3, label: 'Syncing addon list', detail: `Pulling from ${platformText}...` })
    try {
      // Refresh is a force-read plus the same user push as Sync: additive merge, nothing removed by the read.
      await syncAccount(accountId, true, 'user')
      setRefreshProgress({ status: 'running', current: 1, total: 3, label: 'Syncing server state', detail: 'Checking failover rules and connection health...' })

      await pullServerState()
      await checkRules()
      setRefreshProgress({ status: 'running', current: 2, total: 3, label: 'Checking for updates', detail: `Scanning ${addons.length} addons...` })

      const updateInfoList = await checkAddonUpdates(addons, accountId, (current, total) => {
        setRefreshProgress(prev => ({ ...prev, current: 2 + (current / total), total: 3, label: 'Checking for updates', detail: `${current} of ${total} addons checked` }))
      })
      const versions: Record<string, string> = {}
      const health: Record<string, HealthStatus> = {}
      const hints: Record<string, SavedAddonManifestChangeSummary> = {}

      updateInfoList.forEach((info) => {
        versions[info.versionKey] = info.latestVersion
        versions[info.addonId] = info.latestVersion
        health[info.addonId] = info.health
        if (info.hasManifestShapeChange && info.manifestChanges) {
          hints[info.versionKey] = info.manifestChanges
          hints[info.addonId] = info.manifestChanges
        }
      })
      updateLatestVersions(versions)
      useAddonStore.getState().updateManifestChangeHints(hints)
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
      setRefreshProgress({ status: 'complete', current: 3, total: 3, label: 'Refresh complete', detail: description })
      setTimeout(() => setRefreshProgress({ status: 'idle', current: 0, total: 0, label: '' }), 3000)
    } catch (error) {
      setRefreshProgress({ status: 'error', current: 0, total: 0, label: 'Refresh failed', detail: 'Failed to refresh addons' })
      setTimeout(() => setRefreshProgress({ status: 'idle', current: 0, total: 0, label: '' }), 5000)
      toast({
        title: 'Refresh Failed',
        description: 'Failed to refresh addons',
        variant: 'destructive',
      })
    } finally {
      setCheckingUpdates(false)
    }
  }, [account, addons, toast, updateLatestVersions, syncAccount, accountId, checkRules, pullServerState, checkingUpdates])

  const {
    handleUpdateAddon,
    handleProtectAll,
    handleUnprotectAll,
    handleHideConfigureAll,
    handleShowConfigureAll,
    handleEnableAll,
    handleDisableAll,
    handleProtectSelected,
    handleUnprotectSelected,
    handleHideConfigureSelected,
    handleShowConfigureSelected,
    handleBulkEnable,
    handleBulkDisable,
  } = useAddonFlagOperations({ accountId, account, addons, selectedAddonUrls, setSelectedAddonUrls, setIsSelectionMode })

  const searchInputRef = useRef<HTMLInputElement>(null)

  const updateAddonRef = useRef(handleUpdateAddon)
  updateAddonRef.current = handleUpdateAddon
  const stableUpdateAddon = useCallback(
    (accId: string, transportUrl: string) => updateAddonRef.current(accId, transportUrl),
    []
  )
  const handleRemoveAddon = useCallback(
    (accId: string, transportUrl: string, index?: number) => removeAddonByIndex(accId, index ?? 0, transportUrl),
    [removeAddonByIndex]
  )

  const {
    handleCreateRule,
    handleUpdateAll,
    handleReinstallSelected,
    handleReinstallAll,
    handleBulkCloneToAccounts,
    handleBulkDeployToAll,
  } = useAddonHeavyOperations({ accountId, account, addons, accounts, updatesAvailable, selectedAddonUrls, setSearchParams, setUpdatingAll, setRefreshProgress, setIsSelectionMode, setSelectedAddonUrls, setIsBulkActionLoading, setShowBulkAccountPicker })

  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const privacyLevelNames = useUIStore((state) => state.privacyLevelNames)
  const selectedAddons = useMemo(() => {
    return addons.filter((_, index) => selectedAddonUrls.has(`${addons[index].transportUrl}::${index}`))
  }, [addons, selectedAddonUrls])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia('(min-width: 768px)')
    const handleViewportChange = () => setIsDesktopAddonListViewport(mediaQuery.matches)

    handleViewportChange()
    mediaQuery.addEventListener('change', handleViewportChange)

    return () => mediaQuery.removeEventListener('change', handleViewportChange)
  }, [])

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

  const privacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
  const displayName = account.name.includes('@')
    ? maskEmailLevel(account.name, privacyLevel)
    : maskNameLevel(account.name, privacyLevel)
  const activeProfileName = account.activeProfileId
    ? (account.profiles?.find(p => p.id === account.activeProfileId)?.name || 'Setup')
    : 'Main Setup'
  const allEnabled = selectedAddons.length > 0 && selectedAddons.every(a => a.flags?.enabled !== false)
  const allProtected = selectedAddons.length > 0 && selectedAddons.every(a => a.flags?.protected)
  const allHideConfigure = selectedAddons.length > 0 && selectedAddons.every(a => a.metadata?.hideConfigure)

  const currentIndex = accounts.findIndex(a => a.id === accountId)
  const prevAccount = accounts.length > 1 ? (currentIndex > 0 ? accounts[currentIndex - 1] : accounts[accounts.length - 1]) : null
  const nextAccount = accounts.length > 1 ? (currentIndex < accounts.length - 1 ? accounts[currentIndex + 1] : accounts[0]) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="mt-0.5 h-9 w-9 shrink-0 rounded-xl border border-border/40 bg-card text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <AccountAvatar account={account} size="lg" />
          <div className="min-w-0 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-2xl font-semibold tracking-tight md:text-3xl">{displayName}</h2>
              {updatesAvailable.length > 0 && (
                <span data-theme-part="badge" className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                  {updatesAvailable.length} update{updatesAvailable.length !== 1 ? 's' : ''} available
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{addons.length} installed</span>
              <span className="text-border">/</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label={`Active setup: ${activeProfileName}`} className="h-7 gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                    <User className="h-3.5 w-3.5" />
                    <span className="text-muted-foreground/70">Setup:</span>
                    <span className="truncate max-w-[140px]">{activeProfileName}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
                  <div className="border-b border-border/40 px-3 py-3">
                    <p className="text-xs font-semibold">Setups · Addons + Autopilot rules</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">One active setup for this local account. Switching changes its addons and activates that setup’s Autopilot rules.</p>
                  </div>
                  <DropdownMenuItem
                    className="gap-2"
                    onClick={() => handleSwitchProfile('default')}
                    disabled={!account.activeProfileId}
                  >
                    <User className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className={!account.activeProfileId ? 'font-semibold' : ''}>{'Main Setup'}</span>
                    {!account.activeProfileId && <Check className="ml-auto h-4 w-4 text-primary" />}
                  </DropdownMenuItem>
                  {(account.profiles || []).filter(p => p.id !== 'default').map(p => (
                    <div key={p.id} className="group relative">
                      <DropdownMenuItem
                        className="gap-2 pr-20 group-hover:bg-accent group-hover:text-accent-foreground"
                        onClick={() => handleSwitchProfile(p.id)}
                        disabled={account.activeProfileId === p.id}
                      >
                        <User className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className={`truncate flex-1 text-left ${account.activeProfileId === p.id ? 'font-semibold' : ''}`}>{p.name}</span>
                        {account.activeProfileId === p.id && <Check className="h-4 w-4 text-primary shrink-0" />}
                      </DropdownMenuItem>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-50 group-hover:opacity-100 transition-opacity sm:opacity-60">
                        <Tooltip content={`Rename ${p.name}`} side="top">
                          <DropdownMenuItem
                            className="h-7 w-7 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProfileEditName(p.name);
                              setProfileToEdit({ id: p.id, name: p.name });
                            }}
                            aria-label={`Rename ${p.name}`}
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </DropdownMenuItem>
                        </Tooltip>
                        <Tooltip content={`Delete ${p.name}`} side="top">
                          <DropdownMenuItem
                            className="h-7 w-7 p-0 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProfileToDelete({ id: p.id, name: p.name });
                            }}
                            aria-label={`Delete ${p.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </DropdownMenuItem>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
                  <DropdownMenuItem
                    onClick={() => {
                      setIsCreateProfileOpen(true);
                    }}
                    className="gap-2 text-primary focus:text-primary"
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    Create setup
                  </DropdownMenuItem>
                  <div className="border-t border-border/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">Need a separate person or Nuvio profile? Open Connections to manage its login and local account.</div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {accounts.length > 1 && (
          <div data-theme-part="panel" className="self-end rounded-2xl border border-border/40 bg-card p-1.5 shadow-sm sm:self-auto" data-account-switcher-pill>
            <AccountSwitcher
            mode="pagination"
            accounts={accounts}
            selectedId={accountId}
            onSelect={(id) => navigate(`/account/${id}?tab=${activeTab}`)}
            onPrev={() => prevAccount && navigate(`/account/${prevAccount?.id}?tab=${activeTab}`)}
            onNext={() => nextAccount && navigate(`/account/${nextAccount?.id}?tab=${activeTab}`)}
            prevLabel={prevAccount ? `Previous: ${prevAccount.name || getAccountEmail(prevAccount)}` : undefined}
            nextLabel={nextAccount ? `Next: ${nextAccount.name || getAccountEmail(nextAccount)}` : undefined}
          />
          </div>
        )}
      </div>

      <Tabs value={activeAccountTab} onValueChange={handleTabChange} className="space-y-4">
          <TabsList>
          <TabsTrigger value="addons" className="relative">
            Installed Addons
            {addons.length > 0 && (
              <span data-theme-part="badge" className="ml-2 flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 text-xs font-semibold text-muted-foreground">
                {addons.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="failover">
            Autopilot
          </TabsTrigger>
          <TabsTrigger value="changelog">
            Changelog
          </TabsTrigger>
          <TabsTrigger value="connections">
            Connections
          </TabsTrigger>
        </TabsList>

        <TabsContent value="addons" animated={false} className="space-y-4">
          <ResurrectedNotice accountId={accountId} />
          <ToolbarShell contentClassName="gap-2 sm:gap-3">
            {/* Search + view toggle - grouped so they never wrap apart */}
            <div className="grid w-full grid-cols-[1fr_auto] items-center gap-2 sm:flex sm:w-auto sm:flex-none">
              <div className="relative flex-1 min-w-0 sm:min-w-[180px] sm:max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search addons..."
                  className="pl-9 pr-9 h-8 text-xs w-full bg-muted/30 border border-border/40 focus:bg-muted/40 transition-colors"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  data-search-focus
                  disabled={addons.length === 0}
                />
                {searchQuery && (
                  <button
                    data-theme-part="button"
                    onClick={() => handleSearchChange('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 hover:bg-accent rounded-full transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
              <div data-theme-part="tabs-list" className="hidden items-center bg-muted/50 rounded-lg p-0.5 border border-border/40 gap-0.5 shrink-0 md:flex">
                <Button variant="ghost" size="sm" data-theme-part="tab" data-state={addonListView === 'grid' ? 'active' : 'inactive'} className={`h-8 w-8 rounded-lg p-0 ${addonListView === 'grid' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setAddonListView('grid')} aria-label="Grid view">
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" data-theme-part="tab" data-state={addonListView === 'list' ? 'active' : 'inactive'} className={`h-8 w-8 rounded-lg p-0 ${addonListView === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setAddonListView('list')} aria-label="List view">
                  <List className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid w-full grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:w-auto sm:flex-wrap sm:justify-end">

              {!isSelectionMode && (
                <>
                  <Tooltip content="Refresh addon list" side="bottom">
                    <Button
                      onClick={handleCheckUpdates}
                      disabled={addons.length === 0 || checkingUpdates}
                      size="sm"
                      variant="outline"
                      className="w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto"
                    >
                      <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={checkingUpdates} />
                      <span>{checkingUpdates ? 'Refreshing...' : 'Refresh'}</span>
                    </Button>
                  </Tooltip>
                  <Tooltip content="Reorder addons" side="bottom">
                    <Button
                      size="sm"
                      onClick={() => setReorderDialogOpen(true)}
                      variant="outline"
                      className="hidden shrink-0 gap-1.5 h-8 text-xs font-medium sm:inline-flex"
                      disabled={addons.length < 2}
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Reorder</span>
                    </Button>
                  </Tooltip>
                  <Tooltip content="Install from library" side="bottom">
                    <Button
                      size="sm"
                      onClick={() => setInstallFromLibraryOpen(true)}
                      variant="outline"
                      className="hidden shrink-0 gap-1.5 h-8 text-xs font-medium sm:flex"
                    >
                      <Library className="h-3.5 w-3.5" />
                      Library
                    </Button>
                  </Tooltip>
                </>
              )}
              {!isSelectionMode && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="ml-0 w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto">
                      <Layers className="h-3.5 w-3.5" />
                      <span className="sm:hidden">Actions</span>
                      <span className="hidden sm:inline">Bulk Actions</span>
                      {updatesAvailable.length > 0 && (
                        <span data-theme-part="badge" className="ml-1 w-4 h-4 flex items-center justify-center text-xs font-semibold bg-primary text-primary-foreground rounded-full shrink-0">
                          {updatesAvailable.length}
                        </span>
                      )}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
                    <DropdownMenuItem className="gap-2 sm:hidden" onClick={() => setInstallFromLibraryOpen(true)}>
                      <Library className="h-4 w-4" />
                      Install from Library
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2 sm:hidden"
                      onClick={() => setReorderDialogOpen(true)}
                      disabled={addons.length < 2}
                    >
                      <GripVertical className="h-4 w-4" />
                      Reorder Addons
                    </DropdownMenuItem>
                    {addons.some(a => a.flags?.enabled === false) && (
                      <DropdownMenuItem className="gap-2 sm:hidden" onClick={toggleHideDisabled}>
                        <List className="h-4 w-4" />
                        {hideDisabled ? 'Show disabled' : 'Hide disabled'}
                      </DropdownMenuItem>
                    )}
                    {updatesAvailable.length > 0 && (
                      <DropdownMenuItem className="gap-2" onClick={handleUpdateAll} disabled={updatingAll}>
                        <AnimatedUpdateIcon className="h-4 w-4" isAnimating={updatingAll} />
                        Update All ({updatesAvailable.length})
                      </DropdownMenuItem>
                    )}
                      <DropdownMenuItem className="gap-2" onClick={handleReinstallAll} disabled={updatingAll}>
                        <Zap className="h-4 w-4 text-success" />
                      Force Reinstall All
                    </DropdownMenuItem>
                      <DropdownMenuItem className="gap-2" onClick={() => setBulkSaveOpen(true)}>
                        <Save className="h-4 w-4" />
                      Save All to Library
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onClick={() => setBulkUrlReplaceOpen(true)} disabled={addons.length === 0}>
                        <Wand2 className="h-4 w-4 text-primary" />
                      Find &amp; Replace URL
                    </DropdownMenuItem>
                    {addons.some(a => !a.flags?.protected) ? (
                      <DropdownMenuItem className="gap-2" onClick={handleProtectAll}>
                        <AnimatedShieldIcon className="h-4 w-4 text-primary" />
                        Protect All
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem className="gap-2" onClick={handleUnprotectAll}>
                        <AnimatedShieldIcon className="h-4 w-4 text-muted-foreground" />
                        Unprotect All
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="gap-2" onClick={handleEnableAll}>
                        <Zap className="h-4 w-4 text-success" />
                      Enable All
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onClick={handleDisableAll}>
                        <X className="h-4 w-4 text-destructive" />
                      Disable All
                    </DropdownMenuItem>
                    {addons.some(a => !a.metadata?.hideConfigure) ? (
                      <DropdownMenuItem className="gap-2" onClick={handleHideConfigureAll}>
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                        Hide Configure All
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem className="gap-2" onClick={handleShowConfigureAll}>
                        <EyeOff className="h-4 w-4 text-primary" />
                        Show Configure All
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="gap-2" onClick={() => setShowClearAllConfirm(true)} disabled={!hasPlatformConnection(account) || addons.length === 0}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                        Clear All Addons
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {addons.some(a => a.flags?.enabled === false) && !isSelectionMode && (
                <Tooltip content={hideDisabled ? 'Show disabled addons' : 'Hide disabled addons'} side="bottom">
                  <Button
                    size="sm"
                    onClick={toggleHideDisabled}
                    variant="outline"
                    className="hidden h-8 shrink-0 text-xs font-medium sm:flex"
                  >
                    {hideDisabled ? 'Show disabled' : 'Hide disabled'}
                  </Button>
                </Tooltip>
              )}

              <Button
                size="sm"
                variant="outline"
                onClick={toggleSelectionMode}
                className="w-full shrink-0 gap-1.5 h-8 px-3 text-xs font-medium sm:w-auto sm:px-4"
              >
                {isSelectionMode ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                <span>{isSelectionMode ? "Cancel" : "Select"}</span>
              </Button>

              {isSelectionMode && (
                <Button
                  size="sm"
                  onClick={selectAllAddons}
                   variant="outline"
                   className="w-full shrink-0 sm:w-auto sm:flex-none h-8 gap-1.5 text-xs font-medium"
                >
                  <Check className="h-3.5 w-3.5" />
                  {selectedAddonUrls.size === filteredAddons.length && filteredAddons.length > 0 ? 'Deselect All' : 'Select All'}
                </Button>
              )}

              {!isSelectionMode && (
                <Button
                  onClick={() => openAddAddonDialog(accountId)}
                  size="sm"
                  className="w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Install
                </Button>
              )}
            </div>
          </ToolbarShell>

          <OperationProgress
            status={refreshProgress.status}
            current={refreshProgress.current}
            total={refreshProgress.total}
            label={refreshProgress.label}
            detail={refreshProgress.detail}
          />

          {addons.length === 0 ? (
            <EmptyState
              icon={<Library className="h-6 w-6" />}
              title="No addons installed"
              description="Install your first addon to start streaming. Add it from a manifest URL, or pick from your saved Library."
              action={<Button onClick={() => openAddAddonDialog(accountId)}>Install First Addon</Button>}
            />
          ) : filteredAddons.length === 0 ? (
            <EmptyState
              icon={<Search className="h-6 w-6" />}
              title="No addons match your search"
              description="Try a different keyword, or clear the search to see every installed addon."
              action={<Button variant="outline" onClick={() => setSearchQuery('')}>Clear Search</Button>}
            />
          ) : (
            <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/40 p-3 shadow-sm">
            <>
            <StaggerContainer className={effectiveAddonListView === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'}>
              {filteredAddons.slice(0, visibleCount).map((addon) => {
                const originalIndex = addonIndexMap.get(addon) ?? 0
                const normUrl = addon.transportUrl.toLowerCase()
                const linkedRule = linkedRuleMap.get(normUrl)
                const primaryUrl = linkedRule?.priorityChain?.[0]
                const primaryAddon = primaryUrl
                  ? addonUrlMap.get(primaryUrl.toLowerCase()) ?? null
                  : null
                const primaryRule = primaryRuleMap.get(normUrl)
                return (
                  <StaggerItem key={`${addon.transportUrl}-${originalIndex}`}>
                    <AddonCard
                      index={originalIndex}
                      addon={addon}
                      accountId={accountId}
                      accountAuthKey={accountAuthKey}
                      onRemove={handleRemoveAddon}
                      onUpdate={stableUpdateAddon}
                      latestVersion={getLatestAddonVersion(latestVersions, addon)}
                      manifestChange={manifestChangeHints[addon.manifest.id]}
                      isOnline={healthStatus[addon.manifest.id]?.isOnline}
                      healthError={healthStatus[addon.manifest.id]?.error}
                      isSelectionMode={isSelectionMode}
                      onToggleSelect={toggleAddonSelection}
                      onLongPress={handleAddonLongPress}
                      selectionId={`${addon.transportUrl}::${originalIndex}`}
                      isSelected={selectedAddonUrls.has(`${addon.transportUrl}::${originalIndex}`)}
                      failoverPrimaryName={linkedRule && primaryAddon ? (primaryAddon.metadata?.customName || primaryAddon.manifest.name) : undefined}
                      failoverPaused={linkedRule ? !linkedRule.isActive : undefined}
                      isPrimary={!!primaryRule}
                      isPrimaryPaused={primaryRule ? !primaryRule.isActive : undefined}
                      isInstalled={installedKeys.has(`${addon.manifest.id}::${addon.transportUrl}`)}
                      isSaved={isSavedAddon(addon)}
                      compact={effectiveAddonListView === 'list'}
                    />
                  </StaggerItem>
                )
              })}
            </StaggerContainer>
            {visibleCount < filteredAddons.length && (
              <div className="flex justify-center pt-4">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setVisibleCount(prev => prev + 200)}
                  className="gap-1.5 text-xs font-medium"
                >
                  Load More ({filteredAddons.length - visibleCount} remaining)
                </Button>
              </div>
            )}
            </>
            </div>
          )}
        </TabsContent>

        <TabsContent value="failover">
          <Suspense fallback={null}>
            <FailoverManager
              accountId={accountId}
              activeView={failoverViewByTab[activeTab as keyof typeof failoverViewByTab] ?? 'rules'}
              onActiveViewChange={handleFailoverViewChange}
            />
          </Suspense>
        </TabsContent>

        <TabsContent value="changelog">
          <AddonChangelog accountId={accountId} />
        </TabsContent>

        <TabsContent value="connections">
          <div className="space-y-4">
            <ConnectionManager
              accountId={accountId}
              account={account ?? undefined}
              connections={account?.connections}
              onShowInstalledAddons={() => handleTabChange('addons')}
            />

          </div>
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
              accountAuthKey={account ? getStremioAuthKey(account) : ''}
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

      <BulkUrlReplaceDialog
        open={bulkUrlReplaceOpen}
        onOpenChange={setBulkUrlReplaceOpen}
        accountId={accountId}
        accountAddons={addons}
        accountName={displayName}
      />

      <AccountPickerDialog
        open={showBulkAccountPicker}
        onOpenChange={setShowBulkAccountPicker}
        title="Clone Addons"
        description="Select accounts to clone the selected addons to."
        onConfirm={handleBulkCloneToAccounts}
        confirmLabel="Clone"
      />

      <ConfirmationDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={`Delete ${selectedAddonUrls.size} Addon${selectedAddonUrls.size !== 1 ? 's' : ''}?`}
        description={
          <>
            Are you sure you want to delete {selectedAddonUrls.size} selected addon{selectedAddonUrls.size !== 1 ? 's' : ''}? This action cannot be undone.
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
        impactItems={deleteConfirmationNames.length > 0 ? deleteConfirmationNames : undefined}
      />

      <ConfirmationDialog
        open={showClearAllConfirm}
        onOpenChange={setShowClearAllConfirm}
        title="Clear All Addons"
        description={`This will permanently remove all ${account?.addons.length || 0} addons from ${displayName}. This action cannot be undone.`}
        confirmText="Clear All"
        isDestructive={true}
        onConfirm={handleClearAllAddons}
        isLoading={updatingAll}
        disabled={updatingAll}
      />

      <FloatingActionBar
        open={isSelectionMode && selectedAddonUrls.size > 0}
        selectedCount={selectedAddonUrls.size}
        totalCount={filteredAddons.length}
        onClearSelection={() => { setIsSelectionMode(false); setSelectedAddonUrls(new Set()) }}
        actions={[
          {
            label: allEnabled ? 'Disable' : 'Enable',
            icon: allEnabled ? <X className="h-3.5 w-3.5 text-destructive" /> : <Zap className="h-3.5 w-3.5 text-success" />,
            onClick: allEnabled ? handleBulkDisable : handleBulkEnable,
            tooltip: allEnabled ? 'Disable selected' : 'Enable selected',
          },
          {
            label: allProtected ? 'Unprotect' : 'Protect',
            icon: <Shield className={cn("h-3.5 w-3.5", allProtected ? "fill-primary/20 text-primary" : "")} />,
            onClick: allProtected ? handleUnprotectSelected : handleProtectSelected,
            tooltip: allProtected ? 'Unprotect selected' : 'Protect selected',
          },
          {
            label: allHideConfigure ? 'Show Configure' : 'Hide Configure',
            icon: <EyeOff className={cn("h-3.5 w-3.5", allHideConfigure ? "text-primary" : "text-muted-foreground")} />,
            onClick: allHideConfigure ? handleShowConfigureSelected : handleHideConfigureSelected,
            tooltip: allHideConfigure ? 'Show configure button' : 'Hide configure button',
          },
          {
            label: 'Clone',
            icon: <Copy className="h-3.5 w-3.5" />,
            onClick: () => setShowBulkAccountPicker(true),
            disabled: isBulkActionLoading,
            tooltip: 'Clone to other accounts',
          },
          {
            label: 'Deploy to All',
            icon: <Download className="h-3.5 w-3.5" />,
            onClick: handleBulkDeployToAll,
            disabled: isBulkActionLoading,
            tooltip: 'Deploy to all accounts',
          },
          {
            label: `Reinstall (${selectedAddonUrls.size})`,
            icon: <AnimatedUpdateIcon className="h-3.5 w-3.5" isAnimating={updatingAll} />,
            onClick: handleReinstallSelected,
            disabled: updatingAll,
            tooltip: 'Reinstall selected addons',
          },
          {
            label: 'Save',
            icon: <Save className="h-3.5 w-3.5" />,
            onClick: () => setBulkSaveOpen(true),
            tooltip: 'Save to library',
          },
          ...(selectedAddonUrls.size >= 2 ? [{
            label: 'Autopilot',
            icon: <Zap className="h-3.5 w-3.5 text-warning" />,
            onClick: handleCreateRule,
            variant: 'default' as const,
            tooltip: 'Create failover rule',
          }] : []),
          {
            label: 'Delete',
            icon: <Trash2 className="h-3.5 w-3.5" />,
            onClick: handleBulkDeleteClick,
            disabled: updatingAll,
            variant: 'destructive' as const,
            tooltip: 'Delete selected addons',
          },
        ]}
      />

      <ConfirmationDialog
        open={!!profileToDelete}
        onOpenChange={(open) => !open && setProfileToDelete(null)}
        title="Delete Setup?"
        description={`Are you sure you want to delete the setup "${profileToDelete?.name}"? This cannot be undone.`}
        confirmText="Delete"
        isDestructive={true}
        onConfirm={handleDeleteProfile}
      />

      <Dialog open={!!profileToEdit} onOpenChange={(open) => !open && setProfileToEdit(null)}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Rename Setup</DialogTitle>
            <DialogDescription>
              Enter a new name for this setup.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Setup Name</Label>
              <Input
                id="profile-name"
                placeholder="e.g. Kids, Secondary, Test"
                value={profileEditName}
                onChange={(e) => setProfileEditName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="subtle" onClick={() => setProfileToEdit(null)}>Cancel</Button>
            <Button onClick={handleSaveProfile} disabled={profileEditLoading || !profileEditName.trim()}>
              {profileEditLoading ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AccountSetupCreateDialog
        isOpen={isCreateProfileOpen}
        onClose={() => setIsCreateProfileOpen(false)}
        accountName={displayName}
        onConfirm={handleCreateProfileConfirm}
      />
    </div >
  )
}
