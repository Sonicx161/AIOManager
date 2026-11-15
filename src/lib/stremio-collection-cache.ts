export async function collectionCacheKey(authKey: string, context: string): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify([authKey, context]))
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createCollectionCache<T>(
    read: (authKey: string, context: string) => Promise<T | null>,
    options: { now?: () => number; cap?: number; successTtl?: number; failureTtl?: number } = {},
) {
    const now = options.now || Date.now
    const cap = options.cap ?? 1000
    const entries = new Map<string, { value: T | null; expires: number }>()
    const pending = new Map<string, Promise<T | null>>()
    return async (authKey: string, context: string): Promise<T | null> => {
        const key = await collectionCacheKey(authKey, context)
        for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id)
        const cached = entries.get(key)
        if (cached) { entries.delete(key); entries.set(key, cached); return cached.value }
        const existing = pending.get(key)
        if (existing) return existing
        if (pending.size >= cap) return null
        const work = read(authKey, context).catch(() => null)
        pending.set(key, work)
        try {
            const value = await work
            entries.delete(key)
            entries.set(key, { value, expires: now() + (value ? options.successTtl ?? 3600000 : options.failureTtl ?? 300000) })
            while (entries.size > cap) entries.delete(entries.keys().next().value!)
            return value
        } finally { pending.delete(key) }
    }
}
