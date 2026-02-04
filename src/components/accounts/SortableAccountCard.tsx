import { AccountCard } from './AccountCard'
import { StremioAccount } from '@/types/account'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

interface SortableAccountCardProps {
    account: StremioAccount
    isSelected?: boolean
    onToggleSelect?: (accountId: string) => void
    onDelete?: () => void
    isSelectionMode?: boolean
}

export function SortableAccountCard({
    account,
    isSelected,
    onToggleSelect,
    onDelete,
    isSelectionMode,
}: SortableAccountCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: account.id,
    })

    // We only pass attributes and listeners to the drag handle
    const dragHandleProps = {
        ...attributes,
        ...listeners,
    }

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 10 : 'auto',
        position: 'relative' as const,
    }

    return (
        <div ref={setNodeRef} style={style}>
            <AccountCard
                account={account}
                isSelected={isSelected}
                onToggleSelect={onToggleSelect}
                onDelete={onDelete}
                // Pass drag handle props to AccountCard to render the grip
                dragHandleProps={dragHandleProps}
                isSelectionMode={isSelectionMode}
            />
        </div>
    )
}
