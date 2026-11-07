// Connection pictures: shared types for per-connection profile picture rows.
//
// Scope change 2026-11-05: rows exist for the Jellyfin family only (native
// Jellyfin users plus the AIOStreams and AIOMetadata Jellyfin logins). Stremio,
// Nuvio and RealStream are out of scope; their row prefixes are dropped by the
// sync migration (sync-merge.ts).
//
// Leaf module (no runtime imports beyond types) so it stays importable under
// the node:test runner and outside the React tree.

export type PicturePlatform = 'jellyfin' | 'aiostreams' | 'aiometadata'

/** A picture the user picked for a row (or the account default, reused here). */
export type PictureSpec =
    | { kind: 'url'; url: string }
    | { kind: 'dataUrl'; dataUrl: string }
    | { kind: 'none' }

/** What the platform currently shows for one row, plus its thumbnail. */
export interface PictureRowCurrent {
    /**
     * Comparison marker: the exact value the platform reports (Jellyfin image
     * tag, facade avatar URL). Null or '' means no picture. Never image bytes.
     */
    marker: string | null
    thumbUrl: string | null
}

/** Persisted per-row state on the Account (synced with the account blob). */
export interface PictureRowState {
    /** Follows the account picture as the default. Rows flip to false when a change made elsewhere is detected. */
    followsDefault: boolean
    /** The marker value AIOManager last wrote for this row; null until the first write. */
    lastWritten: string | null
    lastWrittenAt?: number
    /** Monotonic per-row counter bumped on every persisted state change; confirms compare it to detect races. */
    revision?: number
    /** Can't change (e.g. Jellyfin 403). Locked rows are never written. */
    locked?: boolean
    lockedReason?: string
}

/** Static description of one picture target row. */
export interface PictureRow {
    id: string
    platform: PicturePlatform
    label: string
    /** Account, profile or user name; masked by the caller per privacy mode. */
    sub: string
    /** Only a pasted public image link can be written (AIOS/AIOM logins). */
    linkOnly: boolean
    /**
     * Capability gate (not persisted): the row cannot be written until this is
     * cleared (switch off, locked vault, missing instance access key or addon password).
     */
    readOnlyReason?: string
}

export type PictureRowMode = 'synced' | 'pending' | 'own' | 'locked'

export interface PictureRowStatus {
    mode: PictureRowMode
    current: PictureRowCurrent
    /** The row flipped from followsDefault to own during this read (persist by caller). */
    flippedToOwn: boolean
}

export type SyncSkipReason = 'locked' | 'own-picture' | 'already-synced' | 'needs-public-link' | 'no-account-picture' | 'invalid-picture'

export interface PlannedRowWrite {
    row: PictureRow
    spec: PictureSpec
    previous: PictureRowCurrent
}

export interface PlannedRowSkip {
    row: PictureRow
    reason: SyncSkipReason
}

export interface SyncPlan {
    writes: PlannedRowWrite[]
    skips: PlannedRowSkip[]
}

/**
 * Snapshot kept per written row so Undo can restore the previous picture.
 * Restore payloads are platform shaped and never contain tokens.
 */
export type UndoRestore =
    | { platform: 'jellyfin'; previousBase64: string | null; previousMime: string | null }
    | { platform: 'aiostreams'; previousUrl: string | null }
    | { platform: 'aiometadata'; previousUrl: string | null }

export interface PlannedUndo {
    rowId: string
    row: PictureRow
    restore: UndoRestore
    /** True when the write was a per-row override (not the account default). */
    wasOverride?: boolean
    /** True when the write was the explicit "Use account picture" opt back in. */
    refollowsDefault?: boolean
    /** The row's followsDefault before the write ran (restored after undo). */
    followsDefaultBefore?: boolean
}

export const CANT_CHANGE_COPY = "Your Jellyfin user can't change its picture. Ask the server admin or reconnect with an admin key."
