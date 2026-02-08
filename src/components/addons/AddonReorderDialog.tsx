import { useState, useEffect } from 'react'
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
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
  restrictToVerticalAxis,
} from '@dnd-kit/modifiers'
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
  const [items, setItems] = useState<(AddonDescriptor & { uniqueId: string })[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reorderAddons = useAccountStore((state) => state.reorderAddons)

  // Initialize items when dialog opens or addons change
  useEffect(() => {
    if (open) {
      // Assign unique fallback IDs to support duplicates during reorg
      setItems(addons.map((a, i) => ({ ...a, uniqueId: `${a.transportUrl}::${i}` })))
      setError(null)
    }
  }, [open, addons])

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 3,
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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      setItems((items) => {
        const oldIndex = items.findIndex((item) => item.uniqueId === active.id)
        const newIndex = items.findIndex((item) => item.uniqueId === over.id)
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
            modifiers={[restrictToVerticalAxis]}
          >
            <SortableContext
              items={items.map((item) => item.uniqueId)} // Use unique IDs
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {items.map((addon) => (
                  <SortableAddonItem key={addon.uniqueId} id={addon.uniqueId} addon={addon} />
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
