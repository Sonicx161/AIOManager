import type { VaultProvider } from '@/types/vault'
import rawProviders from './provider-registry.data.json'
import {
    COMPOSITE_AUTH,
    CREDENTIAL_LABELS,
    groupForCategory,
    vaultProviderForId,
} from './provider-registry-maps'
import { PROVIDER_SETUP, ProviderSetup } from './provider-setup'
import { resolveRegistryForKey } from './provider-registry-core'

export interface RawProvider {
    id: string
    name: string
    category: string
    authType: string
    website?: string
    credentialUrl?: string
    placeholder?: string
    description?: string
    genres?: string[]
}

export interface RegistryProvider {
    id: string
    name: string
    group: string
    vaultProvider: VaultProvider
    credentialLabel: string
    credentialUrl?: string
    placeholder?: string
    description?: string
    /** Composite credentials (user:pass, self-hosted url+key), stored as a single value for now. */
    composite: boolean
    setup?: ProviderSetup
}

function toRegistryProvider(raw: RawProvider): RegistryProvider | null {
    const group = groupForCategory(raw.category)
    if (group === null) return null

    const composite = COMPOSITE_AUTH.has(raw.authType)
    const placeholder =
        raw.placeholder || (raw.authType === 'user:pass' ? 'username:password' : undefined)

    return {
        id: raw.id,
        name: raw.name,
        group,
        vaultProvider: vaultProviderForId(raw.id),
        credentialLabel: CREDENTIAL_LABELS[raw.authType] || 'API Key',
        credentialUrl: raw.credentialUrl || (raw.website && raw.website !== '#' ? raw.website : undefined),
        placeholder,
        description: raw.description?.trim() || undefined,
        composite,
        setup: PROVIDER_SETUP[raw.id],
    }
}

const catalog: RegistryProvider[] = (rawProviders as RawProvider[])
    .map(toRegistryProvider)
    .filter((p): p is RegistryProvider => p !== null)

// AIOStreams is a first-class connection target rather than an AIOStatus catalog entry.
const AIOSTREAMS_ENTRY: RegistryProvider = {
    id: 'aiostreams',
    name: 'AIOStreams',
    group: 'AIOStreams',
    vaultProvider: 'aiostreams',
    credentialLabel: 'API Key',
    description: 'Credentials for your AIOStreams instance, used for authenticated addon requests.',
    composite: false,
}

export const CUSTOM_ENTRY: RegistryProvider = {
    id: 'custom',
    name: 'Other / Custom',
    group: 'Custom',
    vaultProvider: 'other',
    credentialLabel: 'API Key / Token',
    description: 'Manually track any provider not listed above.',
    composite: false,
}

export const PROVIDER_REGISTRY: RegistryProvider[] = [AIOSTREAMS_ENTRY, ...catalog, CUSTOM_ENTRY]

export const PICKER_PROVIDERS: RegistryProvider[] = PROVIDER_REGISTRY.filter((p) => p !== AIOSTREAMS_ENTRY)

export const PROVIDER_REGISTRY_BY_ID: Record<string, RegistryProvider> = Object.fromEntries(
    PROVIDER_REGISTRY.map((p) => [p.id, p])
)

export function registryForKey(key: {
    catalogId?: string
    provider: VaultProvider
    customProviderName?: string
}): RegistryProvider {
    return resolveRegistryForKey(key, PROVIDER_REGISTRY, catalog, CUSTOM_ENTRY)
}
