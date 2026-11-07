import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { useUIStore } from '@/store/uiStore'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { useState, useMemo } from 'react'
import { Search, Filter, Check, AlertCircle, Package, LayoutGrid, List, ShieldCheck, Loader2, Tag, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AddonTag } from './AddonTag'
import { AddonIcon } from '@/components/ui/addon-icon'
import { extractAddonParams } from '@/lib/addon-params'
import { installStopMessage } from '@/lib/bulk-result'

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
  const library = useAddonStore(s => s.library)
  const bulkApplySavedAddons = useAddonStore(s => s.bulkApplySavedAddons)
  const loading = useAddonStore(s => s.loading)
  const syncAccount = useAccountStore((state) => state.syncAccount)

  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const viewMode = useUIStore(s => s.libraryViewMode)
  const setViewMode = useUIStore(s => s.setLibraryViewMode)

  const [searchTerm, setSearchTerm] = useState('')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [profileFilter, setProfileFilter] = useState<string>('all')

  const profiles = useProfileStore(s => s.profiles)

  const savedAddons = useMemo(() =>
    Object.values(library).sort((a, b) => a.name.localeCompare(b.name)),
    [library])

  const allTags = useMemo(() => {
    const tags = new Set<string>()
    savedAddons.forEach(addon => addon.tags.forEach(tag => tags.add(tag)))
    return Array.from(tags).sort()
  }, [savedAddons])

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

  const filteredAddons = useMemo(() => {
    return savedAddons.filter(addon => {
      const matchesSearch = addon.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (addon.manifest.name || '').toLowerCase().includes(searchTerm.toLowerCase())
      const matchesTag = tagFilter === 'all' || addon.tags.includes(tagFilter)
      const matchesProfile = profileFilter === 'all' || addon.profileId === profileFilter
      return matchesSearch && matchesTag && matchesProfile
    })
  }, [savedAddons, searchTerm, tagFilter, profileFilter])

  const installedSavedCount = useMemo(() => {
    return savedAddons.filter(addon => installedAddons.some(installed => {
      const installedUrl = installed.transportUrl.replace(/\/$/, '')
      const savedUrl = addon.installUrl.replace(/\/$/, '')
      return installedUrl === savedUrl
    })).length
  }, [installedAddons, savedAddons])
  const allFilteredSelected = filteredAddons.length > 0 && selectedSavedAddonIds.size === filteredAddons.length


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
      setNotice(null)
      setSearchTerm('')
      onOpenChange(false)
    }
  }

  const handleInstall = async () => {
    if (selectedSavedAddonIds.size === 0) {
      setError('Select at least one saved addon')
      return
    }

    setError(null)
    setNotice(null)
    setSuccess(false)

    try {
      const accountsToApply = [{ id: accountId, authKey: accountAuthKey }]

      const bulkResult = await bulkApplySavedAddons(
        Array.from(selectedSavedAddonIds),
        accountsToApply
      )


      const stopped = installStopMessage(bulkResult)
      if (stopped) {
        setNotice(stopped)
      } else if (bulkResult.failed === 0) {
        setSuccess(true)
        await syncAccount(accountId)
        if (onSuccess) onSuccess()
        setTimeout(() => handleClose(), 2000)
      } else {
        const firstError = bulkResult.errors[0]?.error
        setError(firstError ? `Install failed: ${firstError}` : `Completed with ${bulkResult.failed} error(s)`)
        setSuccess(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install saved addons')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[92vh] sm:max-w-5xl">
        <DialogHeader className="p-5 pb-2 pr-14 sm:p-6 sm:pb-3 sm:pr-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-2xl tracking-tight">Install from Library</DialogTitle>
              <DialogDescription>
                Pick saved addons and deploy them to this account in one pass.
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span data-theme-part="badge" className="rounded-full border border-border/40 bg-background/70 px-2.5 py-1 font-semibold tabular-nums">
                {filteredAddons.length} shown
              </span>
              <span data-theme-part="badge" className="rounded-full border border-border/40 bg-background/70 px-2.5 py-1 font-semibold tabular-nums">
                {installedSavedCount} installed
              </span>
            </div>
          </div>

        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside data-theme-part="panel" className="shrink-0 border-b border-border/40 bg-card/40 p-4 lg:border-b-0 lg:border-r">
            <div className="grid gap-2 sm:grid-cols-2 lg:sticky lg:top-0 lg:block lg:space-y-3">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter Library</p>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search saved addons..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="h-9 bg-background/70 pl-9"
                  />
                </div>
              </div>

              <Select value={tagFilter} onValueChange={setTagFilter}>
                <SelectTrigger className="h-9 w-full bg-background/70">
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
                    <Filter className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-left text-foreground">{tagFilter === 'all' ? 'All Tags' : tagFilter}</span>
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
                <SelectTrigger className="h-9 w-full bg-background/70">
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate text-left text-foreground">
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

              <div className="grid grid-cols-[1fr_auto] gap-2 sm:col-span-2 lg:col-span-auto">
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={selectAll}
                  className="h-9 gap-2"
                  disabled={filteredAddons.length === 0}
                >
                  <Check className={cn("h-3.5 w-3.5", allFilteredSelected ? "opacity-100" : "opacity-0")} />
                  {allFilteredSelected ? "Deselect" : "Select All"}
                </Button>

                <div data-theme-part="tabs-list" className="flex items-center rounded-xl border border-border/40 bg-background/70 p-0.5">
                  <Tooltip content="Grid View" side="top">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-theme-part="tab"
                      data-state={viewMode === 'grid' ? 'active' : 'inactive'}
                      className={`h-8 w-8 rounded-lg p-0 ${viewMode === 'grid' ? 'bg-muted shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setViewMode('grid')}
                      aria-label="Grid view"
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="List View" side="top">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-theme-part="tab"
                      data-state={viewMode === 'list' ? 'active' : 'inactive'}
                      className={`h-8 w-8 rounded-lg p-0 ${viewMode === 'list' ? 'bg-muted shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setViewMode('list')}
                      aria-label="List view"
                    >
                      <List className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                </div>
              </div>

              <div data-theme-part="panel" className="hidden rounded-2xl border border-border/35 bg-background/35 p-3 text-xs text-muted-foreground sm:block lg:block">
                <div className="flex justify-between gap-2">
                  <span>Selected</span>
                  <span className="font-semibold tabular-nums text-foreground">{selectedSavedAddonIds.size}</span>
                </div>
                <div className="mt-1 flex justify-between gap-2">
                  <span>Matching</span>
                  <span className="font-semibold tabular-nums text-foreground">{filteredAddons.length}</span>
                </div>
              </div>
            </div>
          </aside>

          <div className="h-[34dvh] min-h-[220px] flex-1 overflow-y-auto overscroll-contain p-0 sm:h-[45vh] lg:h-[58vh]">
            <div className="space-y-4 p-4 sm:p-6">

            <div className={cn(
              "grid gap-3",
              viewMode === 'grid' ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
            )}>
              {filteredAddons.length === 0 ? (
                <div className="col-span-full rounded-[1.75rem] border border-dashed border-border/50 bg-muted/10 py-14 text-center text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p>No saved addons match your filters.</p>
                </div>
              ) : (
                filteredAddons.map((addon) => {
                  const { isInstalled, isSelected } = getAddonStatus(addon)
                  return (
                    <button
                      type="button"
                      key={addon.id}
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={addon.name}
                      data-theme-part="addon-card"
                      className={cn(
                        "group relative cursor-pointer border text-left transition-[transform,opacity,box-shadow] hover:border-primary/45 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        viewMode === 'grid'
                          ? "flex min-h-[112px] flex-col rounded-[1.35rem] p-4 sm:min-h-[128px]"
                          : "grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl p-3",
                        isSelected
                          ? "border-primary/25 bg-primary/12 ring-1 ring-primary/25"
                          : "border-border/40 bg-card/70",
                        isInstalled && !isSelected && "border-dashed bg-muted/20 opacity-70"
                      )}
                      onClick={() => toggleSavedAddon(addon.id)}
                    >
                      <div aria-hidden="true" className={cn(
                        "rounded-full border border-primary/20 flex items-center justify-center transition-[transform,opacity,box-shadow] z-10 shrink-0",
                        viewMode === 'grid' ? "absolute top-3 right-3 h-6 w-6" : "h-6 w-6",
                        isSelected ? "bg-primary border-primary scale-110" : "bg-background group-hover:border-primary/50"
                      )}>
                        {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>

                      <div className={cn("flex min-w-0 flex-1 items-start gap-3", viewMode === 'grid' ? "mb-3 pr-6" : "")}>
                        <AddonIcon
                          name={addon.name}
                          logo={addon.metadata?.customLogo || addon.manifest.logo}
                          alt={addon.name}
                          className={viewMode === 'grid' ? 'h-12 w-12' : 'h-10 w-10'}
                          textClassName="text-sm"
                        />
                        <div className="min-w-0 flex-1">
                          <Tooltip content={addon.name}>
                            <span className="block truncate font-semibold leading-tight tracking-tight">
                              {addon.name}
                            </span>
                          </Tooltip>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            v{addon.manifest.version}
                          </span>
                        </div>
                      </div>

                      <div className={cn(
                        "flex items-center gap-2",
                        viewMode === 'grid' ? "mt-auto justify-between w-full" : "justify-end shrink-0"
                      )}>
                        <div className="flex flex-wrap justify-end gap-1">
                          {(() => { const p = extractAddonParams(addon.installUrl).params; if (!p.tag && !p.variant) return null; return (
                            <span data-theme-part="badge" className="inline-flex min-w-0 max-w-[140px] items-center gap-0.5 rounded-full bg-primary/10 px-1.5 text-[11px] font-medium text-primary">
                              {p.tag ? <Tag className="h-2.5 w-2.5 shrink-0" /> : <Layers className="h-2.5 w-2.5 shrink-0" />}
                              <span className="truncate">{p.tag || p.variant}</span>
                            </span>
                          ) })()}
                          {addon.tags.slice(0, viewMode === 'grid' ? 2 : 3).map(tag => (
                            <AddonTag key={tag} tag={tag} />
                          ))}
                          {addon.tags.length > (viewMode === 'grid' ? 2 : 3) && (
                            <span className="text-xs text-muted-foreground px-1">+{addon.tags.length - (viewMode === 'grid' ? 2 : 3)}</span>
                          )}
                        </div>

                        {isInstalled && (
                          <Badge variant="outline" className="text-xs h-5 px-1.5 font-normal bg-muted text-muted-foreground border-transparent">
                            Installed
                          </Badge>
                        )}
                       </div>
                    </button>
                  )
                })
              )}
            </div>
            </div>
          </div>
        </div>

        <div className="px-4 pb-4 pt-2">
          {selectedSavedAddonIds.size > 0 && (
            <div data-theme-part="panel" className="mb-4 rounded-2xl border border-primary/20 bg-primary/10 p-3 shadow-sm">
              <p className="text-sm font-medium">Ready to install</p>
              <p className="text-xs text-muted-foreground">
                {selectedSavedAddonIds.size} addon{selectedSavedAddonIds.size !== 1 ? 's' : ''} will be installed to {accountId === 'all' ? 'all accounts' : 'this account'}.
              </p>
            </div>
          )}

          {error && (
            <div data-theme-tone="status" data-theme-part="panel" className="mb-4 flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {notice && (
            <div data-theme-tone="status" data-theme-part="panel" className="mb-4 flex items-center gap-2 rounded-xl border border-border/40 bg-muted/30 p-3 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4" />
              {notice}
            </div>
          )}

          {success && (
            <div data-theme-tone="status" data-theme-part="panel" className="mb-4 flex items-center gap-2 rounded-xl border border-success/20 bg-success/10 p-3 text-sm text-success">
              <Check className="h-4 w-4" />
              Installation successful!
            </div>
          )}

          <DialogFooter className="grid grid-cols-2 gap-3 p-0 sm:grid-cols-2">
            <Button variant="subtle" onClick={handleClose} disabled={loading && !success} ripple={false}>
              {success ? 'Close' : 'Cancel'}
            </Button>
            <Button
              onClick={handleInstall}
              disabled={selectedSavedAddonIds.size === 0 || loading || success}
              className="gap-2"
              ripple={false}
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? 'Installing...' : success ? 'Installed' : 'Install Selected'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
