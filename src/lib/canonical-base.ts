import type { AddonDescriptor } from '@/types/addon'

/**
 * Per-account "merge base" for the inbound canonical reconcile (the common ancestor a
 * three-way merge needs; see canonical-merge.ts). The base is "the canonical the server
 * last CONFIRMED it received from this client", committed only on a successful push, so
 * a failed push never advances it (which would silently resurrect a just-deleted addon).
 *
 * Device-local on purpose: it's this device's view of the last reconciled canonical, not
 * shared state. Kept out of the synced blob to avoid cross-device clobber.
 *
 * Entries carry the server-side hash of the stored list when the server reported one;
 * an unchanged hash on a later read lets the reconcile skip that hub's merge entirely.
 * Bare-array entries from older locals stay readable (no hash, full merge path).
 */

const KEY = 'aio-canonical-base'

export interface CanonicalBaseEntry {
    addons: AddonDescriptor[]
    /** sha256 of the hub's stored canonical plaintext as the server reported it. */
    hash?: string
}

type BaseMap = Record<string, CanonicalBaseEntry | AddonDescriptor[]>

const isEntryShape = (value: unknown): value is CanonicalBaseEntry =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as CanonicalBaseEntry).addons)

const normalize = (value: CanonicalBaseEntry | AddonDescriptor[]): CanonicalBaseEntry =>
    Array.isArray(value) ? { addons: value } : value

function load(): Record<string, CanonicalBaseEntry> {
    try {
        const raw = localStorage.getItem(KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object') return {}
        const out: Record<string, CanonicalBaseEntry> = {}
        for (const [id, value] of Object.entries(parsed as BaseMap)) {
            if (Array.isArray(value) || isEntryShape(value)) out[id] = normalize(value as CanonicalBaseEntry | AddonDescriptor[])
        }
        return out
    } catch {
        return {}
    }
}

/** The recorded base for an account, or null if none has been committed yet. */
export function getCanonicalBase(accountId: string): AddonDescriptor[] | null {
    const map = load()
    return Object.prototype.hasOwnProperty.call(map, accountId) ? map[accountId].addons : null
}

/** The recorded base entry (addons plus the server-reported hash) or null. */
export function getCanonicalBaseEntry(accountId: string): CanonicalBaseEntry | null {
    const map = load()
    return Object.prototype.hasOwnProperty.call(map, accountId) ? map[accountId] : null
}

/**
 * Commit base snapshots. Writes localStorage only when something actually changed
 * (zero-I/O ethos: no write per sync cycle when nothing moved).
 */
export function setCanonicalBases(entries: Record<string, CanonicalBaseEntry>): void {
    const map = load()
    let changed = false
    for (const [id, entry] of Object.entries(entries)) {
        if (JSON.stringify(map[id]) !== JSON.stringify(entry)) {
            map[id] = entry
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
export function confirmedCanonicalEntries(entries: Record<string, CanonicalBaseEntry>, receipts: unknown): Record<string, CanonicalBaseEntry> {
    if (!receipts || typeof receipts !== 'object') return entries
    const confirmed: Record<string, CanonicalBaseEntry> = {}
    for (const [id, entry] of Object.entries(entries)) {
        const status = (receipts as Record<string, unknown>)[id]
        if (status === 'applied' || status === 'unchanged') confirmed[id] = entry
    }
    return confirmed
}

/** Hubs the server reported 'rejected' for this push (empty without receipts). */
export function rejectedCanonicalEntries(entries: Record<string, CanonicalBaseEntry>, receipts: unknown): string[] {
    if (!receipts || typeof receipts !== 'object') return []
    return Object.keys(entries).filter(id => (receipts as Record<string, unknown>)[id] === 'rejected')
}
