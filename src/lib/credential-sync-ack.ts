// Which pending Stremio transition notes a credential sync response settled: a 200 can still reject individual accounts.
export function acknowledgedTransitionAccounts(pendingAccountIds: string[], response: unknown): string[] {
    const rejected = new Set<string>()
    const list = (response as { rejected?: unknown } | null)?.rejected
    if (Array.isArray(list)) {
        for (const entry of list) {
            const accountId = (entry as { accountId?: unknown } | null)?.accountId
            if (accountId !== undefined && accountId !== null) rejected.add(String(accountId))
        }
    }
    return pendingAccountIds.filter(accountId => !rejected.has(String(accountId)))
}
