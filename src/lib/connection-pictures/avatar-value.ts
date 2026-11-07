// Connection pictures: avatar value constraints (review CP-008).
//
// Stored avatar values are attacker-influenced strings: the facades store
// free-text URLs. Every value that reaches storage or an img src must pass one
// of these allowlists first: https image links only, or bounded base64 data
// URIs of a safe raster type. SVG is never allowed (script execution),
// javascript: and every other scheme are rejected.
//
// Pure leaf module: no store or React imports, relative imports only.

export const AVATAR_URL_MAX_LENGTH = 2048
export const AVATAR_DATAURI_MAX_CHARS = 700_000
export const AVATAR_DATAURI_MAX_BYTES = 512 * 1024
/** Byte budget for transport-level uploads (Jellyfin base64 body, proxy downloads). */
export const AVATAR_UPLOAD_MAX_BYTES = 512 * 1024

const DATA_URI_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]*)$/i

export interface DataUriLimits {
    maxChars: number
    maxBytes: number
}

/** True when the string parses as an http(s) URL with a real, non-empty host. */
function isHttpUrlWithHost(value: string, schemes: readonly string[]): boolean {
    if (value.length === 0 || value.length > AVATAR_URL_MAX_LENGTH) return false
    if (/\s/.test(value)) return false
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        return false
    }
    if (!schemes.includes(parsed.protocol)) return false
    return parsed.hostname.length > 0
}

export function isValidAvatarHttpsUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false
    return isHttpUrlWithHost(value.trim(), ['https:'])
}

/** Raster image content types transports may accept (SVG is never one). */
export function isAllowedAvatarImageMime(value: unknown): boolean {
    return typeof value === 'string' && /^image\/(png|jpe?g|webp|gif)$/i.test(value.trim())
}

/** Accepts only base64 data URIs of a safe raster type within the byte budget. */
export function sanitizeAvatarDataUri(value: unknown, limits: DataUriLimits = { maxChars: AVATAR_DATAURI_MAX_CHARS, maxBytes: AVATAR_DATAURI_MAX_BYTES }): string | null {
    if (typeof value !== 'string') return null
    const v = value.trim()
    const match = v.match(DATA_URI_PATTERN)
    if (!match) return null
    if (v.length > limits.maxChars) return null
    const payload = match[2]
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    const bytes = Math.floor(payload.length * 3 / 4) - padding
    if (bytes <= 0 || bytes > limits.maxBytes) return null
    return v
}

/** Strict src allowlist for platform-stored avatar strings (the facades). */
export function sanitizePlatformAvatarSrc(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const v = value.trim()
    if (isValidAvatarHttpsUrl(v)) return v
    return sanitizeAvatarDataUri(v)
}

/** Allowlist for srcs the app builds from the user's own configured servers (http LAN included). */
export function sanitizeServerImageSrc(value: unknown): string | null {
    if (typeof value !== 'string') return null
    return isHttpUrlWithHost(value.trim(), ['http:', 'https:']) ? value.trim() : null
}
