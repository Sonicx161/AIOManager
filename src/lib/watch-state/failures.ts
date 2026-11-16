import type { MigrationFailure } from './types.ts'
import { StaleChecksError } from './prewrite-fresh.ts'
import { SeriesLookupRateLimitError } from '../series-batch-retry.ts'

// Only these structured fields leave the importer. Never export exception text,
// transport bodies, URLs, auth keys or provider-specific error messages.
export class WatchMigrationError extends Error {
    readonly failure: MigrationFailure
    constructor(failure: MigrationFailure, message = migrationFailureMessage(failure)) {
        super(message)
        this.name = 'WatchMigrationError'
        this.failure = failure
    }
}

export class WatchTransportError extends Error {
    constructor() {
        super('The connection was interrupted. Check both connections, then preview again.')
        this.name = 'WatchTransportError'
    }
}

export async function transportFetch(input: string, init: RequestInit): Promise<Response> {
    try { return await fetch(input, init) } catch (error) {
        if (error instanceof TypeError) throw new WatchTransportError()
        throw error
    }
}

export class GlobalMatchFailure extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'GlobalMatchFailure'
    }
}

export function migrationFailure(error: unknown, stage: MigrationFailure['stage'] = 'write'): MigrationFailure {
    if (error instanceof WatchMigrationError) return { ...error.failure }
    if (error instanceof SeriesLookupRateLimitError) return { stage, reason: 'rate_limited', httpStatus: 429 }
    if (error instanceof WatchTransportError) return { stage, reason: 'network' }
    const name = error instanceof Error ? error.name : ''
    return { stage, reason: name === 'TimeoutError' ? 'timeout' : 'unknown' }
}

export async function migrationStage<T>(stage: MigrationFailure['stage'], operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
        // A stale-checks abort restarts the row in the engine; it is control flow,
        // not a transport failure, so it must survive this classification.
        if (error instanceof StaleChecksError) throw error
        // Unknown errors retain their original message inside this module for local
        // debugging. The engine/UI/report use only migrationFailureMessage below.
        throw new WatchMigrationError({ ...migrationFailure(error, stage), stage }, error instanceof Error ? error.message : undefined)
    }
}

export function migrationFailureMessage(failure: MigrationFailure): string {
    if (failure.reason === 'proxy_redirect') return 'AIOManager returned a redirect while checking Stremio. Check the reverse proxy or sign-in gate, then preview again.'
    const step = { identity: 'verifying the sign-in', prewrite: 'checking the title before saving', write: 'saving the title', readback: 'reading the title back', verification: 'checking the saved state' }[failure.stage]
    const detail = failure.reason === 'rate_limited' ? 'The connection temporarily limited requests'
        : failure.reason === 'timeout' ? 'The connection timed out'
            : failure.reason === 'network' ? 'The connection was interrupted'
                : failure.reason === 'http' ? `The connection returned HTTP ${failure.httpStatus ?? 'error'}`
                    : failure.reason === 'state_mismatch' ? 'The saved state did not pass verification'
                        : failure.reason === 'acknowledgement' ? 'The connection did not confirm the save'
                            : failure.reason === 'invalid_response' ? 'The connection returned an unreadable response'
                                : failure.reason === 'remote_declined' ? 'The service did not confirm the request'
                                    : 'The operation could not be verified'
    return `${detail} while ${step}. Preview again before continuing; the title may already be saved.`
}
