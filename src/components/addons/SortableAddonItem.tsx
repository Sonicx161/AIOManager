import { AddonDescriptor } from '@/types/addon'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

interface SortableAddonItemProps {
  addon: AddonDescriptor
  id: string
}

export function SortableAddonItem({ addon, id }: SortableAddonItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        flex items-center gap-3 p-3 bg-card border rounded-lg transition-all duration-200
        ${isDragging ? 'shadow-xl z-50 border-primary scale-[1.02] ring-2 ring-primary/20' : 'shadow-sm'}
      `}
    >
      {/* Drag Handle - Increased Touch Target */}
      <div
        {...attributes}
        {...listeners}
        className="
          -ml-2 p-3 cursor-grab active:cursor-grabbing 
          text-muted-foreground hover:text-foreground 
          hover:bg-accent rounded-md transition-colors
        "
        style={{ touchAction: 'none' }}
        title="Drag to reorder"
      >
        <GripVertical className="h-5 w-5" />
      </div>

      {/* Addon Logo */}
      {addon.manifest.logo && (
        <img
          src={addon.manifest.logo}
          alt={addon.manifest.name}
          className="w-8 h-8 rounded object-contain flex-shrink-0 bg-transparent"
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
      )}

      {/* Addon Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className={`font-medium text-sm truncate ${isDragging ? 'text-primary' : ''}`}>
            {addon.metadata?.customName || addon.manifest.name}
          </h3>
          {(addon.flags?.protected || addon.flags?.official) && (
            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded flex-shrink-0">
              {addon.flags?.protected ? 'Protected' : 'Official'}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">v{addon.manifest.version}</p>
      </div>
    </div>
  )
}
