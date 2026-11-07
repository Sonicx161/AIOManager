import type { HydraDriverConfig } from './provider'

export type ConnectionType = 'native' | 'hydra-inbound' | 'hydra-outbound'
export type ConnectionStatus = 'active' | 'expired' | 'error' | 'degraded' | 'pending'

export interface MediaServerIdentity {
    product: 'jellyfin' | 'aiostreams' | 'aiometadata' | 'compatible'
    productName: string
    serverId?: string
    serverName?: string
    version?: string
    packageName?: string
    userId: string
    userName: string
    authMethod: 'password' | 'token'
    lastCheckedAt: number
}

export interface Connection {
    id: string
    platform: string
    connectionType: ConnectionType
    driverType?: ConnectionType
    enabled: boolean
    status: ConnectionStatus
    credentials: Record<string, string>
    profileMapping?: Record<string, number>
    lastSync: number
    lastKnownAddonCount: number
    capabilities: string[]
    consecutiveFailures: number
    lastError?: string
    lastErrorAt?: number
    pluginList?: NuvioPluginDescriptor[]
    driverConfig?: HydraDriverConfig
    displayName?: string
    mediaServer?: MediaServerIdentity
    /** Incarnation token: minted per add, carried on bound server rules and credentials so a delayed cleanup of a removed incarnation never claims the re-added one's rows. */
    generation?: string
}

export interface NuvioPluginDescriptor {
    url: string
    name: string
    enabled: boolean
    sort_order: number
    repo_type?: string
}

export interface PlatformDriver {
    testConnection(credentials: Record<string, string>): Promise<{ ok: boolean; capabilities: string[] }>
    readAddons(credentials: Record<string, string>, options?: { profileId?: string }): Promise<unknown[]>
    writeAddons(credentials: Record<string, string>, addons: unknown[], options?: { profileId?: string }): Promise<void>
    installAddon(credentials: Record<string, string>, addonUrl: string, options?: { profileId?: string }): Promise<void>
    removeAddon(credentials: Record<string, string>, addonUrl: string, options?: { profileId?: string }): Promise<void>
    healthCheck?(addonUrl?: string): Promise<{ healthy: boolean; latencyMs: number }>
}

// Media connections have their own API contract; they are never addon sources or targets.
// Retain legacy addon platforms whose stored records predate runtime capabilities.
export function isAddonConnection(c: Pick<Connection, 'platform' | 'connectionType' | 'capabilities'>): boolean {
    if (c.platform === 'jellyfin') return false
    return c.connectionType === 'hydra-outbound'
        || c.platform === 'stremio'
        || c.platform === 'nuvio'
        || c.platform === 'realstream'
        || c.capabilities?.includes('addons') === true
}

export function isSyncEligibleConnection(c: Connection): boolean {
    if (c.connectionType === 'hydra-inbound') return false
    return isAddonConnection(c) && (c.connectionType === 'hydra-outbound' || c.platform !== 'stremio')
}
