import { JellyfinError } from './client.ts'
import type { JellyfinClient, JellyfinItemResult, JellyfinSession } from './types.ts'
import type { JellyfinSecret } from './connection-data.ts'

export type MediaReadCauseCode =
    | 'auth-expired' | 'denied' | 'not-found' | 'unsupported' | 'server' | 'rate-limited'
    | 'timeout' | 'unreachable' | 'blocked' | 'bad-response' | 'unlock' | 'unknown'

export interface MediaReadCause {
    code: MediaReadCauseCode
    httpStatus?: number
}

export interface MediaFailureContext {
    baseUrl?: string
    pageProtocol?: string
}

export type MediaRead<T> =
    | { status: 'success'; data: T; checkedAt: number }
    | { status: 'unsupported' | 'denied' | 'error'; message: string; checkedAt: number; startedAt?: number; httpStatus?: number; cause?: MediaReadCause }
    | { status: 'waiting'; message: string }

export interface JellyfinMediaReads {
    resume: MediaRead<JellyfinItemResult>
    played: MediaRead<JellyfinItemResult>
    sessions: MediaRead<JellyfinSession[]>
}

function isMixedContent(context?: MediaFailureContext): boolean {
    const page = context?.pageProtocol ?? (globalThis as { location?: { protocol?: string } }).location?.protocol
    if (page !== 'https:' || !context?.baseUrl) return false
    try { return new URL(context.baseUrl).protocol === 'http:' } catch { return false }
}

/** Classifies a failed read from what the client actually saw; never guesses at CORS. */
export function classifyMediaFailure(error: unknown, context?: MediaFailureContext): MediaReadCause {
    if (!(error instanceof JellyfinError)) return { code: 'unknown' }
    const httpStatus = error.status
    const withStatus = (code: MediaReadCauseCode): MediaReadCause => ({ code, ...(httpStatus !== undefined ? { httpStatus } : {}) })
    if (httpStatus === 429) return withStatus('rate-limited')
    if (httpStatus === 408) return withStatus('timeout')
    switch (error.kind) {
        case 'auth': return withStatus(httpStatus === 401 || httpStatus === undefined ? 'auth-expired' : 'denied')
        case 'unsupported': return withStatus(httpStatus === 404 ? 'not-found' : 'unsupported')
        case 'server': return withStatus('server')
        case 'timeout': return { code: 'timeout' }
        case 'network': return { code: isMixedContent(context) ? 'blocked' : 'unreachable' }
        case 'invalid-response': return { code: 'bad-response' }
        default: return withStatus('unknown')
    }
}

export function describeMediaCause(cause: MediaReadCause): string {
    const http = cause.httpStatus !== undefined ? ` (HTTP ${cause.httpStatus})` : ''
    switch (cause.code) {
        case 'auth-expired': return `The login has expired${http}.`
        case 'denied': return `Access was denied${http}.`
        case 'not-found': return `This endpoint isn't available on this server${http}.`
        case 'unsupported': return `This server does not support this read${http}.`
        case 'server': return `The server had an error${http}.`
        case 'rate-limited': return `The server is rate limiting requests${http}.`
        case 'timeout': return 'The server timed out.'
        case 'unreachable': return "Couldn't reach the server."
        case 'blocked': return 'The browser blocked this request. An http server cannot be used from an https page.'
        case 'bad-response': return 'The server sent an unexpected response.'
        case 'unlock': return "Couldn't unlock the saved login."
        default: return `This read failed${http}.`
    }
}

export async function captureMediaRead<T>(read: () => Promise<T>, signal: AbortSignal, context?: MediaFailureContext): Promise<MediaRead<T>> {
    const startedAt = Date.now()
    try {
        const data = await read()
        signal.throwIfAborted()
        return { status: 'success', data, checkedAt: Date.now() }
    } catch (error) {
        if (signal.aborted) throw error
        const status = error instanceof JellyfinError
            ? error.kind === 'unsupported' ? 'unsupported' : error.kind === 'auth' ? 'denied' : 'error'
            : 'error'
        const httpStatus = error instanceof JellyfinError ? error.status : undefined
        const cause = classifyMediaFailure(error, context)
        let message = describeMediaCause(cause)
        if (status === 'unsupported') message = 'This server does not expose this read.'
        else if (status === 'denied') message = httpStatus === 401
            ? 'The saved sign-in was rejected. Reconnect this server, then refresh Activity.'
            : 'The server denied this read. Check this user’s permissions or reconnect to the correct user.'
        return { status, message, cause, startedAt, checkedAt: Date.now(), ...(httpStatus !== undefined ? { httpStatus } : {}) }
    }
}

const RETRY_PAUSE_MS = 500

function pauseBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * One retry for transient head-read failures (timeout, network, server 5xx).
 * 4xx (auth, unsupported) propagates immediately, and the abort signal cancels
 * both the pause and the retry.
 */
export async function retryOnceOnTransient<T>(read: () => Promise<T>, signal: AbortSignal, pauseMs = RETRY_PAUSE_MS): Promise<T> {
    try {
        return await read()
    } catch (error) {
        const transient = error instanceof JellyfinError && (error.kind === 'timeout' || error.kind === 'network' || error.kind === 'server')
        if (!transient || signal.aborted) throw error
        await pauseBeforeRetry(pauseMs, signal)
        signal.throwIfAborted()
        return read()
    }
}

export async function readJellyfinMedia(client: JellyfinClient, secret: JellyfinSecret, signal: AbortSignal): Promise<JellyfinMediaReads> {
    const context = { baseUrl: secret.baseUrl }
    const [resume, played, sessions] = await Promise.all([
        captureMediaRead(() => client.readResume(secret.accessToken, secret.userId, signal), signal, context),
        captureMediaRead(() => client.readPlayed(secret.accessToken, secret.userId, signal), signal, context),
        captureMediaRead(() => client.readSessions(secret.accessToken, secret.userId, signal), signal, context),
    ])
    return { resume, played, sessions }
}
