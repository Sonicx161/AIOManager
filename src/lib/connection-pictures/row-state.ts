// Connection pictures: pure row-state and sync-planning logic (owner spec
// 2026-11-05 option C plus the keep-pictures-set-elsewhere amendment).
//
// Pure leaf module: no fetch, no stores, no React. Everything is derived from
// the platform marker values so sync decisions never depend on image bytes.

import type {
    PictureRow,
    PictureRowCurrent,
    PictureRowState,
    PictureRowStatus,
    PictureSpec,
    SyncPlan,
    PlannedRowWrite,
    PlannedRowSkip,
} from './types.ts'
import { isValidAvatarHttpsUrl, sanitizeAvatarDataUri } from './avatar-value.ts'
import { markerMatchesSynced } from './synced-marker.ts'

/** True when the marker means "the platform has no picture". */
export function markerIsEmpty(marker: string | null | undefined): boolean {
    return marker === null || marker === undefined || marker === ''
}

/** The marker the account default would produce on a platform, when bytelessly comparable. */
export function accountMarkerFor(platform: PictureRow['platform'], spec: PictureSpec): string | null {
    if (spec.kind === 'none') return ''
    if (platform === 'aiostreams' || platform === 'aiometadata') {
        return spec.kind === 'url' ? spec.url : null
    }
    // Jellyfin stores bytes: equality is only ever judged against the marker
    // AIOManager itself wrote (the image tag).
    return null
}

/** True when the uploaded spec cannot be delivered to a link-only platform. */
export function specNeedsPublicLink(spec: PictureSpec): boolean {
    return spec.kind === 'dataUrl'
}

/**
 * True when the spec value is storable on a platform that keeps the URL or
 * data URI verbatim (the facades). Byte platforms (Jellyfin) fetch the URL
 * through the guarded proxy, so no scheme rule applies there.
 */
export function specStorableOnPlatform(platform: PictureRow['platform'], spec: PictureSpec): boolean {
    if (platform === 'jellyfin') return true
    if (spec.kind === 'url') return isValidAvatarHttpsUrl(spec.url)
    if (spec.kind === 'dataUrl') return sanitizeAvatarDataUri(spec.dataUrl) !== null
    return true
}

/**
 * Derive one row's status from the freshly read platform marker and the
 * stored state (amendment): a platform picture AIOManager did not write, or
 * one that changed since our last write, is that row's OWN picture.
 */
export function deriveRowStatus(args: {
    row: PictureRow
    stored: PictureRowState | undefined
    current: PictureRowCurrent
    accountSpec: PictureSpec
}): PictureRowStatus {
    const { row, stored, current } = args
    const marker = current.marker ?? null
    if (stored?.locked) return { mode: 'locked', current, flippedToOwn: false }
    const written = stored?.lastWritten ?? null
    const followsDefault = stored?.followsDefault ?? true

    if (markerIsEmpty(marker)) {
        const accountMarker = accountMarkerFor(row.platform, args.accountSpec)
        if (args.accountSpec.kind === 'none' || accountMarker === '') {
            return { mode: 'synced', current, flippedToOwn: false }
        }
        return { mode: 'pending', current, flippedToOwn: false }
    }

    // CP-R3-002: the stored marker may be the digest of a large live value
    // (data URIs never ride the synced blob), so compare through the digest.
    if (written !== null && markerMatchesSynced(marker, written)) {
        return { mode: followsDefault ? 'synced' : 'own', current, flippedToOwn: false }
    }

    const accountMarker = accountMarkerFor(row.platform, args.accountSpec)
    if (accountMarker !== null && marker === accountMarker) {
        return { mode: 'synced', current, flippedToOwn: false }
    }

    // Own picture: set in the platform's own app, never written by AIOManager,
    // or changed elsewhere after our last write. Never overwritten by Sync.
    return { mode: 'own', current, flippedToOwn: written !== null && followsDefault }
}

/**
 * Decide exactly which rows the user's Sync action writes. Only rows that
 * follow the default (and can receive the account picture) plus rows handed a
 * new picture here are written; own and locked rows are listed as skips.
 */
export function planSync(args: {
    rows: Array<{ row: PictureRow; status: PictureRowStatus; stored: PictureRowState | undefined }>
    accountSpec: PictureSpec
    overrides: Record<string, PictureSpec>
}): SyncPlan {
    const writes: PlannedRowWrite[] = []
    const skips: PlannedRowSkip[] = []
    const hasAccountPicture = args.accountSpec.kind !== 'none'
    for (const entry of args.rows) {
        const { row, status } = entry
        const override = args.overrides[row.id]
        if (row.readOnlyReason) {
            skips.push({ row, reason: 'locked' })
            continue
        }
        if (override) {
            if (row.linkOnly && specNeedsPublicLink(override)) {
                skips.push({ row, reason: 'needs-public-link' })
                continue
            }
            if (!specStorableOnPlatform(row.platform, override)) {
                skips.push({ row, reason: 'invalid-picture' })
                continue
            }
            if (sameTargetMarker(row, override, status.current)) {
                skips.push({ row, reason: 'already-synced' })
                continue
            }
            writes.push({ row, spec: override, previous: status.current })
            continue
        }
        if (!hasAccountPicture) {
            skips.push({ row, reason: 'no-account-picture' })
            continue
        }
        if (!specStorableOnPlatform(row.platform, args.accountSpec)) {
            skips.push({ row, reason: 'invalid-picture' })
            continue
        }
        if (row.linkOnly && specNeedsPublicLink(args.accountSpec)) {
            skips.push({ row, reason: 'needs-public-link' })
            continue
        }
        if (status.mode === 'locked') {
            skips.push({ row, reason: 'locked' })
            continue
        }
        if (status.mode === 'own') {
            skips.push({ row, reason: 'own-picture' })
            continue
        }
        if (status.mode === 'synced') {
            skips.push({ row, reason: 'already-synced' })
            continue
        }
        const accountMarker = accountMarkerFor(row.platform, args.accountSpec)
        if (accountMarker !== null && accountMarker === (status.current.marker ?? null)) {
            skips.push({ row, reason: 'already-synced' })
            continue
        }
        writes.push({ row, spec: args.accountSpec, previous: status.current })
    }
    return { writes, skips }
}

function sameTargetMarker(row: PictureRow, spec: PictureSpec, current: PictureRowCurrent): boolean {
    const marker = accountMarkerFor(row.platform, spec)
    return marker !== null && marker === (current.marker ?? null)
}

/** True when "Use account picture" cannot deliver the account spec to this row. */
export function accountDefaultBlocked(row: PictureRow, accountSpec: PictureSpec): boolean {
    return row.linkOnly && specNeedsPublicLink(accountSpec)
}

export type AccountDefaultPlan =
    | { action: 'persist-refollow'; marker: string }
    | { action: 'queue-write'; spec: PictureSpec }
    | { action: 'none' }

/**
 * CP-006 decision for "Use account picture": a row whose platform already
 * shows the account marker just re-follows (no write); any other row,
 * including one AIOManager never wrote or one whose stored state still
 * follows the default, queues the account picture as its pending write so
 * the confirm flow delivers it and the re-follow lands on success.
 */
export function accountDefaultPlan(args: {
    row: PictureRow
    accountSpec: PictureSpec
    currentMarker: string | null | undefined
}): AccountDefaultPlan {
    if (args.accountSpec.kind === 'none') return { action: 'none' }
    if (accountDefaultBlocked(args.row, args.accountSpec)) return { action: 'none' }
    const marker = accountMarkerFor(args.row.platform, args.accountSpec)
    if (marker !== null && marker !== '' && (args.currentMarker ?? null) === marker) {
        return { action: 'persist-refollow', marker }
    }
    return { action: 'queue-write', spec: args.accountSpec }
}

/** Human skip label for the confirm sheet footer (no em dashes). */
export function skipLabel(reason: PlannedRowSkip['reason']): string {
    switch (reason) {
        case 'locked': return "Can't change"
        case 'own-picture': return 'Own picture kept'
        case 'already-synced': return 'Already synced'
        case 'needs-public-link': return 'Needs a public image link'
        case 'no-account-picture': return 'No account picture'
        case 'invalid-picture': return 'Picture not supported'
    }
}

/**
 * The followsDefault a row gets after a successful write: an explicit
 * "Use account picture" re-follow returns to the default, any other override
 * leaves the default, and default-following rows keep their classification.
 */
export function followsDefaultAfterWrite(args: { refollowsDefault: boolean; wasOverride: boolean; stored: PictureRowState | undefined }): boolean {
    if (args.refollowsDefault) return true
    if (args.wasOverride) return false
    return args.stored?.followsDefault ?? true
}

/**
 * Compare-and-set for the confirm sheet (CP-004): every row's freshly read
 * platform marker and persisted row revision must still equal the values the
 * user saw when confirming. Any mismatch (or an unreadable row) invalidates
 * the confirm so a stale list can never write over a newer picture.
 */
export function staleConfirmRowIds(
    confirmed: Array<{ rowId: string; marker: string | null; revision: number }>,
    freshMarkers: Record<string, string | null | undefined>,
    freshRevisions: Record<string, number | undefined>,
): string[] {
    const norm = (v: string | null | undefined) => (v == null || v === '' ? '' : v)
    const stale: string[] = []
    for (const entry of confirmed) {
        const marker = freshMarkers[entry.rowId]
        if (marker === undefined || norm(marker) !== norm(entry.marker)) {
            stale.push(entry.rowId)
            continue
        }
        if ((freshRevisions[entry.rowId] ?? 0) !== entry.revision) stale.push(entry.rowId)
    }
    return stale
}

export type WriteReadbackOutcome = 'verified' | 'not-persisted' | 'changed-elsewhere' | 'unreadable'

/**
 * CP-R2-003: classify the marker read back immediately after a write.
 * Value platforms (the facades) keep the exact value, so a readback that is
 * neither ours nor the pre-write value changed elsewhere. Byte platforms
 * (Jellyfin) mint a fresh tag per upload, so only presence or absence is
 * provable; `ours` is null there and `removed` marks a removal.
 */
export function classifyWriteReadback(args: {
    platform: PictureRow['platform']
    preWrite: string | null
    ours: string | null
    after: string | null | undefined
    removed?: boolean
}): WriteReadbackOutcome {
    const norm = (v: string | null | undefined) => (v == null || v === '' ? '' : v)
    if (args.after === undefined) return 'unreadable'
    const after = norm(args.after)
    if (args.ours === null) {
        if (args.removed) return after === '' ? 'verified' : 'not-persisted'
        return after !== '' ? 'verified' : 'not-persisted'
    }
    // An empty platform value after a value write is never a foreign picture;
    // the write simply did not land.
    if (after === '') return 'not-persisted'
    if (after === norm(args.ours)) return 'verified'
    if (after === norm(args.preWrite)) return 'not-persisted'
    return 'changed-elsewhere'
}

/**
 * CP-R2-002: does the fresh readback prove an undo restored the row? Value
 * platforms must show the exact previous marker; byte platforms mint a new
 * tag per upload, so presence (or absence for a clear) is the proof.
 */
export function restoreReadbackMatches(args: {
    platform: PictureRow['platform']
    expected: string | null
    fresh: string | null | undefined
}): boolean {
    const norm = (v: string | null | undefined) => (v == null || v === '' ? '' : v)
    if (args.fresh === undefined) return false
    if (args.platform === 'jellyfin') {
        return norm(args.expected) === '' ? norm(args.fresh) === '' : norm(args.fresh) !== ''
    }
    return norm(args.fresh) === norm(args.expected)
}
