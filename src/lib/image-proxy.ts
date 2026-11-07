export const IMAGE_PROXY_WIDTHS = [92, 154, 185, 342, 500, 780] as const

const PROXY_PATH = '/api/proxy-image'
const TMDB_SIZE = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(?:original|w\d+)(\/)/

export function clampProxyWidth(px: number): number {
    return IMAGE_PROXY_WIDTHS.find(w => w >= px) ?? IMAGE_PROXY_WIDTHS[IMAGE_PROXY_WIDTHS.length - 1]
}

// TMDB serves every allowlisted width natively, so the size segment is swapped instead of proxied.
export function sizeTmdbUrl(url: string, px: number): string {
    return url.replace(TMDB_SIZE, `$1w${clampProxyWidth(px)}$2`)
}

export function proxyImageUrl(url: string, width?: number): string {
    const w = width ? `&w=${clampProxyWidth(width)}` : ''
    return `${PROXY_PATH}?url=${encodeURIComponent(url)}${w}`
}

export const isRemoteAvatar = (avatar: string): boolean => /^https?:\/\//i.test(avatar)

// Unsigned form. The server rejects it for remote avatars; render through getSignedAvatarSrc instead.
export function avatarImageSrc(avatar: string): string {
    if (!isRemoteAvatar(avatar)) return avatar
    return `${PROXY_PATH}?kind=avatar&url=${encodeURIComponent(avatar)}`
}

export interface SignedAvatar { src: string; exp: number }
export type AvatarSignTransport = (urls: string[]) => Promise<Array<SignedAvatar | null> | null>

const SIGN_BATCH_MAX = 50
const SIGN_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000

// Batches avatar URLs into one authenticated sign call and keeps the signed URLs until just before they expire.
export function createAvatarSigner(post: AvatarSignTransport, now: () => number = Date.now) {
    const cache = new Map<string, SignedAvatar>()
    const inflight = new Map<string, Promise<string | null>>()
    let queue: Array<{ url: string; resolve: (src: string | null) => void }> = []
    let scheduled = false

    const flush = async () => {
        scheduled = false
        const batch = queue
        queue = []
        for (let i = 0; i < batch.length; i += SIGN_BATCH_MAX) {
            const chunk = batch.slice(i, i + SIGN_BATCH_MAX)
            let items: Array<SignedAvatar | null> | null = null
            try { items = await post(chunk.map(c => c.url)) } catch { items = null }
            chunk.forEach((c, idx) => {
                const item = items?.[idx] ?? null
                if (item) cache.set(c.url, item)
                c.resolve(item?.src ?? null)
            })
        }
    }

    const get = (url: string): Promise<string | null> => {
        const hit = cache.get(url)
        if (hit && hit.exp - now() > SIGN_REFRESH_MARGIN_MS) return Promise.resolve(hit.src)
        const pending = inflight.get(url)
        if (pending) return pending
        const promise = new Promise<string | null>(resolve => {
            queue.push({ url, resolve })
            if (!scheduled) { scheduled = true; setTimeout(() => { void flush() }, 0) }
        }).finally(() => inflight.delete(url))
        inflight.set(url, promise)
        return promise
    }

    return { get, invalidate: (url: string) => { cache.delete(url) }, clear: () => cache.clear() }
}

async function postSignRequest(urls: string[]): Promise<Array<SignedAvatar | null> | null> {
    const { getSyncAuthHeaders } = await import('@/lib/sync-auth')
    const headers = await getSyncAuthHeaders()
    if (!headers['x-sync-user']) return null
    const res = await fetch(`${PROXY_PATH}/sign`, { method: 'POST', headers, body: JSON.stringify({ urls }) })
    if (!res.ok) return null
    const data = await res.json() as { items?: Array<SignedAvatar | null> }
    return Array.isArray(data.items) ? data.items : null
}

// Remote avatars go through the authenticated proxy so the viewer's IP never reaches the third-party host.
export const avatarSigner = createAvatarSigner(postSignRequest)
export const getSignedAvatarSrc = (avatar: string): Promise<string | null> => avatarSigner.get(avatar)

// Re-points an already built poster URL at another allowlisted width; undefined when it has no sized variant.
export function retargetImageUrl(url: string, px: number): string | undefined {
    const w = clampProxyWidth(px)
    if (url.startsWith(PROXY_PATH)) {
        return /[?&]w=\d+/.test(url) ? url.replace(/([?&])w=\d+/, `$1w=${w}`) : `${url}&w=${w}`
    }
    const sized = sizeTmdbUrl(url, w)
    return sized === url && !TMDB_SIZE.test(url) ? undefined : sized
}

export interface PosterImageCandidate {
    url: string
    /** Actual pixel width of the file this candidate serves (width-descriptor truth). */
    width: number
}

// Metahub serves small=300px, medium=500px and big=the unresized original; the
// proxy request params that select each variant, and the pixel widths the browser
// should expect from them. Big's real width varies, so its descriptor is a lower
// bound assumption: worst case the browser picks the original, which is exactly
// what the unsized source served before any sizing existed.
const METAHUB_RUNGS: ReadonlyArray<{ requestPx: number; filePx: number }> = [
    { requestPx: 185, filePx: 300 },
    { requestPx: 342, filePx: 500 },
    { requestPx: 780, filePx: 800 },
]

// Native TMDB widths for direct (unproxied) poster URLs; the trailing rung keeps
// DPR 3 / 2xl surfaces at or above rendered pixels.
const POSTER_TMDB_LADDER = [92, 154, 185, 342, 500, 780, 1280]

/**
 * Width-descriptor candidates for a poster source: one entry per sized variant,
 * ascending by true served pixel width, so `sizes`-driven selection always serves
 * at least the rendered CSS size times devicePixelRatio. Null when the source has
 * no sized variants (original source must be kept as-is there).
 */
export function posterImageCandidates(src: string): PosterImageCandidate[] | null {
    if (src.includes('kind=avatar')) return null
    if (src.startsWith(PROXY_PATH)) {
        // Only metahub hosts have server-side variants; other proxied hosts pass through.
        let inner: URL | null = null
        try {
            inner = new URL(decodeURIComponent(new URL(src, 'https://x.invalid').searchParams.get('url') ?? ''))
        } catch { return null }
        if (!inner || !(inner.hostname === 'metahub.space' || inner.hostname.endsWith('.metahub.space'))) return null
        const candidates: PosterImageCandidate[] = []
        for (const rung of METAHUB_RUNGS) {
            const url = retargetImageUrl(src, rung.requestPx)
            if (url && !candidates.some(c => c.url === url)) candidates.push({ url, width: rung.filePx })
        }
        return candidates.length > 0 ? candidates : null
    }
    if (TMDB_SIZE.test(src)) {
        // TMDB files are exactly the requested width. The ladder extends past the
        // proxy clamp (native w1280) so DPR 3 and 2xl grid columns get a rung at or
        // above rendered px; these URLs are fetched directly, never proxied.
        const candidates: PosterImageCandidate[] = []
        for (const w of POSTER_TMDB_LADDER) {
            const url = src.replace(TMDB_SIZE, `$1w${w}$2`)
            if (!candidates.some(c => c.url === url)) candidates.push({ url, width: w })
        }
        return candidates.length > 0 ? candidates : null
    }
    return null
}
