import { VaultProvider } from './vault'

export interface ProviderHealth {
    id: string // Vault key ID
    name: string
    provider: VaultProvider
    status: 'active' | 'expired' | 'error' | 'none'
    daysRemaining: number | null
    expiresAt: string | null
    lastChecked: number
    loading: boolean
    error?: string
}

export interface ProviderState {
    health: Record<string, ProviderHealth>
    isRefreshing: boolean
}
