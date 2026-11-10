// Server-side reader for the deduplicated canonicalAddons push field. The client
// dedupes manifests into one table (shared only between identical manifests, the
// descriptor's manifest value replaced by that key); this restores each descriptor
// with its original key order so the stored plaintext stays byte-identical to the
// legacy inline form.
import zlib from 'node:zlib'

const MAX_V2_DECOMPRESSED_BYTES = 128 * 1024 * 1024

function restoreDescriptor(addon, manifests) {
    if (!addon || typeof addon !== 'object' || Array.isArray(addon)) return addon
    const reference = addon.manifest
    if (typeof reference !== 'string') return addon
    const manifest = manifests[reference]
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return addon
    const restored = {}
    for (const [field, value] of Object.entries(addon)) {
        restored[field] = field === 'manifest' ? manifest : value
    }
    return restored
}

/**
 * Decode a canonicalAddonsV2 envelope ({version:2, compressed, data}) into the
 * legacy Record<accountId, AddonDescriptor[]> shape plus the parsed compact form.
 * Returns null for a malformed or oversized payload so callers can reject the push.
 */
export function decodeCanonicalAddonsV2(field) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null
    if (field.version !== 2 || typeof field.data !== 'string') return null
    try {
        let json
        if (field.compressed === true) {
            const compressed = Buffer.from(field.data, 'base64')
            if (compressed.length === 0 || compressed.length > 64 * 1024 * 1024) return null
            const decompressed = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_V2_DECOMPRESSED_BYTES })
            json = decompressed.toString('utf8')
        } else {
            json = field.data
        }
        if (json.length > MAX_V2_DECOMPRESSED_BYTES) return null
        const parsed = JSON.parse(json)
        if (!parsed || typeof parsed !== 'object' || parsed.version !== 2) return null
        if (parsed.manifests !== undefined && (typeof parsed.manifests !== 'object' || Array.isArray(parsed.manifests))) return null
        if (!parsed.addons || typeof parsed.addons !== 'object' || Array.isArray(parsed.addons)) return null
        const manifests = parsed.manifests || {}
        const accounts = {}
        for (const [accountId, addons] of Object.entries(parsed.addons)) {
            if (!accountId || !Array.isArray(addons)) continue
            accounts[accountId] = addons.map(addon => restoreDescriptor(addon, manifests))
        }
        return { accounts, compact: parsed }
    } catch {
        return null
    }
}
