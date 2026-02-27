import { AddonDescriptor } from '@/types/addon'

const OFFICIAL_ADDONS: Record<string, { name: string; logo?: string; description?: string }> = {
    'cinemeta': {
        name: 'Cinemeta',
        logo: 'https://v3-cinemeta.strem.io/logo.png',
        description: 'Official Movie and Series directory'
    },
    'watchhub': {
        name: 'WatchHub',
        logo: 'https://watchhub.strem.io/logo.png',
        description: 'Find where to watch movies & series'
    },
    'youtube': {
        name: 'YouTube',
        logo: 'https://v3-channels.strem.io/logo.png',
        description: 'Official YouTube addon'
    },
    'opensubtitles': {
        name: 'OpenSubtitles',
        logo: 'https://opensubtitles-v3.strem.io/logo.png',
        description: 'Official subtitle provider'
    },
    'local': {
        name: 'Local Files',
        logo: '📦',
        description: 'Files from your local computer'
    }
}

const URL_PATTERNS = [
    { pattern: 'v3-cinemeta.strem.io', key: 'cinemeta' },
    { pattern: 'watchhub.strem.io', key: 'watchhub' },
    { pattern: 'v3-channels.strem.io', key: 'youtube' },
    { pattern: 'opensubtitles-v3.strem.io', key: 'opensubtitles' },
    { pattern: '127.0.0.1:11470/local-addon', key: 'local' },
    { pattern: 'localhost:11470/local-addon', key: 'local' }
]

/**
 * Generates a readable name from a transport URL hostname.
 */
export function getHostnameIdentifier(transportUrl: string): string {
    try {
        const hostname = new URL(transportUrl).hostname
        return hostname
            .replace(/^www\./, '')
            .replace(/\.[^.]+$/, '')
            .split(/[.-]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ')
    } catch {
        return 'Unknown Addon'
    }
}

/**
 * Robustly identifies an addon even if the manifest is missing or partial.
 * Non-destructive: Preserves all existing fields (catalogs, behaviorHints, etc.) while filling gaps.
 */
export function identifyAddon(transportUrl: string, manifest?: Partial<AddonDescriptor['manifest']>): AddonDescriptor['manifest'] {
    const url = transportUrl.toLowerCase()
    const id = (manifest?.id || '').toLowerCase()
    const name = manifest?.name || ''
    const isUnknown = !name || name === 'Unknown Addon'

    // Helper to ensure core fields exist while preserving everything else
    const wrap = (meta: Partial<AddonDescriptor['manifest']>) => ({
        ...manifest,
        id: manifest?.id || meta.id || 'unknown',
        name: isUnknown ? meta.name : (manifest?.name || meta.name),
        logo: manifest?.logo || meta.logo,
        description: manifest?.description || meta.description,
        version: manifest?.version || '0.0.0',
        types: manifest?.types || []
    } as AddonDescriptor['manifest'])

    // 1. Check ID-based official matches
    for (const [key, meta] of Object.entries(OFFICIAL_ADDONS)) {
        if (id.includes(key) || (name && name.toLowerCase() === meta.name.toLowerCase())) {
            return wrap({ ...meta, id: key })
        }
    }

    // 2. Check URL-based official matches
    for (const { pattern, key } of URL_PATTERNS) {
        if (url.includes(pattern)) {
            return wrap({ ...OFFICIAL_ADDONS[key], id: key })
        }
    }

    // 3. Fallback: Return empty wrap (No baking of fallbacks into the manifest object)
    return wrap({})
}
