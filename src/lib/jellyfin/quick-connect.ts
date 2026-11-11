// Quick Connect sign-in flow: initiate, poll, and hand back the one-time
// secret exactly once. The secret exists only inside the caller's await chain
// here and in the sign-in that consumes it; nothing in this module stores,
// logs or serializes it.
import { JellyfinError, normalizeJellyfinUrl } from './client.ts'
import type { JellyfinClient, JellyfinQuickConnectResult } from './types.ts'

/** The facades keep codes for 10 minutes; the dialog follows the 5-minute mockup. */
export const QUICK_CONNECT_TTL_MS = 5 * 60_000
/** Spec: poll every 2 to 3 seconds. */
export const QUICK_CONNECT_POLL_MS = 2500

export type QuickConnectOutcome =
    | { kind: 'approved'; secret: string }
    | { kind: 'expired' }
    | { kind: 'unavailable' }

export interface QuickConnectRunnerOptions {
    signal: AbortSignal
    onCode: (code: string, expiresAt: number) => void
    ttlMs?: number
    pollMs?: number
    now?: () => number
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new JellyfinError('aborted', 'Quick Connect wait was aborted')); return }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
        const onAbort = () => { clearTimeout(timer); reject(new JellyfinError('aborted', 'Quick Connect wait was aborted')) }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

type QuickConnectProbe = Pick<JellyfinClient, 'quickConnectEnabled' | 'quickConnectInitiate' | 'quickConnectState'>

/**
 * Runs the standard Jellyfin Quick Connect flow against one server:
 * Enabled, Initiate, poll Connect until Authenticated, then return the secret
 * so the caller can sign in with it (the server consumes the secret on that
 * sign-in; a second use fails). Outcomes:
 *   - unavailable: the server answered that Quick Connect is off (or the
 *     endpoint does not exist). No code was minted.
 *   - expired: the client deadline passed, or the server started answering
 *     404 for the secret (server-side lapse or consumption).
 *   - approved: the user approved the code; `secret` must be used exactly once.
 * Abort, timeout and network failures throw; the caller renders its ordinary
 * reachability error for those.
 */
export async function runQuickConnect(client: QuickConnectProbe, options: QuickConnectRunnerOptions): Promise<QuickConnectOutcome> {
    const { signal, onCode } = options
    const ttlMs = options.ttlMs ?? QUICK_CONNECT_TTL_MS
    const pollMs = options.pollMs ?? QUICK_CONNECT_POLL_MS
    const now = options.now ?? Date.now

    if (!await client.quickConnectEnabled(signal)) return { kind: 'unavailable' }
    const initiated = await client.quickConnectInitiate(signal)
    const secret = initiated.Secret!
    const expiresAt = now() + ttlMs
    onCode(initiated.Code!, expiresAt)

    for (;;) {
        if (now() >= expiresAt) return { kind: 'expired' }
        await pause(pollMs, signal)
        if (now() >= expiresAt) return { kind: 'expired' }
        let state: JellyfinQuickConnectResult
        try {
            state = await client.quickConnectState(secret, signal)
        } catch (err) {
            // An unknown secret means the server dropped it: TTL lapse or the
            // code was already consumed. That is the expired state, not an error.
            if (err instanceof JellyfinError && err.status === 404) return { kind: 'expired' }
            throw err
        }
        if (state.Authenticated === true) return { kind: 'approved', secret }
    }
}

export interface QuickConnectAttempt {
    /** Attempt id captured at initiate; any restart or cancel invalidates it. */
    generation: number
    /** Normalized server identity captured at initiate. */
    baseUrl: string
}

/**
 * Whether a result (or an in-flight step) still belongs to the attempt the
 * dialog started: same attempt id, same server. Checked after every await so
 * a late approval can never install a session for another server, another
 * selection, or another dialog instance.
 */
export function quickConnectAttemptCurrent(attempt: QuickConnectAttempt, generation: number, baseUrl: string): boolean {
    return attempt.generation === generation && attempt.baseUrl === normalizeJellyfinUrl(baseUrl)
}
