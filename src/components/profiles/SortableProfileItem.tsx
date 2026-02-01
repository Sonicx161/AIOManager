import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, User } from 'lucide-react'
import { Profile } from '@/types/profile'
import { cn } from '@/lib/utils'

interface SortableProfileItemProps {
    id: string
    profile: Profile
}

export function SortableProfileItem({ id, profile }: SortableProfileItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={cn(
                'flex items-center gap-3 p-3 bg-card border rounded-lg',
                isDragging && 'opacity-50',
                'touch-none' // Important for touch devices
            )}
        >
            <div
                {...attributes}
                {...listeners}
                className="cursor-grab hover:text-foreground text-muted-foreground p-1 rounded hover:bg-muted transition-colors shrink-0"
            >
                <GripVertical className="h-4 w-4" />
            </div>

            <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="bg-muted p-2 rounded-full shrink-0">
                    <User className="w-4 h-4 text-muted-foreground" />
                </div>

                <div className="flex flex-col min-w-0">
                    <p className="font-medium text-sm truncate">{profile.name}</p>
                    {profile.description && (
                        <p className="text-xs text-muted-foreground truncate">
                            {profile.description}
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}
