import { triggerSync } from '@/lib/sync-trigger'
import { updateAddons } from '@/api/addons'
import { decrypt } from '@/lib/crypto'
import { loadSessionKey } from '@/lib/crypto'
import { toast } from '@/hooks/use-toast'
import { ACCOUNT_CONTEXT_PROFILE_SWAP } from '@/lib/account-contexts'
import { buildAddonCollectionDiff } from '@/lib/addon-collection-diff'
import { restoreAddonDeletions } from '@/lib/addon-tombstones'
import {
    safeUUID,
    getAccountById,
    getStremioAuthKey,
    persistAccounts,
    acquireSyncMutex,
    setAccountLoading,
    clearAccountLoading,
} from '../accountStore'
import type { AccountStore, ProfileSwitchResult } from '../accountStore'
import type { AddonDescriptor } from '@/types/addon'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

export async function createSubProfile(accountId: string, name: string, cloneFromCurrent = false) {
    const store = await getStore()
    if (!name.trim() || name.trim().length > 64) return

    const { accounts } = store.getState()
    const account = getAccountById(accounts, accountId)
    if (!account) return

    const { useFailoverStore } = await import('@/store/failoverStore')
    const currentRules = cloneFromCurrent
        ? structuredClone(useFailoverStore.getState().rules.filter(r => r.accountId === accountId))
        : []

    const newProfile = {
        id: safeUUID(),
        name: name.trim(),
        addons: cloneFromCurrent ? structuredClone(account.addons) : [],
        apRules: currentRules,
    }

    const updatedProfiles = [...(account.profiles || []), newProfile]

    const updatedAccount = {
        ...account,
        profiles: updatedProfiles,
    }

    store.setState({ accounts: accounts.map((a) => (a.id === accountId ? updatedAccount : a)) })
    persistAccounts(store.getState().accounts)
    await store.getState().switchProfile(accountId, newProfile.id)
    return newProfile.id
}

export async function deleteSubProfile(accountId: string, profileId: string) {
    const store = await getStore()
    setAccountLoading(accountId)
    try {
        const { accounts } = store.getState()
        const account = getAccountById(accounts, accountId)
        if (!account || !account.profiles) return

        if (account.activeProfileId === profileId) {
            await store.getState().switchProfile(accountId, 'default')
        }

        const currentAccount = getAccountById(store.getState().accounts, accountId)
        if (!currentAccount?.profiles) return

        const updatedProfiles = currentAccount.profiles.filter((p) => p.id !== profileId)
        const updatedAccount = {
            ...currentAccount,
            profiles: updatedProfiles.length > 0 ? updatedProfiles : undefined,
            activeProfileId: updatedProfiles.length > 0 ? currentAccount.activeProfileId : undefined
        }

        store.setState({ accounts: store.getState().accounts.map((a) => (a.id === accountId ? updatedAccount : a)) })
        persistAccounts(store.getState().accounts)

        const { useFailoverStore } = await import('@/store/failoverStore')
        await useFailoverStore.getState().deleteProfileRules(accountId, profileId)

        triggerSync()
    } finally {
        clearAccountLoading(accountId)
    }
}

export async function renameSubProfile(accountId: string, profileId: string, newName: string) {
    const store = await getStore()
    if (!newName.trim() || newName.trim().length > 64) return

    const { accounts } = store.getState()
    const account = getAccountById(accounts, accountId)
    if (!account || !account.profiles) return

    const updatedProfiles = account.profiles.map(p =>
        p.id === profileId ? { ...p, name: newName.trim() } : p
    )

    const updatedAccount = {
        ...account,
        profiles: updatedProfiles,
    }

    store.setState({ accounts: store.getState().accounts.map((a) => (a.id === accountId ? updatedAccount : a)) })
    persistAccounts(store.getState().accounts)
    triggerSync()
}

export async function switchProfile(accountId: string, targetProfileId: string) {
    const store = await getStore()
    store.setState({ error: null })
    setAccountLoading(accountId)
    const releaseMutex = await acquireSyncMutex(accountId)
    try {
        const { accounts } = store.getState()
        const account = getAccountById(accounts, accountId)
        if (!account) throw new Error('Account not found')

        const isTargetDefault = targetProfileId === 'default'
        const targetProfile = isTargetDefault ? undefined : account.profiles?.find((p) => p.id === targetProfileId)
        const targetName = isTargetDefault ? 'Main Setup' : targetProfile?.name || 'Setup'

        if (!isTargetDefault && !targetProfile) {
            throw new Error('Target setup not found')
        }

        const { useFailoverStore } = await import('@/store/failoverStore')
        const failoverStore = useFailoverStore.getState()

        const currentRules = failoverStore.rules.filter(r => r.accountId === accountId)

        await failoverStore.toggleAllRulesForAccount(accountId, false)

        const updatedProfiles = account.profiles ? [...account.profiles] : []
        if (account.activeProfileId) {
            const activeIdx = updatedProfiles.findIndex(p => p.id === account.activeProfileId)
            if (activeIdx !== -1) {
                updatedProfiles[activeIdx] = {
                    ...updatedProfiles[activeIdx],
                    addons: structuredClone(account.addons),
                    apRules: structuredClone(currentRules)
                }
            }
        } else {
            const defaultIdx = updatedProfiles.findIndex(p => p.id === 'default')
            const defaultState = {
                id: 'default',
                name: 'Main',
                addons: structuredClone(account.addons),
                apRules: structuredClone(currentRules)
            }
            if (defaultIdx !== -1) updatedProfiles[defaultIdx] = defaultState
            else updatedProfiles.unshift(defaultState)
        }

        let newAddons: AddonDescriptor[]
        if (isTargetDefault) {
            let defaultProfile = updatedProfiles.find(p => p.id === 'default')
            if (!defaultProfile) {
                defaultProfile = {
                    id: 'default',
                    name: 'Main',
                    addons: structuredClone(account.addons),
                    apRules: structuredClone(currentRules),
                }
                updatedProfiles.unshift(defaultProfile)
            }
            newAddons = defaultProfile.addons ?? account.addons
        } else {
            newAddons = targetProfile?.addons ?? []
        }
        const addonChanges = buildAddonCollectionDiff(account.addons, newAddons)

        if (addonChanges.hasChanges) {
            const sessionKey = await loadSessionKey()
            if (!sessionKey) throw new Error('Session expired. Sign in again before switching setups.')
            const authKey = await decrypt(getStremioAuthKey(account), sessionKey)
            if (authKey) {
                await updateAddons(authKey, newAddons, ACCOUNT_CONTEXT_PROFILE_SWAP, {
                    allowCollectionShrink: true,
                    previousCollection: account.addons,
                })
            }
        }

        const savedTargetExists = isTargetDefault
            ? !!account.profiles?.some(p => p.id === 'default')
            : !!targetProfile
        const deletionState = restoreAddonDeletions(
            account.deletedAddons,
            account.restoredAddons,
            savedTargetExists ? newAddons : []
        )
        const updatedAccount = {
            ...account,
            addons: newAddons,
            profiles: updatedProfiles,
            activeProfileId: isTargetDefault ? undefined : targetProfileId,
            ...deletionState,
        }

        store.setState({ accounts: store.getState().accounts.map((a) => (a.id === accountId ? updatedAccount : a)) })
        persistAccounts(store.getState().accounts)

        const targetRules = targetProfile ? targetProfile.apRules || [] : (updatedProfiles.find(p => p.id === 'default')?.apRules || [])
        await failoverStore.awakenProfileRules(accountId, targetRules)
        await failoverStore.pruneServerRulesToActive(accountId, targetRules.map(r => r.id))

        const { pushToConnections } = await import('./accountAddonOps')
        pushToConnections(accountId).catch(() => {})

        triggerSync()

        return {
            targetProfileId,
            targetName,
            addonChanges,
            remoteWriteSkipped: !addonChanges.hasChanges,
        } as ProfileSwitchResult
    } catch (error) {
        if (import.meta.env.DEV) console.error('Failed to switch setup:', error)
        try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            await useFailoverStore.getState().toggleAllRulesForAccount(accountId, true)
        } catch (rollbackErr) {
            if (import.meta.env.DEV) console.error('Failed to restore autopilot rules after setup switch failure:', rollbackErr)
            toast({ variant: 'destructive', title: 'Autopilot rules may need manual re-enablement' })
        }
        store.setState({ error: error instanceof Error ? error.message : 'Failed to switch setup' })
        throw error
    } finally {
        releaseMutex()
        clearAccountLoading(accountId)
    }
}
