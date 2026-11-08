import { getSyncAuthHeaders } from './sync-auth.ts'

function parseErrorBody(text: string): { error?: unknown } | null {
    if (!text) return null
    try { return JSON.parse(text) as { error?: unknown } | null } catch { return null }
}

export interface HttpResult<T> {
    ok: boolean
    status: number
    data: T | null
    error?: string
}

export async function apiFetch<T>(
    path: string,
    opts: {
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
        body?: unknown
        signal?: AbortSignal
        timeoutMs?: number
        authHeaders?: Record<string, string>
        contentType?: string
        baseUrl?: string
    } = {}
): Promise<HttpResult<T>> {
    const { method = 'GET', signal, timeoutMs = 15000, authHeaders, contentType = 'application/json' } = opts
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const headers: Record<string, string> = { ...(authHeaders ?? await getSyncAuthHeaders()) }
    // A bodyless request must not claim JSON: Fastify answers 400 to an empty JSON body.
    if (opts.body !== undefined) headers['Content-Type'] = contentType
    else delete headers['Content-Type']
    const base = opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, '')}/api` : '/api'
    const fetchPromise = fetch(`${base}${path.startsWith('/') ? path : '/' + path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
    })
    fetchPromise.catch(() => {})

    try {
        const res = await fetchPromise
        clearTimeout(timeout)
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const parsed = parseErrorBody(text)
            return { ok: false, status: res.status, data: null, error: typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}` }
        }
        const text = await res.text()
        if (!text) return { ok: true, status: res.status, data: null }
        return { ok: true, status: res.status, data: JSON.parse(text) as T }
    } catch (err) {
        clearTimeout(timeout)
        if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, status: 0, data: null, error: 'Aborted' }
        return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'Network error' }
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort)
    }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    const result = await apiFetch<T>(path, { signal })
    return result.data
}

export async function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    const result = await apiFetch<T>(path, { method: 'POST', body, signal })
    return result.data
}

export async function apiDelete(path: string): Promise<boolean> {
    const result = await apiFetch(path, { method: 'DELETE' })
    return result.ok
}
