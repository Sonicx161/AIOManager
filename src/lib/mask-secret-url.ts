const SENSITIVE_KEY = /key|token|secret|pass|auth|sig|jwt|cred|session/i
const OPAQUE_SEGMENT = /^[A-Za-z0-9_\-=%+~.]+$/

function shorten(value: string): string {
    return `${value.slice(0, 3)}...${value.slice(-3)}`
}

function isOpaque(value: string): boolean {
    if (!OPAQUE_SEGMENT.test(value)) return value.length >= 20
    if (value.length >= 20) return true
    return value.length >= 12 && !value.includes('.') && /\d/.test(value) && /[A-Za-z]/.test(value)
}

/** Display-only: hides token/credential-looking parts of a URL. Never use the result for copy, fetch, or storage. */
export function maskSecretUrl(url: string): string {
    if (!url) return url
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return url.length > 32 ? shorten(url) : url
    }
    const userinfo = parsed.username || parsed.password ? '***:***@' : ''
    const path = parsed.pathname
        .split('/')
        .map(segment => (isOpaque(segment) ? shorten(segment) : segment))
        .join('/')
    const query = parsed.search
        ? '?' + parsed.search.slice(1).split('&').map(pair => {
            const eq = pair.indexOf('=')
            if (eq < 0) return pair
            const key = pair.slice(0, eq)
            const value = pair.slice(eq + 1)
            return SENSITIVE_KEY.test(key) || isOpaque(value) ? `${key}=***` : pair
        }).join('&')
        : ''
    const hash = parsed.hash ? '#***' : ''
    return `${parsed.protocol}//${userinfo}${parsed.host}${path === '/' ? '' : path}${query}${hash}`
}
