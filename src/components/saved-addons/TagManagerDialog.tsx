import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAddonStore } from '@/store/addonStore'
import { Edit2, Trash2, Tag, Check, X, Search } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'
import { toast } from '@/hooks/use-toast'

interface TagManagerDialogProps {
    isOpen: boolean
    onClose: () => void
}

export function TagManagerDialog({ isOpen, onClose }: TagManagerDialogProps) {
    const library = useAddonStore((state) => state.library)
    const renameTag = useAddonStore((state) => state.renameTag)
    const bulkUpdateSavedAddons = useAddonStore((state) => state.bulkUpdateSavedAddons)

    const allTags = useMemo(() => {
        const counts = new Map<string, number>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => {
                counts.set(tag, (counts.get(tag) || 0) + 1)
            })
        })
        return Array.from(counts.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [library])

    const [editingTag, setEditingTag] = useState<string | null>(null)
    const [newName, setNewName] = useState('')
    const [search, setSearch] = useState('')
    const [confirmingDeleteTag, setConfirmingDeleteTag] = useState<string | null>(null)

    useEffect(() => {
        if (!isOpen) {
            setEditingTag(null)
            setConfirmingDeleteTag(null)
        }
    }, [isOpen])

    const filteredTags = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return allTags
        return allTags.filter((tag) => tag.name.toLowerCase().includes(query))
    }, [allTags, search])

    const handleRename = async (oldTag: string) => {
        if (!newName.trim() || newName === oldTag) {
            setEditingTag(null)
            return
        }

        try {
            await renameTag(oldTag, newName.trim())
            toast({ title: 'Tag Renamed', description: `"${oldTag}" is now "${newName.trim()}"` })
            setEditingTag(null)
            setNewName('')
        } catch (err) {
            toast({ title: 'Rename Failed', variant: 'destructive' })
        }
    }

    const handleDeleteTag = async (tag: string, count: number) => {
        const addonIds = Object.values(library)
            .filter(a => a.tags.includes(tag))
            .map(a => a.id)

        if (addonIds.length === 0) return

        try {
            await bulkUpdateSavedAddons(addonIds, { tagsRemove: [tag] })
            toast({
                title: 'Tag Deleted',
                description: count > 0 ? `Removed "${tag}" from ${count} addon${count !== 1 ? 's' : ''}` : `Removed "${tag}"`,
            })
        } catch (err) {
            toast({ title: 'Delete Failed', variant: 'destructive' })
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[88dvh] sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Tag className="h-5 w-5 text-primary" />
                        Global Tag Manager
                    </DialogTitle>
                    <DialogDescription>
                        Rename a tag everywhere it appears, or remove it from every saved addon.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-3">
                    <div data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/45 bg-muted/25 px-3 py-2">
                        <div>
                            <p className="text-sm font-semibold">{allTags.length} tag{allTags.length !== 1 ? 's' : ''}</p>
                            <p className="text-xs text-muted-foreground">Changes apply across the whole library.</p>
                        </div>
                    </div>

                    {allTags.length > 0 && (
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search tags..."
                                className="h-9 pl-9 text-sm"
                            />
                        </div>
                    )}

                    <div className="max-h-[min(52vh,24rem)] space-y-2 overflow-y-auto pr-1">
                        {allTags.length === 0 && (
                            <p className="text-center text-sm text-muted-foreground py-8">No tags found in library</p>
                        )}
                        {allTags.length > 0 && filteredTags.length === 0 && (
                            <p className="text-center text-sm text-muted-foreground py-8">No tags match your search</p>
                        )}
                        {filteredTags.map(({ name: tag, count }) => (
                            <div key={tag} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/45 bg-card/80 p-2.5 transition-colors hover:bg-muted/30">
                                {editingTag === tag ? (
                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                        <Input
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            className="h-11 py-0 sm:h-8"
                                            autoFocus
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleRename(tag)
                                                if (e.key === 'Escape') setEditingTag(null)
                                            }}
                                        />
                                        <Button size="icon" variant="ghost" className="h-11 w-11 text-success sm:h-8 sm:w-8" onClick={() => handleRename(tag)} aria-label="Save name">
                                            <Check className="h-4 w-4" />
                                        </Button>
                                        <Button size="icon" variant="ghost" className="h-11 w-11 text-muted-foreground sm:h-8 sm:w-8" onClick={() => setEditingTag(null)} aria-label="Cancel rename">
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ) : confirmingDeleteTag === tag ? (
                                    <>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-semibold">{tag}</div>
                                            <div className="text-xs text-muted-foreground">
                                                Remove from {count} addon{count !== 1 ? 's' : ''}?
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 gap-1">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-11 px-3 text-destructive hover:text-destructive sm:h-8"
                                                onClick={() => {
                                                    setConfirmingDeleteTag(null)
                                                    handleDeleteTag(tag, count)
                                                }}
                                            >
                                                Remove
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-11 px-3 text-muted-foreground sm:h-8"
                                                onClick={() => setConfirmingDeleteTag(null)}
                                            >
                                                Cancel
                                            </Button>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-semibold">{tag}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {count} addon{count !== 1 ? 's' : ''}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 gap-1">
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-11 w-11 text-muted-foreground hover:text-primary sm:h-8 sm:w-8"
                                                aria-label={`Rename tag ${tag}`}
                                                onClick={() => {
                                                    setEditingTag(tag)
                                                    setNewName(tag)
                                                }}
                                            >
                                                <Edit2 className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-11 w-11 text-muted-foreground hover:text-destructive sm:h-8 sm:w-8"
                                                aria-label={`Delete tag ${tag}`}
                                                onClick={() => setConfirmingDeleteTag(tag)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="subtle" onClick={onClose}>Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
