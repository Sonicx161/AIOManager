import { JellyfinError } from '../jellyfin/client.ts'
import { PROFILE_MISMATCH_MESSAGE } from '../jellyfin/session.ts'
import { GlobalMatchFailure, WatchMigrationError, migrationFailureMessage } from './failures.ts'

export const AUTH_EXPIRED_MATCH_MESSAGE = 'The destination sign-in expired. Reconnect and preview again.'
export const STREMIO_AUTH_EXPIRED_MESSAGE = 'The Stremio sign-in expired. Reconnect and preview again.'
export const ACCESS_REFUSED_PREFIX = 'The destination refused access (HTTP'
export const REPEATED_MATCH_PREFIX = 'Matching kept failing for every title:'

export const NUVIO_SCOPE_MATCH_MESSAGES = [
    'The Nuvio user or profile changed. Preview again from the start.',
    'The selected Nuvio profile changed. Preview again before importing.',
    'The selected Nuvio profile changed. Select it again in Connections before importing.',
    'The saved Nuvio profile no longer matches. Select it again in Connections.',
]

const TRANSIENT_MATCH_MESSAGE = 'The destination temporarily limited matching for this title. Preview again to retry it.'
const UNREACHABLE_MATCH_MESSAGE = 'The destination could not be reached while checking this title. Preview again to retry it.'
const UNEXPECTED_MATCH_MESSAGE = 'The destination returned an unexpected response while checking this title. Preview again to retry it.'

function statusOf(error: unknown): number | null {
    const status = (error as { status?: unknown } | null)?.status
    return typeof status === 'number' && Number.isInteger(status) && status > 0 ? status : null
}

export function isTransientMatchFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const candidate = error as { kind?: unknown; status?: unknown }
    return candidate.kind === 'server' || candidate.kind === 'network' || candidate.kind === 'timeout'
        || candidate.status === 429 || candidate.status === 503
}

export function matchFailureReason(error: unknown): string {
    if (error instanceof WatchMigrationError) return migrationFailureMessage(error.failure)
    const status = statusOf(error)
    if (status === 429 || status === 503) return TRANSIENT_MATCH_MESSAGE
    if (status !== null) return `The destination answered HTTP ${status} while checking this title. Preview again to retry it.`
    const kind = (error as { kind?: unknown } | null)?.kind
    if (kind === 'network' || kind === 'timeout') return UNREACHABLE_MATCH_MESSAGE
    return UNEXPECTED_MATCH_MESSAGE
}

export function isGlobalMatchFailure(error: unknown): boolean {
    if (error instanceof GlobalMatchFailure) return true
    if (error instanceof WatchMigrationError) {
        if (error.failure.stage === 'identity') return true
        return error.failure.httpStatus === 401 || error.failure.httpStatus === 403
    }
    if (error instanceof JellyfinError) return error.kind === 'auth'
    const status = statusOf(error)
    if (status === 401 || status === 403) return true
    return error instanceof Error && NUVIO_SCOPE_MATCH_MESSAGES.includes(error.message)
}

export function globalMatchAbortError(error: unknown): Error {
    if (error instanceof GlobalMatchFailure) return error
    if (error instanceof Error && NUVIO_SCOPE_MATCH_MESSAGES.includes(error.message)) return error
    if (error instanceof WatchMigrationError) {
        if (error.failure.httpStatus === 401 || error.failure.httpStatus === 403) return new Error(STREMIO_AUTH_EXPIRED_MESSAGE)
        return error
    }
    const status = statusOf(error)
    if (error instanceof JellyfinError && error.kind === 'auth' && status !== 403) return new Error(AUTH_EXPIRED_MATCH_MESSAGE)
    if (status === 401) return new Error(AUTH_EXPIRED_MATCH_MESSAGE)
    if (status === 403) return new Error(`${ACCESS_REFUSED_PREFIX} 403). Check the selected user, then preview again.`)
    return error instanceof Error ? error : new Error(String(error))
}

export function repeatedMatchFailureMessage(error: unknown): string {
    const status = statusOf(error)
    if (status !== null) return `${REPEATED_MATCH_PREFIX} the destination answered HTTP ${status}. Test the connection, then preview again.`
    const kind = (error as { kind?: unknown } | null)?.kind
    if (kind === 'network' || kind === 'timeout') return `${REPEATED_MATCH_PREFIX} the destination could not be reached. Test the connection, then preview again.`
    if (error instanceof WatchMigrationError) return migrationFailureMessage(error.failure)
    return `${REPEATED_MATCH_PREFIX} the destination returned an unexpected response. Test the connection, then preview again.`
}

const KNOWN_MESSAGES = [
    PROFILE_MISMATCH_MESSAGE,
    'The destination library could not be read completely, so matches cannot be verified safely. Try the preview again.',
    'The destination sign-in expired. Reconnect and preview again.',
    'The Stremio sign-in expired. Reconnect and preview again.',
    'The destination changed. Preview again before importing.',
    'The source user or profile changed. Preview again before importing.',
    'The write could not be verified. Preview again before continuing.',
    'Choose a different remote user or server for the destination.',
    'Choose a specific Nuvio profile in Connections first.',
    'The Nuvio profile could not be read completely, so matches cannot be verified safely. Try the preview again.',
    'The Nuvio user or profile changed. Preview again from the start.',
    'The selected Nuvio profile changed. Preview again before importing.',
    'The selected Nuvio profile changed. Select it again in Connections before importing.',
    'The saved Nuvio profile no longer matches. Select it again in Connections.',
    'Stremio returned an unexpected library shape; nothing was interpreted as data.',
    'Stremio returned duplicate library rows; refusing to guess.',
]

export function migrationErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof WatchMigrationError) return migrationFailureMessage(error.failure)
    if (!(error instanceof Error) || !error.message) return fallback
    if (KNOWN_MESSAGES.includes(error.message)) return error.message
    if (error instanceof GlobalMatchFailure) return error.message
    if (error.message.startsWith(REPEATED_MATCH_PREFIX) || error.message.startsWith(ACCESS_REFUSED_PREFIX)) return error.message
    if (error.message.startsWith('The Nuvio profile could not be read')) return error.message
    const code = /\bHTTP (\d{3})\b|\((\d{3})\)|Server returned (\d{3}) from/.exec(error.message)
    if (code) return `${fallback} (the server answered ${code[1] || code[2] || code[3]})`
    return fallback
}
