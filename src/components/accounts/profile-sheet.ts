// Pure helpers for the Edit Account profile sheet. They run directly in node:test.

interface CardVisibility {
    hideLastWatched?: boolean
    hideAddonPreview?: boolean
    hidePlatformLogos?: boolean
}

/** Short "On the card" row summary: what the dashboard card still shows. */
export function cardVisibilitySummary(visibility: CardVisibility): string {
    const extras: Array<[boolean, string]> = [
        [!!visibility.hideLastWatched, 'last watched'],
        [!!visibility.hideAddonPreview, 'addons'],
        [!!visibility.hidePlatformLogos, 'platforms'],
    ]
    const hidden = extras.filter(([isHidden]) => isHidden).map(([, label]) => label)
    if (hidden.length === 0) return 'Last watched, addons, platforms'
    return `Hidden: ${hidden.join(', ')}`
}

/** "N active" row summary; paused connections (enabled === false) do not count. */
export function activeConnectionsLabel(connections: ReadonlyArray<{ enabled?: boolean }>): string {
    const count = connections.filter(connection => connection.enabled !== false).length
    return count === 0 ? 'None' : `${count} active`
}
