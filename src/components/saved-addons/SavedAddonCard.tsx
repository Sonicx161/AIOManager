import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/hooks/use-toast'
import { maskUrl, getAddonConfigureUrl, isNewerVersion } from '@/lib/utils'
import { useAddonStore } from '@/store/addonStore'
import { useUIStore } from '@/store/uiStore'
import { SavedAddon } from '@/types/saved-addon'
import { Copy, MoreVertical, Pencil, RefreshCw, Settings, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { SavedAddonDetails } from './SavedAddonDetails'
import { AddonTag } from '../addons/AddonTag'

interface SavedAddonCardProps {
  savedAddon: SavedAddon
  latestVersion?: string
  onUpdate?: (savedAddonId: string, addonName: string) => Promise<void>
  isSelectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
}

export function SavedAddonCard({
  savedAddon,
  latestVersion,
  onUpdate,
  isSelectionMode,
  isSelected,
  onToggleSelect
}: SavedAddonCardProps) {
  const { deleteSavedAddon } = useAddonStore()
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { toast } = useToast()
  const [showDetails, setShowDetails] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [updating, setUpdating] = useState(false)

  const hasUpdate = latestVersion ? isNewerVersion(savedAddon.manifest.version, latestVersion) : false

  const handleDelete = () => {
    setShowDeleteDialog(true)
  }

  const handleConfirmDelete = async () => {
    try {
      await deleteSavedAddon(savedAddon.id)
      setShowDeleteDialog(false)
    } catch (error) {
      console.error('Failed to delete saved addon:', error)
    }
  }

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleDateString()
  }

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(savedAddon.installUrl)
    toast({
      title: 'URL Copied',
      description: 'Addon install URL copied to clipboard',
    })
  }

  const handleOpenConfiguration = (e: React.MouseEvent) => {
    e.stopPropagation()
    const configUrl = getAddonConfigureUrl(savedAddon.installUrl)
    window.open(configUrl, '_blank', 'noopener,noreferrer')
  }

  const getHealthStatusColor = () => {
    if (!savedAddon.health) {
      return 'bg-gray-400' // Unchecked
    }
    return savedAddon.health.isOnline ? 'bg-green-500' : 'bg-red-500'
  }

  const getHealthTooltip = () => {
    if (!savedAddon.health) {
      return 'Health not checked'
    }
    const status = savedAddon.health.isOnline ? 'Online' : 'Offline'
    const lastChecked = new Date(savedAddon.health.lastChecked)
    const timeAgo = getTimeAgo(lastChecked)
    return `${status}\nLast checked: ${timeAgo}`
  }

  const getTimeAgo = (date: Date) => {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  const handleUpdate = async (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!onUpdate) return
    setUpdating(true)
    try {
      await onUpdate(savedAddon.id, savedAddon.name)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <>
      <Card
        className={`flex flex-col transition-all duration-200 ${isSelectionMode
          ? 'cursor-pointer hover:border-primary/50'
          : ''
          } ${isSelected
            ? 'ring-2 ring-primary border-primary bg-primary/5'
            : ''
          }`}
        onClick={() => {
          if (isSelectionMode && onToggleSelect) {
            onToggleSelect(savedAddon.id)
          }
        }}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">


              <div
                className={`w-2 h-2 rounded-full shrink-0 ${getHealthStatusColor()}`}
                title={getHealthTooltip()}
              />
              <CardTitle className="text-lg line-clamp-2">{savedAddon.name}</CardTitle>
              {hasUpdate && (
                <span className="text-xs px-2 py-1 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">
                  Update
                </span>
              )}
              {savedAddon.sourceType === 'cloned-from-account' && (
                <span className="text-xs px-2 py-1 rounded-md bg-primary/10 text-primary shrink-0">
                  Cloned
                </span>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className="p-1 hover:bg-accent rounded transition-colors duration-150 shrink-0">
                <MoreVertical className="h-5 w-5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowDetails(true)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onClick={handleDelete}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>

        <CardContent className="flex-1">
          <div className="space-y-3">
            {/* Addon Info */}
            <div className="flex items-center gap-3">
              {savedAddon.metadata?.customLogo || savedAddon.manifest.logo ? (
                <img
                  src={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                  alt={savedAddon.name} // savedAddon.name is the display name
                  className="w-10 h-10 rounded object-contain flex-shrink-0 bg-transparent"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              ) : (
                <div className="w-10 h-10 rounded bg-muted flex items-center justify-center flex-shrink-0">
                  <span className="text-xs text-muted-foreground">📦</span>
                </div>
              )}
              <div className="text-sm min-w-0">
                <p className="font-medium truncate">{savedAddon.manifest.name}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-2">
                  v{savedAddon.manifest.version}
                  {hasUpdate && latestVersion && (
                    <span className="text-blue-600 dark:text-blue-400">→ v{latestVersion}</span>
                  )}
                </p>
              </div>
            </div>

            {/* Tags */}
            {savedAddon.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {savedAddon.tags.map((tag) => (
                  <AddonTag key={tag} tag={tag} />
                ))}
              </div>
            )}

            {/* Dates */}
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Created: {formatDate(savedAddon.createdAt)}</p>
              {savedAddon.lastUsed && <p>Last used: {formatDate(savedAddon.lastUsed)}</p>}
            </div>

            {/* URL Display and Actions */}
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={handleCopyUrl}
                className="text-[10px] text-muted-foreground truncate font-mono bg-muted/50 px-2 py-1.5 rounded flex-1 flex items-center justify-between gap-2 hover:bg-muted transition-colors group"
                title="Copy URL"
              >
                <span className="truncate">
                  {isPrivacyModeEnabled ? maskUrl(savedAddon.installUrl) : savedAddon.installUrl}
                </span>
                <Copy className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity" />
              </button>
              {savedAddon.manifest.behaviorHints?.configurable && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={handleOpenConfiguration}
                  title="Configure Addon"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Update Button */}
            {hasUpdate && onUpdate && (
              <Button
                variant="default"
                size="sm"
                onClick={handleUpdate}
                disabled={updating}
                className="w-full mt-2"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${updating ? 'animate-spin' : ''}`} />
                {updating ? 'Updating...' : 'Update Addon'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Details Dialog */}
      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Saved Addon</DialogTitle>
          </DialogHeader>
          <SavedAddonDetails savedAddon={savedAddon} onClose={() => setShowDetails(false)} />
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete Saved Addon?"
        description={
          <>
            <p>Are you sure you want to delete "{savedAddon.name}"?</p>
            <p className="font-semibold">
              This will NOT remove it from accounts where it's already installed.
            </p>
          </>
        }
        confirmText="Delete"
        isDestructive={true}
        onConfirm={handleConfirmDelete}
      />
    </>
  )
}
