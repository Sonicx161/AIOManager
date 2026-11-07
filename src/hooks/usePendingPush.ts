import { useSyncExternalStore } from 'react'
import { getPendingPush, subscribePendingPush } from '@/lib/sync/pending-push'

export function usePendingPush(accountId: string) {
    return useSyncExternalStore(subscribePendingPush, () => getPendingPush(accountId))
}
