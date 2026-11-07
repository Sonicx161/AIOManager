/**
 * Dashboard query plumbing for the screens: retry policy, paged query options,
 * pane states and copy. Only the lazy dashboard chunk imports this module; the
 * app shell uses admin-session.ts. Relative imports for node:test.
 */
import {
    AdminApiError,
    getAudit,
    getUsers,
    type AuditPage,
    type UserFilterId,
    type UsersPage,
    type UsersQuery,
} from '../api/admin.ts'

export {
    ADMIN_STATUS_KEY,
    endAdminSession,
    handleAdminQueryError,
    isAdminQueryKey,
    isAdminSignedIn,
    overviewRefetchInterval,
} from './admin-session.ts'

export const ADMIN_AUDIT_KEY = ['admin-audit'] as const

// Dashboard reads retry transient failures (and 429/503) but never 4xx.
export function adminRetry(failureCount: number, error: Error): boolean {
    if (error instanceof AdminApiError) {
        if (error.status === 429 || error.status === 503) return failureCount < 3
        if (error.status >= 400 && error.status < 500) return false
    }
    return failureCount < 2
}

export function auditQueryOptions() {
    return {
        queryKey: ADMIN_AUDIT_KEY,
        queryFn: ({ pageParam }: { pageParam: string | null }) => getAudit(pageParam ?? undefined),
        initialPageParam: null as string | null,
        getNextPageParam: (last: AuditPage) => last.cursor,
        staleTime: 15_000,
        retry: adminRetry,
    }
}

export function usersQueryOptions(filter: UserFilterId, query: UsersQuery = {}) {
    const q = query.q ?? ''
    const sort = query.sort ?? 'lastseen'
    const order = query.order ?? 'desc'
    return {
        // The empty search and the server-default sort keep their own keys, so a
        // cleared box never append stale results from a searched page.
        queryKey: ['admin-users', filter, q, sort, order] as const,
        queryFn: ({ pageParam }: { pageParam: string | null }) => getUsers(filter, pageParam ?? undefined, { q: q || undefined, sort, order }),
        initialPageParam: null as string | null,
        getNextPageParam: (last: UsersPage) => last.cursor,
        staleTime: 30_000,
        retry: adminRetry,
    }
}

/** Flattens pages, keeping the first row per key (offset pages can overlap after a refetch). */
export function uniqueRows<T>(pages: { rows: T[] }[] | undefined, key: (row: T) => string | number): T[] {
    const seen = new Set<string | number>()
    const out: T[] = []
    for (const page of pages ?? []) {
        for (const row of page.rows) {
            const k = key(row)
            if (seen.has(k)) continue
            seen.add(k)
            out.push(row)
        }
    }
    return out
}

export function adminErrorStatus(error: unknown): number {
    return error instanceof AdminApiError ? error.status : 0
}

/** Pane error copy: unavailable (503) and rate limited read differently from a failed load. */
export function paneErrorCopy(error: unknown, subject: string): string {
    const status = adminErrorStatus(error)
    if (status === 503) return `${subject} is unavailable on this instance right now.`
    if (status === 429) return 'Too many requests. Wait a moment, then retry.'
    return `${subject} could not be loaded.`
}

export type PaneView = 'loading' | 'gone' | 'error' | 'stale' | 'ready'

/**
 * Which state a dashboard pane renders. A 404 wins over cached data (the thing
 * is gone); any other error with cached data keeps the data as stale; a failed
 * "Load more" keeps its own inline message instead.
 */
export function paneView(query: { isPending: boolean; data: unknown; error: unknown; isFetchNextPageError?: boolean }): PaneView {
    if (query.isPending) return 'loading'
    if (adminErrorStatus(query.error) === 404) return 'gone'
    if (query.data === undefined) return 'error'
    if (query.error && !query.isFetchNextPageError) return 'stale'
    return 'ready'
}

/** Quiet note above cached data after a failed refresh. */
export function staleNoteCopy(error: unknown): string {
    return adminErrorStatus(error) === 503
        ? 'Showing the last loaded data; the server is unavailable right now.'
        : 'Showing the last loaded data; the latest refresh failed.'
}

/**
 * Users footer line. Search is server-side: the match count comes from the
 * server (it searched every account), and "load more" pages within the matches.
 */
export function usersFooterText(o: { searching: boolean; matching: number; total: number; query: string; hasNextPage: boolean }): string {
    return o.searching
        ? `${o.matching === o.total && !o.hasNextPage
            ? `${o.matching} account${o.matching === 1 ? '' : 's'} match`
            : `${o.matching} of ${o.total} accounts match`} "${o.query}" in this filter${o.hasNextPage ? '; load more below' : ''}. The search ran on the server over every account.`
        : `Showing ${o.matching} of ${o.total} matching. Search runs on the server across every account.`
}
