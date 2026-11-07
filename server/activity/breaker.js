// Consecutive fetch failures back off per account; a successful fetch clears the record.

export function createFailureBreaker({
    threshold = 2,
    baseMs = 5 * 60_000,
    maxMs = 60 * 60_000,
    now = () => Date.now(),
    maxEntries = 10_000,
} = {}) {
    // { failures: number, until: number, lastFailureAt: number }
    const entries = new Map()
    const enabled = baseMs > 0 && threshold > 0 && maxMs > 0

    const prune = () => {
        if (entries.size <= maxEntries) return
        const sorted = [...entries.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt)
        const overflow = sorted.length - maxEntries
        for (let i = 0; i < overflow; i++) entries.delete(sorted[i][0])
    }

    return {
        recordFailure(key) {
            if (!enabled) return
            const prev = entries.get(key)
            const failures = (prev?.failures ?? 0) + 1
            const until = failures >= threshold
                ? now() + Math.min(maxMs, baseMs * Math.pow(2, failures - threshold))
                : 0
            entries.set(key, { failures, until, lastFailureAt: now() })
            prune()
        },

        recordSuccess(key) {
            entries.delete(key)
        },

        // { skip, failures } | null (null = unknown key, never failed)
        shouldSkip(key) {
            if (!enabled) return null
            const entry = entries.get(key)
            if (!entry) return null
            if (entry.until > now()) return { skip: true, failures: entry.failures, until: entry.until }
            return { skip: false, failures: entry.failures, until: entry.until }
        },

        isTripped(key) {
            const s = this.shouldSkip(key)
            return Boolean(s?.skip)
        },

        size() {
            return entries.size
        },

        // Owner-scoped inspection and clearing (Dashboard repairs): the predicate sees
        // the raw key string, callers parse their own key convention.
        inspectMatching(fn) {
            const out = []
            for (const [key, entry] of entries.entries()) if (fn(key, entry)) out.push({ key, ...entry })
            return out
        },

        clearMatching(fn) {
            let cleared = 0
            for (const key of [...entries.keys()]) {
                if (fn(key, entries.get(key))) {
                    entries.delete(key)
                    cleared++
                }
            }
            return cleared
        },
    }
}
