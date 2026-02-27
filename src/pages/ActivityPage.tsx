import { ActivityFeed } from '@/components/activity/ActivityFeed'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ActivityItem } from '@/types/activity'
import { useAccountStore } from '@/store/accountStore'
import { useLibraryCache } from '@/store/libraryCache'
import { stremioClient } from '@/api/stremio-client'
import { decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { ActivityPageSkeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FloatingActionBar } from '@/components/ui/floating-action-bar'

import { Grid, List, Search, Check, Activity, X } from 'lucide-react'
import { AnimatedRefreshIcon, AnimatedTrashIcon } from '@/components/ui/AnimatedIcons'
import { useEffect, useState, useMemo, useRef } from 'react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Progress } from '@/components/ui/progress'

export function ActivityPage() {
    const { accounts } = useAccountStore()
    const {
        items: history,
        ensureLoaded,
        loading,
        loadingProgress,
        invalidate: fetchActivityFull,
        removeItems
    } = useLibraryCache()

    // Map useLibraryCache functions to original b06e names for UI compatibility
    const fetchActivity = async (silent = false) => {
        if (!silent) {
            fetchActivityFull() // Invalidate
            await ensureLoaded(accounts) // Re-fetch immediately
        }
    }

    const [searchInput, setSearchInput] = useState('')
    const [searchTerm, setSearchTerm] = useState('')
    const searchInputRef = useRef<HTMLInputElement>(null)

    // Debounce search input
    useEffect(() => {
        const timer = setTimeout(() => {
            setSearchTerm(searchInput)
        }, 200)
        return () => clearTimeout(timer)
    }, [searchInput])

    const [userFilter, setUserFilter] = useState('all')
    const [timeFilter, setTimeFilter] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('activity-time-filter') || 'all'
        }
        return 'all'
    })
    const [customStartDate, setCustomStartDate] = useState<string>(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('activity-since-date') || ''
        }
        return ''
    })
    const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('activity-view-mode')
            return saved === 'list' ? 'list' : 'grid'
        }
        return 'grid'
    })
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
    const [showDeleteDialog, setShowDeleteDialog] = useState(false)
    const [isBulkMode, setIsBulkMode] = useState(false)

    useEffect(() => {
        if (accounts.length > 0) {
            ensureLoaded(accounts)
        }
    }, [accounts, ensureLoaded])

    const orderedAccounts = accounts

    // Get unique accounts from history and sort by account store order
    const accountOptions = useMemo(() => {
        const accountMap = new Map<string, { id: string; name: string; colorIndex: number }>()
        history.forEach(item => {
            if (!accountMap.has(item.accountId)) {
                accountMap.set(item.accountId, {
                    id: item.accountId,
                    name: item.accountName,
                    colorIndex: item.accountColorIndex
                })
            }
        })

        return Array.from(accountMap.values()).sort((a, b) => {
            const indexA = orderedAccounts.findIndex(acc => acc.id === a.id)
            const indexB = orderedAccounts.findIndex(acc => acc.id === b.id)
            if (indexA === -1) return 1
            if (indexB === -1) return -1
            return indexA - indexB
        })
    }, [history, orderedAccounts])

    // Filter history based on search, user filter and time filter
    const filteredHistory = useMemo(() => {
        const now = new Date().getTime()
        const oneDay = 24 * 60 * 60 * 1000
        const sevenDays = 7 * oneDay
        const thirtyDays = 30 * oneDay

        return history.filter(item => {
            // User filter
            if (userFilter !== 'all' && item.accountId !== userFilter) {
                return false
            }
            // Time filter
            const itemTime = new Date(item.timestamp).getTime()
            if (timeFilter === '24h' && now - itemTime > oneDay) return false
            if (timeFilter === '7d' && now - itemTime > sevenDays) return false
            if (timeFilter === '30d' && now - itemTime > thirtyDays) return false
            if (timeFilter === 'since' && customStartDate) {
                const sinceTime = new Date(customStartDate).getTime()
                if (itemTime < sinceTime) return false
            }

            // Search filter
            if (searchTerm.trim()) {
                const searchLower = searchTerm.toLowerCase()
                return item.name.toLowerCase().includes(searchLower)
            }
            return true
        })
    }, [history, userFilter, searchTerm, timeFilter, customStartDate])

    // Session stats comparison
    const sessionComparison = useMemo(() => {
        const now = new Date().getTime()
        const oneDay = 24 * 60 * 60 * 1000

        const watchedToday = history
            .filter(item => now - new Date(item.timestamp).getTime() < oneDay)
            .reduce((acc, item) => acc + (item.watched || 0), 0)

        const watchedYesterday = history
            .filter(item => {
                const diff = now - new Date(item.timestamp).getTime()
                return diff > oneDay && diff < 2 * oneDay
            })
            .reduce((acc, item) => acc + (item.watched || 0), 0)

        const diff = watchedToday - watchedYesterday
        const percent = watchedYesterday > 0 ? (diff / watchedYesterday) * 100 : 0

        return {
            todayHrs: Math.round(watchedToday / 3600000 * 10) / 10,
            percent: Math.round(percent),
            isUp: diff > 0
        }
    }, [history])

    const handleViewModeChange = (mode: 'grid' | 'list') => {
        setViewMode(mode)
        if (typeof window !== 'undefined') {
            localStorage.setItem('activity-view-mode', mode)
        }
    }


    const handleToggleSelect = (itemId: string | string[]) => {
        const ids = Array.isArray(itemId) ? itemId : [itemId]
        setSelectedItems(prev => {
            const newSet = new Set(prev)
            const allSelected = ids.every(id => newSet.has(id))
            if (allSelected) {
                ids.forEach(id => newSet.delete(id))
            } else {
                ids.forEach(id => newSet.add(id))
            }
            return newSet
        })
    }

    const handleSelectAll = () => {
        // Select all filtered items
        setSelectedItems(new Set(filteredHistory.map((item: ActivityItem) => item.id)))
    }

    const handleDeselectAll = () => {
        setSelectedItems(new Set())
        setIsBulkMode(false)
    }

    const handleDeleteSelected = async () => {
        if (selectedItems.size === 0) return
        const count = selectedItems.size
        const itemIds = Array.from(selectedItems)
        setShowDeleteDialog(false)
        setSelectedItems(new Set())

        // Remove from display immediately
        removeItems(itemIds)

        // Fire Stremio API calls using items we actually have in cache
        const { encryptionKey } = useAuthStore.getState()
        if (encryptionKey) {
            const itemsToDelete = history.filter(item => itemIds.includes(item.id))
            const itemsByAccount: Record<string, typeof itemsToDelete> = {}
            itemsToDelete.forEach(item => {
                if (!itemsByAccount[item.accountId]) itemsByAccount[item.accountId] = []
                itemsByAccount[item.accountId].push(item)
            })
            for (const [accountId, items] of Object.entries(itemsByAccount)) {
                const account = accounts.find(a => a.id === accountId)
                if (account) {
                    try {
                        const authKey = await decrypt(account.authKey, encryptionKey)
                        await Promise.all(items.map(item =>
                            stremioClient.removeLibraryItem(authKey, item.itemId, account.id)
                                .catch(e => console.error(`Failed to remove ${item.itemId}:`, e))
                        ))
                    } catch (e) {
                        console.error(`Failed to process deletions for account ${accountId}:`, e)
                    }
                }
            }
        }

        toast({
            title: 'Items Deleted',
            description: `${count} item(s) removed from Stremio history.`
        })
    }

    const isSelecting = selectedItems.size > 0 || isBulkMode

    // LOADING STATE
    if (loading) {
        return (
            <div>
                <ActivityPageSkeleton />
                <div className="mt-4 text-center text-sm text-muted-foreground font-mono animate-pulse">
                    {loadingProgress.current > 0 ? `Synced ${loadingProgress.current} of ${loadingProgress.total} accounts` : 'Connecting to Stremio...'}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Activity</h1>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                        <p className="text-muted-foreground">
                            Unified watch history from all your accounts.
                        </p>
                    </div>
                </div>
                {history.length > 0 && (
                    <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-2 text-xs font-bold text-primary bg-primary/10 px-3 py-1.5 rounded-full whitespace-nowrap border border-primary/20">
                            <Activity className="h-3 w-3" />
                            {history.length} items • {Math.round(history.reduce((acc, item) => acc + (item.overallTimeWatched || item.watched || 0), 0) / 3600000)}h total
                            {sessionComparison.todayHrs > 0 && (
                                <span className={cn(
                                    "ml-2 pl-2 border-l border-primary/30",
                                    sessionComparison.isUp ? "text-green-500" : "text-amber-500"
                                )}>
                                    {sessionComparison.isUp ? '↑' : '↓'}{sessionComparison.todayHrs}h today
                                </span>
                            )}
                        </div>
                    </div>
                )}
                {/* Actions Toolbar (Mobile) */}
                <div className="flex md:hidden gap-2 w-full mt-2">
                    <Button
                        variant={isSelecting ? "secondary" : "outline"}
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                            if (isBulkMode || selectedItems.size > 0) handleDeselectAll()
                            else setIsBulkMode(true)
                        }}
                    >
                        <Check className="mr-2 h-4 w-4" />
                        {isSelecting ? 'Cancel' : 'Select'}
                    </Button>
                    <Button size="sm" onClick={() => fetchActivity()} disabled={loading} className="flex-1">
                        <AnimatedRefreshIcon className="mr-2 h-4 w-4" isAnimating={loading} />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* PROGRESS BAR */}
            {
                loading && (
                    <div className="relative h-1 w-full bg-muted overflow-hidden rounded-full">
                        <Progress value={(loadingProgress.current / loadingProgress.total) * 100} className="h-full bg-primary transition-all duration-300" />
                    </div>
                )
            }

            {/* Controls Row */}
            <div className="flex flex-col xl:flex-row gap-3 items-end xl:items-center">
                <div className="flex flex-1 w-full gap-3 flex-col lg:flex-row items-center">
                    {/* Search */}
                    <div className="relative flex-[2] w-full lg:w-auto">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            ref={searchInputRef}
                            placeholder="Search history..."
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            className="pl-10 pr-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors w-full"
                            data-search-focus
                        />
                        {searchInput && (
                            <button
                                onClick={() => setSearchInput('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-accent rounded-full transition-colors focus:outline-none"
                            >
                                <X className="h-4 w-4 text-muted-foreground" />
                            </button>
                        )}
                    </div>

                    <div className="flex flex-1 w-full lg:w-auto gap-3">
                        {/* User Filter - Conditional */}
                        {accountOptions.length > 1 && (
                            <Select value={userFilter} onValueChange={setUserFilter}>
                                <SelectTrigger className="flex-1 lg:w-[150px]">
                                    <SelectValue placeholder="All Users" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Users</SelectItem>
                                    {accountOptions.map(account => (
                                        <SelectItem key={account.id} value={account.id}>
                                            {account.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}

                        {/* Time Filter */}
                        <Select value={timeFilter} onValueChange={(val) => {
                            setTimeFilter(val)
                            localStorage.setItem('activity-time-filter', val)
                        }}>
                            <SelectTrigger className="flex-1 lg:w-[150px]">
                                <SelectValue placeholder="All Time" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Time</SelectItem>
                                <SelectItem value="24h">Last 24 Hours</SelectItem>
                                <SelectItem value="7d">Last 7 Days</SelectItem>
                                <SelectItem value="30d">Last 30 Days</SelectItem>
                                <SelectItem value="since">Since…</SelectItem>
                            </SelectContent>
                        </Select>

                        {/* Since Date Picker */}
                        {timeFilter === 'since' && (
                            <Input
                                type="date"
                                value={customStartDate}
                                onChange={(e) => {
                                    setCustomStartDate(e.target.value)
                                    localStorage.setItem('activity-since-date', e.target.value)
                                }}
                                className="flex-1 lg:w-[170px]"
                            />
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 w-full xl:w-auto overflow-x-auto pb-1 xl:pb-0 shrink-0 items-center">
                    <Button
                        variant={isSelecting ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => {
                            if (isBulkMode || selectedItems.size > 0) handleDeselectAll()
                            else setIsBulkMode(true)
                        }}
                        className="h-10 whitespace-nowrap"
                    >
                        <Check className="mr-2 h-4 w-4" />
                        {isSelecting ? 'Cancel' : 'Select'}
                    </Button>

                    <Button size="sm" onClick={() => fetchActivity()} disabled={loading} className="h-10 whitespace-nowrap">
                        <AnimatedRefreshIcon className="mr-2 h-4 w-4" isAnimating={loading} />
                        Refresh
                    </Button>

                    {/* View Mode Toggle - Segmented Control */}
                    <Tabs value={viewMode} onValueChange={(v) => handleViewModeChange(v as 'grid' | 'list')} className="ml-auto xl:ml-0 h-10">
                        <TabsList className="grid w-full grid-cols-2 h-full bg-muted/50 p-1">
                            <TabsTrigger value="grid" className="h-full data-[state=active]:shadow-sm">
                                <Grid className="h-4 w-4 mr-2" />
                                <span className="hidden sm:inline">Grid</span>
                            </TabsTrigger>
                            <TabsTrigger value="list" className="h-full data-[state=active]:shadow-sm">
                                <List className="h-4 w-4 mr-2" />
                                <span className="hidden sm:inline">List</span>
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </div>

            <ActivityFeed
                history={filteredHistory}
                viewMode={viewMode}
                selectedItems={selectedItems}
                isBulkMode={isBulkMode}
                onToggleSelect={(id) => {
                    handleToggleSelect(id)
                    // If we manually select something, ensure we're in bulk mode for the UI
                    setIsBulkMode(true)
                }}
                onDelete={async (id) => {
                    const ids = Array.isArray(id) ? id : [id]
                    removeItems(ids)

                    const { encryptionKey } = useAuthStore.getState()
                    if (encryptionKey) {
                        const itemsToDelete = history.filter(item => ids.includes(item.id))
                        for (const item of itemsToDelete) {
                            const account = accounts.find(a => a.id === item.accountId)
                            if (account) {
                                try {
                                    const authKey = await decrypt(account.authKey, encryptionKey)
                                    await stremioClient.removeLibraryItem(authKey, item.itemId, account.id)
                                } catch (e) {
                                    console.error(`Failed to remove ${item.itemId}:`, e)
                                }
                            }
                        }
                    }

                    fetchActivityFull() // Invalidate cache
                    toast({
                        title: ids.length > 1 ? 'Episodes Deleted' : 'Item Deleted',
                        description: `Removed from activity history.`
                    })
                }}
            />

            {/* Delete Confirmation Dialog */}
            <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Selected Items?</AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-3">
                                <p>
                                    This will permanently remove {selectedItems.size} item(s) from your Stremio watch history. This cannot be undone.
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Note: deleting a series removes the entire show, not individual episodes. This is a Stremio limitation.
                                </p>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleDeleteSelected} className="bg-destructive hover:bg-destructive/90">
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Floating Action Bar for Bulk Deletion */}
            <FloatingActionBar
                open={selectedItems.size > 0}
                selectedCount={selectedItems.size}
                totalCount={filteredHistory.length}
                onClearSelection={handleDeselectAll}
                actions={[
                    {
                        label: 'Select All',
                        onClick: handleSelectAll,
                        variant: 'outline',
                        icon: <Check className="h-4 w-4" />,
                        disabled: selectedItems.size === filteredHistory.length
                    },
                    {
                        label: 'Delete History',
                        onClick: () => setShowDeleteDialog(true),
                        variant: 'destructive',
                        icon: <AnimatedTrashIcon className="h-4 w-4" />
                    },
                ].filter(Boolean) as any}
            />
        </div >
    )
}
