import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { CommandItem, CommandResultGroup } from './CommandPalette'

export function VirtualCommandResults({ groups, selectedIndex, query, scrollRoot, renderItem }: {
    groups: CommandResultGroup[]
    selectedIndex: number
    query: string
    scrollRoot: HTMLDivElement | null
    renderItem: (item: CommandItem) => React.ReactNode
}) {
    const rows = useMemo(() => {
        let commandIndex = 0
        return groups.flatMap(group => [
            { key: `heading:${group.category}`, category: group.category, item: null as CommandItem | null, commandIndex: -1 },
            ...group.items.map(item => ({ key: `item:${item.id}`, category: group.category, item, commandIndex: commandIndex++ })),
        ])
    }, [groups])
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRoot?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]') ?? null,
        estimateSize: index => rows[index].item ? 72 : 36,
        getItemKey: index => rows[index].key,
        scrollPaddingStart: 12,
        scrollPaddingEnd: 12,
        overscan: 6,
    })
    const selectionScroll = useRef<{ selectedIndex: number; query: string; scrollRoot: HTMLDivElement | null } | null>(null)
    useEffect(() => {
        const previous = selectionScroll.current
        selectionScroll.current = { selectedIndex, query, scrollRoot }
        if (previous && previous.selectedIndex === selectedIndex && previous.query === query && previous.scrollRoot === scrollRoot) return
        const rowIndex = rows.findIndex(row => row.commandIndex === selectedIndex)
        if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
    }, [rows, selectedIndex, query, scrollRoot, virtualizer])
    return <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map(virtualRow => {
            const row = rows[virtualRow.index]
            return <div key={virtualRow.key} data-index={virtualRow.index} ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', paddingBottom: 4, transform: `translateY(${virtualRow.start}px)` }}>
                {row.item ? renderItem(row.item) : <div className="px-6 pt-3 pb-1 text-xs font-medium text-muted-foreground">{row.category.charAt(0) + row.category.slice(1).toLowerCase()}</div>}
            </div>
        })}
    </div>
}
