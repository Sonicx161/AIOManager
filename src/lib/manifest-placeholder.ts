import type { AddonManifest } from '@/types/addon'

type ManifestLike = Partial<AddonManifest> | null | undefined
type ManifestHolder = { transportUrl: string; manifest?: AddonManifest }

const KNOWN_GOOD_MAX = 2000
const knownGood = new Map<string, AddonManifest>()
const unreachable = new Set<string>()

export function manifestKey(url: string | undefined): string {
    return (url || '').trim().toLowerCase().replace(/\/manifest\.json$/, '').replace(/\/+$/, '')
}

// Placeholders are minted when a manifest cannot be fetched: id 'unknown' or a
// 'pending-sync-' recovery id, or a 0.0.0 shell with no resources, catalogs or description.
export function isPlaceholderManifest(manifest: ManifestLike): boolean {
    if (!manifest) return true
    const id = manifest.id || ''
    if (!id || id === 'unknown' || id.startsWith('pending-sync-')) return true
    const version = (manifest.version || '').replace(/^v/, '')
    if (version !== '0.0.0' && version !== '') return false
    const hasShape = (Array.isArray(manifest.resources) && manifest.resources.length > 0)
        || (Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0)
        || Boolean(manifest.description && !manifest.description.startsWith('Addon from '))
    return !hasShape
}

export function isPlaceholderAddon(addon: Pick<ManifestHolder, 'manifest'>): boolean {
    return isPlaceholderManifest(addon.manifest)
}

export function rememberKnownManifests(addons: ManifestHolder[] | undefined): void {
    for (const addon of addons || []) {
        if (!addon?.transportUrl || isPlaceholderManifest(addon.manifest)) continue
        const key = manifestKey(addon.transportUrl)
        if (!knownGood.has(key) && knownGood.size >= KNOWN_GOOD_MAX) {
            const oldest = knownGood.keys().next().value
            if (oldest !== undefined) knownGood.delete(oldest)
        }
        knownGood.set(key, addon.manifest as AddonManifest)
    }
}

export function getKnownManifest(transportUrl: string): AddonManifest | undefined {
    return knownGood.get(manifestKey(transportUrl))
}

// A placeholder never replaces a known-good manifest. Count and order are untouched;
// only the manifest of a placeholder row is swapped, and unchanged rows keep identity.
export function restoreKnownManifests<T extends ManifestHolder>(addons: T[], previous?: ManifestHolder[]): T[] {
    if (!Array.isArray(addons)) return addons
    let prevByUrl: Map<string, AddonManifest> | null = null
    let changed = false
    const out = addons.map((addon) => {
        if (!addon || !isPlaceholderManifest(addon.manifest)) return addon
        if (!prevByUrl) {
            prevByUrl = new Map()
            for (const p of previous || []) {
                if (p?.transportUrl && !isPlaceholderManifest(p.manifest)) prevByUrl.set(manifestKey(p.transportUrl), p.manifest as AddonManifest)
            }
        }
        const key = manifestKey(addon.transportUrl)
        const good = prevByUrl.get(key) || knownGood.get(key)
        if (!good) return addon
        changed = true
        return { ...addon, manifest: good }
    })
    return changed ? out : addons
}

export function markManifestUnreachable(url: string): void {
    unreachable.add(manifestKey(url))
}

export function clearManifestUnreachable(url: string): void {
    unreachable.delete(manifestKey(url))
}

export function isManifestUnreachable(url: string): boolean {
    return unreachable.has(manifestKey(url))
}

export interface HealOptions<T extends ManifestHolder> {
    fetchManifest: (transportUrl: string) => Promise<AddonManifest>
    apply: (addon: T, fetched: AddonManifest) => T
    shouldSkip?: (transportUrl: string) => boolean
    onFailure?: (transportUrl: string, error: unknown) => void
    concurrency?: number
}

// Replaces a stored placeholder only when the real manifest was fetched. A failed
// or placeholder-shaped fetch leaves the row untouched; order and count never change.
export async function healPlaceholderAddons<T extends ManifestHolder>(
    addons: T[],
    options: HealOptions<T>,
): Promise<{ addons: T[]; healed: number }> {
    const targets: number[] = []
    addons.forEach((addon, index) => {
        if (addon && isPlaceholderManifest(addon.manifest) && addon.transportUrl) targets.push(index)
    })
    if (targets.length === 0) return { addons, healed: 0 }

    const out = addons.slice()
    let healed = 0
    const width = Math.max(1, options.concurrency ?? 4)
    for (let i = 0; i < targets.length; i += width) {
        await Promise.all(targets.slice(i, i + width).map(async (index) => {
            const addon = addons[index]
            if (options.shouldSkip?.(addon.transportUrl)) {
                markManifestUnreachable(addon.transportUrl)
                return
            }
            try {
                const fetched = await options.fetchManifest(addon.transportUrl)
                if (isPlaceholderManifest(fetched)) throw new Error('Fetched manifest is a placeholder')
                out[index] = options.apply(addon, fetched)
                clearManifestUnreachable(addon.transportUrl)
                healed++
            } catch (error) {
                markManifestUnreachable(addon.transportUrl)
                options.onFailure?.(addon.transportUrl, error)
            }
        }))
    }
    return { addons: out, healed }
}
