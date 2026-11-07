const DEV = process.env.NODE_ENV === 'development'

export async function resilientFetch(url, options = {}) {
    const {
        timeout = 10000,
        retries = 2,
        retryDelay = 1000,
        idempotent,
        fetchImpl,
        ...fetchOptions
    } = options

    const method = (fetchOptions.method || 'GET').toUpperCase()
    const isIdempotent = idempotent ?? ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method)

    let lastError = null

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController()
        const id = setTimeout(() => controller.abort(), timeout)

        let combinedSignal
        if (fetchOptions.signal) {
            try {
                combinedSignal = AbortSignal.any([fetchOptions.signal, controller.signal])
            } catch {
                fetchOptions.signal.addEventListener('abort', () => controller.abort(), { once: true })
                combinedSignal = controller.signal
            }
        } else {
            combinedSignal = controller.signal
        }

        try {
            const response = await (fetchImpl || fetch)(url, {
                ...fetchOptions,
                signal: combinedSignal,
            })

            clearTimeout(id)

            if (response.status === 429 && attempt < retries) {
                const retryAfter = response.headers.get('Retry-After')
                let delay = retryDelay * Math.pow(2, attempt)
                if (retryAfter) {
                    const asSeconds = parseInt(retryAfter, 10)
                    if (Number.isFinite(asSeconds) && asSeconds > 0) {
                        delay = Math.min(asSeconds * 1000, 8000)
                    } else {
                        const asDate = Date.parse(retryAfter)
                        if (Number.isFinite(asDate)) {
                            delay = Math.min(Math.max(0, asDate - Date.now()), 8000)
                        }
                    }
                }
                if (DEV) console.warn(`[API] 429 Too Many Requests. Retrying in ${delay}ms...`)
                await new Promise(resolve => setTimeout(resolve, delay))
                continue
            }

            if (response.status >= 500 && attempt < retries && isIdempotent) {
                if (DEV) console.warn(`[API] Server Error ${response.status}. Retrying in ${retryDelay * Math.pow(2, attempt)}ms...`)
                await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)))
                continue
            }

            return response
        } catch (err) {
            clearTimeout(id)
            lastError = err instanceof Error ? err : new Error(String(err))

            if (lastError.name === 'AbortError' && fetchOptions.signal?.aborted) {
                return new Response(null, { status: 499, statusText: 'Client Closed Request' })
            }

            if (attempt < retries && isIdempotent) {
                const isTimeout = lastError.name === 'AbortError'
                const isNetworkError = lastError.message === 'Failed to fetch' || lastError.message.includes('fetch failed')

                if (isTimeout || isNetworkError) {
                    if (DEV) console.warn(`[API] ${isTimeout ? 'Timeout' : 'Network Error'} on attempt ${attempt + 1}. Retrying...`)
                    await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)))
                    continue
                }
            }
            throw lastError
        }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${retries} retries`)
}
