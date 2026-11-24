export type DestinationState = 'removed' | 'paused' | 'partial' | 'sync'

export interface DestinationConnectionLike {
    id: string
    platform: string
    enabled?: boolean
}

export interface DestinationRow {
    draft: DestinationState
    saved: DestinationState
    policyChanged?: boolean
}

const rowUnsaved = (row: DestinationRow) => row.draft !== row.saved || row.policyChanged === true

export function destinationPolicyChanged(
    platform: string,
    connections: readonly DestinationConnectionLike[],
    draft: { platforms: ReadonlySet<string>; connections: ReadonlySet<string> },
    saved: { platforms: ReadonlySet<string>; connections: ReadonlySet<string> },
): boolean {
    if (draft.platforms.has(platform) !== saved.platforms.has(platform)) return true
    return connections.some(c => c.platform === platform && draft.connections.has(c.id) !== saved.connections.has(c.id))
}

export function destinationState(
    platform: string,
    connections: readonly DestinationConnectionLike[],
    excludedPlatforms: ReadonlySet<string>,
    excludedConnections: ReadonlySet<string>,
): DestinationState {
    const conns = connections.filter(c => c.platform === platform)
    const live = conns.filter(c => !excludedConnections.has(c.id))
    if (excludedPlatforms.has(platform) || live.length === 0) return 'removed'
    if (!live.some(c => c.enabled)) return 'paused'
    return live.length < conns.length ? 'partial' : 'sync'
}

export function destinationRowLabel(row: DestinationRow): string {
    const unsaved = rowUnsaved(row)
    switch (row.draft) {
        case 'removed': return unsaved ? 'Will be removed on save' : 'Not synced here'
        case 'sync': return unsaved ? 'Will sync' : 'Syncs here'
        case 'paused': return 'Sync paused'
        case 'partial': return 'Some logins excluded'
    }
}

export interface DestinationSummary {
    main: string
    paused: string | null
    removed: string | null
}

export function destinationSummary(rows: readonly DestinationRow[]): DestinationSummary {
    const total = rows.length
    const syncing = rows.filter(r => r.draft === 'sync' || r.draft === 'partial').length
    const paused = rows.filter(r => r.draft === 'paused').length
    const pendingRemovals = rows.filter(r => r.draft === 'removed' && r.saved !== 'removed').length
    const unsaved = rows.some(rowUnsaved)
    const noun = total === 1 ? 'platform' : 'platforms'
    return {
        main: `${syncing} of ${total} ${noun} ${unsaved ? 'will sync' : 'sync'}`,
        paused: paused > 0 ? `, ${paused} paused` : null,
        removed: unsaved && pendingRemovals > 0 ? `, ${pendingRemovals} will be removed on save` : null,
    }
}
