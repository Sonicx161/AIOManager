// Pure avatar bounds shared by upload, heal, and the sync export guard. Kept separate
// from the GIF pipeline (src/lib/avatar-gif.ts) so statically importing this module
// from boot-closure code cannot drag any codec logic into the boot bundle.

export const AVATAR_FIT_DIMENSION = 256
export const AVATAR_GIF_CAP_BYTES = 500 * 1024
export const AVATAR_EXPORT_CEILING_CHARS = 1024 * 1024

const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38]

export function isGifBytes(bytes: Uint8Array): boolean {
    return bytes.length >= 6 && GIF_MAGIC.every((b, i) => bytes[i] === b)
}

// Logical screen descriptor (header bytes 6-9) without decoding any frames: lets the
// upload path pass compliant GIFs through with no worker round trip.
export function gifScreenSize(bytes: Uint8Array): { width: number; height: number } | null {
    if (bytes.length < 10 || !isGifBytes(bytes)) return null
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
}

export function decodedDataUrlBytes(value: string): number | null {
    if (!value.startsWith('data:')) return null
    const comma = value.indexOf(',')
    if (comma < 0) return null
    const meta = value.slice(0, comma)
    const payload = value.length - comma - 1
    if (!/;base64$/i.test(meta)) return payload
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
    return Math.floor(payload * 3 / 4) - padding
}

export function isOversizedAvatarDataUrl(value: string | null | undefined): boolean {
    if (!value) return false
    const bytes = decodedDataUrlBytes(value)
    return bytes !== null && bytes > AVATAR_GIF_CAP_BYTES
}

// Last-resort export guard: an avatar data URI over the hard ceiling is not exported
// (the local copy stays), so one bad picture can never block sync again.
export function exportAvatarValue(value: string | null | undefined): { value: string | null; dropped: boolean } {
    if (typeof value !== 'string' || !value.startsWith('data:')) return { value: value ?? null, dropped: false }
    return value.length > AVATAR_EXPORT_CEILING_CHARS ? { value: null, dropped: true } : { value, dropped: false }
}
