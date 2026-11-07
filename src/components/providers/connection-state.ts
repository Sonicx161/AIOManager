import type { Connection, ConnectionStatus } from '../../types/connection.ts'

/** AIOMetadata exposes no live sessions, and its /Sessions poll never passes CORS. */
export function supportsLiveSessions(connection: Pick<Connection, 'mediaServer'>): boolean {
    const server = connection.mediaServer
    return server?.product !== 'aiometadata' && server?.productName?.toLowerCase() !== 'aiometadata'
}

export function countActiveConnections(
    connections: readonly Pick<Connection, 'id' | 'enabled' | 'status'>[],
    liveStatus: (id: string) => ConnectionStatus | undefined,
): number {
    return connections.filter(c => c.enabled !== false && (liveStatus(c.id) ?? c.status) === 'active').length
}

/** A paused connection reads as Disabled and shows no live state (sync, errors, expiry). */
export function connectionPresentation<S extends string>(enabled: boolean, display: S): { pill: S | 'disabled'; showLive: boolean } {
    return enabled ? { pill: display, showLive: true } : { pill: 'disabled', showLive: false }
}

/** Healthy rows show no status chip at all: the enabled toggle already says Active. */
export function isHealthyConnection<S extends string>(enabled: boolean, display: S): boolean {
    return connectionPresentation(enabled, display).showLive && display === 'active'
}
