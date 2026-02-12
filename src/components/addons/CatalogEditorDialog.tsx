import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
import { AddonDescriptor, Catalog } from '@/types/addon'
import {
    DndContext,
    closestCenter,
    MouseSensor,
    TouchSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core'
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2, RotateCcw } from 'lucide-react'
import { useState, useEffect } from 'react'

interface SortableCatalogItemProps {
    catalog: Catalog & { _tempId: string }
    onRename: (id: string, name: string) => void
    onDelete: (id: string) => void
}

function SortableCatalogItem({ catalog, onRename, onDelete }: SortableCatalogItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: catalog._tempId })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`flex items-center gap-3 p-3 rounded-lg border bg-card ${isDragging ? 'shadow-lg' : ''}`}
        >
            {/* Drag handle - Increased Touch Target */}
            <button
                {...attributes}
                {...listeners}
                className="
                    -ml-2 p-3 cursor-grab active:cursor-grabbing 
                    text-muted-foreground hover:text-foreground 
                    hover:bg-accent rounded-md transition-colors 
                    shrink-0
                "
                style={{ touchAction: 'none' }}
                title="Drag to reorder"
            >
                <GripVertical className="h-5 w-5" />
            </button>

            {/* Name input */}
            <div className="flex-1 min-w-0">
                <Input
                    value={catalog.name || ''}
                    placeholder={`${catalog.type} - ${catalog.id}`}
                    onChange={(e) => onRename(catalog._tempId, e.target.value)}
                    className="h-8"
                />
                <div className="text-xs text-muted-foreground mt-1">
                    Type: {catalog.type} • ID: {catalog.id}
                </div>
            </div>

            {/* Delete button */}
            <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(catalog._tempId)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
                <Trash2 className="h-4 w-4" />
            </Button>
        </div>
    )
}

interface CatalogEditorDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    addon: AddonDescriptor
    onSave: (updatedAddon: AddonDescriptor) => Promise<void>
}

export function CatalogEditorDialog({
    open,
    onOpenChange,
    addon,
    onSave,
}: CatalogEditorDialogProps) {
    const [catalogs, setCatalogs] = useState<(Catalog & { _tempId: string })[]>([])
    const [saving, setSaving] = useState(false)
    const [hasChanges, setHasChanges] = useState(false)

    const sensors = useSensors(
        useSensor(MouseSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(TouchSensor, {
            activationConstraint: {
                delay: 200,
                tolerance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    )

    // Initialize catalogs when dialog opens
    useEffect(() => {
        if (open && addon.manifest.catalogs) {
            // Respect existing overrides on open
            const removedIds = new Set(addon.catalogOverrides?.removed || [])

            const effectiveCatalogs = addon.manifest.catalogs
                .filter(cat => !removedIds.has(cat.id))
                .map((cat, idx) => ({
                    ...cat,
                    _tempId: `${cat.id}-${cat.type}-${idx}`,
                }))

            setCatalogs(effectiveCatalogs)
            setHasChanges(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open])

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            setCatalogs((items) => {
                const oldIndex = items.findIndex((item) => item._tempId === active.id)
                const newIndex = items.findIndex((item) => item._tempId === over.id)
                setHasChanges(true)
                return arrayMove(items, oldIndex, newIndex)
            })
        }
    }

    const handleRename = (id: string, name: string) => {
        setCatalogs((items) =>
            items.map((item) =>
                item._tempId === id ? { ...item, name } : item
            )
        )
        setHasChanges(true)
    }

    const handleDelete = (id: string) => {
        setCatalogs((items) => items.filter((item) => item._tempId !== id))
        setHasChanges(true)
    }

    const handleSave = async () => {
        setSaving(true)
        try {
            // Remove the temporary IDs before saving
            const cleanedCatalogs: Catalog[] = catalogs.map(({ _tempId, ...rest }) => rest)
            const currentCatalogIds = new Set(cleanedCatalogs.map(c => c.id))

            // Logic:
            // 1. Start with existing removed IDs
            const finalRemovedIds = new Set(addon.catalogOverrides?.removed || [])

            // 2. Un-delete: If an ID is currently visible, it must NOT be in the removed list
            for (const id of currentCatalogIds) {
                finalRemovedIds.delete(id)
            }

            // 3. New Deletions: If an ID was in the visible list we started with, but is gone now, ADD it to removed
            const originalVisibleIds = (addon.manifest.catalogs || []).map(c => c.id)
            for (const id of originalVisibleIds) {
                if (!currentCatalogIds.has(id)) {
                    finalRemovedIds.add(id)
                }
            }

            const updatedAddon: AddonDescriptor = {
                ...addon,
                manifest: {
                    ...addon.manifest,
                    catalogs: cleanedCatalogs,
                },
                catalogOverrides: {
                    ...addon.catalogOverrides,
                    removed: Array.from(finalRemovedIds)
                }
            }

            await onSave(updatedAddon)

            toast({
                title: 'Catalogs Updated',
                description: `Changes saved for ${addon.manifest.name}`,
            })

            onOpenChange(false)
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Failed to Save',
                description: error instanceof Error ? error.message : 'Unknown error',
            })
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        setSaving(true)
        try {
            const { fetchAddonManifest } = await import('@/api/addons')
            const fresh = await fetchAddonManifest(addon.transportUrl)

            if (fresh.manifest.catalogs) {
                const freshCatalogs = fresh.manifest.catalogs.map((cat, idx) => ({
                    ...cat,
                    _tempId: `${cat.id}-${cat.type}-${idx}`,
                }))
                setCatalogs(freshCatalogs)
                setHasChanges(true)
                toast({
                    title: 'Catalogs Reset',
                    description: 'Loaded original catalogs from addon. Click Save to apply.',
                })
            }
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Reset Failed',
                description: 'Could not fetch original manifest.',
            })
        } finally {
            setSaving(false)
        }
    }

    const catalogCount = catalogs.length

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>Edit Catalogs: {addon.manifest.name}</DialogTitle>
                    <DialogDescription>
                        Drag to reorder, rename, or delete catalogs. {catalogCount} catalog{catalogCount !== 1 ? 's' : ''}.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto space-y-2 py-4">
                    {catalogs.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            This addon has no catalogs
                        </div>
                    ) : (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext
                                items={catalogs.map((c) => c._tempId)}
                                strategy={verticalListSortingStrategy}
                            >
                                {catalogs.map((catalog) => (
                                    <SortableCatalogItem
                                        key={catalog._tempId}
                                        catalog={catalog}
                                        onRename={handleRename}
                                        onDelete={handleDelete}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>
                    )}
                </div>

                <DialogFooter className="gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={handleReset}
                        disabled={saving}
                        className="mr-auto text-muted-foreground hover:text-foreground"
                        title="Restore original catalogs"
                    >
                        <RotateCcw className="h-4 w-4 mr-2" />
                        Default
                    </Button>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={!hasChanges || saving}>
                        {saving ? 'Saving...' : 'Save Changes'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
