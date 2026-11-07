// Failed native connection pushes (Nuvio, RealStream, Hydra) after a swap, kept in memory only and retried with
// backoff while the rule's target is unchanged. A restart drops them; the hourly connection audit re-finds any drift.
export const CONNECTION_RETRY_BASE_MS = 60_000
export const CONNECTION_RETRY_MAX_MS = 30 * 60_000
const MAX_PENDING = 10000

export const connectionRetryBackoffMs = (attempts) =>
    Math.min(CONNECTION_RETRY_MAX_MS, CONNECTION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))

export function createConnectionRetry({ nowMs }) {
    const pending = new Map()

    // connectionIds null means every enabled native connection of the account.
    const schedule = (ruleId, { accountId, target, connectionIds = null, due = false }) => {
        if (!ruleId) return
        const prev = pending.get(ruleId)
        const attempts = due ? 0 : (prev && prev.target === target ? prev.attempts : 0) + 1
        pending.delete(ruleId)
        pending.set(ruleId, { accountId, target, connectionIds, attempts, nextAt: due ? nowMs() : nowMs() + connectionRetryBackoffMs(attempts) })
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value)
    }

    // The due entry for this target; an entry for another target is stale (a new swap pushes everywhere) and is dropped.
    const takeDue = (ruleId, target) => {
        const entry = pending.get(ruleId)
        if (!entry) return null
        if (entry.target !== target) { pending.delete(ruleId); return null }
        return nowMs() >= entry.nextAt ? entry : null
    }

    const clear = (ruleId) => { pending.delete(ruleId) }
    const clearAccount = (accountId) => {
        for (const [ruleId, entry] of pending) if (entry.accountId === accountId) pending.delete(ruleId)
    }
    const get = (ruleId) => {
        const entry = pending.get(ruleId)
        return entry ? { ...entry, connectionIds: entry.connectionIds ? [...entry.connectionIds] : null } : null
    }

    return { schedule, takeDue, clear, clearAccount, get, size: () => pending.size }
}
