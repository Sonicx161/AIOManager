import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { ReorderDialog } from '@/components/ui/reorder-dialog'
import { SavedAddonIcon } from './SavedAddonIcon'
import { SavedAddon } from '@/types/saved-addon'
import { useAddonStore } from '@/store/addonStore'

interface LibraryReorderDialogProps {
  sectionTitle: string
  addons: SavedAddon[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SavedAddonReorderRowProps {
  addon: SavedAddon
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  isDragging?: boolean
  isOverlay?: boolean
  setNodeRef?: (node: HTMLDivElement | null) => void
  style?: React.CSSProperties
}

const SavedAddonReorderRow = memo(function SavedAddonReorderRow({
  addon,
  dragHandleProps,
  isDragging = false,
  isOverlay = false,
  setNodeRef,
  style,
}: SavedAddonReorderRowProps) {
  return (
    <div
      data-theme-part="addon-card"
      ref={setNodeRef}
      style={style}
      className={[
        'flex w-full items-center gap-3 rounded-2xl border bg-card p-3',
        !isDragging ? 'transition-[transform,opacity,box-shadow,border-color] duration-200' : '',
        isOverlay
          ? 'cursor-grabbing border-primary/60 shadow-2xl ring-2 ring-primary/10'
          : isDragging
            ? 'opacity-0'
            : 'border-border/40 shadow-sm hover:border-border hover:shadow-md',
      ].join(' ')}
    >
      <div
        {...dragHandleProps}
        className={[
          'shrink-0 rounded-lg p-2 text-muted-foreground transition-colors',
          isOverlay ? 'cursor-grabbing' : 'cursor-grab hover:bg-muted/50 hover:text-foreground active:cursor-grabbing',
        ].join(' ')}
        style={{ touchAction: 'none' }}
      >
        <GripVertical className="h-4 w-4" />
      </div>

      <SavedAddonIcon
        name={addon.metadata?.customName || addon.name}
        addon={addon}
        alt={addon.name}
        className="h-9 w-9"
        textClassName="text-xs"
      />

      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-sm truncate">
          {addon.metadata?.customName || addon.name}
        </h3>
        <p className="text-xs font-mono text-muted-foreground">v{addon.manifest.version}</p>
      </div>
    </div>
  )
})

const SortableSavedAddon = memo(function SortableSavedAddon({ addon }: { addon: SavedAddon }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: addon.id,
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  return (
    <SavedAddonReorderRow
      addon={addon}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      setNodeRef={setNodeRef}
      style={style}
    />
  )
})

export function LibraryReorderDialog({
  sectionTitle,
  addons,
  open,
  onOpenChange,
}: LibraryReorderDialogProps) {
  const reorderSavedAddons = useAddonStore((state) => state.reorderSavedAddons)

  return (
    <ReorderDialog<SavedAddon>
      title={`Reorder ${sectionTitle}`}
      description="Drag and drop to reorder these addons. Changes will be saved."
      items={addons}
      getId={(addon) => addon.id}
      renderRow={(addon) => <SortableSavedAddon addon={addon} />}
      renderOverlay={(addon) => <SavedAddonReorderRow addon={addon} isOverlay />}
      onSave={(ordered) => reorderSavedAddons(ordered.map((item) => item.id))}
      onReset={() => [...addons].sort((a, b) =>
        (a.metadata?.customName || a.name).localeCompare(b.metadata?.customName || b.name)
      )}
      resetLabel="Reset to A-Z"
      saveErrorMessage="Failed to save addon order"
      open={open}
      onOpenChange={onOpenChange}
    />
  )
}
