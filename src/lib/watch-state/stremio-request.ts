import { WatchMigrationError } from './failures.ts'
import type { MigrationFailure } from './types.ts'

type StremioOperation = 'GetUser' | 'DatastoreGet' | 'DatastorePut'

interface RequestOptions {
    authKey: string
    accountId: string
    headers(): Promise<Record<string, string>>
    assertCurrent(): void
    fetch?: typeof fetch
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    /** Clock used only for rate budgeting; production uses Date.now. */
    now?: () => number
    /** Shared per-scope request pacer; defaults to this account's registry pacer. */
    pacer?: StremioRequestPacer
}

export interface StremioPacerContext {
    signal: AbortSignal
    sleep(ms: number, signal: AbortSignal): Promise<void>
    now(): number
    assertCurrent(): void
}

export interface StremioRequestPacer {
    /**
     * Waits until the next request may be sent: observed 429 cooldowns and the
     * rolling route-call budget apply backpressure before the request leaves.
     * Every caller waits out the remaining cooldown — including the next call
     * on the same transport after a non-retryable or final-attempt 429 — while
     * the operation that observed the 429 does not double-wait, because its own
     * bounded retry sleep already advanced the same clock. The abort signal and
     * account ownership are re-checked after every wait so cancellation or an
     * owner change aborts a queued call instead of sending it.
     */
    reserve(context: StremioPacerContext): Promise<void>
    /** Records a bounded Retry-After cooldown for every later request of this account. */
    observeRateLimit(delayMs: number, now: number): void
    snapshot(now: number): { cooldownMs: number; windowCount: number }
}

export interface StremioRequestPacerOptions {
    windowMs?: number
    maxPerWindow?: number
}

/** Rolling budget stays under the server proxy's 600 route calls/min/IP limit, leaving headroom for other app traffic. */
export const STREMIO_REQUEST_WINDOW_MS = 60_000
export const STREMIO_REQUEST_MAX_PER_WINDOW = 540

const MAX_SHARED_PACERS = 8
const sharedPacers = new Map<string, StremioRequestPacer>()

/** One pacer per auth/import scope, shared across sessions and fresh previews of the same account. */
export function stremioWatchRequestPacer(scope: string, options: StremioRequestPacerOptions = {}): StremioRequestPacer {
    const existing = sharedPacers.get(scope)
    if (existing !== undefined) {
        sharedPacers.delete(scope)
        sharedPacers.set(scope, existing)
        return existing
    }
    const created = createStremioRequestPacer(options)
    sharedPacers.set(scope, created)
    while (sharedPacers.size > MAX_SHARED_PACERS) sharedPacers.delete(sharedPacers.keys().next().value as string)
    return created
}

export function createStremioRequestPacer(options: StremioRequestPacerOptions = {}): StremioRequestPacer {
    const windowMs = Math.max(1, options.windowMs ?? STREMIO_REQUEST_WINDOW_MS)
    const maxPerWindow = Math.max(1, options.maxPerWindow ?? STREMIO_REQUEST_MAX_PER_WINDOW)
    let notBefore = 0
    const sentAt: number[] = []
    const prune = (now: number) => {
        while (sentAt.length > 0 && sentAt[0] <= now - windowMs) sentAt.shift()
    }
    return {
        async reserve(context) {
            context.signal.throwIfAborted()
            // Each pass waits out the largest pending delay or frees a send slot.
            // The loop only ends with a genuinely free slot — or an abort / owner
            // change thrown after a wait — so sustained contention never fails
            // open into an over-budget send after a fixed number of passes.
            for (;;) {
                const now = context.now()
                prune(now)
                const cooldownMs = Math.max(0, notBefore - now)
                const slotMs = sentAt.length >= maxPerWindow ? Math.max(0, sentAt[0] + windowMs - now) : 0
                const waitMs = Math.max(cooldownMs, slotMs)
                if (waitMs <= 0) break
                await context.sleep(waitMs, context.signal)
                context.signal.throwIfAborted()
                context.assertCurrent()
            }
            sentAt.push(context.now())
        },
        observeRateLimit(delayMs, now) {
            const bounded = Math.max(0, Math.min(Math.round(delayMs), 60_000))
            notBefore = Math.max(notBefore, now + bounded)
        },
        snapshot(now) {
            prune(now)
            return { cooldownMs: Math.max(0, notBefore - now), windowCount: sentAt.length }
        },
    }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
        signal.addEventListener('abort', abort, { once: true })
    })
}

function retryDelay(value: string | null, attempt: number): number {
    const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null
    const date = value && seconds === null ? Date.parse(value) : Number.NaN
    const requested = seconds !== null ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 1000 * (attempt + 1)
    return Math.min(60_000, Math.max(1000, requested))
}

export function createStremioWatchRequest(options: RequestOptions) {
    const sleepFn = options.sleep ?? sleep
    const now = options.now ?? Date.now
    const pacer = options.pacer ?? stremioWatchRequestPacer(`account:${options.accountId}`)
    return async (type: StremioOperation, body: Record<string, unknown>, signal: AbortSignal, beforeDispatch?: () => void): Promise<unknown> => {
        const stage: MigrationFailure['stage'] = type === 'GetUser' ? 'identity' : type === 'DatastorePut' ? 'write' : 'prewrite'
        // Reads may retry a transient transport failure. Never replay a library
        // replacement here: an interrupted write may have reached Stremio already.
        const maxAttempts = type === 'DatastorePut' ? 1 : 3
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            signal.throwIfAborted()
            const headers = await options.headers()
            options.assertCurrent()
            signal.throwIfAborted()
            await pacer.reserve({ signal, sleep: sleepFn, now, assertCurrent: options.assertCurrent })
            // The pacing wait may straddle an account owner change; re-check it
            // here so no request leaves with auth captured before the wait.
            options.assertCurrent()
            signal.throwIfAborted()
            // Writes re-assert their pre-write freshness here: header and pacing waits
            // can outlast the freshness bound, so the guard runs on every attempt,
            // immediately before the request leaves.
            beforeDispatch?.()
            let response: Response
            try {
                response = await (options.fetch ?? fetch)('/api/stremio-proxy', {
                    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-account-context': options.accountId },
                    body: JSON.stringify({ ...body, type, authKey: options.authKey }),
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
                })
            } catch (error) {
                signal.throwIfAborted()
                const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network'
                if (attempt + 1 < maxAttempts) {
                    await sleepFn(retryDelay(null, attempt), signal)
                    continue
                }
                throw new WatchMigrationError({ stage, reason, attempts: attempt + 1 })
            }
            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500
                await response.body?.cancel().catch(() => {})
                if (response.status === 429) {
                    // An advertised rate-limit cooldown binds every later request of this
                    // account — including the very next call on this same transport after
                    // a non-retryable or final-attempt 429, and the next write after a
                    // fresh preview — so the budget applies before a Put leaves, not after.
                    pacer.observeRateLimit(retryDelay(response.headers.get('Retry-After'), attempt), now())
                }
                if (retryable && attempt + 1 < maxAttempts) {
                    await sleepFn(retryDelay(response.headers.get('Retry-After'), attempt), signal)
                    continue
                }
                throw new WatchMigrationError({ stage, reason: response.status === 429 ? 'rate_limited' : 'http', httpStatus: response.status, attempts: attempt + 1 })
            }
            let data: unknown
            try { data = await response.json() }
            catch (error) {
                signal.throwIfAborted()
                const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout'
                    : error instanceof TypeError ? 'network' : 'invalid_response'
                if (reason !== 'invalid_response' && attempt + 1 < maxAttempts) {
                    await sleepFn(retryDelay(null, attempt), signal)
                    continue
                }
                throw new WatchMigrationError({ stage, reason, attempts: attempt + 1 })
            }
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WatchMigrationError({ stage, reason: 'invalid_response', attempts: attempt + 1 })
            const envelope = data as Record<string, unknown>
            if (envelope.error || envelope.result === false || envelope.result === undefined) throw new WatchMigrationError({ stage, reason: 'remote_declined', attempts: attempt + 1 })
            return envelope.result
        }
    }
}
