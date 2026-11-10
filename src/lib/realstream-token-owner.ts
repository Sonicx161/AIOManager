import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { clearRealStreamTokens, type RealStreamTokenOwner } from '@/lib/realstream-token-cache'
import { useSyncStore } from '@/store/syncStore'
import { getSyncApiPath } from '@/store/sync-store-helpers'
import type { Connection } from '@/types/connection'

subscribeWorkspaceChanges(clearRealStreamTokens)

export function realStreamTokenOwner(accountId: string, connection: Pick<Connection, 'id' | 'generation' | 'credentials'>): RealStreamTokenOwner {
    const sync = useSyncStore.getState()
    return {
        session: [getActiveWorkspaceId(), getSyncApiPath(sync.serverUrl), sync.auth.id].join('|'),
        accountId,
        connection: { id: connection.id, generation: connection.generation, credentials: connection.credentials },
    }
}
