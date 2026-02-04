import { ActivityFeed } from '@/components/activity/ActivityFeed'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useActivityStore, ActivityItem } from '@/store/activityStore'
import { useAccountStore } from '@/store/accountStore'

import { RefreshCw, Trash2, Grid, List, Search, CheckSquare, XSquare } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'
import { toast } from '@/hooks/use-toast'
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

export function ActivityPage() {
    const { fetchActivity, clearHistory, deleteItems, loading, initialize, history } = useActivityStore()

    const [searchTerm, setSearchTerm] = useState('')
    const [userFilter, setUserFilter] = useState('all')
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

    useEffect(() => {
        initialize().then(() => {
            fetchActivity()
        })
    }, [initialize, fetchActivity])

    const orderedAccounts = useAccountStore((state) => state.accounts)

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

    // Filter history based on search and user filter
    const filteredHistory = useMemo(() => {
        return history.filter(item => {
            // User filter
            if (userFilter !== 'all' && item.accountId !== userFilter) {
                return false
            }
            // Search filter
            if (searchTerm.trim()) {
                const searchLower = searchTerm.toLowerCase()
                return item.name.toLowerCase().includes(searchLower)
            }
            return true
        })
    }, [history, userFilter, searchTerm])

    const handleViewModeChange = (mode: 'grid' | 'list') => {
        setViewMode(mode)
        if (typeof window !== 'undefined') {
            localStorage.setItem('activity-view-mode', mode)
        }
    }

    const handleClearHistory = async () => {
        await clearHistory()
    }

    const handleToggleSelect = (itemId: string) => {
        setSelectedItems(prev => {
            const newSet = new Set(prev)
            if (newSet.has(itemId)) {
                newSet.delete(itemId)
            } else {
                newSet.add(itemId)
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
    }

    const handleDeleteSelected = async () => {
        if (selectedItems.size === 0) return
        const count = selectedItems.size
        const itemIds = Array.from(selectedItems)
        setShowDeleteDialog(false)
        setSelectedItems(new Set())

        await deleteItems(itemIds, removeFromLibrary)

        // Reset checkbox for next time
        setRemoveFromLibrary(false)

        toast({
            title: 'Items Deleted',
            description: `${count} item(s) removed from ${removeFromLibrary ? 'Stremio library and ' : ''}activity history.`
        })
    }

    const isSelecting = selectedItems.size > 0

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Activity</h1>
                    <p className="text-muted-foreground mt-1">
                        Watch history from all your accounts.
                    </p>
                </div>
            </div>

            {/* Controls Row */}
            <div className="flex flex-col xl:flex-row gap-3 items-end xl:items-center">
                <div className="flex flex-1 w-full gap-3 flex-col sm:flex-row">
                    {/* Search */}
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search by title..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9"
                        />
                    </div>

                    {/* User Filter */}
                    <Select value={userFilter} onValueChange={setUserFilter}>
                        <SelectTrigger className="w-full sm:w-[180px]">
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
                </div>

                {/* Actions */}
                <div className="flex gap-2 w-full xl:w-auto overflow-x-auto pb-1 xl:pb-0">
                    {isSelecting ? (
                        <>
                            <Button variant="outline" size="sm" onClick={handleDeselectAll} className="whitespace-nowrap">
                                <XSquare className="mr-2 h-4 w-4" />
                                Deselect
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)} className="whitespace-nowrap">
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete ({selectedItems.size})
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button variant="outline" size="sm" onClick={handleSelectAll} disabled={filteredHistory.length === 0} className="whitespace-nowrap">
                                <CheckSquare className="mr-2 h-4 w-4" />
                                Select All
                            </Button>
                        </>
                    )}

                    <Button variant="outline" size="sm" onClick={handleClearHistory} disabled={loading} className="whitespace-nowrap">
                        <Trash2 className="mr-2 h-4 w-4" />
                        Clear Local
                    </Button>
                    <Button size="sm" onClick={() => fetchActivity()} disabled={loading} className="whitespace-nowrap">
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
                onToggleSelect={handleToggleSelect}
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
