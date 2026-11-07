export interface WatchStateRequestGateOptions {
    windowMs?: number
    maxRequests?: number
    now?: () => number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface WatchStateRequestGate {
    run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason)
            return
        }
        let timer = 0
        const abort = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            reject(signal.reason)
        }
        timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
        }, ms) as unknown as number
        signal.addEventListener('abort', abort, { once: true })
    })
}

/**
 * Reserves request slots under a provider's rolling IP budget. The network
 * operation starts after its slot is reserved, but does not hold the gate,
 * so independent reads can still run concurrently.
 */
export function createWatchStateRequestGate(options: WatchStateRequestGateOptions = {}): WatchStateRequestGate {
    const windowMs = Math.max(1, options.windowMs ?? 30_000)
    const maxRequests = Math.max(1, options.maxRequests ?? 220)
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? defaultSleep
    const sentAt: number[] = []
    let reservationTail = Promise.resolve()

    const reserve = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted()
        let release!: () => void
        const turn = new Promise<void>(resolve => { release = resolve })
        const prior = reservationTail
        reservationTail = reservationTail.then(() => turn)
        await prior
        try {
            for (;;) {
                signal.throwIfAborted()
                const current = now()
                while (sentAt.length > 0 && sentAt[0] <= current - windowMs) sentAt.shift()
                if (sentAt.length < maxRequests) {
                    sentAt.push(current)
                    return
                }
                await sleep(Math.max(1, sentAt[0] + windowMs - current), signal)
            }
        } finally {
            release()
        }
    }

    return {
        async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
            await reserve(signal)
            return operation()
        },
    }
}
