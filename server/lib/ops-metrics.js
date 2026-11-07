// In-memory registry the Dashboard reads: cache layer stats and background task state.
// Registration is a closure call; nothing here writes to the DB or holds the process open.
const cacheLayers = new Map()
const tasks = new Map()

export function registerCacheLayer(id, { label, stats }) {
    cacheLayers.set(id, { id, label, stats })
}

export function registerTask(id, info) {
    tasks.set(id, { id, ...info })
}

export function readCacheLayers() {
    const out = []
    for (const layer of cacheLayers.values()) {
        try { out.push({ id: layer.id, label: layer.label, ...layer.stats() }) } catch { out.push({ id: layer.id, label: layer.label, error: 'unavailable' }) }
    }
    return out
}

export function readTasks() {
    const out = []
    for (const t of tasks.values()) {
        try {
            out.push({
                id: t.id,
                label: t.label,
                intervalMs: typeof t.intervalMs === 'function' ? t.intervalMs() : t.intervalMs ?? null,
                enabled: t.enabled ? Boolean(t.enabled()) : true,
                running: t.running ? Boolean(t.running()) : false,
                lastRunAt: t.lastRunAt ? t.lastRunAt() ?? null : null,
                idempotent: Boolean(t.idempotent),
            })
        } catch {
            out.push({ id: t.id, label: t.label, error: 'unavailable' })
        }
    }
    return out
}
