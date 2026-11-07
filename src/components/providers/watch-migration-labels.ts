import type { Account } from '@/types/account'
import type { Connection } from '@/types/connection'
import { getAccountEmail, getStremioConnection } from '@/store/accountStore'
import { migrationConnectionLabel } from '@/lib/watch-state/sources'

// Number siblings within one product, so AIOMetadata and AIOStreams never count against each other.
function samePeers(connection: Connection, peers: readonly Connection[]): Connection[] {
    if (connection.platform !== 'jellyfin') return [...peers]
    const product = connection.mediaServer?.product
    return peers.filter(peer => peer.platform !== 'jellyfin' || peer.mediaServer?.product === product)
}

export function watchConnectionLabel(
    connection: Connection,
    peers: readonly Connection[],
    account: Account | undefined,
    formatPrivate: (value: string) => string,
    formatProfile: (value: string) => string = formatPrivate,
): string {
    const label = migrationConnectionLabel(connection, samePeers(connection, peers), formatPrivate, formatProfile)
    if (connection.platform !== 'stremio' || connection.credentials?.email || !account) return label
    const email = getStremioConnection(account)?.id === connection.id ? getAccountEmail(account) : undefined
    return email ? `${label} · ${formatPrivate(email)}` : label
}
