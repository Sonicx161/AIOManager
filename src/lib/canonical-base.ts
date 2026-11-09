import type { AddonDescriptor } from '@/types/addon'

/**
 * Per-account "merge base" for the inbound canonical reconcile (the common ancestor a
 * three-way merge needs; see canonical-merge.ts). The base is "the canonical the server
 * last CONFIRMED it received from this client", committed only on a successful push, so
 * a failed push never advances it (which would silently resurrect a just-deleted addon).
 *
 * Device-local on purpose: it's this device's view of the last reconciled canonical, not
 * shared state. Kept out of the synced blob to avoid cross-device clobber.
 */

const KEY = 'aio-canonical-base'
type BaseMap = Record<string, AddonDescriptor[]>

function load(): BaseMap {
    try {
        const raw = localStorage.getItem(KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' ? (parsed as BaseMap) : {}
    } catch {
        return {}
    }
}

/** The recorded base for an account, or null if none has been committed yet. */
export function getCanonicalBase(accountId: string): AddonDescriptor[] | null {
    const map = load()
    return Object.prototype.hasOwnProperty.call(map, accountId) ? map[accountId] : null
}

/**
 * Commit base snapshots. Writes localStorage only when something actually changed
 * (zero-I/O ethos: no write per sync cycle when nothing moved).
 */
export function setCanonicalBases(entries: BaseMap): void {
    const map = load()
    let changed = false
    for (const [id, addons] of Object.entries(entries)) {
        if (JSON.stringify(map[id]) !== JSON.stringify(addons)) {
            map[id] = addons
            changed = true
        }
    }
    if (changed) {
        try { localStorage.setItem(KEY, JSON.stringify(map)) } catch {}
    }
}

/** Drop all bases (logout; the next login re-establishes them on first push). */
export function clearCanonicalBases(): void {
    try { localStorage.removeItem(KEY) } catch {}
}

/**
 * Restrict a push's canonical payload to the entries the server confirmed it
 * holds ('applied' writes and 'unchanged' no-ops). A 'rejected' hub (shrink
 * guard, other workspace) must keep its old base: the server never stored that
 * snapshot, and a wrong base makes the next three-way merge treat stored
 * content as remote adds/removals. A receipt-less response is an older server
 * that cannot report per-hub outcomes; keep confirming everything so bases on
 * older self-hosted servers do not stall.
 */
export function confirmedCanonicalEntries(entries: BaseMap, receipts: unknown): BaseMap {
    if (!receipts || typeof receipts !== 'object') return entries
    const confirmed: BaseMap = {}
    for (const [id, addons] of Object.entries(entries)) {
        const status = (receipts as Record<string, unknown>)[id]
        if (status === 'applied' || status === 'unchanged') confirmed[id] = addons
    }
    return confirmed
}

/** Hubs the server reported 'rejected' for this push (empty without receipts). */
export function rejectedCanonicalEntries(entries: BaseMap, receipts: unknown): string[] {
    if (!receipts || typeof receipts !== 'object') return []
    return Object.keys(entries).filter(id => (receipts as Record<string, unknown>)[id] === 'rejected')
}
