/**
 * Transport seam for the Dashboard API client: swap the network layer in tests
 * and in the dev mock. Kept dependency-free so admin.ts and admin-mock.ts can
 * both import it under node:test.
 */

export interface AdminTransportFetch {
    /** Mirrors fetch for a request that already carries method, headers and body. */
    (path: string, init: RequestInit): Promise<{ status: number; body: string; headers?: Record<string, string> }>
}

export interface AdminTransport {
    fetch: AdminTransportFetch
    /** SSE stand-in so the mock can drive the live tail. */
    streamLogs?: (handlers: { onLine: (line: never) => void; onOpen?: () => void; onError?: (error: Event, closed: boolean) => void }) => () => void
}

export interface LogsStreamHandlers {
    onLine: (line: { seq: number; at: string; level: 'info' | 'warn' | 'error'; module: string; message: string }) => void
    onOpen?: () => void
    onError?: (error: Event, closed: boolean) => void
}

let transport: AdminTransport | null = null

/**
 * The seam is allowed in dev builds and under node:test (which runs outside
 * Vite, where import.meta.env does not exist). A prod browser can never use it.
 */
export function adminSeamAllowed(): boolean {
    try {
        if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) return true
    } catch {
        // import.meta.env missing outside Vite
    }
    const runtimeProcess = (globalThis as { process?: { env?: { NODE_TEST_CONTEXT?: string } } }).process
    return runtimeProcess?.env?.NODE_TEST_CONTEXT !== undefined
}

/**
 * Test/dev seam: swaps the network layer. Callers outside dev builds are rejected
 * so the seam cannot ship.
 */
export function setAdminTransport(next: AdminTransport | null): void {
    if (!adminSeamAllowed()) throw new Error('admin transport seam is dev-only')
    transport = next
}

export function currentTransport(): AdminTransport {
    return transport ?? { fetch: realFetch }
}

export async function realFetch(path: string, init: RequestInit): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const res = await fetch(path, { ...init, credentials: 'include' })
    const body = await res.text().catch(() => '')
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
    return { status: res.status, body, headers }
}

export class AdminApiError extends Error {
    status: number
    expected?: number
    /** Seconds to wait before retrying, from Retry-After on 429. */
    retryAfterSec?: number
    /** Per-key validation errors from a settings write. */
    fieldErrors?: Record<string, string>
    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}
