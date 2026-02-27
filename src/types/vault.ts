export type VaultProvider =
    | 'real-debrid'
    | 'torbox'
    | 'premiumize'
    | 'alldebrid'
    | 'debrid-link'
    | 'offcloud'
    | 'put-io'
    | 'easynews'
    | 'pikpak'
    | 'trakt'
    | 'other'

export interface VaultKey {
    id: string
    name: string
    provider: VaultProvider
    value: string
    updatedAt: number
}

export interface VaultState {
    keys: VaultKey[]
    isLocked: boolean
    loading: boolean
    error: string | null
}
