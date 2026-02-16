import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Loader2, Tags, User } from 'lucide-react'
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
            <DialogContent className="sm:max-w-xl">
                <DialogHeader className="pb-4 border-b">
                    <DialogTitle>Bulk Edit {selectedCount} Addon{selectedCount !== 1 ? 's' : ''}</DialogTitle>
                    <DialogDescription>
                        Configure tags and profile assignment for all selected library items.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 py-6">
                    {/* Tag Management Card */}
                    <Card className="border shadow-none">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
                                <Tags className="h-4 w-4" />
                                Tag Management
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="grid gap-5">
                            <div className="grid gap-2">
                                <Label className="text-xs font-medium">Add Tags</Label>
                                <TagInput
                                    value={tagsToAdd}
                                    onChange={setTagsToAdd}
                                    placeholder="Type and press Enter to add..."
                                    suggestions={allKnownTags}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    These tags will be appended to the selection.
                                </p>
                            </div>

                            <div className="grid gap-2">
                                <Label className="text-xs font-medium">Remove Tags</Label>
                                <TagSelector
                                    value={tagsToRemove}
                                    onChange={setTagsToRemove}
                                    options={availableTags}
                                    placeholder="Select tags to remove..."
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    Only tags currently present in the selection are shown here.
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Profile Card */}
                    <Card className="border shadow-none">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-wide text-muted-foreground">
                                <User className="h-4 w-4" />
                                Profile Migration
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid gap-2">
                                <Label htmlFor="profile" className="text-xs font-medium">Assign to Profile</Label>
                                <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                                    <SelectTrigger className="bg-background">
                                        <SelectValue placeholder="No profile change" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="no-change"><i>Don't change profile</i></SelectItem>
                                        <SelectItem value="unassigned">Move to Unassigned</SelectItem>
                                        {profiles.map((profile) => (
                                            <SelectItem key={profile.id} value={profile.id}>
                                                {profile.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Change Preview */}
                    <div className="bg-muted/30 border border-dashed rounded-lg p-3 space-y-2">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Change Preview</h4>
                        <div className="text-xs space-y-1">
                            {tagsToAdd.length > 0 && (
                                <p>• Will add <b>{tagsToAdd.length}</b> tag{tagsToAdd.length !== 1 ? 's' : ''}: <span className="text-primary">{tagsToAdd.join(', ')}</span></p>
                            )}
                            {tagsToRemove.length > 0 && (
                                <p>• Will remove <b>{tagsToRemove.length}</b> tag{tagsToRemove.length !== 1 ? 's' : ''}: <span className="text-destructive">{tagsToRemove.join(', ')}</span></p>
                            )}
                            {selectedProfileId !== 'no-change' && (
                                <p>• Will move to <b>{selectedProfileId === 'unassigned' ? 'Unassigned' : profiles.find(p => p.id === selectedProfileId)?.name}</b> profile.</p>
                            )}
                            {tagsToAdd.length === 0 && tagsToRemove.length === 0 && selectedProfileId === 'no-change' && (
                                <p className="italic text-muted-foreground">No changes configured.</p>
                            )}
                        </div>
                    </div>
                </div>

                <DialogFooter className="pt-4 border-t">
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
