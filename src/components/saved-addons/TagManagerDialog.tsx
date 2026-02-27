import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAddonStore } from '@/store/addonStore'
import { Edit2, Trash2, Tag, Check, X } from 'lucide-react'
import { useState, useMemo } from 'react'
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
        const tagsSet = new Set<string>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => tagsSet.add(tag))
        })
        return Array.from(tagsSet).sort()
    }, [library])

    const [editingTag, setEditingTag] = useState<string | null>(null)
    const [newName, setNewName] = useState('')

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

    const handleDeleteTag = async (tag: string) => {
        // Find all addons with this tag
        const addonIds = Object.values(library)
            .filter(a => a.tags.includes(tag))
            .map(a => a.id)

        if (addonIds.length === 0) return

        try {
            await bulkUpdateSavedAddons(addonIds, { tagsRemove: [tag] })
            toast({ title: 'Tag Deleted', description: `Removed "${tag}" from ${addonIds.length} addons` })
        } catch (err) {
            toast({ title: 'Delete Failed', variant: 'destructive' })
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Tag className="h-5 w-5 text-primary" />
                        Global Tag Manager
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4 max-h-[400px] overflow-y-auto pr-2">
                    {allTags.length === 0 && (
                        <p className="text-center text-muted-foreground py-8">No tags found in library</p>
                    )}
                    {allTags.map((tag) => (
                        <div key={tag} className="flex items-center justify-between gap-4 p-2 rounded-lg border bg-accent/10 hover:bg-accent/20 transition-colors">
                            {editingTag === tag ? (
                                <div className="flex-1 flex gap-2">
                                    <Input
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        className="h-8 py-0"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleRename(tag)
                                            if (e.key === 'Escape') setEditingTag(null)
                                        }}
                                    />
                                    <Button size="icon" variant="ghost" className="h-8 w-8 text-green-500" onClick={() => handleRename(tag)}>
                                        <Check className="h-4 w-4" />
                                    </Button>
                                    <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={() => setEditingTag(null)}>
                                        <X className="h-4 w-4" />
                                    </Button>
                                </div>
                            ) : (
                                <>
                                    <span className="font-medium truncate">{tag}</span>
                                    <div className="flex gap-1">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8 text-muted-foreground hover:text-primary"
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
                                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                            onClick={() => handleDeleteTag(tag)}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
