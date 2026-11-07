// Stremio WatchedBitField decoder (client port of the server-validated logic).
//
// Format: "{videoId}:{length}:{base64(deflate(bitfield))}". videoId itself contains colons
// (tt1355642:1:5, kitsu:46873:11), so parse from the RIGHT: last = base64, second-last = length
// (total videos spanned), the rest = videoId. Set bit i => the (i+1)-th video in the series'
// ordered video list is watched. The base64 payload is zlib-wrapped deflate (starts 0x78 / "eJx"),
// so DecompressionStream('deflate') (not 'deflate-raw') inflates it.
//
// Verified against real library items (see server vectors): Physical:100 -> 14 eps; SPY x FAMILY
// -> eps 38-40; FMAB -> all-zero (flagged-watched but no per-episode bits). The bitfield is
// authoritative WHEN populated; Stremio leaves it empty/zero for some watch patterns, so callers
// must treat an empty result as "no data", not "nothing watched".

export interface DecodedBitfield {
    videoId: string
    length: number
    watchedIndices: number[]
}

export type BitfieldInterpretation =
    | { kind: 'bits'; decoded: DecodedBitfield; indices: number[] }
    | { kind: 'unprovable'; reason: 'no-bitfield' | 'decode' | 'anchor' | 'index' | 'anchor-order' | 'count' }

/**
 * Shared read/write-adjacent interpretation. Readers may tolerate a legacy
 * anchor that exists but is not the highest set bit; writers must require the
 * canonical max-bit anchor before treating the state as authoritative.
 */
export async function interpretWatchedBitfield(
    watchedStr: string | null | undefined,
    videos: { id: string }[],
    options: { anchorPolicy?: 'exists' | 'max'; timesWatched?: number | null } = {},
): Promise<BitfieldInterpretation> {
    const decoded = await decodeWatchedBitfield(watchedStr)
    if (!decoded || decoded.watchedIndices.length === 0) return { kind: 'unprovable', reason: decoded ? 'no-bitfield' : 'decode' }
    const anchorIndex = videos.findIndex(video => video.id === decoded.videoId)
    if (anchorIndex < 0) return { kind: 'unprovable', reason: 'anchor' }
    if (decoded.watchedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= videos.length)) {
        return { kind: 'unprovable', reason: 'index' }
    }
    const maxIndex = Math.max(...decoded.watchedIndices)
    if (options.anchorPolicy === 'max' && anchorIndex !== maxIndex) return { kind: 'unprovable', reason: 'anchor-order' }
    if (options.timesWatched != null && options.timesWatched > 0 && options.timesWatched !== decoded.watchedIndices.length) {
        return { kind: 'unprovable', reason: 'count' }
    }
    return { kind: 'bits', decoded, indices: decoded.watchedIndices }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
    const ab = await new Response(stream).arrayBuffer()
    return new Uint8Array(ab)
}

async function readWatchedField(watchedStr: string | null | undefined): Promise<{ videoId: string; length: number; buf: Uint8Array | null } | null> {
    if (!watchedStr || typeof watchedStr !== 'string') return null

    const parts = watchedStr.split(':')
    if (parts.length < 3) return null

    const base64 = parts[parts.length - 1]
    const length = parseInt(parts[parts.length - 2], 10)
    const videoId = parts.slice(0, parts.length - 2).join(':')
    if (!base64 || !Number.isFinite(length)) return null

    try {
        return { videoId, length, buf: await inflate(base64ToBytes(base64)) }
    } catch {
        return { videoId, length, buf: null }
    }
}

export async function decodeWatchedBitfield(watchedStr: string | null | undefined): Promise<DecodedBitfield | null> {
    const field = await readWatchedField(watchedStr)
    if (!field) return null
    const { videoId, length, buf } = field
    if (!buf) return { videoId, length, watchedIndices: [] }

    const limit = length > 0 ? Math.min(length, buf.length * 8) : buf.length * 8
    const watchedIndices: number[] = []
    for (let idx = 0; idx < limit; idx++) {
        if (buf[idx >> 3] & (1 << (idx & 7))) watchedIndices.push(idx)
    }
    return { videoId, length, watchedIndices }
}

/**
 * A structurally valid bitfield with every bit clear (stremio-core's shape once all episodes
 * are unmarked): an anchor id, a positive safe-integer length the decoded payload covers, and
 * no set bit. Anything malformed is not proof of "no marks".
 */
/** Same structural checks as hasNoWatchedBits without requiring every bit clear. */
export async function isWellFormedWatchedField(watchedStr: string | null | undefined): Promise<boolean> {
    const token = String(watchedStr || '').split(':').slice(-2, -1)[0] ?? ''
    if (!/^[1-9][0-9]*$/.test(token) || !Number.isSafeInteger(Number(token))) return false
    const field = await readWatchedField(watchedStr)
    if (!field?.buf || !field.videoId) return false
    if (field.length !== Number(token)) return false
    return field.buf.length >= Math.ceil(field.length / 8)
}

export async function hasNoWatchedBits(watchedStr: string | null | undefined): Promise<boolean> {
    // The whole length token must be a positive decimal integer; parseInt alone accepts "1e20" or "1.5".
    const token = String(watchedStr || '').split(':').slice(-2, -1)[0] ?? ''
    if (!/^[1-9][0-9]*$/.test(token) || !Number.isSafeInteger(Number(token))) return false
    const field = await readWatchedField(watchedStr)
    if (!field?.buf || !field.videoId) return false
    if (field.length !== Number(token)) return false
    if (field.buf.length < Math.ceil(field.length / 8)) return false
    return field.buf.every(byte => byte === 0)
}

export type ResolvedWatchedBits =
    | { kind: 'bits'; videoId: string; anchorIndex: number; offset: number; indices: number[] }
    | { kind: 'unprovable'; reason: 'no-bitfield' | 'decode' | 'anchor' | 'index' }

/**
 * Decodes against the CURRENT video list the way stremio-core's
 * WatchedBitField::construct_with_videos does: locate the anchor video, then bit i of the
 * list is stored bit (i + anchorLength - anchorIndex - 1). Stremio silently drops a bitfield
 * whose anchor is missing and any bit shifted out of range; a writer must never do either, so
 * those cases are unprovable instead of guessed.
 */
export async function resolveWatchedBitsAgainstVideos(
    watchedStr: string | null | undefined,
    videos: { id: string }[],
): Promise<ResolvedWatchedBits> {
    const field = await readWatchedField(watchedStr)
    if (!field) return { kind: 'unprovable', reason: 'decode' }
    if (!field.buf) return { kind: 'unprovable', reason: 'no-bitfield' }
    if (field.length <= 0) return { kind: 'unprovable', reason: 'decode' }
    const anchorIndex = videos.findIndex(video => video.id === field.videoId)
    if (anchorIndex < 0) return { kind: 'unprovable', reason: 'anchor' }
    const offset = field.length - anchorIndex - 1
    const indices: number[] = []
    for (let stored = 0; stored < field.buf.length * 8; stored++) {
        if (!(field.buf[stored >> 3] & (1 << (stored & 7)))) continue
        const index = stored - offset
        if (index < 0 || index >= videos.length) return { kind: 'unprovable', reason: 'index' }
        indices.push(index)
    }
    if (indices.length === 0) return { kind: 'unprovable', reason: 'no-bitfield' }
    return { kind: 'bits', videoId: field.videoId, anchorIndex, offset, indices }
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
    const ab = await new Response(stream).arrayBuffer()
    return new Uint8Array(ab)
}

// The anchor id and the declared length must derive from the SAME max set bit, exactly like
// stremio-core's writer (last_index_of(true)): anchor = videos[max(indices)].id, length =
// max(indices) + 1. Callers used to pass a stale anchor id with a freshly edited bitfield,
// desynchronising the two halves of the string on decode.
export async function encodeWatchedBitfield(indices: number[], videos: { id: string }[]): Promise<string> {
    if (indices.length === 0) throw new Error('encodeWatchedBitfield: no watched indices')
    const maxIdx = Math.max(...indices)
    const anchor = videos[maxIdx]
    if (!anchor || !anchor.id) throw new Error('encodeWatchedBitfield: anchor video missing from list')
    const length = maxIdx + 1
    const bytes = new Uint8Array(Math.ceil(length / 8))
    for (const idx of indices) {
        if (idx < 0 || idx >= length) continue
        bytes[idx >> 3] |= 1 << (idx & 7)
    }
    return `${anchor.id}:${length}:${bytesToBase64(await deflateRaw(bytes))}`
}
