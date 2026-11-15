export function createBackfillProcessed(cap = 2048) {
    const entries = new Map<string, string>()
    const set = (key: string, value: string) => {
        entries.delete(key)
        entries.set(key, value)
        while (entries.size > cap) entries.delete(entries.keys().next().value!)
    }
    return {
        get(key: string) {
            const value = entries.get(key)
            if (value !== undefined) { entries.delete(key); entries.set(key, value) }
            return value
        },
        set,
        delete: (key: string) => entries.delete(key),
        clear: () => entries.clear(),
        export: () => Object.fromEntries(entries),
        load(value: Record<string, string>) {
            for (const [key, watched] of Object.entries(value)) if (typeof watched === 'string') set(key, watched)
        },
        prune(scope: string, ids: ReadonlySet<string>) {
            let changed = false
            for (const key of entries.keys()) {
                let parts: unknown
                try { parts = JSON.parse(key) } catch { continue }
                if (Array.isArray(parts) && parts[0] === scope && !ids.has(parts[3])) { entries.delete(key); changed = true }
            }
            return changed
        },
    }
}
