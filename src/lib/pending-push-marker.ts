// Durable retry marker for a deferred push that never confirmed (Sol P1-SYNC-01). A
// phone can suspend the page after pagehide before the async push reaches the server,
// so the hidden-flush path records this marker: localStorage only, no secrets, just a
// timestamp per workspace. Markers and confirmed-push timestamps are workspace-scoped:
// one workspace's marker or confirmation never overwrites or suppresses another's. The
// next valid session retries one normal push and clears its own marker only after the
// server confirms it.

const MARKER_KEY_PREFIX = 'aio-pending-push-marker-v1:'
const CONFIRMED_KEY_PREFIX = 'aio-pending-push-confirmed-v1:'
const LEGACY_MARKER_KEY = 'aio-pending-push-v1'
const LEGACY_CONFIRMED_KEY = 'aio-pending-push-confirmed-at'

export interface PendingPushMarker {
    workspaceId: string
    markedAt: number
}

// Same rule as sanitizeWorkspaceId in workspace-persistence, kept local so this
// module stays dependency-free (localStorage only).
function workspaceSlot(id: string): string {
    return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'anon'
}

function markerKey(workspaceId: string): string {
    return MARKER_KEY_PREFIX + workspaceSlot(workspaceId)
}

function confirmedKey(workspaceId: string): string {
    return CONFIRMED_KEY_PREFIX + workspaceSlot(workspaceId)
}

function readNumberAt(key: string): number | null {
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = Number(raw)
        return Number.isFinite(parsed) ? parsed : null
    } catch {
        return null
    }
}

// A valid legacy marker moves into its own workspace slot exactly once; the legacy
// confirmed time was global and cannot be attributed to one workspace, so it is
// dropped (an extra safe retry) instead of suppressing another workspace's marker.
// A valid source is deleted only once its retry intent is durably preserved: if the
// destination write fails, the legacy key stays for a later attempt and its value is
// returned so this boot can still retry (Sol P2-SYNC-MIGRATION-01).
function migrateLegacyGlobalKeys(): PendingPushMarker | null {
    let retained: PendingPushMarker | null = null
    try {
        const raw = localStorage.getItem(LEGACY_MARKER_KEY)
        if (raw !== null) {
            let discard = true
            let valid: PendingPushMarker | null = null
            try {
                const parsed = JSON.parse(raw) as { workspaceId?: unknown; markedAt?: unknown }
                if (typeof parsed.workspaceId === 'string' && parsed.workspaceId
                    && typeof parsed.markedAt === 'number' && Number.isFinite(parsed.markedAt)) {
                    valid = { workspaceId: parsed.workspaceId, markedAt: parsed.markedAt }
                }
            } catch { /* corrupt legacy marker: discard it */ }
            if (valid) {
                const key = markerKey(valid.workspaceId)
                try {
                    if (localStorage.getItem(key) === null) localStorage.setItem(key, String(valid.markedAt))
                } catch {
                    // Storage rejected the destination write (quota, read-only mode):
                    // keep the source for a later attempt, expose its value this boot.
                    retained = valid
                    discard = false
                }
            }
            if (discard) { try { localStorage.removeItem(LEGACY_MARKER_KEY) } catch {} }
        }
        try { localStorage.removeItem(LEGACY_CONFIRMED_KEY) } catch {}
    } catch {}
    return retained
}

export function readPendingPushMarker(workspaceId: string): PendingPushMarker | null {
    const retained = migrateLegacyGlobalKeys()
    const markedAt = readNumberAt(markerKey(workspaceId))
    if (markedAt !== null) return { workspaceId, markedAt }
    return retained !== null && retained.workspaceId === workspaceId ? retained : null
}

export function writePendingPushMarker(workspaceId: string, now: number = Date.now()): void {
    migrateLegacyGlobalKeys()
    try { localStorage.setItem(markerKey(workspaceId), String(now)) } catch {}
}

export function clearPendingPushMarker(workspaceId: string): void {
    migrateLegacyGlobalKeys()
    try { localStorage.removeItem(markerKey(workspaceId)) } catch {}
    // A retained legacy source for this workspace must retire with its marker, or a
    // failed-write boot would resurrect it on the next migration attempt.
    try {
        const raw = localStorage.getItem(LEGACY_MARKER_KEY)
        if (raw === null) return
        const parsed = JSON.parse(raw) as { workspaceId?: unknown }
        if (parsed.workspaceId === workspaceId) localStorage.removeItem(LEGACY_MARKER_KEY)
    } catch {}
}

export function readLastConfirmedPushAt(workspaceId: string): number | null {
    migrateLegacyGlobalKeys()
    return readNumberAt(confirmedKey(workspaceId))
}

// A marker is actionable only for the workspace that wrote it and only while that
// workspace has no confirmed push landing after it was written.
export function pendingPushDue(
    marker: PendingPushMarker | null,
    opts: { workspaceId: string; lastConfirmedPushAt: number | null },
): boolean {
    if (!marker) return false
    if (marker.workspaceId !== opts.workspaceId) return false
    if (opts.lastConfirmedPushAt !== null && marker.markedAt <= opts.lastConfirmedPushAt) return false
    return true
}

// A confirmed push (or a skip against the already-confirmed hash) retires only this
// workspace's marker and stamps only this workspace's confirm time.
export function noteConfirmedPush(workspaceId: string, now: number = Date.now()): void {
    clearPendingPushMarker(workspaceId)
    try { localStorage.setItem(confirmedKey(workspaceId), String(now)) } catch {}
}
