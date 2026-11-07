import type { ActivityItem } from '../types/activity.ts'
import { isUnresolvedActivityName } from './activity-metadata-overlay.ts'
import { watcherIdentityKeys } from './watcher-identity.ts'

/**
 * Share display metadata already present in the local activity set. This is
 * deliberately display-only: ids, provenance, watch state and deletion
 * routing never change here.
 */
export function enrichActivityItemsByIdentity(items: ActivityItem[]): ActivityItem[] {
    if (items.length < 2) return items
    const titleImdbs = new Map<string, Set<string>>()
    for (const item of items) {
        const titleKey = watcherIdentityKeys(item).find(key => key.startsWith('m:') || key.startsWith('s:'))
        const tt = /^tt\d+/i.exec(item.itemId || '')?.[0].toLowerCase()
        if (!titleKey || !tt) continue
        const ids = titleImdbs.get(titleKey) || new Set<string>()
        ids.add(tt)
        titleImdbs.set(titleKey, ids)
    }
    const bestByKey = new Map<string, { name: string; poster?: string; genres?: string[] }>()
    for (const item of items) {
        if (isUnresolvedActivityName(item.name)) continue
        const value = { name: item.name, poster: item.poster || undefined, genres: item.genres }
        for (const key of watcherIdentityKeys(item)) {
            if ((key.startsWith('m:') || key.startsWith('s:')) && (titleImdbs.get(key)?.size || 0) > 1) continue
            const existing = bestByKey.get(key)
            bestByKey.set(key, existing ? {
                name: value.name.length > existing.name.length ? value.name : existing.name,
                poster: existing.poster || value.poster,
                genres: existing.genres?.length ? existing.genres : value.genres,
            } : value)
        }
    }
    let changed = false
    const next = items.map(item => {
        const keys = watcherIdentityKeys(item)
        const entry = keys.map(key => bestByKey.get(key)).find(Boolean)
        if (!entry) return item
        const name = isUnresolvedActivityName(item.name) ? entry.name : item.name
        const poster = item.poster || entry.poster
        const genres = item.genres?.length ? item.genres : entry.genres
        if (name === item.name && poster === item.poster && genres === item.genres) return item
        changed = true
        return { ...item, name, ...(poster ? { poster } : {}), ...(genres ? { genres } : {}) }
    })
    return changed ? next : items
}
