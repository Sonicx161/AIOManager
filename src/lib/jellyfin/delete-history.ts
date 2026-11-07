import type { Account } from '../../types/account.ts'
import type { ActivityItem } from '../../types/activity.ts'
import { mapConcurrent } from '../concurrency.ts'
import { createJellyfinClient } from './client.ts'
import { openJellyfinSecret } from './connection-data.ts'

/** Clear only the exact server items that contributed to the selected Activity entries. */
export async function deleteJellyfinWatchItems(
    account: Pick<Account, 'id' | 'connections'>,
    items: ActivityItem[],
    open: (value: string) => Promise<string>,
    createClient = createJellyfinClient,
): Promise<Set<string>> {
    const kept = new Set<string>()
    const credentials = new Map<string, ReturnType<typeof openJellyfinSecret>>()
    const writes = new Map<string, Promise<void>>()
    await mapConcurrent(items, 4, async item => {
        try {
            const targets = item.mediaTargets || []
            if (item.accountId !== account.id || (item.source === 'jellyfin' && !targets.length)) throw new Error('Missing media item mapping')
            // Resolve every mapping before changing any of this entry's source state.
            const jobs = await Promise.all(targets.map(async target => {
                const connection = account.connections?.find(connection => connection.id === target.connectionId && connection.platform === 'jellyfin' && connection.enabled)
                if (!connection || !target.itemId) throw new Error('Media connection unavailable')
                if (!credentials.has(connection.id)) credentials.set(connection.id, openJellyfinSecret(connection, open))
                const secret = await credentials.get(connection.id)!
                return { target, secret }
            }))
            await Promise.all(jobs.map(({ target, secret }) => {
                const key = JSON.stringify([target.connectionId, target.itemId])
                if (!writes.has(key)) {
                    writes.set(key, createClient(secret.baseUrl, { deviceId: secret.deviceId }).clearWatchState(secret.accessToken, secret.userId, target.itemId))
                }
                return writes.get(key)!
            }))
        } catch {
            kept.add(item.id)
        }
    })
    return kept
}

/** Media connections whose server history an Activity delete changed. */
export function mediaDeleteTargets(items: ActivityItem[]): Array<{ accountId: string; connectionId: string }> {
    const seen = new Map<string, { accountId: string; connectionId: string }>()
    for (const item of items) {
        if (item.source !== 'jellyfin' && !item.mediaTargets?.length) continue
        const ids = item.mediaTargets?.length ? item.mediaTargets.map(target => target.connectionId) : [item.sourceConnectionId || '']
        for (const connectionId of ids) seen.set(JSON.stringify([item.accountId, connectionId]), { accountId: item.accountId, connectionId })
    }
    return [...seen.values()]
}
