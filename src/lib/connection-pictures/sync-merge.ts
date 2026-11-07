// Connection pictures sync merge and migration (review CP-002, CP-R2-004, CP-R3-002,
// scope change 2026-11-05).
//
// connectionPictures is part of the account blob, so it must survive backup
// export/import, the cloud sync envelope, and pulls from a second device.
// Imported state is untrusted: rows, markers and reasons are bounded here so a
// crafted blob cannot expand the synced state without limit, and markers are
// stored as bounded digests so image data never rides the blob. Schema 3 drops
// rows for the out-of-scope platforms (Stremio, Nuvio, RealStream) so old
// blobs migrate cleanly to the Jellyfin-family row set.
// Pure leaf module: relative imports only, importable under node:test.

import type { PictureRowState } from './types.ts'
import { syncedMarkerFor, CONNECTION_PICTURES_SYNCED_MARKER_MAX_LENGTH } from './synced-marker.ts'

export const CONNECTION_PICTURES_SCHEMA_VERSION = 3
/** Hard caps for the synced picture state (CP-R2-004). */
export const CONNECTION_PICTURES_MAX_ROWS = 256
export const CONNECTION_PICTURES_ROW_ID_MAX_LENGTH = 128
/**
 * CP-R3-002: markers at or under this length travel verbatim, anything longer
 * is stored as a SHA-256 digest, so image data never rides the sync blob.
 */
export const CONNECTION_PICTURES_MARKER_MAX_LENGTH = CONNECTION_PICTURES_SYNCED_MARKER_MAX_LENGTH
export const CONNECTION_PICTURES_LOCK_REASON_MAX_LENGTH = 200

/** Row-id prefixes of platforms removed from the feature (schema 3). */
const REMOVED_PLATFORM_ROW_PREFIXES = ['stremio:', 'realstream:', 'nuvio:']

function sanitizeRow(value: unknown): PictureRowState | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value as Record<string, unknown>
    const followsDefault = typeof raw.followsDefault === 'boolean' ? raw.followsDefault : undefined
    if (followsDefault === undefined) return null
    const row: PictureRowState = { followsDefault, lastWritten: null }
    if (typeof raw.lastWritten === 'string') row.lastWritten = syncedMarkerFor(raw.lastWritten)
    if (typeof raw.lastWrittenAt === 'number' && Number.isFinite(raw.lastWrittenAt)) row.lastWrittenAt = raw.lastWrittenAt
    if (typeof raw.revision === 'number' && Number.isFinite(raw.revision)) row.revision = raw.revision
    if (raw.locked === true) {
        row.locked = true
        if (typeof raw.lockedReason === 'string') row.lockedReason = raw.lockedReason.slice(0, CONNECTION_PICTURES_LOCK_REASON_MAX_LENGTH)
    }
    return row
}

/**
 * Versioned migration for stored and imported blobs: an absent field stays
 * absent (rows then default to followsDefault), malformed rows are dropped,
 * valid rows keep their exact shape, absurd row ids are dropped, rows for the
 * removed platforms (scope change 2026-11-05, schema 3) are dropped, and the
 * row count is capped (newest first, then by row id so the choice is the same
 * on every device). Bump CONNECTION_PICTURES_SCHEMA_VERSION and extend here
 * when the row shape changes again.
 */
export function migrateConnectionPictures(raw: unknown): Record<string, PictureRowState> | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const out: Record<string, PictureRowState> = {}
    let kept = false
    for (const [rowId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (rowId.length > CONNECTION_PICTURES_ROW_ID_MAX_LENGTH) continue
        if (REMOVED_PLATFORM_ROW_PREFIXES.some(prefix => rowId.startsWith(prefix))) continue
        const row = sanitizeRow(value)
        if (row) {
            out[rowId] = row
            kept = true
        }
    }
    if (!kept) return undefined
    const ids = Object.keys(out)
    if (ids.length <= CONNECTION_PICTURES_MAX_ROWS) return out
    ids.sort((a, b) => {
        const at = out[a].lastWrittenAt ?? 0
        const bt = out[b].lastWrittenAt ?? 0
        if (bt !== at) return bt - at
        return a < b ? -1 : a > b ? 1 : 0
    })
    for (const id of ids.slice(CONNECTION_PICTURES_MAX_ROWS)) delete out[id]
    return out
}

/**
 * CP-R3-002: the LIVE mutation path. Applies one row write (or delete) and
 * returns the next map with every migration bound re-applied, so a full avatar
 * data URI handed to the store collapses to a digest and can never ride the
 * synced account blob. Returns undefined when no valid row remains.
 */
export function applyConnectionPictureState(
    current: Record<string, PictureRowState> | undefined,
    rowId: string,
    state: PictureRowState | null,
): Record<string, PictureRowState> | undefined {
    const next = { ...(current ?? {}) }
    if (state === null) delete next[rowId]
    else next[rowId] = { ...state, revision: (current?.[rowId]?.revision ?? 0) + 1 }
    return migrateConnectionPictures(next)
}

function pickNewerRow(local: PictureRowState, incoming: PictureRowState): PictureRowState {
    const localAt = local.lastWrittenAt ?? 0
    const incomingAt = incoming.lastWrittenAt ?? 0
    if (incomingAt > localAt) return incoming
    if (localAt > incomingAt) return local
    // Same write time (an own-picture flip keeps the original timestamp): the
    // explicit Own-picture transition is sticky and must never be lost.
    if (incoming.followsDefault === false) return incoming
    if (local.followsDefault === false) return local
    // Tie falls back to revision: the device that edited the row more wins.
    const localRevision = local.revision ?? 0
    const incomingRevision = incoming.revision ?? 0
    if (incomingRevision !== localRevision) return incomingRevision > localRevision ? incoming : local
    // Full tie: the lexicographically larger marker wins, a rule both devices
    // evaluate identically so the merge cannot diverge.
    return String(incoming.lastWritten ?? '') > String(local.lastWritten ?? '') ? incoming : local
}

/**
 * Per-row merge across devices: merge by row id, newest write wins, an
 * explicit Own-picture transition survives a tie, and remaining ties fall back
 * to revision then a deterministic marker comparison. Rows present on one side
 * only are kept as-is; explicit null entries count as absent.
 */
export function mergeConnectionPictures(
    local: Record<string, PictureRowState> | undefined,
    incoming: Record<string, PictureRowState> | undefined,
): Record<string, PictureRowState> | undefined {
    if (local === undefined && incoming === undefined) return undefined
    if (local === undefined) return incoming ? { ...incoming } : undefined
    if (incoming === undefined) return { ...local }
    const merged: Record<string, PictureRowState> = {}
    const ids = new Set([...Object.keys(local), ...Object.keys(incoming)])
    for (const id of ids) {
        const l = local[id] ?? null
        const r = incoming[id] ?? null
        if (l && r) merged[id] = pickNewerRow(l, r)
        else if (l) merged[id] = l
        else if (r) merged[id] = r
    }
    return merged
}

export interface StaleRowScope {
    connectionIds: Set<string>
    aiostreamsInstances: Set<string>
    aiometadataInstances: Set<string>
}

/**
 * CP-R2-004: row ids whose connection or facade instance no longer exists on
 * the account, so their synced state can be dropped instead of riding every
 * backup and sync blob forever. Unknown prefixes are kept.
 */
export function staleConnectionPictureRowIds(
    stored: Record<string, PictureRowState> | undefined,
    scope: StaleRowScope,
): string[] {
    if (!stored) return []
    const stale: string[] = []
    for (const rowId of Object.keys(stored)) {
        if (rowId.startsWith('jellyfin:')) {
            if (!scope.connectionIds.has(rowId.slice('jellyfin:'.length))) stale.push(rowId)
            continue
        }
        if (rowId.startsWith('aiostreams:')) {
            if (!scope.aiostreamsInstances.has(rowId.slice('aiostreams:'.length))) stale.push(rowId)
            continue
        }
        if (rowId.startsWith('aiometadata:')) {
            if (!scope.aiometadataInstances.has(rowId.slice('aiometadata:'.length))) stale.push(rowId)
        }
    }
    return stale
}
