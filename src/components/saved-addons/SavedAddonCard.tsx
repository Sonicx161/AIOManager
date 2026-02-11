import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { restorationManager } from '@/lib/autopilot/restorationManager'
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
    const error = savedAddon.health.error ? ` (${savedAddon.health.error})` : ''
    const lastChecked = new Date(savedAddon.health.lastChecked)
    const timeAgo = getTimeAgo(lastChecked)
    return `${status}${error}\nLast checked: ${timeAgo}`
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
        className={`flex flex-col h-full transition-all duration-300 ${isSelectionMode
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
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <div className="flex items-center gap-3 min-w-0">
            {(savedAddon.metadata?.customLogo || savedAddon.manifest.logo) ? (
              <div className="bg-muted p-1 rounded-md shrink-0">
                <img
                  src={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                  alt={savedAddon.name}
                  className="w-10 h-10 rounded object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              </div>
            ) : (
              <div className="bg-muted p-1 rounded-md shrink-0 w-12 h-12 flex items-center justify-center">
                <span className="text-lg">📦</span>
              </div>
            )}
            <div className="flex flex-col min-w-0">
              <CardTitle className="text-base font-semibold truncate leading-tight">
                {savedAddon.name}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-1.5 mt-1 overflow-hidden">
                <span className="text-xs truncate">v{savedAddon.manifest.version}</span>
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${getHealthStatusColor()}`}
                  title={getHealthTooltip()}
                />
                {hasUpdate && latestVersion && (
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                    → v{latestVersion}
                  </span>
                )}
                {savedAddon.sourceType === 'cloned-from-account' && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                    Cloned
                  </span>
                )}
                {(() => {
                  const status = restorationManager.getStatus(savedAddon.installUrl)
                  if (status.status === 'restoring') {
                    return (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20 animate-pulse">
                        Restoring...
                      </span>
                    )
                  }
                  if (status.circuitState === 'open') {
                    return (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-500 border border-red-500/20" title="Auto-restore disabled after repeated failures. 30m cooldown.">
                        Failed
                      </span>
                    )
                  }
                  return null
                })()}
              </CardDescription>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="p-1 hover:bg-accent rounded transition-colors duration-150 shrink-0">
              <MoreVertical className="h-5 w-5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleCopyUrl}>
                <Copy className="h-4 w-4 mr-2" />
                Copy URL
              </DropdownMenuItem>
              {savedAddon.manifest.behaviorHints?.configurable && (
                <DropdownMenuItem onClick={handleOpenConfiguration}>
                  <Settings className="h-4 w-4 mr-2" />
                  Configure
                </DropdownMenuItem>
              )}
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
        </CardHeader>

        <CardContent className="flex-grow py-2 min-w-0">
          {/* Description */}
          {savedAddon.manifest.description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
              {savedAddon.manifest.description}
            </p>
          )}

          {/* URL Bar */}
          <div className="flex items-center gap-2 w-full min-w-0 mb-3">
            <div className="flex-1 bg-muted/40 rounded px-2 py-1 flex items-center justify-between border min-w-0 w-full overflow-hidden">
              <span className="text-xs text-muted-foreground font-mono truncate mr-2 flex-grow min-w-0">
                {isPrivacyModeEnabled ? maskUrl(savedAddon.installUrl) : savedAddon.installUrl}
              </span>
              <button
                onClick={handleCopyUrl}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Copy URL"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Tags */}
          {savedAddon.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
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

          {/* Update Button */}
          {hasUpdate && onUpdate && (
            <Button
              variant="default"
              size="sm"
              onClick={handleUpdate}
              disabled={updating}
              className="w-full mt-3"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${updating ? 'animate-spin' : ''}`} />
              {updating ? 'Updating...' : 'Update Addon'}
            </Button>
          )}
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
