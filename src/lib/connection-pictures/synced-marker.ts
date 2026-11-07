// Bounded synced markers (CP-R3-002): the account sync blob never carries
// image data. A marker at or under the cap travels verbatim; anything longer
// (an oversized avatar URL or data URI) is replaced by a SHA-256 digest
// of the exact value written, so equality checks still work at a few bytes.
// Pure leaf module with no imports so it stays runnable under node:test.

export const CONNECTION_PICTURES_SYNCED_MARKER_MAX_LENGTH = 200

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) | 0

/** Synchronous SHA-256 over the UTF-8 bytes of value, lowercase hex. */
export function sha256Hex(value: string): string {
    const bytes = new TextEncoder().encode(value)
    const l = bytes.length
    const blocks = ((l + 8) >> 6) + 1
    const words = new Uint32Array(blocks * 16)
    for (let i = 0; i < l; i++) words[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8)
    words[l >> 2] |= 0x80 << ((3 - (l & 3)) * 8)
    words[blocks * 16 - 1] = l << 3
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
    const w = new Uint32Array(64)
    for (let j = 0; j < blocks; j++) {
        for (let i = 0; i < 16; i++) w[i] = words[j * 16 + i]
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
            const ch = (e & f) ^ (~e & g)
            const t1 = (h + S1 + ch + K[i] + w[i]) | 0
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
            const maj = (a & b) ^ (a & c) ^ (b & c)
            const t2 = (S0 + maj) | 0
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** The representation a marker may take in the synced account blob. */
export function syncedMarkerFor(marker: string | null): string | null {
    if (marker === null) return null
    if (marker.length <= CONNECTION_PICTURES_SYNCED_MARKER_MAX_LENGTH) return marker
    return `sha256:${sha256Hex(marker)}`
}

/** True when a stored synced marker was written from this exact live marker. */
export function markerMatchesSynced(marker: string | null | undefined, synced: string | null | undefined): boolean {
    if (synced === null || synced === undefined || synced === '') return false
    if (marker === synced) return true
    return synced === syncedMarkerFor(marker ?? null)
}
