import { getSyncAuthHeaders } from '@/lib/sync-auth'

const HOUSEHOLD_ACCOUNT_ID = '__household__'

export async function addToWatchlist(itemId: string, type: string, name?: string, poster?: string, accountId?: string): Promise<boolean> {
    try {
        const res = await fetch('/api/watchlist/add', {
            method: 'POST',
            headers: await getSyncAuthHeaders(),
            body: JSON.stringify({ itemId, type, name, poster, accountId }),
        })
        if (!res.ok) return false
        const json = await res.json()
        return Boolean(json?.success)
    } catch {
        return false
    }
}

export async function removeFromWatchlist(itemId: string, accountId?: string): Promise<boolean> {
    try {
        const res = await fetch('/api/watchlist/remove', {
            method: 'DELETE',
            headers: await getSyncAuthHeaders(),
            body: JSON.stringify({ itemId, accountId }),
        })
        if (!res.ok) return false
        const json = await res.json()
        return Boolean(json?.success)
    } catch {
        return false
    }
}

export interface WatchlistItem {
    itemId: string
    type: string
    name?: string
    poster?: string
    addedAt?: number
}

export async function getWatchlist(accountId?: string): Promise<WatchlistItem[]> {
    try {
        const params = accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''
        const res = await fetch(`/api/watchlist${params}`, { headers: await getSyncAuthHeaders() })
        if (!res.ok) return []
        const json = await res.json()
        const items = Array.isArray(json?.items) ? json.items : []
        return items.filter((i: unknown): i is WatchlistItem => {
            if (!i || typeof i !== 'object') return false
            const obj = i as Record<string, unknown>
            return typeof obj.itemId === 'string'
        })
    } catch {
        return []
    }
}

/** Lists holding one item ('' is the household list), or null when the server predates the itemId lookup. */
export async function getWatchlistTargets(itemId: string): Promise<Set<string> | null> {
    try {
        const res = await fetch(`/api/watchlist?itemId=${encodeURIComponent(itemId)}`, { headers: await getSyncAuthHeaders() })
        if (!res.ok) return new Set()
        const json = await res.json()
        if (!Array.isArray(json?.accountIds)) return null
        const targets = new Set<string>()
        for (const id of json.accountIds) if (typeof id === 'string') targets.add(id === HOUSEHOLD_ACCOUNT_ID ? '' : id)
        return targets
    } catch {
        return new Set()
    }
}
