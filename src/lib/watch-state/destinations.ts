import type { Account } from '../../types/account.ts'
import type { WatchStateDestination } from './types.ts'
import { nuvioWatchSession, realStreamWatchSession, stremioWatchSession, watchMigrationSources } from './sources.ts'

export function watchMigrationDestinations(account: Pick<Account, 'authKey' | 'connections'>) {
    return watchMigrationSources(account)
}

export async function createWatchMigrationDestination(account: Account, key: CryptoKey, connectionId: string, signal: AbortSignal, assertCurrent: () => void = () => {}): Promise<WatchStateDestination> {
    const connection = watchMigrationSources(account).find(item => item.id === connectionId)
    if (!connection) throw new Error('This connection is not available as a watch-state destination.')
    signal.throwIfAborted()
    assertCurrent()
    if (connection.platform === 'jellyfin') {
        const [{ createJellyfinWatchDestination }, { decrypt }] = await Promise.all([import('./jellyfin.ts'), import('../crypto.ts')])
        return createJellyfinWatchDestination(connection, value => decrypt(value, key), signal, assertCurrent)
    }
    if (connection.platform === 'stremio') {
        const { createStremioWatchDestination } = await import('./destination-stremio.ts')
        return createStremioWatchDestination(await stremioWatchSession(account, connection, key, signal, assertCurrent))
    }
    if (connection.platform === 'realstream') {
        const { createRealStreamWatchDestination } = await import('./destination-realstream.ts')
        return createRealStreamWatchDestination(await realStreamWatchSession(account, connection, signal, assertCurrent))
    }
    if (connection.platform === 'nuvio') {
        const { createNuvioWatchDestination } = await import('./destination-nuvio.ts')
        return createNuvioWatchDestination(await nuvioWatchSession(account, connection, signal, ['sync_push_watched_items', 'sync_push_watch_progress'], assertCurrent, { reuse: true }))
    }
    throw new Error('This connection does not expose a supported watch-state write API.')
}
