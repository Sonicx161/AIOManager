/**
 * Dashboard session state the app shell needs: query-key scoping, the 401
 * teardown and the CSRF token. Loaded with the entry chunk, so it imports only
 * the transport (never api/admin.ts). Relative imports for node:test.
 */
import type { Query, QueryClient } from '@tanstack/react-query'
import type { AdminStatus } from '../api/admin.ts'
import { AdminApiError } from '../api/admin-transport.ts'

export const ADMIN_STATUS_KEY = ['admin-status'] as const
export const OVERVIEW_REFETCH_MS = 30_000

let csrfToken: string | null = null

export function getAdminCsrf(): string | null {
    return csrfToken
}

export function setAdminCsrf(token: string | null): void {
    csrfToken = token
}

/** Invalidate the cached CSRF token (after sign-out or a CSRF rejection). */
export function invalidateAdminCsrf(): void {
    csrfToken = null
}

// Dashboard queries are session-scoped: never persisted to IndexedDB, and
// dropped as soon as the dashboard session ends (sign-out or a 401).
export function isAdminQueryKey(key: unknown): boolean {
    return Array.isArray(key) && String(key[0]).startsWith('admin-')
}

/**
 * Ends the dashboard session in the cache. The status flips to signed out first
 * so the gate swaps to the sign-in screen on the next render, then every other
 * dashboard query is cancelled and dropped, and the status is confirmed with
 * the server. Used by every sign-out path and the 401 handler.
 */
export function endAdminSession(client: QueryClient): void {
    invalidateAdminCsrf()
    client.setQueryData<AdminStatus>(ADMIN_STATUS_KEY, prev => (prev ? { ...prev, signedIn: false } : prev))
    const others = { predicate: (q: Query) => isAdminQueryKey(q.queryKey) && q.queryKey[0] !== ADMIN_STATUS_KEY[0] }
    void client.cancelQueries(others)
    client.removeQueries(others)
    void client.invalidateQueries({ queryKey: ADMIN_STATUS_KEY })
}

export function handleAdminQueryError(client: QueryClient, error: unknown): void {
    if (error instanceof AdminApiError && error.status === 401) endAdminSession(client)
}

export function isAdminSignedIn(client: QueryClient): boolean {
    return client.getQueryData<AdminStatus>(ADMIN_STATUS_KEY)?.signedIn === true
}

/** Overview polls only while the cached status says signed in. */
export function overviewRefetchInterval(client: QueryClient): () => number | false {
    return () => (isAdminSignedIn(client) ? OVERVIEW_REFETCH_MS : false)
}
