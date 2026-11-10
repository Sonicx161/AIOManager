// One shared in-flight request per owner scope. A caller joins the pending request
// only when its scope key matches the one that started it; any other scope starts
// its own request and replaces the entry. clear() drops the entry on session
// transitions, and an old completion never clears a newer entry.

export interface ScopedSingleFlight<T> {
    run(scope: string, load: () => Promise<T>): Promise<T>
    clear(): void
}

export function createScopedSingleFlight<T>(): ScopedSingleFlight<T> {
    let entry: { scope: string; promise: Promise<T> } | null = null
    return {
        run(scope, load) {
            if (entry && entry.scope === scope) return entry.promise
            const promise = load().finally(() => {
                if (entry?.promise === promise) entry = null
            })
            entry = { scope, promise }
            return promise
        },
        clear() {
            entry = null
        },
    }
}
