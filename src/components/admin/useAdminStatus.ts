import { useCallback, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AdminStatus } from '@/api/admin'

/**
 * Reads the cached dashboard status without fetching. The dashboard route
 * (DashboardPage) owns the actual status query; the header pill nav only needs
 * to know whether cached status resolves to a signed-in dashboard so it can
 * swap the app nav for the dashboard pills.
 */
export function useAdminStatusCache() {
    // Reads the cache only: no observer, so no second queryFn on the shared key
    // (a refetch from the sign-in invalidate must still reach the real call), and
    // no import of the dashboard API into the entry chunk.
    const client = useQueryClient()
    const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client])
    return useSyncExternalStore(subscribe, () => client.getQueryData<AdminStatus>(['admin-status']))
}

/** Pills only when the dashboard is enabled, provisioned and signed in. */
export function isDashboardReady(status: { enabled: boolean; setupRequired: boolean; signedIn: boolean } | undefined): boolean {
    return Boolean(status && status.enabled && !status.setupRequired && status.signedIn)
}
