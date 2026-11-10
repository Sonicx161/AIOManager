import { threeWayMergeCanonical, type CanonicalAddon } from '@/lib/canonical-merge'
import { filterResurrected, mergeAddonDeletionState } from '@/lib/addon-tombstones'
import { getCanonicalBaseEntry } from '@/lib/canonical-base'
import { fetchCanonical, type CanonicalFetchResult } from '@/api/hydra-providers'
import { serverHasStremioCredential } from '@/lib/canonical-visibility'
import { learnServerCredentialedAccounts } from '../syncStore'
import { markFoldedHub } from '@/lib/folded-hubs'
import {
    getAccountById,
    getStremioAuthKey,
    persistAccounts,
    acquireSyncMutex,
} from '../accountStore'
import type { AccountStore } from '../accountStore'
import type { AddonDescriptor } from '@/types/addon'
import { captureSyncOwnership, getSyncApiPath, SyncOwnershipLostError, syncRuntime, type SyncOwnership } from '../sync-store-helpers'
import { bindOwnershipScope } from '@/lib/scope-bound-ownership'
import { createScopedSingleFlight } from '@/lib/scoped-single-flight'
import { subscribeWorkspaceChanges } from '@/lib/workspace-persistence'

type StoreRef = { getState: () => AccountStore; setState: (partial: Partial<AccountStore> | ((state: AccountStore) => Partial<AccountStore>)) => void }

// Concurrent sync rounds at login each asked the server for the same canonical store;
// sharing the one in-flight promise turns that burst into a single request. Only
// rounds of the same server, identity, workspace and sync generation share it: a
// response fetched for one session must never be folded into another.
const canonicalFetch = createScopedSingleFlight<CanonicalFetchResult>()
subscribeWorkspaceChanges(() => canonicalFetch.clear())

function fetchCanonicalShared(ownership: SyncOwnership, sync: { serverUrl?: string; auth: { id: string } }): Promise<CanonicalFetchResult> {
    const scope = [getSyncApiPath(sync.serverUrl), sync.auth.id, ownership.workspace, ownership.seq].join('|')
    return canonicalFetch.run(scope, fetchCanonical)
}

async function getStore(): Promise<StoreRef> {
    const { useAccountStore } = await import('../accountStore')
    return useAccountStore
}

// The walk yields to the main thread between slices; a large workspace reconciles
// without freezing the UI behind the "Syncing" badge.
const RECONCILE_SLICE_ACCOUNTS = 25
const yieldToMain = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * Fold inbound canonical-store writes (e.g. AIOStreams) into all accounts via the
 * tested three-way merge, BEFORE the client's blob push so the push reflects the merge.
 * The client is the single merger.
 *
 * Incremental: a hub whose server hash equals the base hash (the server still holds
 * exactly what this client's last confirmed push put there) is proven to merge to
 * `{ addons: local, changed: false }` — threeWayMergeCanonical(base, local, base)
 * keeps every local key and drops every remote-only key, all of which are base keys —
 * so the expensive manifest-deep merge is skipped for unchanged hubs.
 *
 * Loop-safety: this is invoked from inside syncToRemote. It mutates account.addons under
 * the per-account sync mutex and propagates a changed Hub to native connections via
 * pushToConnections (which only hits triggerReconciliation + connectionStore, NO
 * triggerSync), but it never calls backgroundSync/triggerSync itself. The in-flight blob
 * push carries the rest.
 *
 * @returns true if any Hub changed (the caller may want to ensure a push follows).
 */
export async function reconcileInboundCanonical(sessionOwnership: SyncOwnership = captureSyncOwnership()): Promise<boolean> {
    const store = await getStore()
    sessionOwnership.assert()
    const targets = store.getState().accounts
    if (targets.length === 0) return false

    const { useSyncStore } = await import('../syncStore')
    sessionOwnership.assert()
    // A server switch keeps workspace and pull generation, so the endpoint and
    // identity are part of this reconcile's ownership too.
    const syncScope = () => {
        const { serverUrl, auth } = useSyncStore.getState()
        return `${getSyncApiPath(serverUrl)}|${auth.id}`
    }
    const ownership = bindOwnershipScope(sessionOwnership, syncScope, () =>
        new SyncOwnershipLostError(sessionOwnership.workspace, sessionOwnership.seq, sessionOwnership.workspace, syncRuntime.pullSeq))
    let remote: Record<string, { addons: AddonDescriptor[]; updatedAt: number; hash?: string }>
    try {
        const result = await fetchCanonicalShared(ownership, useSyncStore.getState())
        ownership.assert()
        remote = result.canonical
        learnServerCredentialedAccounts(result.serverStremioCredentialedAccounts)
    } catch {
        return false // best-effort; never block the push on it
    }
    const serverCredentialed = useSyncStore.getState().serverStremioCredentialedAccounts

    let anyChanged = false
    let walked = 0

    for (const account of targets) {
        if (serverHasStremioCredential(account.id, serverCredentialed, !!getStremioAuthKey(account))) continue
        if (walked > 0 && walked % RECONCILE_SLICE_ACCOUNTS === 0) await yieldToMain()
        walked++
        const remoteEntry = remote[account.id]
        const remoteAddons = (remoteEntry?.addons || []) as unknown as CanonicalAddon[]

        const releaseMutex = await acquireSyncMutex(account.id)
        let didChange = false
        let mergedCount = -1
        try {
            ownership.assert()
            const current = getAccountById(store.getState().accounts, account.id)
            if (!current) continue
            const baseEntry = getCanonicalBaseEntry(account.id)
            const base = (baseEntry?.addons ?? null) as unknown as CanonicalAddon[] | null
            const remoteMatchesBase = !!(baseEntry?.hash && remoteEntry?.hash && baseEntry.hash === remoteEntry.hash)
            const deletionState = mergeAddonDeletionState(current.deletedAddons, undefined, current.restoredAddons, undefined)
            const local = filterResurrected((current.addons || []) as unknown as CanonicalAddon[], [], deletionState.deletedAddons)
            const survivingRemote = remoteMatchesBase
                ? []
                : filterResurrected(remoteAddons, [], deletionState.deletedAddons)
            const { addons: merged, changed } = remoteMatchesBase
                ? { addons: local, changed: false }
                : threeWayMergeCanonical(base, local, survivingRemote)
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
            releaseMutex()
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
