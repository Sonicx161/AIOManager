import type { AddonDescriptor } from '@/types/addon'

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
        description: 'Files from your local computer'
    },
    'aiostreams': {
        name: 'AIOStreams',
        description: 'Unified stream aggregator'
    },
    'aiometadata': {
        name: 'AIOMetadata',
        description: 'Metadata enrichment addon'
    },
    'aiometedata': {
        name: 'AIOMetadata',
        description: 'Metadata enrichment addon'
    },
    'trakt': {
        name: 'Trakt',
        logo: 'https://upload.wikimedia.org/wikipedia/commons/3/3d/Trakt.tv-favicon.svg',
        description: 'Trakt watch history sync integration'
    },
    'publicdomainmovies': {
        name: 'Public Domain Movies',
        description: 'Public domain movies'
    },
    'watchly': {
        name: 'Watchly',
        description: 'Movie and series recommendations based on your Stremio library'
    }
}

const URL_PATTERNS = [
    { pattern: 'v3-cinemeta.strem.io', key: 'cinemeta' },
    { pattern: 'cinemeta.strem.io', key: 'cinemeta' },
    { pattern: 'watchhub.strem.io', key: 'watchhub' },
    { pattern: 'v3-channels.strem.io', key: 'youtube' },
    { pattern: 'channels.strem.io', key: 'youtube' },
    { pattern: 'opensubtitles-v3.strem.io', key: 'opensubtitles' },
    { pattern: 'opensubtitles.strem.io', key: 'opensubtitles' },
    { pattern: 'opensubtitles.strem.io/stremio', key: 'opensubtitles' },
    { pattern: '127.0.0.1:11470/local-addon', key: 'local' },
    { pattern: 'localhost:11470/local-addon', key: 'local' },
    { pattern: 'aiostreams', key: 'aiostreams' },
    { pattern: 'aio-streams', key: 'aiostreams' },
    { pattern: 'aiometadata', key: 'aiometadata' },
    { pattern: 'aio-metadata', key: 'aiometadata' },
    { pattern: 'aiometedata', key: 'aiometedata' },
    { pattern: 'strem.io/trakt', key: 'trakt' },
    { pattern: 'caching.stremio.net', key: 'publicdomainmovies' },
    { pattern: 'watchly', key: 'watchly' },
]

const normalizeDisplayName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

function shouldUseCanonicalName(currentName: string, canonicalName: string): boolean {
    if (!currentName || currentName === 'Unknown Addon') return true
    return normalizeDisplayName(currentName) === normalizeDisplayName(canonicalName)
}

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

export function identifyAddon(transportUrl: string, manifest?: Partial<AddonDescriptor['manifest']>): AddonDescriptor['manifest'] {
    const url = transportUrl.toLowerCase()
    const id = (manifest?.id || '').toLowerCase()
    const name = manifest?.name || ''
    const normalizedId = normalizeDisplayName(id)
    const normalizedName = normalizeDisplayName(name)

    const wrap = (meta: Partial<AddonDescriptor['manifest']>) => ({
        ...manifest,
        id: manifest?.id || meta.id || 'unknown',
        name: shouldUseCanonicalName(name, meta.name || '') ? (meta.name || manifest?.name || 'Unknown Addon') : (manifest?.name || meta.name || 'Unknown Addon'),
        logo: manifest?.logo || meta.logo,
        description: manifest?.description || meta.description,
        version: manifest?.version || '0.0.0',
        types: manifest?.types || []
    } as AddonDescriptor['manifest'])

    for (const [key, meta] of Object.entries(OFFICIAL_ADDONS)) {
        const normalizedKey = normalizeDisplayName(key)
        const normalizedMetaName = normalizeDisplayName(meta.name)
        if (normalizedId.includes(normalizedKey) || (name && normalizedName === normalizedMetaName)) {
            return wrap({ ...meta, id: key })
        }
    }

    for (const { pattern, key } of URL_PATTERNS) {
        if (url.includes(pattern)) {
            const result = wrap({ ...OFFICIAL_ADDONS[key], id: key })
            const hostName = getHostnameIdentifier(transportUrl)
            if (result.name === hostName) {
                result.name = OFFICIAL_ADDONS[key].name
            }
            return result
        }
    }

    return wrap((!name || name === 'Unknown Addon') ? { name: getHostnameIdentifier(transportUrl) } : {})
}
