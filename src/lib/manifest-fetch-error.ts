export const ADDON_UNREACHABLE = 'Could not reach this addon. Check the URL and that the addon server is online.'

// Only the proxy's own "Internal Proxy Error" or "Gateway Timeout" means the addon was never reached.
export function manifestFetchErrorMessage(status: number, body: unknown, viaProxy: boolean): string {
    const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : ''
    if (status === 404) return 'Addon manifest not found at this URL'
    if (viaProxy) {
        if (error === 'Internal Proxy Error' || error === 'Gateway Timeout') return ADDON_UNREACHABLE
        if (status === 403 && error.startsWith('Access Denied')) return 'This server does not allow requests to that address.'
    }
    return `Addon server responded with ${status}`
}

export function installErrorMessage(err: unknown): string {
    if (err instanceof TypeError) return /fetch|network|load failed/i.test(err.message) ? ADDON_UNREACHABLE : 'Invalid URL format'
    return err instanceof Error ? err.message : 'Failed to install addon'
}

export async function readErrorBody(response: Response, timeoutMs = 3000): Promise<unknown> {
    const reader = response.body?.getReader()
    if (!reader) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const text = (async () => {
        const decoder = new TextDecoder()
        let out = ''
        for (;;) {
            const { done, value } = await reader.read()
            if (done) return out + decoder.decode()
            out += decoder.decode(value, { stream: true })
        }
    })().catch(() => null)
    try {
        const result = await Promise.race([text, timedOut])
        if (result === null) {
            reader.cancel().catch(() => {})
            return null
        }
        return JSON.parse(result)
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}
