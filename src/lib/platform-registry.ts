import type { ConnectionType } from '@/types/connection'
import stremioLogo from '@/assets/platforms/stremio.png'
import nuvioLogo from '@/assets/platforms/nuvio.png'
import hydraLogo from '@/assets/platforms/hydra.png'
// Official icon: https://github.com/jellyfin/jellyfin-ux/blob/master/branding/SVG/icon-transparent.svg
import jellyfinLogo from '@/assets/platforms/jellyfin.svg'

// Capabilities a platform CAN expose, declared statically. This is the catalog-level answer to
// "what does this platform support" (used to surface platform-exclusive sections), distinct from
// a live connection's runtime capabilities[] which only carries the v2.0 sync scope.
export type PlatformFeature =
    | 'addons'
    | 'plugins'
    | 'profiles'
    | 'library'
    | 'collections'
    | 'settings'
    | 'watchHistory'
    | 'watchProgress'

export interface PlatformRegistryEntry {
    id: string
    name: string
    logo: string
    connectionType: ConnectionType
    requiresAuth: boolean
    hasNativeDriver: boolean
    description: string
    available: boolean
    features: PlatformFeature[]
}

export const PLATFORM_REGISTRY: PlatformRegistryEntry[] = [
    {
        id: 'jellyfin',
        name: 'Jellyfin',
        logo: jellyfinLogo,
        connectionType: 'native',
        requiresAuth: true,
        hasNativeDriver: false,
        description: 'Jellyfin servers, AIOStreams (AIOS) and AIOMetadata (AIOM).',
        available: true,
        features: [],
    },
    {
        id: 'stremio',
        name: 'Stremio',
        logo: stremioLogo,
        connectionType: 'native',
        requiresAuth: true,
        hasNativeDriver: true,
        description: 'Stremio addon collection',
        available: true,
        features: ['addons', 'library', 'watchHistory', 'watchProgress'],
    },
    {
        id: 'nuvio',
        name: 'Nuvio',
        logo: nuvioLogo,
        connectionType: 'native',
        requiresAuth: true,
        hasNativeDriver: true,
        description: 'Nuvio addons and plugins',
        available: true,
        features: ['addons', 'plugins', 'profiles', 'library', 'collections', 'settings', 'watchHistory', 'watchProgress'],
    },
    {
        id: 'hydra-outbound',
        name: 'Hydra',
        logo: hydraLogo,
        connectionType: 'hydra-outbound',
        requiresAuth: false,
        hasNativeDriver: false,
        description: 'Push addons to a Hydra-compatible server',
        available: true,
        features: ['addons'],
    },
]

export function getPlatformEntry(platformId: string): PlatformRegistryEntry | undefined {
    return PLATFORM_REGISTRY.find(p => p.id === platformId)
}

export function platformSupports(platformId: string, feature: PlatformFeature): boolean {
    return getPlatformEntry(platformId)?.features.includes(feature) ?? false
}

// A platform-exclusive section is surfaced in the account workspace only when an enabled
// connection whose platform declares the feature is present (the account's connections are its
// workspace). Static (registry) rather than runtime capabilities so read-only surfaces outside
// the v2.0 sync scope still appear.
export function accountSupportsFeature(
    connections: ReadonlyArray<{ enabled: boolean; platform: string }> | undefined,
    feature: PlatformFeature,
): boolean {
    return (connections || []).some(c => c.enabled && platformSupports(c.platform, feature))
}

export function getConnectionTypeLabel(type: ConnectionType): string {
    switch (type) {
        case 'native': return 'Native'
        case 'hydra-inbound': return 'Inbound'
        case 'hydra-outbound': return 'Outbound'
    }
}
