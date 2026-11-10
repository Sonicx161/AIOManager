// Dedupe canonicalAddons for the sync push the way the export blob already does:
// one shared manifest table, descriptors referencing it. The reference replaces the
// manifest VALUE in place, so the server can rebuild each descriptor with its
// original key order and store byte-identical JSON.
//
// Two configured instances can publish the same id and version with different
// names, catalogs or config, so a table entry is shared only between manifests
// whose complete serialized JSON matches. The first variant keeps the plain
// id:version reference; later distinct variants get id:version#n.

export interface DedupedCanonicalAddons {
    version: 2
    manifests: Record<string, unknown>
    addons: Record<string, unknown[]>
}

export const canonicalManifestKey = (manifest: { id?: unknown; version?: unknown }): string | null =>
    typeof manifest.id === 'string' && manifest.id && typeof manifest.version === 'string' && manifest.version
        ? `${manifest.id}:${manifest.version}`
        : null

export function dedupeCanonicalAddons(canonical: Record<string, unknown[]>): DedupedCanonicalAddons {
    const manifests: Record<string, unknown> = {}
    const addons: Record<string, unknown[]> = {}
    const refByContent = new Map<string, string>()
    const variantsByKey = new Map<string, number>()
    const serialized = new WeakMap<object, string>()
    const referenceFor = (baseKey: string, manifest: object): string => {
        let json = serialized.get(manifest)
        if (json === undefined) {
            json = JSON.stringify(manifest)
            serialized.set(manifest, json)
        }
        const contentKey = `${baseKey}\n${json}`
        const known = refByContent.get(contentKey)
        if (known) return known
        const variant = variantsByKey.get(baseKey) ?? 0
        variantsByKey.set(baseKey, variant + 1)
        let ref = variant === 0 ? baseKey : `${baseKey}#${variant}`
        while (manifests[ref] !== undefined) ref = `${ref}#`
        manifests[ref] = manifest
        refByContent.set(contentKey, ref)
        return ref
    }
    for (const [accountId, list] of Object.entries(canonical)) {
        if (!Array.isArray(list)) {
            addons[accountId] = list
            continue
        }
        addons[accountId] = list.map(addon => {
            if (!addon || typeof addon !== 'object' || Array.isArray(addon)) return addon
            const manifest = (addon as Record<string, unknown>).manifest
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return addon
            const key = canonicalManifestKey(manifest as { id?: unknown; version?: unknown })
            if (!key) return addon
            const ref = referenceFor(key, manifest)
            const referenced: Record<string, unknown> = {}
            for (const [field, value] of Object.entries(addon as Record<string, unknown>)) {
                referenced[field] = field === 'manifest' ? ref : value
            }
            return referenced
        })
    }
    return { version: 2, manifests, addons }
}
