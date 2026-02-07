import { useState, useEffect } from 'react'
import {
    DndContext,
    closestCenter,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Profile } from '@/types/profile'
import { SortableProfileItem } from './SortableProfileItem'
import { useProfileStore } from '@/store/profileStore'

interface ProfileReorderDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export function ProfileReorderDialog({
    open,
    onOpenChange,
}: ProfileReorderDialogProps) {
    const { profiles, reorderProfiles } = useProfileStore()
    const [items, setItems] = useState<Profile[]>([])
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Initialize items when dialog opens or profiles change
    useEffect(() => {
        if (open) {
            setItems(profiles)
            setError(null)
        }
    }, [open, profiles])

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                delay: 250,
                tolerance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setItems((items) => {
                const oldIndex = items.findIndex((item) => item.id === active.id)
                const newIndex = items.findIndex((item) => item.id === over.id)
                return arrayMove(items, oldIndex, newIndex)
            })
        }
    }

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
            await reorderProfiles(items)
            onOpenChange(false)
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to save profile order'
            setError(message)
        } finally {
            setSaving(false)
        }
    }

    const handleCancel = () => {
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Reorder Profiles</DialogTitle>
                    <DialogDescription>
                        Drag and drop to reorder your profiles.
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-[60vh] overflow-y-auto py-4">
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={items.map((item) => item.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="space-y-2">
                                {items.length === 0 && (
                                    <p className="text-center text-muted-foreground py-4">No profiles to reorder.</p>
                                )}
                                {items.map((profile) => (
                                    <SortableProfileItem key={profile.id} id={profile.id} profile={profile} />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <DialogFooter>
                    <Button variant="outline" onClick={handleCancel} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
