import { createHmac, timingSafeEqual } from 'node:crypto'

export const IMAGE_WIDTHS = [92, 154, 185, 342, 500, 780]

const METAHUB_PATH = /^\/(poster|background|logo)\/(small|medium|big)\//
const VARIANT_RANK = { small: 0, medium: 1, big: 2 }

export const clampImageWidth = (raw) => {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 0) return null
    return IMAGE_WIDTHS.find((w) => w >= n) ?? IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1]
}

// small is 300px wide, medium 500px, big is the unresized original (often over 1MB)
const variantForWidth = (width) => (width <= 300 ? 'small' : width <= 500 ? 'medium' : 'big')

// Only ever downgrades a metahub artwork variant; other hosts and unknown paths pass through.
export const metahubVariantUrl = (rawUrl, width) => {
    if (!width) return rawUrl
    let u
    try { u = new URL(rawUrl) } catch { return rawUrl }
    if (u.hostname !== 'metahub.space' && !u.hostname.endsWith('.metahub.space')) return rawUrl
    const match = u.pathname.match(METAHUB_PATH)
    if (!match) return rawUrl
    const wanted = variantForWidth(width)
    if (VARIANT_RANK[wanted] >= VARIANT_RANK[match[2]]) return rawUrl
    u.pathname = u.pathname.replace(METAHUB_PATH, `/${match[1]}/${wanted}/`)
    return u.href
}

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const AVATAR_CACHE_CONTROL = 'public, max-age=604800, stale-while-revalidate=86400'

export const AVATAR_ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
export const AVATAR_SIGN_BATCH_MAX = 50
export const AVATAR_SIGN_TTL_MS = 24 * 60 * 60 * 1000
export const AVATAR_SIGN_BUCKET_MS = 60 * 60 * 1000
export const AVATAR_BUDGET_BYTES = 50 * 1024 * 1024
export const AVATAR_BUDGET_WINDOW_MS = 60 * 60 * 1000

// Artwork behind a stable URL can change upstream, so it revalidates instead of being immutable.
export const POSTER_CACHE_CONTROL = 'public, max-age=604800, must-revalidate'

const ASCII = (buf, start, end) => buf.toString('latin1', start, end)
const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'])

const ftypBrands = (buf) => {
    if (buf.length < 12 || ASCII(buf, 4, 8) !== 'ftyp') return null
    const size = Math.min(buf.readUInt32BE(0) || buf.length, buf.length, 256)
    const brands = [ASCII(buf, 8, 12)]
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ASCII(buf, i, i + 4))
    return brands
}

// Content type from the leading bytes only. SVG and anything unrecognised return null.
export const detectImageType = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null
    if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    const head = ASCII(buf, 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
    if (ASCII(buf, 0, 4) === 'RIFF' && ASCII(buf, 8, 12) === 'WEBP') return 'image/webp'
    const brands = ftypBrands(buf)
    if (brands) {
        if (brands.some((b) => AVIF_BRANDS.has(b))) return 'image/avif'
        if (brands.some((b) => HEIC_BRANDS.has(b))) return 'image/heic'
        return null
    }
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.readUInt16LE(4) > 0 && buf.readUInt16LE(4) <= 256) return 'image/x-icon'
    return null
}

const TYPE_ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/vnd.microsoft.icon': 'image/x-icon', 'image/ico': 'image/x-icon', 'image/heif': 'image/heic' }

// True when the upstream header names an image type that disagrees with the detected one. A non-image
// header (octet-stream, text/html) is not a conflict: the detected bytes decide what is served.
export const declaredTypeConflicts = (declared, detected) => {
    const base = String(declared || '').split(';')[0].trim().toLowerCase()
    if (!base.startsWith('image/')) return false
    return (TYPE_ALIASES[base] || base) !== detected
}

const b64u = (buf) => buf.toString('base64url')
const avatarKey = (secret) => createHmac('sha256', String(secret)).update('aiom:avatar-proxy:v1').digest()
const avatarPayload = (userTag, exp, width, url) => `${userTag}
${exp}
${width || ''}
${url}`

export const normalizeAvatarUrl = (raw) => {
    try {
        const u = new URL(raw)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
        if (u.username || u.password) return null
        return u.href
    } catch {
        return null
    }
}

export const avatarUserTag = (secret, userId) => b64u(createHmac('sha256', avatarKey(secret)).update(`u:${userId}`).digest()).slice(0, 22)

// exp is bucketed so the signed URL stays byte-identical within a bucket and the browser cache keeps hitting.
export const signAvatarUrl = (secret, userId, rawUrl, { now = Date.now(), width = '' } = {}) => {
    const url = normalizeAvatarUrl(rawUrl)
    if (!url) return null
    const exp = (Math.floor(now / AVATAR_SIGN_BUCKET_MS) + 1) * AVATAR_SIGN_BUCKET_MS + AVATAR_SIGN_TTL_MS
    const u = avatarUserTag(secret, userId)
    const sig = b64u(createHmac('sha256', avatarKey(secret)).update(avatarPayload(u, exp, width, url)).digest())
    const q = new URLSearchParams({ kind: 'avatar', url, u, exp: String(exp), sig })
    if (width) q.set('w', width)
    return { src: `/api/proxy-image?${q.toString()}`, exp }
}

// Returns the normalized URL when the signature is valid and unexpired, otherwise null.
export const verifyAvatarSignature = (secret, { url, u, exp, sig, w }, now = Date.now()) => {
    const normalized = normalizeAvatarUrl(url)
    const expNum = Number(exp)
    if (!normalized || !u || !sig || !Number.isFinite(expNum) || expNum <= now) return null
    const expected = createHmac('sha256', avatarKey(secret)).update(avatarPayload(u, expNum, w, normalized)).digest()
    let given
    try { given = Buffer.from(String(sig), 'base64url') } catch { return null }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    return normalized
}

export const ifNoneMatchSatisfies = (header, etag) => {
    if (!header || !etag) return false
    return String(header).split(',').map(tag => tag.trim()).some(tag => tag === etag || tag === `W/${etag}` || tag === '*')
}

// Beyond this skew a future Last-Modified is bogus and would pin stale bytes.
const LAST_MODIFIED_SKEW_MS = 5 * 60_000

export function parseLastModified(value, now = Date.now()) {
    if (typeof value !== 'string' || !value) return null
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || ms > now + LAST_MODIFIED_SKEW_MS) return null
    return ms
}

// Artwork only (avatars use signed URLs); retention is capped at one extra TTL window.
export function keepCachedArtifact({ isAvatar, staleLM, freshLM, retained = 0, maxRetained = 1, now = Date.now() }) {
    if (isAvatar) return false
    if (retained >= maxRetained) return false
    const stale = parseLastModified(staleLM, now)
    const fresh = parseLastModified(freshLM, now)
    if (stale === null || fresh === null) return false
    return fresh < stale
}

// Fixed-window byte budget per key. reserve() holds the worst case up front so concurrent fetches cannot overshoot.
export const createByteBudget = ({ limit = AVATAR_BUDGET_BYTES, windowMs = AVATAR_BUDGET_WINDOW_MS, now = Date.now, maxKeys = 5000 } = {}) => {
    const entries = new Map()
    const entryFor = (key) => {
        const t = now()
        let e = entries.get(key)
        if (!e || e.resetAt <= t) {
            if (!e && entries.size >= maxKeys) {
                for (const [k, v] of entries) if (v.resetAt <= t) entries.delete(k)
                if (entries.size >= maxKeys) entries.delete(entries.keys().next().value)
            }
            e = { used: 0, resetAt: t + windowMs }
            entries.set(key, e)
        }
        return e
    }
    return {
        reserve: (key, bytes) => {
            const e = entryFor(key)
            if (e.used + bytes > limit) return false
            e.used += bytes
            return true
        },
        settle: (key, reserved, actual) => {
            const e = entryFor(key)
            e.used = Math.max(0, e.used - reserved + Math.max(0, actual))
        },
        used: (key) => entryFor(key).used,
        limit,
    }
}
