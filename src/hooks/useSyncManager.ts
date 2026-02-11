import { useState, useEffect } from 'react'
import { syncManager } from '@/lib/sync/syncManager'

export function usePendingRemoval(accountId: string, transportUrl: string) {
    const [isPending, setIsPending] = useState(() =>
        syncManager.isPendingRemoval(accountId, transportUrl)
    )

    useEffect(() => {
        const checkStatus = () => {
            setIsPending(syncManager.isPendingRemoval(accountId, transportUrl))
        }

        // Initial check in case it changed between state init and effect
        checkStatus()

        // SyncManager triggers all observers on any change
        const unsubscribe = syncManager.subscribe(checkStatus)
        return () => { unsubscribe() }
    }, [accountId, transportUrl])

    return isPending
}
