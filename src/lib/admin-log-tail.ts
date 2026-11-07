/**
 * Live log tail controller. EventSource retries dropped connections on its own;
 * a refused stream (the browser gives up) is probed once: a 401 ends the tail,
 * anything else reopens it after a pause. Relative imports for node:test.
 */
import { streamLogs, type LogLine } from '../api/admin.ts'

export type TailState = 'connecting' | 'live' | 'reconnecting' | 'stopped'

export interface LogTailOptions {
    afterSeq: number
    onLine: (line: LogLine) => void
    onState: (state: TailState) => void
    /** Resolves true when the dashboard session is gone (401). */
    isSignedOut: () => Promise<boolean>
    retryMs?: number
}

export function openLogTail({ afterSeq, onLine, onState, isSignedOut, retryMs = 5000 }: LogTailOptions): () => void {
    let lastSeq = afterSeq
    let disposed = false
    let close: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
        onState('connecting')
        close = streamLogs({
            onOpen: () => { if (!disposed) onState('live') },
            onLine: line => {
                if (disposed) return
                if (line.seq > lastSeq) lastSeq = line.seq
                onLine(line)
            },
            onError: (_event, closed) => {
                if (disposed) return
                onState('reconnecting')
                if (!closed) return
                close?.()
                close = null
                void isSignedOut().then(signedOut => {
                    if (disposed) return
                    if (signedOut) {
                        onState('stopped')
                        return
                    }
                    timer = setTimeout(connect, retryMs)
                })
            },
        }, lastSeq)
    }

    connect()
    return () => {
        disposed = true
        if (timer) clearTimeout(timer)
        close?.()
    }
}

/**
 * Appends a tail line once per seq, keeping the newest `cap` lines. Pure: the
 * dedupe reads only the previous rows, so a replayed state updater (StrictMode)
 * returns the same result.
 */
export function appendTailLine(prev: LogLine[], line: LogLine, cap = 200): LogLine[] {
    if (prev.some(l => l.seq === line.seq)) return prev
    const next = [...prev, line]
    return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * The tail runs once the buffer has loaded at least once. A later failed
 * buffer refetch keeps the cached data and must not close the stream.
 */
export function logTailEnabled(live: boolean, query: { data: unknown }): boolean {
    return live && query.data !== undefined
}
