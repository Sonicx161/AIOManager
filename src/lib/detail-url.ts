const DETAIL_KEYS = new Set(['detail', 'type', 'person', 'account', 'season', 'episode'])

const keyOf = (segment: string) => {
    const raw = segment.split('=')[0].replace(/\+/g, ' ')
    try { return decodeURIComponent(raw) } catch { return raw }
}

// Removes the detail sheet's parameters from a raw search string, leaving every other segment exactly as written.
export function withoutDetailParams(search: string): string {
    const body = search.startsWith('?') ? search.slice(1) : search
    if (!body) return search
    const segments = body.split('&')
    if (!segments.some(segment => keyOf(segment) === 'detail')) return search
    const kept = segments.filter(segment => !DETAIL_KEYS.has(keyOf(segment)))
    return kept.length ? `?${kept.join('&')}` : ''
}

type UrlParts = { pathname: string; search: string; hash: string }

export function staleDetailCleanup(routed: UrlParts, current: UrlParts): UrlParts | null {
    if (current.pathname !== routed.pathname || withoutDetailParams(routed.search) === routed.search) return null
    const search = withoutDetailParams(current.search)
    if (search === current.search) return null
    return { pathname: current.pathname, search, hash: current.hash }
}
