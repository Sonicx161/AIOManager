import { normUrl, type Tombstones } from '../../lib/addon-tombstones.ts'
import { getAddonInstanceKey } from '../../lib/addon-instance-identity.ts'
import { normalizeAddonUrl } from '../../lib/addon-url.ts'
import { acquireSyncMutex, tryAcquireSyncMutex } from '../syncMutex.ts'
import type { AddonDescriptor } from '../../types/addon'
import type { AddonActionContext, AddonDeleteAck, AddonActionEntry } from '../../api/addon-actions'

// Server addon-action reconciliation: a tombstone lifts only when the server holds that exact deletion's identity plus a newer install.

export type ServerAddonActionRow = AddonActionEntry

export interface AddonActionPlan {
    lifts: Array<{ urlKey: string; value: number; transportUrl: string }>
    acks: AddonDeleteAck[]
}

export const ACK_BATCH_SIZE = 100
export const QUERY_BATCH_SIZE = 200
export const MAX_URL_KEY_LENGTH = 2048

export class InstallAbortedError extends Error {
    constructor(cause: unknown) {
        super(`Install aborted: ${cause instanceof Error ? cause.message : String(cause)}`)
        this.name = 'InstallAbortedError'
    }
}

// Only the sweep's guarded install checks ownership and tombstone movement mid-flight;
// a normal UI install runs without these checks, exactly like beta.
export function makeInstallGuard(options: { guard?: () => void } | undefined, ownership: { assert: () => void }): () => void {
    const guard = options?.guard
    if (!guard) return () => {}
    return () => {
        ownership.assert()
        try {
            guard()
        } catch (err) {
            throw new InstallAbortedError(err)
        }
    }
}

// A lift never replaces a newer config: when the hub already holds the same instance
// (for example an AIOStreams uuid) under a different URL, the lift must not adopt its URL.
export function liftBlockedByInstance(hubAddons: Array<Pick<AddonDescriptor, 'transportUrl' | 'manifest'>>, incoming: Pick<AddonDescriptor, 'transportUrl' | 'manifest'>): boolean {
    const incomingKey = getAddonInstanceKey(incoming)
    const incomingUrl = normalizeAddonUrl(incoming.transportUrl)
    return hubAddons.some(a => normalizeAddonUrl(a.transportUrl) !== incomingUrl && getAddonInstanceKey(a) === incomingKey)
}

export interface PreSyncSweepDeps {
    // Non-blocking try-acquire: returns null when the account is busy with another sync.
    tryAcquire: () => (() => void) | null
    sweep: () => Promise<void>
}

// Per-account entry of Sync All: busy accounts are skipped without waiting, and the sweep
// runs before any connection or eligibility skip so local-only accounts lift too. The
// sweep's installs take the mutex themselves, so afterwards the account is retaken
// non-blockingly: null means it went busy during the sweep and the sync must skip it.
export async function preSyncSweep(deps: PreSyncSweepDeps): Promise<(() => void) | null> {
    const probe = deps.tryAcquire()
    if (!probe) return null
    probe()
    await deps.sweep().catch(() => {})
    return deps.tryAcquire()
}

// A sweep install never queues behind a busy account: it takes the mutex non-blockingly and
// aborts, so the next sweep retries the lift.
export async function acquireInstallMutex(accountId: string, options: { skipIfBusy?: boolean } | undefined): Promise<() => void> {
    if (!options?.skipIfBusy) return acquireSyncMutex(accountId)
    const release = tryAcquireSyncMutex(accountId)
    if (!release) throw new InstallAbortedError(new Error('account busy'))
    return release
}

// The tombstone value is a deletion identity, never a time: lift only on the same identity
// with a newer install (by sequence, not clock), and re-acknowledge anything else.
export function planAddonActionSync(tombstones: Tombstones | undefined, actions: ServerAddonActionRow[]): AddonActionPlan {
    const lifts: AddonActionPlan['lifts'] = []
    const acks: AddonDeleteAck[] = []
    if (!tombstones) return { lifts, acks }
    const rows = new Map<string, ServerAddonActionRow>()
    for (const row of actions || []) {
        if (row?.urlKey) rows.set(row.urlKey, row)
    }
    for (const [urlKey, value] of Object.entries(tombstones)) {
        const row = rows.get(urlKey)
        const token = String(value)
        if (row && row.deleteToken === token) {
            if (row.transportUrl && row.installSeq > row.deleteSeq) {
                lifts.push({ urlKey, value, transportUrl: row.transportUrl })
            }
            continue
        }
        acks.push({ url: urlKey, token })
    }
    return { lifts, acks }
}

export interface AddonActionReconcileDeps {
    getTombstones: (accountId: string) => Tombstones | undefined
    // One key-filtered server read per call; the reconcile caps each call at QUERY_BATCH_SIZE keys.
    fetchActions: (accountId: string, urlKeys: string[]) => Promise<ServerAddonActionRow[]>
    sendAcks: (accountId: string, acks: AddonDeleteAck[]) => Promise<void>
    install: (accountId: string, transportUrl: string, guard: () => void) => Promise<void>
    ownership: () => boolean
}

export async function reconcileAddonActionsWith(accountId: string, deps: AddonActionReconcileDeps): Promise<void> {
    const tombstones = deps.getTombstones(accountId)
    if (!tombstones || Object.keys(tombstones).length === 0) return
    // Over-long keys can never be served by the server; skip instead of failing the batch.
    const urlKeys = Object.keys(tombstones).filter(key => key.length > 0 && key.length <= MAX_URL_KEY_LENGTH)
    let actions: ServerAddonActionRow[]
    try {
        actions = []
        for (let i = 0; i < urlKeys.length; i += QUERY_BATCH_SIZE) {
            actions.push(...await deps.fetchActions(accountId, urlKeys.slice(i, i + QUERY_BATCH_SIZE)))
        }
    } catch {
        return
    }
    if (!deps.ownership()) return
    const plan = planAddonActionSync(Object.fromEntries(urlKeys.map(key => [key, tombstones[key]])), actions)
    for (let i = 0; i < plan.acks.length; i += ACK_BATCH_SIZE) {
        if (!deps.ownership()) return
        await deps.sendAcks(accountId, plan.acks.slice(i, i + ACK_BATCH_SIZE)).catch(() => {})
    }
    for (const lift of plan.lifts) {
        if (!deps.ownership()) return
        const guard = () => {
            if (deps.getTombstones(accountId)?.[lift.urlKey] !== lift.value) throw new Error('tombstone moved')
            if (!deps.ownership()) throw new Error('ownership lost')
        }
        await deps.install(accountId, lift.transportUrl, guard).catch(() => {})
    }
}

export interface AddonDeleteDispatch {
    captureContext: () => Promise<AddonActionContext | null>
    send: (accountId: string, deletes: AddonDeleteAck[], ctx: AddonActionContext) => Promise<void>
}

// The exact tombstone values and the ownership context are captured synchronously at
// delete time by the caller; nothing here reads the live account store.
export function addonDeleteAcks(tombstones: Tombstones | undefined, urls: Array<string | undefined>): AddonDeleteAck[] {
    const acks: AddonDeleteAck[] = []
    for (const url of urls) {
        const key = normUrl(url)
        const value = tombstones?.[key]
        if (key && key.length <= MAX_URL_KEY_LENGTH && value !== undefined) acks.push({ url: key, token: String(value) })
    }
    return acks
}

export async function deliverAddonDeleteAcks(accountId: string, deletes: AddonDeleteAck[], ownership: { current: () => boolean }, dispatch: AddonDeleteDispatch): Promise<void> {
    const ctx = await dispatch.captureContext()
    if (!ctx) return
    if (!ownership.current()) return
    for (let i = 0; i < deletes.length; i += ACK_BATCH_SIZE) {
        if (!ownership.current()) return
        await dispatch.send(accountId, deletes.slice(i, i + ACK_BATCH_SIZE), ctx).catch(() => { return })
    }
}

const liveAddonDeleteDispatch: AddonDeleteDispatch = {
    captureContext: async () => (await import('../../api/addon-actions')).captureAddonActionContext(),
    send: async (accountId, deletes, ctx) => (await import('../../api/addon-actions')).postAddonActionDeletes(accountId, deletes, ctx),
}

// Fire and forget: the per-sync sweep is the retry.
export function queueAddonActionDeletes(accountId: string, deletes: AddonDeleteAck[], ownership: { current: () => boolean }, dispatch: AddonDeleteDispatch = liveAddonDeleteDispatch): void {
    if (!Array.isArray(deletes) || deletes.length === 0) return
    void deliverAddonDeleteAcks(accountId, deletes, ownership, dispatch).catch(() => {})
}

// Runs before the account sync mutex: each lift installs through the regular path, which takes that mutex itself.
export async function reconcileServerAddonActions(accountId: string): Promise<void> {
    const { captureSyncOwnership } = await import('../sync-store-helpers')
    const ownership = captureSyncOwnership()
    const { captureAddonActionContext, queryAddonActions, postAddonActionDeletes } = await import('../../api/addon-actions')
    const ctx = await captureAddonActionContext()
    if (!ctx) return
    const { useAccountStore, getAccountById } = await import('../accountStore')
    const { installAddonToAccount } = await import('./accountAddonOps')
    await reconcileAddonActionsWith(accountId, {
        getTombstones: id => getAccountById(useAccountStore.getState().accounts, id)?.deletedAddons,
        fetchActions: (id, urlKeys) => queryAddonActions(id, urlKeys, ctx),
        sendAcks: (id, acks) => postAddonActionDeletes(id, acks, ctx),
        install: (id, transportUrl, guard) => installAddonToAccount(id, transportUrl, undefined, { guard, skipIfBusy: true }),
        ownership: () => ownership.current(),
    })
}
