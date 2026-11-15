export class SeriesLookupRateLimitError extends Error {
    constructor() { super('Episode list checks are rate limited. Try again shortly.'); this.name = 'SeriesLookupRateLimitError' }
}

export async function fetchSeriesBatch(
    send: () => Promise<Response>,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => new Promise((resolve, reject) => {
        signal?.throwIfAborted()
        const abort = () => { clearTimeout(timer); reject(signal?.reason) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
        signal?.addEventListener('abort', abort, { once: true })
    }),
    onWait?: () => void,
    signal?: AbortSignal,
): Promise<Response> {
    for (let attempt = 0; attempt < 300; attempt++) {
        signal?.throwIfAborted()
        const response = await send()
        signal?.throwIfAborted()
        if (response.status !== 429) return response
        const raw = response.headers.get('Retry-After')
        const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : 2
        await response.body?.cancel().catch(() => {})
        onWait?.()
        signal?.throwIfAborted()
        await sleep(Math.max(250, Math.min(60_000, seconds * 1000)), signal)
    }
    throw new SeriesLookupRateLimitError()
}
