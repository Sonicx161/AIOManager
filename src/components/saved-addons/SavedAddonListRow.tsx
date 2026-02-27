import { SavedAddon } from '@/types/saved-addon'
import { isNewerVersion, getAddonConfigureUrl } from '@/lib/utils'
import { Copy, MoreVertical, Pencil } from 'lucide-react'
import { AnimatedSettingsIcon, AnimatedTrashIcon, AnimatedUpdateIcon } from '../ui/AnimatedIcons'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    Dialog,
    DialogContent,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { useAddonStore } from '@/store/addonStore'
import { useState } from 'react'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { SavedAddonDetails } from './SavedAddonDetails'
import { getTagColor } from '@/lib/tag-utils'

interface SavedAddonListRowProps {
    savedAddon: SavedAddon
    latestVersion?: string
    onUpdate?: (savedAddonId: string, addonName: string) => Promise<void>
    isSelectionMode?: boolean
    isSelected?: boolean
    onToggleSelect?: (id: string) => void
    profileName?: string
}

export function SavedAddonListRow({
    savedAddon,
    latestVersion,
    onUpdate,
    isSelectionMode,
    isSelected,
    onToggleSelect,
    profileName
}: SavedAddonListRowProps) {
    const { deleteSavedAddon } = useAddonStore()
    const { toast } = useToast()
    const [showDetails, setShowDetails] = useState(false)
    const [showDeleteDialog, setShowDeleteDialog] = useState(false)
    const [updating, setUpdating] = useState(false)

    const hasUpdate = latestVersion ? isNewerVersion(savedAddon.manifest.version, latestVersion) : false

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

    const handleConfirmDelete = async () => {
        try {
            await deleteSavedAddon(savedAddon.id)
            setShowDeleteDialog(false)
        } catch (error) {
            console.error('Failed to delete saved addon:', error)
        }
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

    const getHealthTooltip = () => {
        if (!savedAddon.health) return 'Health not checked'
        const status = savedAddon.health.isOnline ? 'Online' : 'Offline'
        const error = savedAddon.health.error ? ` (${savedAddon.health.error})` : ''
        return `${status}${error}`
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

    return (
        <>
            <div
                className={`group flex items-center h-[64px] relative w-full ${isSelectionMode ? 'cursor-pointer' : ''}`}
                style={{
                    background: 'rgba(255,255,255,0.02)',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    padding: '0 16px',
                    transition: 'all 150ms ease',
                    ...(isSelected ? {
                        background: 'hsla(var(--primary), 0.1)',
                        boxShadow: `inset 4px 0 0 hsl(var(--primary))`
                    } : {})
                }}
                onMouseEnter={(e) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    }
                }}
                onMouseLeave={(e) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.02)'
                    }
                }}
                onClick={() => {
                    if (isSelectionMode && onToggleSelect) {
                        onToggleSelect(savedAddon.id)
                    }
                }}
            >
                {isSelected && (
                    <div className="flex-shrink-0 mr-4 flex items-center justify-center w-5 h-5 rounded transition-colors bg-primary border-primary">
                        <Check className="w-3.5 h-3.5 text-white" />
                    </div>
                )}

                {/* Logo */}
                <div className="shrink-0 flex items-center justify-center overflow-hidden mr-4"
                    style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '6px',
                        background: 'rgba(255,255,255,0.06)',
                        color: 'white',
                        fontFamily: '"DM Sans", sans-serif',
                        fontWeight: 900,
                        fontSize: '12px'
                    }}>
                    {(savedAddon.metadata?.customLogo || savedAddon.manifest.logo) ? (
                        <img
                            src={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                            alt={savedAddon.name}
                            className="w-full h-full object-contain"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                        />
                    ) : (
                        <div style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.3), rgba(168,85,247,0.3))', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {savedAddon.name.charAt(0).toUpperCase()}
                        </div>
                    )}
                </div>

                {/* Name & URL */}
                <div className="flex flex-col justify-center shrink-0 min-w-[160px] w-[22%] pr-4">
                    <div className="truncate font-bold text-sm tracking-tight text-white mb-0.5 flex items-center gap-2">
                        {savedAddon.name}
                    </div>
                    <div className="flex items-center gap-1 group/url cursor-pointer" onClick={handleCopyUrl}>
                        <span className="truncate" style={{ fontFamily: '"DM Mono", monospace', fontSize: '10px', color: 'rgba(255,255,255,0.25)' }}>
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
                        {savedAddon.manifest.behaviorHints?.configurable && (
                            <button
                                onClick={handleOpenConfiguration}
                                className="opacity-0 group-hover/url:opacity-100 transition-opacity ml-1.5 text-white/40 hover:text-white"
                                title="Configure"
                            >
                                <AnimatedSettingsIcon className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Version & Update */}
                <div className="shrink-0 w-[8%] min-w-[72px]" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                            v{savedAddon.manifest.version}
                        </span>
                        <span
                            style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                display: 'inline-block',
                                backgroundColor: savedAddon.health ? (savedAddon.health.isOnline ? '#22c55e' : '#ef4444') : '#9ca3af',
                                boxShadow: savedAddon.health?.isOnline ? '0 0 6px #22c55e' : 'none',
                                flexShrink: 0
                            }}
                            title={getHealthTooltip()}
                        />
                        {hasUpdate && onUpdate && (
                            <button
                                onClick={handleUpdate}
                                disabled={updating}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    padding: '2px 6px',
                                    borderRadius: '999px',
                                    background: 'rgba(245,158,11,0.12)',
                                    borderStyle: 'solid',
                                    borderWidth: '1px',
                                    borderColor: 'rgba(245,158,11,0.3)',
                                    fontFamily: '"DM Mono", monospace',
                                    fontSize: '8px',
                                    fontWeight: 700,
                                    color: '#f59e0b',
                                    letterSpacing: '0.05em',
                                    textTransform: 'uppercase',
                                    whiteSpace: 'nowrap',
                                    flexShrink: 0,
                                    cursor: updating ? 'not-allowed' : 'pointer',
                                    opacity: updating ? 0.5 : 1
                                }}
                            >
                                {updating ? 'Updating...' : <><AnimatedUpdateIcon className="h-2.5 w-2.5 mr-1" isAnimating={updating} /> Update</>}
                            </button>
                        )}
                    </div>
                </div>


                {/* Tags */}
                <div className="flex-grow flex items-center gap-1 overflow-hidden px-4 mask-edges" onClick={(e) => e.stopPropagation()}>
                    {savedAddon.tags.slice(0, 3).map((tag) => {
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
                    {savedAddon.tags.length > 3 && (
                        <span style={{ fontFamily: '"DM Mono", monospace', fontSize: '9px', color: 'rgba(255,255,255,0.3)' }}>
                            +{savedAddon.tags.length - 3}
                        </span>
                    )}
                </div>

                {/* Saved Date */}
                <div className="shrink-0 text-right w-[16%] min-w-[120px] ml-4 flex items-center justify-end gap-3 ext-xs"
                    style={{
                        fontFamily: '"DM Mono", monospace',
                        fontSize: '9px',
                        color: 'rgba(255,255,255,0.25)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                    }}>
                    {profileName && <span className="truncate max-w-[80px] hidden sm:inline">{profileName} &bull;</span>} SAVED {getTimeAgo(new Date(savedAddon.createdAt))}
                </div>

                {/* Menu */}
                <div className="shrink-0 ml-4">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className="p-1 hover:bg-white/10 rounded-md transition-colors duration-150 outline-none flex items-center justify-center"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <MoreVertical className="h-4 w-4 text-white/40 hover:text-white" />
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
                            <DropdownMenuItem destructive onClick={() => setShowDeleteDialog(true)}>
                                <AnimatedTrashIcon className="h-4 w-4 mr-2" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <Dialog open={showDetails} onOpenChange={setShowDetails}>
                <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                    <SavedAddonDetails savedAddon={savedAddon} onClose={() => setShowDetails(false)} />
                </DialogContent>
            </Dialog>

            <ConfirmationDialog
                open={showDeleteDialog}
                onOpenChange={setShowDeleteDialog}
                title="Delete Saved Addon?"
                description="This will NOT remove it from accounts where it's already installed."
                confirmText="Delete"
                isDestructive={true}
                onConfirm={handleConfirmDelete}
            />
        </>
    )
}

function Check({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
    )
}
