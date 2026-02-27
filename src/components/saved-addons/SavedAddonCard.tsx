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
import { getAddonConfigureUrl, isNewerVersion } from '@/lib/utils'
import { useAddonStore } from '@/store/addonStore'
import { Copy, MoreVertical, Pencil } from 'lucide-react'
import { AnimatedSettingsIcon, AnimatedTrashIcon, AnimatedUpdateIcon } from '../ui/AnimatedIcons'
import { restorationManager } from '@/lib/autopilot/restorationManager'

import { useState } from 'react'
import { SavedAddon } from '@/types/saved-addon'
import { SavedAddonDetails } from './SavedAddonDetails'
import { getTagColor } from '@/lib/tag-utils'

interface SavedAddonCardProps {
  savedAddon: SavedAddon
  latestVersion?: string
  onUpdate?: (savedAddonId: string, addonName: string) => Promise<void>
  isSelectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
  profileName?: string
}

export function SavedAddonCard({
  savedAddon,
  latestVersion,
  onUpdate,
  isSelectionMode,
  isSelected,
  onToggleSelect,
  profileName
}: SavedAddonCardProps) {
  const { deleteSavedAddon } = useAddonStore()
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
      <div
        className={`group flex flex-col h-full relative ${isSelectionMode ? 'cursor-pointer' : ''}`}
        style={{
          background: 'rgba(255,255,255,0.04)',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'rgba(255,255,255,0.08)',
          borderRadius: '20px',
          padding: '20px',
          transition: 'all 200ms ease',
          ...(isSelected ? {
            boxShadow: '0 0 15px hsla(var(--primary), 0.2)',
            background: 'hsla(var(--primary), 0.1)',
            borderColor: 'hsl(var(--primary))'
          } : {})
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
          }
        }}
        onClick={() => {
          if (isSelectionMode && onToggleSelect) {
            onToggleSelect(savedAddon.id)
          }
        }}
      >
        {isSelected && (
          <div className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full flex items-center justify-center border-2 border-background shadow-lg" style={{ background: 'hsl(var(--primary))' }}>
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}

        <div className="flex items-start justify-between pb-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {(savedAddon.metadata?.customLogo || savedAddon.manifest.logo) ? (
              <div
                className="shrink-0 flex items-center justify-center overflow-hidden"
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.06)'
                }}
              >
                <img
                  src={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                  alt={savedAddon.name}
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              </div>
            ) : (
              <div
                className="shrink-0 flex items-center justify-center"
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, rgba(99,102,241,0.3), rgba(168,85,247,0.3))',
                  color: 'white',
                  fontFamily: '"DM Sans", sans-serif',
                  fontWeight: 900,
                  fontSize: '18px'
                }}
              >
                {savedAddon.name.charAt(0).toUpperCase()}
              </div>
            )}

            <div className="flex flex-col min-w-0 pr-2">
              <div
                className="truncate leading-tight flex items-center gap-2"
                style={{
                  fontFamily: '"DM Sans", sans-serif',
                  fontSize: '15px',
                  fontWeight: 700,
                  color: 'white'
                }}
              >
                {savedAddon.name}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-[2px] overflow-hidden">
                <div className="flex items-center gap-1.5">
                  <span
                    style={{
                      fontFamily: '"DM Mono", monospace',
                      fontSize: '10px',
                      color: 'rgba(255,255,255,0.35)'
                    }}
                    className="truncate"
                  >
                    v{savedAddon.manifest.version}
                  </span>

                  <span
                    style={{
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: savedAddon.health ? (savedAddon.health.isOnline ? '#22c55e' : '#ef4444') : '#9ca3af',
                      boxShadow: savedAddon.health?.isOnline ? '0 0 6px #22c55e' : 'none'
                    }}
                    className="shrink-0"
                    title={getHealthTooltip()}
                  />


                  {savedAddon.manifest.behaviorHints?.configurable && (
                    <button
                      onClick={handleOpenConfiguration}
                      className="opacity-0 group-hover:opacity-100 transition-opacity ml-1.5 text-white/40 hover:text-white"
                      title="Configure"
                    >
                      <AnimatedSettingsIcon className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {savedAddon.syncWithInstalled && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-sky-500/10 text-sky-400 border border-sky-500/20" title="Automatically syncs between your library and installed accounts">
                    Synced
                  </span>
                )}
                {savedAddon.sourceType === 'cloned-from-account' && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
                    Cloned
                  </span>
                )}
                {(() => {
                  const status = restorationManager.getStatus(savedAddon.installUrl)
                  if (status.status === 'restoring') {
                    return (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-500 border border-amber-500/20 animate-pulse">
                        Restoring...
                      </span>
                    )
                  }
                  if (status.circuitState === 'open') {
                    return (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-red-500/10 text-red-500 border border-red-500/20" title="Auto-restore disabled after repeated failures. 30m cooldown.">
                        Failed
                      </span>
                    )
                  }
                  return null
                })()}
              </div>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-1.5 hover:bg-white/5 rounded-lg transition-colors duration-150 shrink-0 outline-none flex items-center justify-center -mr-2"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4 text-white/40 hover:text-white transition-colors" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleCopyUrl}>
                <Copy className="h-4 w-4 mr-2" />
                Copy URL
              </DropdownMenuItem>
              {savedAddon.manifest.behaviorHints?.configurable && (
                <DropdownMenuItem onClick={handleOpenConfiguration}>
                  <AnimatedSettingsIcon className="h-4 w-4 mr-2" />
                  Configure
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setShowDetails(true)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onClick={handleDelete}>
                <AnimatedTrashIcon className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex-grow flex flex-col min-w-0 pt-2">
          {/* Condensed URL */}
          <div className="flex items-center gap-1.5 mb-2 w-full min-w-0 group/url cursor-pointer" onClick={handleCopyUrl}>
            <span
              className="truncate flex-grow min-w-0"
              style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '10px',
                color: 'rgba(255,255,255,0.2)'
              }}
            >
              {(() => {
                try {
                  const urlObj = new URL(savedAddon.installUrl)
                  return `${urlObj.hostname}/••••••`
                } catch {
                  return savedAddon.installUrl
                }
              })()}
            </span>
            <Copy className="h-3 w-3 text-white/40 opacity-0 group-hover/url:opacity-100 transition-opacity shrink-0" />
          </div>

          {/* Description */}
          {((savedAddon.metadata?.customDescription || (savedAddon.manifest.description && savedAddon.manifest.description !== `Addon generated by ${savedAddon.name}`))) && (
            <div
              className="line-clamp-1 mb-3"
              style={{
                fontFamily: '"DM Sans", sans-serif',
                fontSize: '12px',
                color: 'rgba(255,255,255,0.4)',
                lineHeight: 1.5
              }}
            >
              {savedAddon.metadata?.customDescription || savedAddon.manifest.description}
            </div>
          )}

          <div className="flex-grow"></div>

          <div className="flex items-end justify-between mt-auto pt-2">
            {/* Tags */}
            <div className="flex flex-wrap gap-1 relative z-20" onClick={(e) => e.stopPropagation()}>
              {hasUpdate && onUpdate && (
                <button
                  onClick={handleUpdate}
                  disabled={updating}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    padding: '2px 7px',
                    borderRadius: '999px',
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    fontFamily: '"DM Mono", monospace',
                    fontSize: '8px',
                    fontWeight: 700,
                    color: '#f59e0b',
                    cursor: updating ? 'not-allowed' : 'pointer',
                    opacity: updating ? 0.5 : 1,
                    flexShrink: 0,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {updating ? 'Updating...' : <><AnimatedUpdateIcon className="h-3 w-3 mr-1" isAnimating={updating} /> Update</>}
                </button>
              )}
              {savedAddon.tags.map((tag) => {
                const color = getTagColor(tag)
                return (
                  <span
                    key={tag}
                    className="font-mono text-[9px] pointer-events-none uppercase tracking-wider font-bold mb-0.5 px-1.5 py-0.5 rounded-md"
                    style={{
                      background: color.bg,
                      color: color.text,
                      border: `1px solid ${color.border}`
                    }}
                  >
                    {tag}
                  </span>
                )
              })}
            </div>

            {/* Consolidated Footer */}
            <div
              className="shrink-0 pl-2 text-right"
              style={{
                fontFamily: '"DM Mono", monospace',
                fontSize: '9px',
                color: 'rgba(255,255,255,0.25)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}
            >
              {profileName && <span>{profileName} &bull; </span>}SAVED {getTimeAgo(new Date(savedAddon.createdAt))}
            </div>
          </div>
        </div>
      </div>

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
