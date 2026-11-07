import { REALSTREAM_CLEAR_UNSUPPORTED } from '../drivers/realstream.ts'

export interface ReconcileConnectionState {
    status?: string
    consecutiveFailures?: number
    lastSync?: number
    lastError?: string | null
    lastErrorAt?: number | null
    skipCyclesRemaining?: number
}

/** A failure-normalized state: every connection-state field is set, so it can replace the raw merged state. */
export interface NormalizedConnectionFailureState extends ReconcileConnectionState {
    consecutiveFailures: number
    lastError: string
    lastErrorAt: number
    lastSync: number
    skipCyclesRemaining: number
    status: 'error' | 'expired'
}

export interface ReconcileConnectionOutcome {
    outcome: 'written' | 'unchanged' | 'skipped' | 'failed'
    /** backoff, auth-cooldown, recent-write, overlay-fail-closed, empty-canonical, no-driver or not-a-target */
    reason?: string
    error?: string
}

export type ConnectionPushOutcome =
    | { kind: 'confirmed' }
    | { kind: 'failed'; error: string }
    | { kind: 'skipped'; reason?: string }
    | { kind: 'not-target' }

// Older servers send no per-connection outcome, so it is read from the connection's state:
// a fresh stamp is a write, and a healthy state with no change entry is a no-op.
const FRESH_WINDOW_MS = 120_000
const lastSeen = new Map<string, number>()

export function classifyConnectionPush(
    accountId: string,
    connectionId: string,
    states: Record<string, ReconcileConnectionState> | undefined | null,
    now = Date.now(),
    outcomes?: Record<string, ReconcileConnectionOutcome> | null,
    changedPlatforms?: ReadonlySet<string> | null,
    platform?: string,
): ConnectionPushOutcome {
    const state = states?.[connectionId]
    const key = `${accountId}:${connectionId}`
    const previous = lastSeen.get(key)
    if (state) lastSeen.set(key, state.lastSync ?? 0)
    const explicit = outcomes?.[connectionId]
    if (explicit) {
        if (explicit.outcome === 'written' || explicit.outcome === 'unchanged') return { kind: 'confirmed' }
        if (explicit.outcome === 'failed') return { kind: 'failed', error: explicit.error || state?.lastError || 'Last write failed' }
        if (explicit.reason === 'not-a-target') return { kind: 'not-target' }
        return { kind: 'skipped', reason: explicit.reason }
    }
    if (!state) return { kind: 'skipped' }
    if (state.status && state.status !== 'active') return { kind: 'failed', error: state.lastError || `Connection is ${state.status}` }
    if ((state.consecutiveFailures ?? 0) > 0) return { kind: 'failed', error: state.lastError || 'Last write failed' }
    const stamp = state.lastSync ?? 0
    const fresh = previous !== undefined ? stamp > previous : stamp > 0 && Math.abs(now - stamp) <= FRESH_WINDOW_MS
    if (fresh) return { kind: 'confirmed' }
    if (changedPlatforms && platform && !changedPlatforms.has(platform)) return { kind: 'confirmed' }
    return { kind: 'skipped' }
}

export function resetPushOutcomeMemory(): void {
    lastSeen.clear()
}

/**
 * The RealStream unsupported clear reaches reconciler consumers as a skip (nothing
 * was written), but no retry can ever succeed: AIOManager cannot clear that
 * platform. Consumers must present it as a user-visible error, never as a healthy
 * skip (SOL-R3-04).
 */
export function isUnsupportedRealStreamClear(explicit: ReconcileConnectionOutcome | undefined | null): boolean {
    return !!explicit && explicit.outcome === 'skipped' && explicit.reason === REALSTREAM_CLEAR_UNSUPPORTED
}

/**
 * One shared outcome normalization for every consumer of the reconciler envelope
 * (SOL-R1-BETA-06): an explicit failure, or an unsupported RealStream clear skip
 * (SOL-R3-04), overrides a below-backoff "active" state, keeps the prior confirmed
 * lastSync so no base advances, and carries the platform error. Returns null when
 * the connection is not failing. Ordinary skips stay skips.
 */
export function normalizeFailedConnectionState(
    explicit: ReconcileConnectionOutcome | undefined | null,
    state: ReconcileConnectionState | undefined,
): { state: NormalizedConnectionFailureState; message: string } | null {
    const message = explicit?.outcome === 'failed'
        ? (explicit.error || state?.lastError || 'Push failed')
        : isUnsupportedRealStreamClear(explicit)
            ? REALSTREAM_CLEAR_UNSUPPORTED
            : (!explicit && state && (state.status === 'error' || state.status === 'expired' || (state.consecutiveFailures ?? 0) > 0)
                ? String(state.lastError || `Connection is ${state.status}`)
                : null)
    if (message === null) return null
    return {
        state: {
            ...state,
            consecutiveFailures: Math.max(1, state?.consecutiveFailures ?? 0),
            lastError: message,
            lastErrorAt: Date.now(),
            lastSync: state?.lastSync ?? 0,
            skipCyclesRemaining: state?.skipCyclesRemaining ?? 0,
            status: state?.status === 'expired' ? 'expired' : 'error',
        },
        message,
    }
}
