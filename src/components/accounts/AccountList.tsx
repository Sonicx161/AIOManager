import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAccounts } from '@/hooks/useAccounts'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
import { RefreshCw, Users, GripHorizontal, Search, X, Layers, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { AccountCard } from './AccountCard'
import { BulkActionsDialog } from './BulkActionsDialog'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { SortableAccountCard } from './SortableAccountCard'

export function AccountList() {
  const openAddAccountDialog = useUIStore((state) => state.openAddAccountDialog)
  const { accounts, error, clearError, syncAllAccounts, removeAccount, loading, reorderAccounts } = useAccounts()
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [showBulkActions, setShowBulkActions] = useState(false)
  const [isReorderMode, setIsReorderMode] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    open: boolean;
    accountIds: string[];
  }>({ open: false, accountIds: [] })

  const [isSelectionMode, setIsSelectionMode] = useState(false)

  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(accountId)) {
        newSet.delete(accountId)
      } else {
        newSet.add(accountId)
      }
      return newSet
    })
  }

  const toggleSelectionMode = () => {
    setIsSelectionMode(!isSelectionMode)
    if (isSelectionMode) {
      setSelectedAccountIds(new Set())
    }
  }

  const selectAll = () => {
    if (selectedAccountIds.size === accounts.length) {
      setSelectedAccountIds(new Set())
    } else {
      setSelectedAccountIds(new Set(accounts.map((a) => a.id)))
    }
  }

  const clearSelection = () => {
    setSelectedAccountIds(new Set())
  }

  const handleDeleteSelected = () => {
    setDeleteConfirmation({
      open: true,
      accountIds: Array.from(selectedAccountIds)
    })
  }

  const confirmDelete = async () => {
    const ids = deleteConfirmation.accountIds
    for (const id of ids) {
      await removeAccount(id)
    }
    setDeleteConfirmation({ open: false, accountIds: [] })
    clearSelection()
  }

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 3,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = accounts.findIndex((a) => a.id === active.id)
      const newIndex = accounts.findIndex((a) => a.id === over.id)

      const newAccounts = arrayMove(accounts, oldIndex, newIndex)

      // Optimistic update handled by store if we pass new order immediately
      const newOrderIds = newAccounts.map(a => a.id)
      await reorderAccounts(newOrderIds)
    }
  }

  const filteredAccounts = accounts.filter((a) => {
    const query = searchQuery.toLowerCase().trim()
    if (!query) return true
    return (
      a.name.toLowerCase().includes(query) ||
      a.email?.toLowerCase().includes(query)
    )
  })

  const selectedAccounts = accounts.filter((a) => selectedAccountIds.has(a.id))

  const checkRules = useFailoverStore((state) => state.checkRules)

  const handleRefreshAll = async () => {
    await syncAllAccounts()
    // Trigger immediate failover check/self-healing after sync
    await checkRules()
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4 text-center animate-in fade-in slide-in-from-bottom-4">
        <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mb-6">
          <Users className="h-10 w-10 text-muted-foreground" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight mb-2">No accounts connected</h2>
        <p className="text-muted-foreground max-w-sm mb-8">
          Manage multiple Stremio accounts from a single dashboard. Securely add your first account to get started.
        </p>
        <Button size="lg" onClick={() => openAddAccountDialog()} className="px-8">
          Add Stremio Account
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded-md flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-destructive hover:text-destructive/80">
            ✕
          </button>
        </div>
      )}

      {/* Bulk Actions Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-card border rounded-md p-3 gap-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
          <span className="text-sm font-medium whitespace-nowrap text-foreground">
            {selectedAccountIds.size} of {accounts.length} selected
          </span>
          <div className="relative w-full sm:w-64 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              className="pl-9 h-9 text-xs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-search-focus
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 hover:bg-transparent text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery('')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          {isSelectionMode && (
            <Button variant="outline" size="sm" onClick={selectAll} className="flex-1 sm:flex-none">
              {selectedAccountIds.size === accounts.length && accounts.length > 0 ? 'Deselect All' : `Select All (${accounts.length})`}
            </Button>
          )}
          {selectedAccountIds.size > 0 && (
            <>
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDeleteSelected}
                className="flex-1 sm:flex-none"
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                Delete ({selectedAccountIds.size})
              </Button>
              <Button
                size="sm"
                onClick={() => setShowBulkActions(true)}
                className="flex-1 sm:flex-none"
              >
                <Layers className="h-4 w-4 mr-1.5" />
                Bulk Actions
              </Button>
            </>
          )}
          {!isSelectionMode && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefreshAll}
                disabled={loading || accounts.length === 0}
                className="flex-1 sm:flex-none"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                variant={isReorderMode ? "secondary" : "outline"}
                onClick={() => {
                  setIsReorderMode(!isReorderMode)
                  if (isSelectionMode) toggleSelectionMode()
                }}
                disabled={accounts.length < 2}
                className="flex-1 sm:flex-none"
              >
                <GripHorizontal className="h-4 w-4 mr-2" />
                {isReorderMode ? 'Done' : 'Reorder'}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant={isSelectionMode ? "secondary" : "outline"}
            onClick={toggleSelectionMode}
            className="flex-1 sm:flex-none"
          >
            {isSelectionMode ? 'Cancel' : 'Select'}
          </Button>
          {!isSelectionMode && (
            <Button size="sm" onClick={() => openAddAccountDialog()} className="flex-1 sm:flex-none">
              Add Account
            </Button>
          )}
        </div>
      </div>

      {isReorderMode ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={filteredAccounts.map(a => a.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAccounts.map((account) => (
                <SortableAccountCard
                  key={account.id}
                  account={account}
                  isSelected={selectedAccountIds.has(account.id)}
                  onToggleSelect={toggleAccountSelection}
                  onDelete={() => setDeleteConfirmation({ open: true, accountIds: [account.id] })}
                  isSelectionMode={isSelectionMode}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAccounts.length === 0 && searchQuery ? (
            <div className="col-span-full py-20 text-center animate-in fade-in zoom-in-95">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                <Search className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold">No accounts found</h3>
              <p className="text-sm text-muted-foreground">No matches for "{searchQuery}"</p>
              <Button variant="link" onClick={() => setSearchQuery('')} className="mt-2">
                Clear search
              </Button>
            </div>
          ) : (
            filteredAccounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                isSelected={selectedAccountIds.has(account.id)}
                onToggleSelect={toggleAccountSelection}
                onDelete={() => setDeleteConfirmation({ open: true, accountIds: [account.id] })}
                isSelectionMode={isSelectionMode}
              />
            ))
          )}
        </div>
      )}

      {/* Bulk Actions Dialog */}
      <Dialog open={showBulkActions} onOpenChange={setShowBulkActions}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Actions</DialogTitle>
          </DialogHeader>
          <BulkActionsDialog
            selectedAccounts={selectedAccounts}
            allAccounts={accounts}
            onClose={() => {
              setShowBulkActions(false)
              clearSelection()
            }}
          />
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={deleteConfirmation.open}
        onOpenChange={(open) => setDeleteConfirmation(prev => ({ ...prev, open }))}
        title={`Delete ${deleteConfirmation.accountIds.length > 1 ? `${deleteConfirmation.accountIds.length} Accounts` : 'Account'}`}
        description={`Are you sure you want to delete ${deleteConfirmation.accountIds.length > 1 ? 'these accounts' : 'this account'}? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive={true}
        isLoading={loading}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
