import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { TagInput } from '@/components/ui/tag-input'
import { TagSelector } from '@/components/ui/tag-selector'
import { useAddonStore } from '@/store/addonStore'
import { useProfileStore } from '@/store/profileStore'
import { Loader2 } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'

interface BulkEditDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    selectedCount: number
    availableTags: string[]
    onSave: (data: { tags?: string[]; tagsRemove?: string[]; profileId?: string | null }) => Promise<void>
}

export function BulkEditDialog({ open, onOpenChange, selectedCount, availableTags, onSave }: BulkEditDialogProps) {
    const { profiles } = useProfileStore()
    const library = useAddonStore(s => s.library)

    const allKnownTags = useMemo(() => {
        const tagsSet = new Set<string>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => tagsSet.add(tag))
        })
        return Array.from(tagsSet).sort()
    }, [library])

    const [loading, setLoading] = useState(false)

    // Data State
    const [tagsToAdd, setTagsToAdd] = useState<string[]>([])
    const [tagsToRemove, setTagsToRemove] = useState<string[]>([])
    const [selectedProfileId, setSelectedProfileId] = useState<string>('no-change')

    // Reset state when dialog opens
    useEffect(() => {
        if (open) {
            setTagsToAdd([])
            setTagsToRemove([])
            setSelectedProfileId('no-change')
        }
    }, [open])

    const handleSave = async () => {
        setLoading(true)
        try {
            const data: { tags?: string[]; tagsRemove?: string[]; profileId?: string | null } = {}

            if (tagsToAdd.length > 0) {
                data.tags = tagsToAdd
            }

            if (tagsToRemove.length > 0) {
                data.tagsRemove = tagsToRemove
            }

            if (selectedProfileId !== 'no-change') {
                data.profileId = selectedProfileId === 'unassigned' ? null : selectedProfileId
            }

            await onSave(data)
            onOpenChange(false)
        } catch (error) {
            console.error(error)
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Bulk Edit {selectedCount} Addons</DialogTitle>
                    <DialogDescription>
                        Apply changes to all selected addons.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 py-4">
                    <div className="space-y-4">
                        <Label className="uppercase text-xs font-bold text-muted-foreground">Tag Management</Label>

                        <div className="grid gap-2">
                            <Label>Add Tags</Label>
                            <TagInput
                                value={tagsToAdd}
                                onChange={setTagsToAdd}
                                placeholder="Type and press Enter to add..."
                                suggestions={allKnownTags}
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Tags will be added to all selected addons.
                            </p>
                        </div>

                        <div className="grid gap-2">
                            <Label>Remove Tags</Label>
                            <TagSelector
                                value={tagsToRemove}
                                onChange={setTagsToRemove}
                                options={availableTags}
                                placeholder="Select tags to remove..."
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Only tags present in the selection are shown.
                            </p>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <Label className="uppercase text-xs font-bold text-muted-foreground">Profile</Label>
                        <div className="grid gap-2">
                            <Label htmlFor="profile">Move to Profile</Label>
                            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Don't change profile" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="no-change">Don't change profile</SelectItem>
                                    <SelectItem value="unassigned">Unassigned (No Profile)</SelectItem>
                                    {profiles.map((profile) => (
                                        <SelectItem key={profile.id} value={profile.id}>
                                            {profile.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={loading}>
                        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Apply Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
