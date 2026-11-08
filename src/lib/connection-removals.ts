// Synced removal markers for connections, modelled on the addon tombstones in
// addon-tombstones.ts (deletedAddons + restoredAddons): an explicit removal on one
// device must not be undone when a stale copy merges the record back. Two maps travel
// with the account blob:
//   deletedConnections  id -> removal version (clock ms, bumped monotonically)
//   restoredConnections id -> the removal version a re-add/restore explicitly overrode
// A connection is removed iff deletedConnections[id] > (restoredConnections[id] ?? 0).
// Survival must be explicit evidence: a record lingering on another device, or its
// lastSync stamp from that device's clock, is never proof the user wanted the login
// back, so lastSync plays no part in the decision.

import type { AccountListImport } from './account-membership.ts'

export type ConnectionRemovals = Record<string, number>
export type ConnectionRestores = Record<string, number>

// A device offline longer than the TTL can resurrect a removal, so keep it generous.
export const CONNECTION_REMOVAL_TTL_MS = 365 * 24 * 60 * 60 * 1000
// Count cap so the synced blob stays bounded however many removals accumulate.
export const CONNECTION_REMOVAL_MAX_ENTRIES = 200

// The stored/synced removal state (a structural slice of Account).
export interface ConnectionRemovalState {
    deletedConnections: ConnectionRemovals
    restoredConnections: ConnectionRestores
}

// Accepts an Account or an incoming normalized record, whose map fields are optional.
export type PartialConnectionRemovalState = Partial<ConnectionRemovalState>

// A fresh removal advances past any observed version even when this device's clock
// moved backwards, and past any acknowledgement it observes, so a removal after a
// re-add/restore always wins (same rule as addTombstones).
export function addConnectionRemovals(state: PartialConnectionRemovalState | undefined, ids: string[], now = Date.now()): ConnectionRemovalState {
    const deleted: ConnectionRemovals = { ...(state?.deletedConnections || {}) }
    const restored: ConnectionRestores = { ...(state?.restoredConnections || {}) }
    for (const id of ids) {
        if (!id) continue
        deleted[id] = Math.max(now, (deleted[id] ?? 0) + 1, (restored[id] ?? 0) + 1)
    }
    return { deletedConnections: deleted, restoredConnections: restored }
}

// A deliberate re-add or backup restore acknowledges the exact removal version it
// overrode: restored[id] = max(restored[id], deleted[id]), exactly like
// restoreAddonDeletions. A stale copy merely merging the record back is not evidence
// of intent and never writes an acknowledgement.
export function acknowledgeConnectionRestores(state: PartialConnectionRemovalState | undefined, ids: string[]): ConnectionRemovalState {
    const deleted: ConnectionRemovals = { ...(state?.deletedConnections || {}) }
    const restored: ConnectionRestores = { ...(state?.restoredConnections || {}) }
    for (const id of ids) {
        if (!id) continue
        const removal = deleted[id]
        if (removal === undefined) continue
        restored[id] = Math.max(restored[id] ?? 0, removal)
        delete deleted[id]
    }
    return { deletedConnections: deleted, restoredConnections: restored }
}

// Newest-wins union across devices for each map, then the same resolution as
// mergeAddonDeletionState: an acknowledgement at or past a removal drops it, so a
// restore on one device cannot be undone by a stale marker from another. The joint
// bounds (TTL + count cap) are applied at the end.
export function mergeConnectionRemovalState(
    local: PartialConnectionRemovalState | undefined,
    remote: PartialConnectionRemovalState | undefined,
    now = Date.now(),
): ConnectionRemovalState {
    const deleted = newestWins(local?.deletedConnections, remote?.deletedConnections)
    const restored = newestWins(local?.restoredConnections, remote?.restoredConnections)
    for (const id of Object.keys(deleted)) {
        if ((restored[id] ?? -1) >= deleted[id]) delete deleted[id]
    }
    return pruneConnectionRemovalState({ deletedConnections: deleted, restoredConnections: restored }, now)
}

function newestWins(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
    const out: Record<string, number> = {}
    for (const src of [a, b]) {
        for (const [id, at] of Object.entries(src || {})) {
            if (!(id in out) || at > out[id]) out[id] = at
        }
    }
    return out
}

// Prune both maps as ONE unit per connection id, ranked by the NEWER of the id's
// removal and acknowledgement (age cap + count cap): the pair is kept or evicted
// together, so an acknowledgement can never fall off while its removal survives
// (a restored connection would flip back to removed the next time a stale device
// merges the bare marker in), and a removal never outlives its acknowledgement
// half either. The TTL (and, past the count cap, rank eviction) is the ONLY
// resurrection bound: once an id's pair is gone a stale copy may merge the login
// back, but until then nothing except an explicit re-add/restore acknowledgement
// revives it. The resolution is re-applied defensively so an inconsistent stored
// pair cannot ride a pruned blob either.
export function pruneConnectionRemovalState(state: PartialConnectionRemovalState | undefined, now = Date.now()): ConnectionRemovalState {
    const deleted: ConnectionRemovals = { ...(state?.deletedConnections || {}) }
    const restored: ConnectionRestores = { ...(state?.restoredConnections || {}) }
    const rankOf = (id: string) => Math.max(deleted[id] ?? 0, restored[id] ?? 0)
    const keep = new Set(Array.from(new Set([...Object.keys(deleted), ...Object.keys(restored)]))
        .filter(id => now - rankOf(id) < CONNECTION_REMOVAL_TTL_MS)
        .sort((x, y) => rankOf(y) - rankOf(x))
        .slice(0, CONNECTION_REMOVAL_MAX_ENTRIES))
    for (const id of Object.keys(deleted)) {
        if (!keep.has(id)) delete deleted[id]
    }
    for (const id of Object.keys(restored)) {
        if (!keep.has(id)) delete restored[id]
    }
    for (const id of Object.keys(deleted)) {
        if ((restored[id] ?? -1) >= deleted[id]) delete deleted[id]
    }
    return { deletedConnections: deleted, restoredConnections: restored }
}

// The marker policy per import flow. A sync pull merges both devices' maps so an
// explicit removal survives a stale copy. A backup restore additionally acknowledges
// the markers of every connection the backup brings back, so another device's stale
// marker cannot undo the restore on the next sync. A merge-mode file import adopts
// NO markers from the file (local markers only): an old backup must never delete a
// connection that is live on this device.
export function importConnectionRemovalState(
    accountList: AccountListImport,
    local: PartialConnectionRemovalState | undefined,
    remote: PartialConnectionRemovalState | undefined,
    restoredIds: string[],
    now = Date.now(),
): ConnectionRemovalState {
    if (accountList === 'merge') return pruneConnectionRemovalState(local, now)
    const merged = mergeConnectionRemovalState(local, remote, now)
    return accountList === 'restore' ? acknowledgeConnectionRestores(merged, restoredIds) : merged
}

// Ids a backup restore brings back: its stored rows, plus the legacy synthesized
// `${accountId}:stremio` login when the backup carries only the flat key.
export function restoredConnectionIds(incomingIds: Iterable<string>, hasFlatKey: boolean, accountIds: string[]): string[] {
    const ids = new Set(incomingIds)
    if (hasFlatKey) for (const id of accountIds) if (id) ids.add(`${id}:stremio`)
    return [...ids]
}

// The removal rule: an unexpired removal version strictly newer than any
// acknowledgement. Mere presence of a record on any device (or its lastSync) is never
// survival evidence.
export function isRemovedConnection(id: string | undefined, state: PartialConnectionRemovalState | undefined, now = Date.now()): boolean {
    if (!id || !state) return false
    const removal = state.deletedConnections?.[id]
    if (removal === undefined || now - removal >= CONNECTION_REMOVAL_TTL_MS) return false
    return removal > (state.restoredConnections?.[id] ?? 0)
}

// Import sanitizers: both fields are additive, so junk entries drop individually
// instead of failing the whole sync.
export function readConnectionRemovals(value: unknown): ConnectionRemovals | undefined {
    return readRemovalMap(value)
}

export function readConnectionRestores(value: unknown): ConnectionRestores | undefined {
    return readRemovalMap(value)
}

function readRemovalMap(value: unknown): Record<string, number> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
        if (!id || typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) continue
        out[id] = at
    }
    return out
}
