import { threeWayMergeCanonical, type CanonicalAddon } from '@/lib/canonical-merge'
import { filterResurrected, mergeAddonDeletionState } from '@/lib/addon-tombstones'
import { getCanonicalBase } from '@/lib/canonical-base'
import { fetchCanonical } from '@/api/hydra-providers'
import { serverHasStremioCredential } from '@/lib/canonical-visibility'
import { learnServerCredentialedAccounts } from '../syncStore'
import { markFoldedHub } from '@/lib/folded-hubs'
import {
    getAccountById,
    getStremioAuthKey,
    persistAccounts,
    syncMutexes,
} from '../accountStore'
import type { AccountStore } from '../accountStore'
import type { AddonDescriptor } from '@/types/addon'
import { captureSyncOwnership, type SyncOwnership } from '../sync-store-helpers'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

/**
 * Fold inbound canonical-store writes (e.g. AIOStreams) into all accounts via the
 * tested three-way merge, BEFORE the client's blob push so the push reflects the merge.
 * The client is the single merger.
 *
 * Loop-safety: this is invoked from inside syncToRemote. It mutates account.addons under
 * the per-account sync mutex and propagates a changed Hub to native connections via
 * pushToConnections (which only hits triggerReconciliation + connectionStore, NO
 * triggerSync), but it never calls backgroundSync/triggerSync itself. The in-flight blob
 * push carries the rest.
 *
 * @returns true if any Hub changed (the caller may want to ensure a push follows).
 */
export async function reconcileInboundCanonical(ownership: SyncOwnership = captureSyncOwnership()): Promise<boolean> {
    const store = await getStore()
    ownership.assert()
    const targets = store.getState().accounts
    if (targets.length === 0) return false

    let remote: Record<string, { addons: AddonDescriptor[]; updatedAt: number }>
    try {
        const result = await fetchCanonical()
        ownership.assert()
        remote = result.canonical
        learnServerCredentialedAccounts(result.serverStremioCredentialedAccounts)
    } catch {
        return false // best-effort; never block the push on it
    }
    const { useSyncStore } = await import('../syncStore')
    ownership.assert()
    const serverCredentialed = useSyncStore.getState().serverStremioCredentialedAccounts

    let anyChanged = false

    for (const account of targets) {
        if (serverHasStremioCredential(account.id, serverCredentialed, !!getStremioAuthKey(account))) continue
        const remoteAddons = (remote[account.id]?.addons || []) as unknown as CanonicalAddon[]

        while (syncMutexes.has(account.id)) {
            await syncMutexes.get(account.id)
            ownership.assert()
        }
        ownership.assert()
        let release!: () => void
        syncMutexes.set(account.id, new Promise<void>(r => { release = r }))
        let didChange = false
        let mergedCount = -1
        try {
            const current = getAccountById(store.getState().accounts, account.id)
            if (!current) continue
            const base = getCanonicalBase(account.id) as unknown as CanonicalAddon[] | null
            const deletionState = mergeAddonDeletionState(current.deletedAddons, undefined, current.restoredAddons, undefined)
            const local = filterResurrected((current.addons || []) as unknown as CanonicalAddon[], [], deletionState.deletedAddons)
            const survivingRemote = filterResurrected(remoteAddons, [], deletionState.deletedAddons)
            const { addons: merged, changed } = threeWayMergeCanonical(base, local, survivingRemote)
            mergedCount = merged.length
            const localSuppressed = local.length !== (current.addons || []).length
            if (!changed && !localSuppressed) continue
            if (merged.length > 0 && local.length === 0) markFoldedHub(account.id)
            const mergedAddons = merged as unknown as AddonDescriptor[]
            const updated = {
                ...current,
                addons: mergedAddons,
                ...deletionState,
                profiles: current.profiles
                    ? current.profiles.map(profile => profile.id === (current.activeProfileId || 'default')
                        ? { ...profile, addons: structuredClone(mergedAddons) }
                        : profile)
                    : current.profiles,
                lastSync: new Date(),
            }
            const next = store.getState().accounts.map(a => (a.id === account.id ? updated : a))
            store.setState({ accounts: next })
            persistAccounts(next, ownership)
            anyChanged = true
            didChange = true
        } finally {
            release()
            syncMutexes.delete(account.id)
        }
        console.info(`[Fold] ${account.id}: remote=${remoteAddons.length} local→merged=${mergedCount} changed=${didChange}`)

        if (didChange) {
            import('./accountAddonOps')
                .then(({ pushToConnections }) => {
                    if (ownership.current()) return pushToConnections(account.id, { ownership })
                })
                .catch(() => { })
        }
    }

    return anyChanged
}
