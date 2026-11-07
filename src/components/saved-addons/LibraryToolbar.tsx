import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { AnimatedRefreshIcon, AnimatedUpdateIcon } from '@/components/ui/AnimatedIcons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Check, ChevronDown, Grid, Layers, List, Plus, Search, SlidersHorizontal, Wand2, X, GripVertical } from 'lucide-react'
import { getActiveFilterCount } from './library-sidebar-selection'

interface LibraryToolbarProps {
  selectedProfileId: string | null
  selectedTag: string | null
  searchQuery: string
  onSearchChange: (value: string) => void
  searchRef?: React.RefObject<HTMLInputElement | null>
  viewMode: 'grid' | 'list'
  onViewModeChange: (mode: 'grid' | 'list') => void
  showReorder?: boolean
  onReorder?: () => void
  savedAddonsCount: number
  healthSummary: { online: number; offline: number }
  checkingUpdates: boolean
  checkingHealth: boolean
  updatingAll: boolean
  updatesCount: number
  onRefresh: () => void
  onUpdateAll: () => void
  onOpenBulkUrlReplace: () => void
  isSelectionMode: boolean
  onToggleSelectionMode: () => void
  onOpenAddDialog: () => void
  onToggleMobileFilters: () => void
}

// Toolbar copied from the account workspace addon list (AddonList.tsx): ToolbarShell,
// search + view toggle grouped so they never wrap apart, outline h-8 text-xs buttons,
// and an Actions dropdown (Layers icon, "Actions" label, inline update badge,
// ChevronDown) holding Update All and Find & Replace URL. Owner label decision for
// the 640-1279 band: Add Addon keeps its text label at every width from sm up while
// Refresh collapses to icon + tooltip + aria-label there; Select keeps its label at
// every width. The labeled Add button needs 70px more than the mockup's icon-only
// one, so the search returns to AddonList's own min-w-[180px] floor and reserves the
// clear-button padding only while a query is typed; lg:gap-2 / lg:flex-nowrap keep
// the desktop row single at >= 1024 (measured: 191px search, 696px card, no overflow).
export function LibraryToolbar({
  selectedProfileId,
  selectedTag,
  searchQuery,
  onSearchChange,
  searchRef,
  viewMode,
  onViewModeChange,
  showReorder,
  onReorder,
  savedAddonsCount,
  healthSummary,
  checkingUpdates,
  checkingHealth,
  updatingAll,
  updatesCount,
  onRefresh,
  onUpdateAll,
  onOpenBulkUrlReplace,
  isSelectionMode,
  onToggleSelectionMode,
  onOpenAddDialog,
  onToggleMobileFilters,
}: LibraryToolbarProps) {
  const busy = checkingUpdates || checkingHealth
  const filterCount = getActiveFilterCount(selectedProfileId, selectedTag)

  return (
    <ToolbarShell data-ctrl="toolbar" contentClassName="gap-2 sm:gap-3 lg:gap-2 lg:flex-nowrap">
      {/* Search + Filters + view toggle, grouped so the search never wraps apart from them. */}
      <div className="grid w-full grid-cols-[1fr_auto] items-center gap-2 sm:flex sm:w-auto sm:flex-none lg:shrink">
        <div className="relative flex-1 min-w-0 sm:min-w-[180px] sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            ref={searchRef}
            type="text"
            placeholder="Search addons..."
            aria-label="Search addons"
            className={cn(
              'pl-9 h-8 text-xs w-full bg-muted/30 border border-border/40 focus:bg-muted/40 transition-colors',
              searchQuery ? 'pr-9' : 'pr-4'
            )}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            data-ctrl="search"
          />
          {searchQuery && (
            <button
              data-theme-part="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 hover:bg-accent rounded-full transition-colors"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        {/* Phone: the Filters sheet opener sits where AddonList keeps its view toggle. */}
        <Button
          variant="outline"
          size="sm"
          data-ctrl="filters"
          onClick={onToggleMobileFilters}
          aria-label="Filters"
          className="flex h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium md:hidden"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>Filters</span>
          {filterCount > 0 && (
            <span
              data-theme-part="badge"
              data-ctrl="filters-badge"
              data-count={filterCount}
              className="ml-0.5 w-4 h-4 flex items-center justify-center text-xs font-semibold bg-primary text-primary-foreground rounded-full shrink-0"
            >
              {filterCount}
            </span>
          )}
        </Button>
        <div data-theme-part="tabs-list" className="hidden items-center bg-muted/50 rounded-lg p-0.5 border border-border/40 gap-0.5 shrink-0 md:flex">
          <Tooltip content="Grid view" side="bottom">
            <Button
              variant="ghost"
              size="sm"
              data-theme-part="tab"
              data-ctrl="view-grid"
              data-state={viewMode === 'grid' ? 'active' : 'inactive'}
              aria-label="Grid view"
              className={cn('h-8 w-8 rounded-lg p-0', viewMode === 'grid' ? 'bg-background shadow-sm text-foreground hover:bg-background' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => onViewModeChange('grid')}
            >
              <Grid className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content="List view" side="bottom">
            <Button
              variant="ghost"
              size="sm"
              data-theme-part="tab"
              data-ctrl="view-list"
              data-state={viewMode === 'list' ? 'active' : 'inactive'}
              aria-label="List view"
              className={cn('h-8 w-8 rounded-lg p-0', viewMode === 'list' ? 'bg-background shadow-sm text-foreground hover:bg-background' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => onViewModeChange('list')}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="grid w-full grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:w-auto sm:flex-wrap sm:justify-end lg:flex-nowrap">
        {savedAddonsCount > 0 && (
          <div
            data-theme-part="badge"
            data-ctrl="health-counts"
            className="hidden xl:flex items-center gap-2 px-2.5 h-8 rounded-md bg-muted/40 border border-border/40 text-xs font-medium text-muted-foreground shrink-0"
          >
            <Tooltip content={`${healthSummary.online} online`} side="top">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                {healthSummary.online}
              </span>
            </Tooltip>
            {healthSummary.offline > 0 && (
              <Tooltip content={`${healthSummary.offline} offline`} side="top">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
                  {healthSummary.offline}
                </span>
              </Tooltip>
            )}
          </div>
        )}
        {showReorder && onReorder && (
          <Button
            size="sm"
            variant="outline"
            onClick={onReorder}
            data-ctrl="reorder-addons"
            className="hidden shrink-0 gap-1.5 h-8 text-xs font-medium sm:inline-flex"
          >
            <GripVertical className="h-3.5 w-3.5" />
            <span>Reorder</span>
          </Button>
        )}
        <Tooltip content="Check for updates" side="bottom">
          <Button
            onClick={onRefresh}
            disabled={busy || updatingAll || savedAddonsCount === 0}
            size="sm"
            variant="outline"
            data-ctrl="refresh"
            aria-label="Refresh"
            className="w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto"
          >
            <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={busy} />
            {/* Labeled on phone and at xl; icon + tooltip + aria-label from sm to xl
                so Add Addon and Select keep their text labels at 1024. */}
            <span className="sm:hidden xl:inline">{busy ? 'Checking...' : 'Refresh'}</span>
          </Button>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-ctrl="actions" className="ml-0 w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto">
              <Layers className="h-3.5 w-3.5" />
              <span>Actions</span>
              {updatesCount > 0 && (
                <span
                  data-theme-part="badge"
                  data-ctrl="actions-badge"
                  data-count={updatesCount}
                  className="ml-1 w-4 h-4 flex items-center justify-center text-xs font-semibold bg-primary text-primary-foreground rounded-full shrink-0"
                >
                  {updatesCount}
                </span>
              )}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
            {showReorder && onReorder && (
              <DropdownMenuItem className="gap-2 sm:hidden" data-ctrl="reorder-addons-item" onClick={onReorder}>
                <GripVertical className="h-4 w-4" />
                Reorder Addons
              </DropdownMenuItem>
            )}
            {updatesCount > 0 && (
              <DropdownMenuItem className="gap-2" data-ctrl="update-all" onClick={onUpdateAll} disabled={updatingAll}>
                <AnimatedUpdateIcon className="h-4 w-4" isAnimating={updatingAll} />
                Update All ({updatesCount})
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="gap-2" data-ctrl="replace-url" onClick={onOpenBulkUrlReplace}>
              <Wand2 className="h-4 w-4 text-primary" />
              Find &amp; Replace URL
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="outline"
          onClick={onToggleSelectionMode}
          data-ctrl="select"
          className="w-full shrink-0 gap-1.5 h-8 px-3 text-xs font-medium sm:w-auto"
        >
          {isSelectionMode ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          <span>{isSelectionMode ? 'Cancel' : 'Select'}</span>
        </Button>
        <Button
          onClick={onOpenAddDialog}
          size="sm"
          data-ctrl="add-addon"
          aria-label="Add Addon"
          className="w-full shrink-0 gap-1.5 h-8 text-xs font-medium sm:w-auto"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="sm:hidden">Add</span>
          <span className="hidden sm:inline">Add Addon</span>
        </Button>
      </div>
    </ToolbarShell>
  )
}
