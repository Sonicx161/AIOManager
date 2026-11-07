import type { ProviderRating, RatingSource } from '@/components/activity/detail/RatingBadge'

export async function authedFetch(url: string, options?: RequestInit): Promise<Response> {
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
        const auth = useSyncStore.getState().auth
        const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) }
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await getSyncPasswordHeader(auth)
        }
        return fetch(url, { ...options, headers })
    } catch {
        return fetch(url, options)
    }
}

export async function fetchAdditionalRatings(imdbId: string): Promise<ProviderRating[]> {
    const results: ProviderRating[] = []
    const has = (src: RatingSource) => results.some(x => x.source === src)
    const DEV = import.meta.env?.DEV

    if (!imdbId.startsWith('tt')) return results

    const mdblistRes = await authedFetch(`/api/metadata/mdblist/i/${encodeURIComponent(imdbId)}`)

    try {
        if (DEV) console.log('[trace] mdblist: status=%d ok=%s', mdblistRes.status, mdblistRes.ok)
        if (mdblistRes.ok) {
            const data = await mdblistRes.json()
            const before = results.length
            if (Array.isArray(data?.ratings)) {
                for (const r of data.ratings) {
                    if (r.source === 'tomatoes' && r.value && !has('tomatoes')) {
                        results.push({ source: 'tomatoes', value: `${r.value}%` })
                    } else if (r.source === 'tomatoesaudience' && r.value && !has('popcorn')) {
                        results.push({ source: 'popcorn', value: `${r.value}%` })
                    } else if (r.source === 'metacritic' && r.value && !has('metacritic')) {
                        results.push({ source: 'metacritic', value: String(r.value) })
                    } else if (r.source === 'trakt' && r.value && !has('trakt')) {
                        results.push({ source: 'trakt', value: typeof r.value === 'number' ? (r.value > 10 ? (r.value / 10).toFixed(1) : r.value.toFixed(1)) : String(r.value) })
                    } else if (r.source === 'letterboxd' && r.value && !has('letterboxd')) {
                        results.push({ source: 'letterboxd', value: typeof r.value === 'number' ? r.value.toFixed(1) : String(r.value) })
                    } else if (r.source === 'simkl' && r.value && !has('simkl')) {
                        results.push({ source: 'simkl', value: typeof r.value === 'number' ? (r.value > 10 ? (r.value / 10).toFixed(1) : r.value.toFixed(1)) : String(r.value) })
                    }
                }
            }
            if (DEV) console.log('[trace] mdblist: +%d ratings (%s)', results.length - before, results.slice(before).map(r => r.source).join(', ') || 'none')
        }
    } catch (e) { if (DEV) console.warn('[trace] mdblist: FAILED', e) }

    if (DEV) console.log('[trace] fetchAdditionalRatings: total=%d sources=[%s]', results.length, results.map(r => r.source).join(', '))
    return results
}

export function mergeRatingsKeepExisting(prev: ProviderRating[], incoming: ProviderRating[]): ProviderRating[] {
    const combined = [...prev]
    for (const item of incoming) {
        if (!combined.some(x => x.source === item.source)) combined.push(item)
    }
    return combined
}
