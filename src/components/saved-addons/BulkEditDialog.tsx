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
import { Loader2, Tags, User, RefreshCw } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'

interface BulkEditDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    selectedCount: number
    availableTags: string[]
    onSave: (data: { tags?: string[]; tagsRemove?: string[]; profileId?: string | null; syncWithInstalled?: boolean }) => Promise<void>
}

export function BulkEditDialog({ open, onOpenChange, selectedCount, availableTags, onSave }: BulkEditDialogProps) {
    const profiles = useProfileStore(s => s.profiles)
    const library = useAddonStore(s => s.library)

    const allKnownTags = useMemo(() => {
        const tagsSet = new Set<string>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => tagsSet.add(tag))
        })
        return Array.from(tagsSet).sort()
    }, [library])

    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [tagsToAdd, setTagsToAdd] = useState<string[]>([])
    const [tagsToRemove, setTagsToRemove] = useState<string[]>([])
    const [selectedProfileId, setSelectedProfileId] = useState<string>('no-change')
    const [syncWithInstalled, setSyncWithInstalled] = useState<'no-change' | boolean>('no-change')

    const hasChanges = tagsToAdd.length > 0 || tagsToRemove.length > 0 || selectedProfileId !== 'no-change' || syncWithInstalled !== 'no-change'

    useEffect(() => {
        if (open) {
            setTagsToAdd([])
            setTagsToRemove([])
            setSelectedProfileId('no-change')
            setSyncWithInstalled('no-change')
            setError(null)
        }
    }, [open])

    const handleSave = async () => {
        setLoading(true)
        setError(null)
        try {
            const data: { tags?: string[]; tagsRemove?: string[]; profileId?: string | null; syncWithInstalled?: boolean } = {}

            if (tagsToAdd.length > 0) {
                data.tags = tagsToAdd
            }

            if (tagsToRemove.length > 0) {
                data.tagsRemove = tagsToRemove
            }

            if (selectedProfileId !== 'no-change') {
                data.profileId = selectedProfileId === 'unassigned' ? null : selectedProfileId
            }

            if (syncWithInstalled !== 'no-change') {
                data.syncWithInstalled = syncWithInstalled
            }

            await onSave(data)
            onOpenChange(false)
        } catch (err) {
            if (import.meta.env.DEV) console.error(err)
            setError(err instanceof Error ? err.message : 'Bulk update failed. Nothing was changed.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl flex max-h-[calc(92dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:p-0">
                <DialogHeader className="p-5 pb-3 sm:p-6 sm:pb-4">
                    <DialogTitle>Edit {selectedCount} Addon{selectedCount !== 1 ? 's' : ''}</DialogTitle>
                    <DialogDescription>
                        Configure tags and profile assignment for all selected library items.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">
                    <div className="space-y-6">
                        <section className="space-y-4">
                            <h4 className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                                <Tags className="h-4 w-4" />
                                Tag Management
                            </h4>
                            <div className="grid gap-5">
                                <div className="grid gap-2">
                                    <Label className="text-xs font-medium">Add Tags</Label>
                                    <TagInput
                                        value={tagsToAdd}
                                        onChange={setTagsToAdd}
                                        placeholder="Type and press Enter to add..."
                                        suggestions={allKnownTags}
                                    />
                                    <p className="text-xs text-muted-foreground">
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
                                    <p className="text-xs text-muted-foreground">
                                        Only tags currently present in the selection are shown here.
                                    </p>
                                </div>
                            </div>
                        </section>

                        <section className="space-y-2">
                            <h4 className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                                <User className="h-4 w-4" />
                                Profile Migration
                            </h4>
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
                        </section>

                        <section className="space-y-2">
                            <h4 className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                                <RefreshCw className="h-4 w-4" />
                                Version Sync
                            </h4>
                            <div className="flex items-center justify-between gap-4">
                                <div className="space-y-0.5">
                                    <Label className="text-xs font-medium">Keep in sync with installed versions</Label>
                                    <p className="text-xs text-muted-foreground">Automatically updates library entries when installed addons are updated.</p>
                                </div>
                                <Select value={String(syncWithInstalled)} onValueChange={(v) => setSyncWithInstalled(v === 'no-change' ? 'no-change' : v === 'true')}>
                                    <SelectTrigger className="bg-background w-32 shrink-0">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="no-change"><i>No change</i></SelectItem>
                                        <SelectItem value="true">Enable</SelectItem>
                                        <SelectItem value="false">Disable</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </section>

                        <div className="bg-muted/30 border border-dashed rounded-lg p-3 space-y-2">
                            <h4 className="text-xs font-bold uppercase text-muted-foreground">Change Preview</h4>
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
                                {syncWithInstalled !== 'no-change' && (
                                    <p>• Will <b>{syncWithInstalled ? 'enable' : 'disable'}</b> version sync.</p>
                                )}
                                {tagsToAdd.length === 0 && tagsToRemove.length === 0 && selectedProfileId === 'no-change' && syncWithInstalled === 'no-change' && (
                                    <p className="italic text-muted-foreground">No changes configured.</p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {error && (
                    <div role="alert" className="mx-5 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-6">
                        {error}
                    </div>
                )}

                <DialogFooter className="px-5 pb-5 sm:px-6 sm:pb-6">
                    <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={loading || !hasChanges} className="gap-2">
                        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                        Apply Changes
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
