import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useAccountStore } from '@/store/accountStore'
import { usePendingPush } from '@/hooks/usePendingPush'
import { getAllPendingResurrected, subscribePendingPush } from '@/lib/sync/pending-push'
import { resurrectedLine } from '@/lib/sync/pending-summary'

function useGuarded(action: () => Promise<unknown>) {
    const [busy, setBusy] = useState(false)
    const inFlight = useRef(false)
    const run = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        try {
            await action()
        } catch {
            // failures surface through sync history
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }, [action])
    return [busy, run] as const
}

export function ResurrectedNotice({ accountId }: { accountId: string }) {
    const reasons = usePendingPush(accountId)
    const counts = useSyncExternalStore(subscribePendingPush, getAllPendingResurrected)
    const removeAgain = useCallback(() => useAccountStore.getState().syncAccount(accountId, true, 'user'), [accountId])
    const [busy, run] = useGuarded(removeAgain)
    if (!reasons.includes('resurrected')) return null
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground" data-testid="resurrected-notice">
            <span>{resurrectedLine(counts.get(accountId))}</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground" disabled={busy} onClick={run}>
                {busy ? 'Removing...' : 'Remove again'}
            </Button>
        </div>
    )
}
