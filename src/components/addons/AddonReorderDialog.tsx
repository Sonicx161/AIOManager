import { useState, useEffect } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
import { AddonDescriptor } from '@/types/addon'
import { SortableAddonItem } from './SortableAddonItem'
import { useAccountStore } from '@/store/accountStore'

interface AddonReorderDialogProps {
  accountId: string
  addons: AddonDescriptor[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddonReorderDialog({
  accountId,
  addons,
  open,
  onOpenChange,
}: AddonReorderDialogProps) {
  const [items, setItems] = useState<AddonDescriptor[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reorderAddons = useAccountStore((state) => state.reorderAddons)

  // Initialize items when dialog opens or addons change
  useEffect(() => {
    if (open) {
      setItems(addons)
      setError(null)
    }
  }, [open, addons])

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 5, // Prevent accidental clicks from triggering drag
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        distance: 5, // Prevent accidental touches from triggering drag
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
        const oldIndex = items.findIndex((item) => item.manifest.id === active.id)
        const newIndex = items.findIndex((item) => item.manifest.id === over.id)
        return arrayMove(items, oldIndex, newIndex)
      })
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await reorderAddons(accountId, items)
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save addon order'
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reorder Addons</DialogTitle>
          <DialogDescription>
            Drag and drop to reorder your addons. Changes will be saved to Stremio.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] overflow-y-auto py-4">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map((item) => item.manifest.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {items.map((addon) => (
                  <SortableAddonItem key={addon.manifest.id} id={addon.manifest.id} addon={addon} />
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
