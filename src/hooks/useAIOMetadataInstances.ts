import { useMemo } from 'react'
import { useAccountStore } from '@/store/accountStore'
import { useVaultStore } from '@/store/vaultStore'
import { isAIOMetadataAddon, parseAIOMetadataUrl, getStoredAIOMetadataPassword } from '@/lib/aiometadata-utils'

export interface AIOMetadataInstanceAccount {
    accountId: string
}

export interface AIOMetadataInstance {
    baseUrl: string
    uuid: string
    addonName: string
    transportUrl: string
    logo?: string
    hasPassword: boolean
    password: string | null
    accounts: AIOMetadataInstanceAccount[]
}

export function useAIOMetadataInstances() {
    const accounts = useAccountStore((state) => state.accounts)
    const vaultLocked = useVaultStore((state) => state.isLocked)

    return useMemo(() => {
        const instanceMap = new Map<string, AIOMetadataInstance>()
        let hasLocked = false

        for (const account of accounts) {
            const addons = account.addons || []
            for (const addon of addons) {
                if (!isAIOMetadataAddon(addon)) continue

                const parsed = parseAIOMetadataUrl(addon.transportUrl)
                if (!parsed) continue

                const storedPassword = vaultLocked ? null : getStoredAIOMetadataPassword(parsed.baseUrl, parsed.uuid)
                if (storedPassword === null) {
                    hasLocked = true
                }

                const key = `${parsed.baseUrl}|${parsed.uuid}`
                const existing = instanceMap.get(key)
                const accountEntry: AIOMetadataInstanceAccount = {
                    accountId: account.id,
                }

                if (existing) {
                    if (!existing.accounts.some(a => a.accountId === account.id)) {
                        existing.accounts.push(accountEntry)
                    }
                    if (storedPassword !== null) {
                        existing.hasPassword = true
                        existing.password = storedPassword
                    }
                } else {
                    instanceMap.set(key, {
                        baseUrl: parsed.baseUrl,
                        uuid: parsed.uuid,
                        addonName: addon.metadata?.customName || addon.manifest?.name || 'AIOMetadata',
                        transportUrl: addon.transportUrl,
                        logo: addon.metadata?.customLogo || addon.manifest?.logo,
                        hasPassword: storedPassword !== null,
                        password: storedPassword,
                        accounts: [accountEntry],
                    })
                }
            }
        }

        return { instances: Array.from(instanceMap.values()), vaultLocked: hasLocked }
    }, [accounts, vaultLocked])
}
