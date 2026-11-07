// Path classifiers for the Dashboard namespace. The router decodes percent-encoding, so a
// raw startsWith('/api/admin') misses /api/%61dmin; these decode first and match without
// case. Malformed encoding under /api counts as admin, so the stricter rules apply.
const pathOf = (url) => String(url || '').split(/[?#]/)[0]

function decodedPath(url) {
    const raw = pathOf(url)
    try { return { path: decodeURIComponent(raw), ok: true } } catch { return { path: raw, ok: false } }
}

export function isAdminPath(url) {
    const { path, ok } = decodedPath(url)
    if (!ok) return /^\/+api(?:\/|$)/i.test(path)
    return /^\/+api\/+admin(?:\/|$)/i.test(path)
}

export function isDashboardSpaPath(url) {
    const { path } = decodedPath(url)
    return /^\/+dashboard(?:\/|$)/i.test(path)
}
