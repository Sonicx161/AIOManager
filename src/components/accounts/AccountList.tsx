import { Button } from '@/components/ui/button'
import type { SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import { ACCOUNT_CONTEXT_ALL_ACCOUNTS_UPDATE } from '@/lib/account-contexts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { AlertCircle, Search, Trash2, RefreshCw, RefreshCcw, Users, GripHorizontal, X, Layers, Check, ChevronDown, ArrowUpCircle, Loader2, LayoutGrid, List, Plus, History } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useState, useRef, useMemo, useCallback, lazy, Suspense, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { AccountCard } from './AccountCard'
import { StaggerContainer, StaggerItem } from '@/components/ui/stagger'
import { OffscreenGate } from '@/components/ui/offscreen-gate'
const BatchOperationsDialog = lazy(() => import('./BatchOperationsDialog').then(m => ({ default: m.BatchOperationsDialog })))
import { BULK_ACTION_OPTIONS, type BulkAction } from './bulk-actions/registry'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { useToast } from '@/hooks/use-toast'
import { EmptyState } from '@/components/common/EmptyState'
import { FloatingActionBar } from '@/components/ui/floating-action-bar'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { OperationProgress, type OperationStatus } from '@/components/ui/operation-progress'
import { AnimatedRefreshIcon } from '@/components/ui/AnimatedIcons'
import { checkAddonUpdates } from '@/api/addons'
import { useAddonStore } from '@/store/addonStore'
import { getLatestAddonVersion, isNewerVersion } from '@/lib/utils'
import { mapConcurrent } from '@/lib/concurrency'
import { getPlatformEntry } from '@/lib/platform-registry'
import { useAccountStore, getStremioAuthKey, hasPlatformConnection } from '@/store/accountStore'
import { accountMatchesQuery } from '@/lib/account-compat'
import { useScrollRestoration } from '@/hooks/use-scroll-restoration'
import { useAuthStore } from '@/store/authStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'

import { Skeleton } from '@/components/ui/skeleton'
import { AccountListRow } from './AccountListRow'
import { AccountReorderDialog } from './AccountReorderDialog'

export function AccountList() {
  useScrollRestoration('accounts')
  const openAddAccountDialog = useUIStore((state) => state.openAddAccountDialog)
  const { accounts, error, clearError, syncAllAccounts, syncAccount, removeAccount, loading } = useAccounts()
  const encryptionKey = useAuthStore(state => state.encryptionKey)
  const liveActivity = useUIStore(state => state.liveActivity)
  const ensureActivityLoaded = useLibraryCache(state => state.ensureLoaded)

  useEffect(() => {
    if (!encryptionKey || accounts.length === 0) return
    const load = (refresh = false) => {
      if (document.hidden || useAuthStore.getState().encryptionKey !== encryptionKey) return
      if (refresh && Date.now() - useLibraryCache.getState().lastFetched >= 60_000) useLibraryCache.setState({ isStale: true })
      // The shared cache deduplicates reads and preserves its normal five-minute TTL.
      void ensureActivityLoaded(accounts).catch(() => {})
    }
    load()
    const timer = liveActivity ? setInterval(() => load(true), 60_000) : undefined
    const onVisible = () => load(liveActivity)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [accounts, encryptionKey, liveActivity, ensureActivityLoaded])
  const loadingCount = useAccountStore(state => state.loadingAccounts.size)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<{ status: OperationStatus; current: number; total: number; label: string; detail?: string }>({ status: 'idle', current: 0, total: 0, label: '' })
  const [refreshMenuOpen, setRefreshMenuOpen] = useState(false)
  const [syncingAll, setSyncingAll] = useState(false)
  const { toast } = useToast()

  const handleCheckAllAddonUpdates = async () => {
    if (checkingUpdates) return
    setCheckingUpdates(true)
    const seenUrls = new Set<string>()
    const allAddons = accounts.flatMap(account => account.addons).filter(addon => {
      if (seenUrls.has(addon.transportUrl)) return false
      seenUrls.add(addon.transportUrl)
      return true
    })

    setUpdateProgress({ status: 'running', current: 0, total: allAddons.length, label: 'Checking for updates', detail: `Scanning ${allAddons.length} addons across ${accounts.length} accounts...` })
    try {
            const updateInfoList = await checkAddonUpdates(allAddons, ACCOUNT_CONTEXT_ALL_ACCOUNTS_UPDATE, (current, total) => {
        setUpdateProgress({ status: 'running', current, total, label: 'Checking for updates', detail: `${current} of ${total} addons checked` })
      })
      const versions: Record<string, string> = {}
      const hints: Record<string, SavedAddonManifestChangeSummary> = {}
      updateInfoList.forEach((info) => {
        versions[info.versionKey] = info.latestVersion
        versions[info.addonId] = info.latestVersion
        if (info.hasManifestShapeChange && info.manifestChanges) {
          hints[info.versionKey] = info.manifestChanges
          hints[info.addonId] = info.manifestChanges
        }
      })
      useAddonStore.getState().updateLatestVersions(versions)
      useAddonStore.getState().updateManifestChangeHints(hints)
      const updatesCount = updateInfoList.filter((info) => info.hasUpdate).length
      const desc = updatesCount > 0 ? `${updatesCount} addon${updatesCount !== 1 ? 's have' : ' has'} updates available` : 'All addons are up to date'
      setUpdateProgress({ status: 'complete', current: allAddons.length, total: allAddons.length, label: 'Update check complete', detail: desc })
      setTimeout(() => setUpdateProgress({ status: 'idle', current: 0, total: 0, label: '' }), 3000)
      toast({ title: 'Update Check Complete', description: 'All account addons have been checked for updates.' })
    } catch (err) {
      setUpdateProgress({ status: 'error', current: 0, total: allAddons.length, label: 'Update check failed', detail: 'Failed to check for addon updates' })
      setTimeout(() => setUpdateProgress({ status: 'idle', current: 0, total: 0, label: '' }), 5000)
      toast({ title: 'Update Check Failed', variant: 'destructive' })
    } finally {
      setCheckingUpdates(false)
    }
  }

  const latestVersions = useAddonStore((state) => state.latestVersions)

  const totalUpdateCount = useMemo(() =>
    accounts.reduce((total, account) =>
      total + account.addons.filter(addon => {
        const latest = getLatestAddonVersion(latestVersions, addon)
        return latest && isNewerVersion(addon.manifest.version, latest)
      }).length,
      0),
    [accounts, latestVersions])

  const totalChangelogCount = useAccountStore(
    useShallow((state) => state.changelog.filter(
      e => Date.now() - new Date(e.timestamp).getTime() < 24 * 60 * 60 * 1000
    ).length)
  )

  const [updatingAll, setUpdatingAll] = useState(false)

  const handleUpdateAll = async () => {
    if (updatingAll) return
    setUpdatingAll(true)
    setUpdateProgress({ status: 'running', current: 0, total: 0, label: 'Updating addons', detail: 'Collecting addons to update...' })
    try {
      const updatableUrls = new Set<string>()
      const accountsWithUpdates: { id: string; authKey: string }[] = []

      for (const account of accounts) {
        const addonsToUpdate = account.addons.filter(addon => {
          const latest = getLatestAddonVersion(latestVersions, addon)
          return latest && isNewerVersion(addon.manifest.version, latest)
        })
        if (addonsToUpdate.length > 0) {
          accountsWithUpdates.push({ id: account.id, authKey: getStremioAuthKey(account) })
          addonsToUpdate.forEach(a => updatableUrls.add(a.transportUrl))
        }
      }

      if (updatableUrls.size === 0) {
        toast({ title: 'No Updates', description: 'All addons are up to date.' })
        return
      }

      setUpdateProgress({ status: 'running', current: 0, total: accountsWithUpdates.length, label: 'Updating addons', detail: `Reinstalling across ${accountsWithUpdates.length} account${accountsWithUpdates.length !== 1 ? 's' : ''}...` })

      const result = await useAddonStore.getState().bulkReinstallAddons(
        Array.from(updatableUrls),
        accountsWithUpdates,
        true,
        (current, total) => setUpdateProgress({ status: 'running', current, total, label: 'Updating addons', detail: `${current} of ${total} accounts processed` })
      )

      setUpdateProgress({ status: 'complete', current: accountsWithUpdates.length, total: accountsWithUpdates.length, label: 'Updates complete', detail: `Updated ${result.success} account${result.success !== 1 ? 's' : ''}` })
      setTimeout(() => setUpdateProgress({ status: 'idle', current: 0, total: 0, label: '' }), 3000)

      toast({
        title: 'Updates Complete',
        description: `Updated ${result.success} account${result.success !== 1 ? 's' : ''}${result.failed > 0 ? ` (${result.failed} failed)` : ''}`,
      })
    } catch (err) {
      setUpdateProgress({ status: 'error', current: 0, total: 0, label: 'Update failed', detail: 'Failed to update addons' })
      setTimeout(() => setUpdateProgress({ status: 'idle', current: 0, total: 0, label: '' }), 5000)
      toast({ title: 'Update Failed', variant: 'destructive' })
    } finally {
      setUpdatingAll(false)
    }
  }

  const handleClearAllChangelog = async () => {
    try {
      await useAccountStore.getState().clearChangelog()
      toast({ title: 'Notifications Cleared', description: 'All changelog notifications have been dismissed.' })
    } catch {
      toast({ title: 'Clear Failed', variant: 'destructive' })
    }
  }

  const handleSearchChange = (val: string) => {
    setSearchQuery(val)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearchQuery(val)
    }, 150)
  }

  const [showBulkActions, setShowBulkActions] = useState(false)
  const [bulkInitialAction, setBulkInitialAction] = useState<string | undefined>(undefined)
  const [reorderDialogOpen, setReorderDialogOpen] = useState(false)

  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const bulkParam = searchParams.get('bulk')
    if (!bulkParam) return
    setSearchParams({}, { replace: true })
    if (!BULK_ACTION_OPTIONS.includes(bulkParam as BulkAction)) return
    setBulkInitialAction(bulkParam)
    setIsSelectionMode(true)
    setShowBulkActions(true)
  }, [searchParams, setSearchParams])
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    open: boolean;
    accountIds: string[];
  }>({ open: false, accountIds: [] })
  const [deleting, setDeleting] = useState(false)
  const maskedAccountLabel = useMaskedAccountLabel()
  const autopilotRules = useFailoverStore(state => state.rules)

  const deleteConfirmationDetails = useMemo(() => {
    return deleteConfirmation.accountIds.map(id => {
      const account = accounts.find(a => a.id === id)
      return account ? { account, name: maskedAccountLabel(account), ruleCount: autopilotRules.filter(rule => rule.accountId === account.id).length, connectionCount: (account.connections || []).length } : null
    }).filter(Boolean)
  }, [deleteConfirmation.accountIds, accounts, maskedAccountLabel, autopilotRules])

  const deletingMultiple = deleteConfirmation.accountIds.length > 1
  const deleteSubject = deletingMultiple
    ? `${deleteConfirmation.accountIds.length} accounts`
    : deleteConfirmationDetails[0]?.name || 'this account'
  const totalRulesInDeletion = deleteConfirmationDetails.reduce((sum, d) => sum + (d?.ruleCount || 0), 0)
  const totalConnectionsInDeletion = deleteConfirmationDetails.reduce((sum, d) => sum + (d?.connectionCount || 0), 0)

  const [isSelectionMode, setIsSelectionMode] = useState(false)
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const accountsView = useUIStore((state) => state.accountsView)
  const setAccountsView = useUIStore((state) => state.setAccountsView)
  const expiredAccounts = useMemo(() => accounts.filter(account => account.status === 'expired'), [accounts])
  const isSessionExpiredError = error ? /session does not exist|session.*expired|invalid.*auth|auth.*expired|unauthorized/i.test(error) : false
  const firstExpiredAccount = expiredAccounts[0]
  const expiredPlatformLabel = useMemo(() => {
    const names = new Set<string>()
    for (const account of expiredAccounts) {
      const failing = (account.connections || []).filter(c => c.status === 'expired' || c.status === 'error')
      if (failing.length === 0) {
        names.add(hasPlatformConnection(account) ? 'Stremio' : 'Account')
      } else {
        for (const c of failing) names.add(getPlatformEntry(c.platform)?.name || c.platform)
      }
    }
    return names.size === 1 ? [...names][0] : null
  }, [expiredAccounts])

  const toggleAccountSelection = useCallback((accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(accountId)) {
        newSet.delete(accountId)
      } else {
        newSet.add(accountId)
      }
      return newSet
    })
  }, [])

  const toggleSelectionMode = () => {
    const nextSelectionMode = !(isSelectionMode || selectedAccountIds.size > 0)
    setIsSelectionMode(nextSelectionMode)
    if (!nextSelectionMode) {
      setSelectedAccountIds(new Set())
    }
  }

  const selectAll = () => {
    if (selectedAccountIds.size === filteredAccounts.length) {
      setSelectedAccountIds(new Set())
    } else {
      setSelectedAccountIds(new Set(filteredAccounts.map((a) => a.id)))
    }
  }

  const clearSelection = () => {
    setSelectedAccountIds(new Set())
  }

  const handleDeleteSingle = useCallback((accountId: string) => {
    setDeleteConfirmation({ open: true, accountIds: [accountId] })
  }, [])

  const handleDeleteSelected = () => {
    setDeleteConfirmation({
      open: true,
      accountIds: Array.from(selectedAccountIds)
    })
  }

  const confirmDelete = async () => {
    const ids = deleteConfirmation.accountIds
    setDeleting(true)
    try {
      await Promise.all(ids.map(id => removeAccount(id)))
      setDeleteConfirmation({ open: false, accountIds: [] })
      clearSelection()
    } catch {
      toast({ variant: 'destructive', title: 'Could not delete', description: `Could not delete ${deleteSubject}. Check the account list and try again.` })
    } finally {
      setDeleting(false)
    }
  }



  const filteredAccounts = useMemo(() => {
    const query = debouncedSearchQuery.toLowerCase().trim()
    if (!query) return accounts
    return accounts.filter(a => {
      if (accountMatchesQuery(a, query)) return true
      if (a.status === 'expired' && 'expired'.includes(query)) return true
      if (a.status === 'error' && ('error'.includes(query) || 'failed'.includes(query))) return true
      if (a.connections?.some(c => c.platform.toLowerCase().includes(query))) return true
      if (hasPlatformConnection(a) && 'stremio'.includes(query)) return true
      return false
    })
  }, [accounts, debouncedSearchQuery])

  const checkRules = useFailoverStore((state) => state.checkRules)
  const isSelectionActive = isSelectionMode || selectedAccountIds.size > 0
  // The 2-per-row pairing rule for the narrow toolbar grid - see accountsToolbarButtonCount.
  // Update All renders col-span-full above the grid, so it never joins the pairing pool.
  const accountsToolbarButtonCount = 3
    + (totalChangelogCount > 0 ? 1 : 0)
    + (accounts.length >= 2 ? 1 : 0)
  const addAccountSpansFull = accountsToolbarButtonCount % 2 === 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && !isSelectionActive) {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isSelectionActive])

  const handleRefreshAll = async () => {
    await syncAllAccounts()
    await checkRules()
  }

  const handleSyncAllAccounts = async () => {
    if (syncingAll || accounts.length === 0) return
    setSyncingAll(true)
    toast({ title: 'Syncing all accounts...', description: `Force syncing ${accounts.length} account${accounts.length !== 1 ? 's' : ''}` })
    let succeeded = 0
    let failed = 0
    try {
      await mapConcurrent(accounts, 5, async (account) => {
        try {
          await syncAccount(account.id, true, 'user')
          succeeded += 1
        } catch {
          failed += 1
        }
      })
      if (failed > 0) {
        toast({ variant: 'destructive', title: 'Sync Incomplete', description: `Synced ${succeeded} of ${accounts.length} accounts (${failed} failed)` })
      } else {
        toast({ title: 'Sync Complete', description: `Synced ${succeeded} of ${accounts.length} accounts` })
      }
    } finally {
      setSyncingAll(false)
    }
  }

  if (loading && accounts.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4 text-center animate-in fade-in slide-in-from-bottom-4">
        <div className="relative w-20 h-20 flex items-center justify-center mb-6">
          <SquircleOverlay />
          <Users className="relative z-10 h-9 w-9 text-muted-foreground" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight mb-2">No accounts connected</h2>
        <p className="text-muted-foreground max-w-sm mb-8">
          Manage all your streaming platforms from a single dashboard. Securely add your first account to get started.
        </p>
        <Button size="lg" onClick={() => openAddAccountDialog()} className="px-8">
          Add Account
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div data-theme-tone="status" data-theme-part="panel" className={`${isSessionExpiredError ? 'border-warning/35 bg-warning/10 text-warning' : 'border-destructive/35 bg-destructive/10 text-destructive'} rounded-xl border px-4 py-3`}>
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-semibold">
                {isSessionExpiredError ? (expiredPlatformLabel ? `${expiredPlatformLabel} session expired` : 'Session expired') : 'Account sync failed'}
              </p>
              <p className="text-xs opacity-85">
                {isSessionExpiredError
                  ? (expiredPlatformLabel
                    ? `${expiredPlatformLabel} rejected a stored token. Re-authenticate this account to refresh it.`
                    : 'Session tokens were rejected. Re-authenticate the affected accounts to refresh them.')
                  : error}
              </p>
              {isSessionExpiredError && firstExpiredAccount && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    openAddAccountDialog(firstExpiredAccount)
                  }}
                  className="mt-2 h-8 border-warning/35 bg-background/60 text-warning hover:bg-warning/10"
                >
                  Fix {expiredAccounts.length > 1 ? `${expiredAccounts.length} expired accounts` : 'expired account'}
                </Button>
              )}
            </div>
            <button data-theme-part="button" onClick={clearError} className="rounded-full p-1 opacity-70 transition-opacity hover:opacity-100" aria-label="Dismiss account error">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {isSessionExpiredError && !firstExpiredAccount && (
            <p className="mt-2 text-xs opacity-75">If this keeps appearing, run Refresh and re-authenticate any account that changes to Session expired.</p>
          )}
        </div>
      )}


      <ToolbarShell contentClassName="gap-2 sm:gap-3">

        <div className="grid w-full grid-cols-[1fr_auto] items-center gap-2 sm:flex sm:w-auto sm:flex-none">
          <div className="relative flex-1 sm:w-72 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              placeholder="Search accounts..."
              className="pl-9 pr-9 h-8 text-xs bg-muted/30 border border-border/40 focus:bg-muted/40 transition-colors w-full"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              data-search-focus
            />
            {searchQuery && (
              <button
                data-theme-part="button"
                onClick={() => handleSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 hover:bg-accent rounded-full transition-colors focus:outline-none"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <div data-theme-part="tabs-list" className="flex items-center bg-muted/50 rounded-lg p-0.5 border border-border/40 gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              data-theme-part="tab"
              data-state={accountsView === 'grid' ? 'active' : 'inactive'}
              className={`h-8 w-8 rounded-lg p-0 ${accountsView === 'grid' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAccountsView('grid')}
              aria-label="Grid view"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-theme-part="tab"
              data-state={accountsView === 'list' ? 'active' : 'inactive'}
              className={`h-8 w-8 rounded-lg p-0 ${accountsView === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAccountsView('list')}
              aria-label="List view"
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>


        <div className="grid w-full grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:w-auto sm:flex-wrap shrink-0">
          {!isSelectionActive && (
            <>
              <DropdownMenu open={refreshMenuOpen || checkingUpdates || syncingAll} onOpenChange={(o) => { if (!checkingUpdates && !syncingAll) setRefreshMenuOpen(o) }}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-1.5 h-8 text-xs font-medium sm:w-auto"
                    disabled={loading || accounts.length === 0}
                  >
                    <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={loading} />
                    <span>Refresh</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" collisionPadding={16} className="w-64 max-w-[calc(100vw-2rem)] p-1.5">
                  <DropdownMenuItem
                    onClick={handleRefreshAll}
                    disabled={loading}
                    className="py-2.5 px-3 rounded-lg gap-2 text-sm font-medium"
                  >
                    <RefreshCw className={`h-4 w-4 shrink-0 ${loading ? 'animate-spin' : ''}`} />
                    Refresh Addon Lists
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleSyncAllAccounts}
                    disabled={syncingAll || loading}
                    keepOpen
                    className="py-2.5 px-3 rounded-lg gap-2 text-sm font-medium"
                  >
                    {syncingAll
                      ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      : <RefreshCcw className="h-4 w-4 shrink-0" />
                    }
                    {syncingAll ? 'Syncing all accounts...' : 'Sync All Accounts'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleCheckAllAddonUpdates}
                    disabled={checkingUpdates}
                    keepOpen
                    className="py-2.5 px-3 rounded-lg gap-2 text-sm font-medium"
                  >
                    {checkingUpdates
                      ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                      : <ArrowUpCircle className="h-4 w-4 shrink-0" />
                    }
                    {checkingUpdates ? 'Checking for updates...' : 'Check for Addon Updates'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {totalUpdateCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleUpdateAll}
                  disabled={updatingAll}
                  className="order-first col-span-full w-full gap-1.5 h-8 text-xs font-medium sm:order-none sm:col-span-auto sm:w-auto sm:flex-none"
                >
                  {updatingAll
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ArrowUpCircle className="h-3.5 w-3.5" />
                  }
                  {updatingAll ? 'Updating...' : `Update All (${totalUpdateCount})`}
                </Button>
              )}

              {totalChangelogCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleClearAllChangelog}
                  className="w-full gap-1.5 h-8 text-xs font-medium sm:w-auto"
                >
                  <History className="h-3.5 w-3.5" />
                  Clear All ({totalChangelogCount})
                </Button>
              )}
              {accounts.length >= 2 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1.5 h-8 text-xs font-medium sm:w-auto"
                  onClick={() => setReorderDialogOpen(true)}
                >
                  <GripHorizontal className="h-3.5 w-3.5" />
                  <span>Reorder</span>
                </Button>
              )}
            </>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={toggleSelectionMode}
            className={`ml-0 w-full gap-1.5 h-8 text-xs font-medium ${isSelectionActive ? 'col-span-full' : ''} sm:w-auto sm:col-span-auto`}
          >
            {isSelectionActive ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            <span>{isSelectionActive ? 'Cancel' : 'Select'}</span>
          </Button>
          {!isSelectionActive && (
            <Button size="sm" className={`w-full gap-1.5 h-8 text-xs font-medium ${addAccountSpansFull ? 'col-span-full' : ''} sm:w-auto sm:col-span-auto`} onClick={() => openAddAccountDialog()}>
              <Plus className="h-3.5 w-3.5" />
              <span className="sm:hidden">Add</span>
              <span className="hidden sm:inline">Add Account</span>
            </Button>
          )}
        </div>
      </ToolbarShell>

      {loading && accounts.length > 0 && (
        <OperationProgress
          status="running"
          current={Math.max(0, accounts.length - loadingCount)}
          total={accounts.length}
          label={`Syncing ${Math.max(0, accounts.length - loadingCount)} of ${accounts.length} accounts`}
          detail={loadingCount > 0 ? `${loadingCount} ${loadingCount === 1 ? 'account' : 'accounts'} remaining` : 'Finishing up...'}
          className="mt-2"
        />
      )}

      <OperationProgress
        status={updateProgress.status}
        current={updateProgress.current}
        total={updateProgress.total}
        label={updateProgress.label}
        detail={updateProgress.detail}
        className="mt-2"
      />


      <FloatingActionBar
        open={selectedAccountIds.size > 0}
        selectedCount={selectedAccountIds.size}
        totalCount={accounts.length}
        onClearSelection={() => { setSelectedAccountIds(new Set()); setIsSelectionMode(false) }}
        actions={[
          {
            label: selectedAccountIds.size === accounts.length ? 'Deselect All' : 'Select All',
            onClick: selectAll,
            variant: 'outline',
            icon: <Check className="h-4 w-4" />,
            tooltip: selectedAccountIds.size === accounts.length ? 'Deselect all accounts' : 'Select all accounts',
          },
          {
            label: 'Bulk Actions',
            onClick: () => setShowBulkActions(true),
            variant: 'outline',
            icon: <Layers className="h-4 w-4" />,
            tooltip: 'Open bulk actions',
          },
          {
            label: `Delete (${selectedAccountIds.size})`,
            onClick: handleDeleteSelected,
            variant: 'destructive',
            icon: <Trash2 className="h-4 w-4" />,
            tooltip: 'Delete selected accounts',
          },
        ]}
      />

      <div data-theme-part="panel" className="rounded-2xl border border-border/40 bg-card/40 p-3 shadow-sm">
      {accountsView === 'list' ? (
        <div className="flex flex-col gap-2">
          {filteredAccounts.length === 0 && searchQuery ? (
            <EmptyState
              className="animate-in fade-in zoom-in-95"
              icon={<Search className="text-muted-foreground" />}
              title="No accounts found"
              description={`No matches for "${searchQuery}"`}
              action={
                <Button variant="link" onClick={() => handleSearchChange('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            filteredAccounts.map((account) => (
              <OffscreenGate key={account.id} className="content-auto-account-row">
                <AccountListRow
                  account={account}
                  isPrivacyMode={isPrivacyModeEnabled}
                  isSelected={selectedAccountIds.has(account.id)}
                  isSelectionMode={isSelectionActive}
                  onToggleSelect={toggleAccountSelection}
                  onDelete={handleDeleteSingle}
                />
              </OffscreenGate>
            ))
          )}
        </div>
      ) : (
        <StaggerContainer className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredAccounts.length === 0 && searchQuery ? (
            <EmptyState
              className="col-span-full animate-in fade-in zoom-in-95"
              icon={<Search className="text-muted-foreground" />}
              title="No accounts found"
              description={`No matches for "${searchQuery}"`}
              action={
                <Button variant="link" onClick={() => handleSearchChange('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <>
              {filteredAccounts.map((account) => (
                <StaggerItem key={account.id} contentAutoClass="content-auto-account-card">
                  <AccountCard
                    account={account}
                    isSelected={selectedAccountIds.has(account.id)}
                    onToggleSelect={toggleAccountSelection}
                    onLongPress={toggleAccountSelection}
                    onDelete={handleDeleteSingle}
                    isSelectionMode={isSelectionActive}
                    isPrivacyMode={isPrivacyModeEnabled}
                  />
                </StaggerItem>
              ))}
            </>
          )}
        </StaggerContainer>
      )}
      </div>

      <AccountReorderDialog
        accounts={accounts}
        open={reorderDialogOpen}
        onOpenChange={setReorderDialogOpen}
        isPrivacyMode={isPrivacyModeEnabled}
      />


      <Dialog open={showBulkActions} onOpenChange={setShowBulkActions}>
        <DialogContent className="max-h-[92vh] sm:max-w-3xl lg:max-w-5xl flex flex-col overflow-hidden p-0 gap-0">
          <DialogHeader className="px-6 pb-2 pt-6 pr-16 sm:pr-6">
            <DialogTitle>Bulk Actions</DialogTitle>
            <DialogDescription>
              Apply installs, syncs, removals, and protection changes across selected accounts.
            </DialogDescription>
          </DialogHeader>
          <Suspense fallback={<div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
            <BatchOperationsDialog
              selectedAccounts={accounts.filter((a) => selectedAccountIds.has(a.id))}
              allAccounts={accounts}
              initialAction={bulkInitialAction as BulkAction | undefined}
              onClose={() => {
                setShowBulkActions(false)
                setBulkInitialAction(undefined)
                clearSelection()
              }}
            />
          </Suspense>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={deleteConfirmation.open}
        onOpenChange={(open) => { if (!deleting) setDeleteConfirmation(prev => ({ ...prev, open })) }}
        title={`Delete ${deletingMultiple ? `${deleteConfirmation.accountIds.length} Accounts` : 'Account'}`}
        description={`Removes ${deleteSubject} from AIOManager, including ${deletingMultiple ? 'their' : 'its'} Autopilot rules and watch history here. Addons on Stremio and your other apps stay as they are. This cannot be undone.`}
        confirmText="Delete"
        isDestructive={true}
        isLoading={deleting}
        onConfirm={confirmDelete}
        impactItems={[
          ...(totalRulesInDeletion > 0 ? [`${totalRulesInDeletion} Autopilot rule${totalRulesInDeletion !== 1 ? 's' : ''}`] : []),
          ...(totalConnectionsInDeletion > 0 ? [`${totalConnectionsInDeletion} connection${totalConnectionsInDeletion !== 1 ? 's' : ''} signed out`] : []),
        ]}
      />
    </div>
  )
}
