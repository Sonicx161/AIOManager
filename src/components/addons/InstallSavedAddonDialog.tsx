import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore } from '@/store/accountStore'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { useState, useMemo } from 'react'
import { Search, Filter, Check, AlertCircle, Package, LayoutGrid, List, ShieldCheck } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { AddonTag } from './AddonTag'

interface InstallSavedAddonDialogProps {
  accountId: string
  accountAuthKey: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
  installedAddons?: AddonDescriptor[]
}

export function InstallSavedAddonDialog({
  accountId,
  accountAuthKey,
  open,
  onOpenChange,
  onSuccess,
  installedAddons = [],
}: InstallSavedAddonDialogProps) {
  const { library, bulkApplySavedAddons, loading } = useAddonStore()
  const syncAccount = useAccountStore((state) => state.syncAccount)

  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // View State
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  // Filter states
  const [searchTerm, setSearchTerm] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [profileFilter, setProfileFilter] = useState<string>('all')

  const { profiles } = useProfileStore()

  // Memoized data
  const savedAddons = useMemo(() =>
    Object.values(library).sort((a, b) => a.name.localeCompare(b.name)),
    [library])

  const allTags = useMemo(() => {
    const tags = new Set<string>()
    savedAddons.forEach(addon => addon.tags.forEach(tag => tags.add(tag)))
    return Array.from(tags).sort()
  }, [savedAddons])

  // Helper to check status
  const getAddonStatus = (savedAddon: { id: string, installUrl: string }) => {
    // Check if installed by comparing transport URLs (ignoring trailing slashes)
    const isInstalled = installedAddons.some(a => {
      const installedUrl = a.transportUrl.replace(/\/$/, '')
      const savedUrl = savedAddon.installUrl.replace(/\/$/, '')
      return installedUrl === savedUrl
    })
    const isSelected = selectedSavedAddonIds.has(savedAddon.id)
    return { isInstalled, isSelected }
  }

  // Filtered list
  const filteredAddons = useMemo(() => {
    return savedAddons.filter(addon => {
      const matchesSearch = addon.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        addon.manifest.name.toLowerCase().includes(searchTerm.toLowerCase())
      const matchesTag = tagFilter === 'all' || addon.tags.includes(tagFilter)
      const matchesProfile = profileFilter === 'all' || addon.profileId === profileFilter
      return matchesSearch && matchesTag && matchesProfile
    })
  }, [savedAddons, searchTerm, tagFilter, profileFilter])


  const toggleSavedAddon = (savedAddonId: string) => {
    setSelectedSavedAddonIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(savedAddonId)) {
        newSet.delete(savedAddonId)
      } else {
        newSet.add(savedAddonId)
      }
      return newSet
    })
  }

  const selectAll = () => {
    if (selectedSavedAddonIds.size === filteredAddons.length) {
      setSelectedSavedAddonIds(new Set())
    } else {
      setSelectedSavedAddonIds(new Set(filteredAddons.map((a) => a.id)))
    }
  }

  const handleClose = () => {
    if (!loading) {
      if (success) {
        setSelectedSavedAddonIds(new Set())
        setSuccess(false)
      }
      setError(null)
      setSearchTerm('')
      onOpenChange(false)
    }
  }

  const handleInstall = async () => {
    if (selectedSavedAddonIds.size === 0) {
      setError('Please select at least one saved addon')
      return
    }

    setError(null)
    setSuccess(false)

    try {
      const accountsToApply = [{ id: accountId, authKey: accountAuthKey }]

      const bulkResult = await bulkApplySavedAddons(
        Array.from(selectedSavedAddonIds),
        accountsToApply
      )


      if (bulkResult.failed === 0) {
        setSuccess(true)
        await syncAccount(accountId)
        if (onSuccess) onSuccess()
        setTimeout(() => handleClose(), 2000)
      } else {
        setError(`Completed with ${bulkResult.failed} error(s)`)
        setSuccess(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install saved addons')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-6 pb-4 border-b">
          <DialogTitle className="text-xl">Install from Library</DialogTitle>
          <DialogDescription>
            Choose addons from your saved library to install on this account.
          </DialogDescription>

          {/* Toolbar */}
          <div className="flex flex-wrap gap-2 mt-4">
            <div className="relative min-w-[160px] flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search saved addons..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger className="w-[160px] shrink-0">
                <div className="flex items-center gap-2 text-muted-foreground min-w-0 flex-1">
                  <Filter className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-foreground text-left">{tagFilter === 'all' ? 'All Tags' : tagFilter}</span>
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tags</SelectItem>
                {allTags.map(tag => (
                  <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={profileFilter} onValueChange={setProfileFilter}>
              <SelectTrigger className="w-[180px] shrink-0">
                <div className="flex items-center gap-2 text-muted-foreground min-w-0 flex-1">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate text-foreground text-left">
                    {profileFilter === 'all' ? 'All Profiles' : profiles.find(p => p.id === profileFilter)?.name || 'Unknown'}
                  </span>
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Profiles</SelectItem>
                {profiles.map(profile => (
                  <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex bg-muted/50 rounded-lg p-1 gap-1 shrink-0">
              <Button
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setViewMode('grid')}
                title="Grid View"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="icon"
                className="h-8 w-8"
                onClick={() => setViewMode('list')}
                title="List View"
              >
                <List className="h-4 w-4" />
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={selectAll}
              className="shrink-0 min-w-[105px]"
              disabled={filteredAddons.length === 0}
            >
              <Check className={cn("mr-2 h-3.5 w-3.5", selectedSavedAddonIds.size === filteredAddons.length ? "opacity-100" : "opacity-0")} />
              {selectedSavedAddonIds.size === filteredAddons.length && filteredAddons.length > 0 ? "Deselect All" : "Select All"}
            </Button>
          </div>
        </DialogHeader>

        {/* Content Area */}
        <ScrollArea className="h-[50vh] sm:h-[60vh] min-h-[300px] p-0 border-b">
          <div className="p-6 pt-2 space-y-4">

            {/* Addon Grid/List */}
            <div className={cn(
              "grid gap-3",
              viewMode === 'grid' ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1"
            )}>
              {filteredAddons.length === 0 ? (
                <div className="col-span-full text-center py-12 text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>No saved addons match your filters.</p>
                </div>
              ) : (
                filteredAddons.map((addon) => {
                  const { isInstalled, isSelected } = getAddonStatus(addon)
                  return (
                    <div
                      key={addon.id}
                      className={cn(
                        "relative transition-all cursor-pointer group hover:border-primary/50 hover:shadow-sm",
                        viewMode === 'grid'
                          ? "flex flex-col p-4 rounded-xl border"
                          : "flex items-center gap-4 p-3 rounded-lg border",
                        isSelected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "bg-card",
                        isInstalled && !isSelected && "opacity-60 bg-muted/30 border-dashed"
                      )}
                      onClick={() => toggleSavedAddon(addon.id)}
                    >
                      {/* Selection Indicator */}
                      <div className={cn(
                        "rounded-full border border-primary/20 flex items-center justify-center transition-all z-10 shrink-0",
                        viewMode === 'grid' ? "absolute top-3 right-3 h-5 w-5" : "h-5 w-5",
                        isSelected ? "bg-primary border-primary scale-110" : "bg-background group-hover:border-primary/50"
                      )}>
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>

                      {/* Header: Logo + Name */}
                      <div className={cn("flex items-start gap-3 min-w-0 flex-1", viewMode === 'grid' ? "mb-3 pr-6" : "")}>
                        <div className="shrink-0">
                          {addon.manifest.logo ? (
                            <img
                              src={addon.manifest.logo}
                              alt=""
                              className={cn(
                                "rounded-lg object-contain bg-background border p-0.5",
                                viewMode === 'grid' ? "h-12 w-12" : "h-10 w-10"
                              )}
                              loading="lazy"
                            />
                          ) : (
                            <div className={cn(
                              "rounded-lg bg-muted flex items-center justify-center border font-bold text-muted-foreground",
                              viewMode === 'grid' ? "h-12 w-12" : "h-10 w-10"
                            )}>
                              {addon.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h4 className="font-semibold leading-tight truncate" title={addon.name}>
                            {addon.name}
                          </h4>
                          <p className="text-xs text-muted-foreground truncate mt-1">
                            v{addon.manifest.version}
                          </p>
                        </div>
                      </div>

                      {/* Footer: Tags + Status */}
                      <div className={cn(
                        "flex items-center gap-2",
                        viewMode === 'grid' ? "mt-auto justify-between w-full" : "justify-end shrink-0"
                      )}>
                        <div className="flex flex-wrap gap-1 justify-end">
                          {addon.tags.slice(0, viewMode === 'grid' ? 2 : 3).map(tag => (
                            <AddonTag key={tag} tag={tag} />
                          ))}
                          {addon.tags.length > (viewMode === 'grid' ? 2 : 3) && (
                            <span className="text-[10px] text-muted-foreground px-1">+{addon.tags.length - (viewMode === 'grid' ? 2 : 3)}</span>
                          )}
                        </div>

                        {isInstalled && (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-normal bg-muted text-muted-foreground border-transparent">
                            Installed
                          </Badge>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="p-4 border-t bg-muted/5">
          {selectedSavedAddonIds.size > 0 && (
            <div className="mb-4 p-3 rounded-md bg-background border shadow-sm">
              <p className="text-sm font-medium">Ready to install</p>
              <p className="text-xs text-muted-foreground">
                {selectedSavedAddonIds.size} addon{selectedSavedAddonIds.size !== 1 ? 's' : ''} will be installed to {accountId === 'all' ? 'all accounts' : 'this account'}.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 p-3 rounded-md bg-green-500/10 text-green-600 dark:text-green-400 text-sm flex items-center gap-2">
              <Check className="h-4 w-4" />
              Installation successful!
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-4 items-center justify-between">

            <div className="w-full sm:w-auto" />


            <div className="flex gap-2 w-full sm:w-auto justify-end">
              <Button variant="outline" onClick={handleClose} disabled={loading && !success}>
                {success ? 'Close' : 'Cancel'}
              </Button>
              <Button
                onClick={handleInstall}
                disabled={selectedSavedAddonIds.size === 0 || loading || success}
                className="min-w-[100px]"
              >
                {loading ? 'Installing...' : success ? 'Installed' : 'Install Selected'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
