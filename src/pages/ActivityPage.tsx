import { ActivityFeed } from '@/components/activity/ActivityFeed'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useActivityStore } from '@/store/activityStore'
import { ActivityItem } from '@/types/activity'
import { useAccountStore } from '@/store/accountStore'
import { useLibraryCache } from '@/store/libraryCache'

import { RefreshCw, Trash2, Grid, List, Search, CheckSquare, XSquare, Activity, X } from 'lucide-react'
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
    const { deleteItems } = useActivityStore()
    const { accounts } = useAccountStore()
    const {
        items: history,
        ensureLoaded,
        loading,
        loadingProgress,
        invalidate: fetchActivityFull,
        lastFetched: lastUpdated
    } = useLibraryCache()

    // Map useLibraryCache functions to original b06e names for UI compatibility
    const fetchActivity = async (silent = false) => {
        if (!silent) {
            fetchActivityFull() // Invalidate
            await ensureLoaded(accounts) // Re-fetch immediately
        }
    }

    const [searchTerm, setSearchTerm] = useState('')
    const searchInputRef = useRef<HTMLInputElement>(null)

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
    const [removeFromLibrary, setRemoveFromLibrary] = useState(false)
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

        await deleteItems(itemIds, removeFromLibrary)
        fetchActivityFull() // Invalidate cache

        // Reset checkbox for next time
        setRemoveFromLibrary(false)

        toast({
            title: 'Items Deleted',
            description: `${count} item(s) removed from ${removeFromLibrary ? 'Stremio library and ' : ''}activity history.`
        })
    }

    const isSelecting = selectedItems.size > 0 || isBulkMode

    // LOADING STATE
    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center p-8 opacity-50 animate-pulse">
                <Activity className="h-16 w-16 mb-4 text-indigo-500" />
                <h2 className="text-2xl font-bold">Gathering watch history...</h2>
                <div className="mt-2 text-sm text-indigo-400 font-mono">
                    {loadingProgress.current > 0 ? `Synced ${loadingProgress.current} accounts` : 'Connecting to Stremio...'}
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
                        {lastUpdated && (
                            <span className="text-[10px] text-muted-foreground mr-2 font-mono opacity-60">
                                Last synced: {new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                        )}
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
                        <CheckSquare className="mr-2 h-4 w-4" />
                        {isSelecting ? 'Cancel' : 'Select'}
                    </Button>
                    <Button size="sm" onClick={() => fetchActivity()} disabled={loading} className="flex-1">
                        <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* PROGRESS BAR */}
            {loading && (
                <div className="relative h-1 w-full bg-muted overflow-hidden rounded-full">
                    <Progress value={(loadingProgress.current / loadingProgress.total) * 100} className="h-full bg-primary transition-all duration-300" />
                </div>
            )}

            {/* Controls Row */}
            <div className="flex flex-col xl:flex-row gap-3 items-end xl:items-center">
                <div className="flex flex-1 w-full gap-3 flex-col sm:flex-row">
                    {/* Search */}
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            ref={searchInputRef}
                            placeholder="Search by title..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10 pr-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                            data-search-focus
                        />
                        {searchTerm && (
                            <button
                                onClick={() => setSearchTerm('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-accent rounded-full transition-colors focus:outline-none"
                            >
                                <X className="h-4 w-4 text-muted-foreground" />
                            </button>
                        )}
                    </div>

                    {/* User Filter */}
                    <Select value={userFilter} onValueChange={setUserFilter}>
                        <SelectTrigger className="w-full sm:w-[150px]">
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

                    {/* Time Filter */}
                    <Select value={timeFilter} onValueChange={(val) => {
                        setTimeFilter(val)
                        localStorage.setItem('activity-time-filter', val)
                    }}>
                        <SelectTrigger className="w-full sm:w-[150px]">
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

                    {/* Since Date Picker (inline, only visible when "Since" is selected) */}
                    {timeFilter === 'since' && (
                        <Input
                            type="date"
                            value={customStartDate}
                            onChange={(e) => {
                                setCustomStartDate(e.target.value)
                                localStorage.setItem('activity-since-date', e.target.value)
                            }}
                            className="w-full sm:w-[170px]"
                        />
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 w-full xl:w-auto overflow-x-auto pb-1 xl:pb-0 shrink-0">
                    {isSelecting && (
                        <>
                            <Button variant="outline" size="sm" onClick={handleSelectAll} disabled={filteredHistory.length === 0} className="whitespace-nowrap">
                                <CheckSquare className="mr-2 h-4 w-4" />
                                Select All ({filteredHistory.length})
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleDeselectAll} className="whitespace-nowrap">
                                <XSquare className="mr-2 h-4 w-4" />
                                Deselect ({selectedItems.size})
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)} className="whitespace-nowrap">
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete ({selectedItems.size})
                            </Button>
                        </>
                    )}

                    <Button
                        variant={isSelecting ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => {
                            if (isBulkMode || selectedItems.size > 0) handleDeselectAll()
                            else setIsBulkMode(true)
                        }}
                        className="hidden md:flex whitespace-nowrap"
                    >
                        <CheckSquare className="mr-2 h-4 w-4" />
                        {isSelecting ? 'Cancel' : 'Select'}
                    </Button>

                    <Button size="sm" onClick={() => fetchActivity()} disabled={loading} className="whitespace-nowrap hidden md:flex">
                        <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>

                    {/* View Mode Toggle */}
                    <div className="flex rounded-md border ml-auto xl:ml-0">
                        <Button
                            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                            size="icon"
                            className="h-9 w-9 rounded-r-none"
                            onClick={() => handleViewModeChange('grid')}
                        >
                            <Grid className="h-4 w-4" />
                        </Button>
                        <Button
                            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                            size="icon"
                            className="h-9 w-9 rounded-l-none"
                            onClick={() => handleViewModeChange('list')}
                        >
                            <List className="h-4 w-4" />
                        </Button>
                    </div>
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
                onDelete={(id, removeRemote) => {
                    const ids = Array.isArray(id) ? id : [id]
                    deleteItems(ids, removeRemote)
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
                        <AlertDialogDescription className="space-y-4">
                            <p>
                                This will remove {selectedItems.size} item(s) from your local activity cache.
                            </p>
                            <div className="flex items-center space-x-2 pt-2">
                                <input
                                    type="checkbox"
                                    id="removeFromLibrary"
                                    checked={removeFromLibrary}
                                    onChange={(e) => setRemoveFromLibrary(e.target.checked)}
                                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                />
                                <label
                                    htmlFor="removeFromLibrary"
                                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                                >
                                    Also remove from Stremio library/history
                                </label>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel onClick={() => setRemoveFromLibrary(false)}>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleDeleteSelected} className="bg-destructive hover:bg-destructive/90">
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}
