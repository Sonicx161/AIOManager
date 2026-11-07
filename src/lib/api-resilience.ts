export interface ResilientFetchOptions extends RequestInit {
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    // Override for POST/PATCH that are safe to repeat (a read-shaped RPC, or one carrying an
    // idempotency key). By default only spec-idempotent methods are retried on ambiguous failures.
    idempotent?: boolean;
}

// Sync uploads carry multi-MB encrypted envelopes (avatars, backfill events); the 10 s
// default aborts every push on a slow uplink. Budget a conservative 128 KB/s on top of a
// generous base, capped so a stuck socket still fails within a few minutes.
export const SYNC_UPLOAD_FLOOR_MS = 30_000;
export const SYNC_UPLOAD_MAX_MS = 300_000;
const SYNC_UPLOAD_CHUNK_BYTES = 128 * 1024;

export function syncUploadTimeoutMs(bodyLength: number): number {
    const sizeMs = Math.ceil(Math.max(0, bodyLength) / SYNC_UPLOAD_CHUNK_BYTES) * 1000;
    return Math.min(SYNC_UPLOAD_FLOOR_MS + sizeMs, SYNC_UPLOAD_MAX_MS);
}

// Pull/mirror responses can be equally large with no up-front size hint, so budget a
// generous fixed floor.
export const SYNC_PULL_TIMEOUT_MS = 60_000;

export async function resilientFetch(
    url: string,
    options: ResilientFetchOptions = {}
): Promise<Response> {
    const {
        timeout = 10000,
        retries = 2,
        retryDelay = 1000,
        idempotent,
        ...fetchOptions
    } = options;

    // 5xx/timeout/network are ambiguous: the write may have executed server-side, so retrying a
    // non-idempotent POST (AddonCollectionSet, DatastorePut, signup) can double-write. Only retry
    // those for idempotent methods (or when the caller explicitly opts in). 429 is different (the
    // server rejected the request before processing), so it stays retryable for any method below.
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const isIdempotent = idempotent ?? ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(new DOMException(`Request timed out after ${Math.round(timeout / 1000)}s`, 'TimeoutError')), timeout);

        let combinedSignal: AbortSignal;
        if (fetchOptions.signal) {
            try {
                combinedSignal = AbortSignal.any([fetchOptions.signal, controller.signal]);
            } catch {
                fetchOptions.signal.addEventListener('abort', () => controller.abort(), { once: true });
                combinedSignal = controller.signal;
            }
        } else {
            combinedSignal = controller.signal;
        }

        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: combinedSignal,
            });

            clearTimeout(id);

            if (response.status === 429 && attempt < retries) {
                const retryAfter = response.headers.get('Retry-After');
                let delay = retryDelay * Math.pow(2, attempt);
                if (retryAfter) {
                    const asSeconds = parseInt(retryAfter, 10);
                    if (Number.isFinite(asSeconds) && asSeconds > 0) {
                        delay = Math.min(asSeconds * 1000, 8000);
                    } else {
                        const asDate = Date.parse(retryAfter);
                        if (Number.isFinite(asDate)) {
                            delay = Math.min(Math.max(0, asDate - Date.now()), 8000);
                        }
                    }
                }
                if (import.meta.env.DEV) console.warn(`[API] 429 Too Many Requests. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (response.status >= 500 && attempt < retries && isIdempotent) {
                if (import.meta.env.DEV) console.warn(`[API] Server Error ${response.status}. Retrying in ${retryDelay * Math.pow(2, attempt)}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
                continue;
            }

            return response;
        } catch (err) {
            clearTimeout(id);
            lastError = err instanceof Error ? err : new Error(String(err));

            if (lastError.name === 'AbortError' && fetchOptions.signal?.aborted) {
                return new Response(null, { status: 499, statusText: 'Client Closed Request' })
            }

            if (attempt < retries && isIdempotent) {
                const isTimeout = lastError.name === 'AbortError';
                const isNetworkError = lastError.message === 'Failed to fetch';

                if (isTimeout || isNetworkError) {
                    if (import.meta.env.DEV) console.warn(`[API] ${isTimeout ? 'Timeout' : 'Network Error'} on attempt ${attempt + 1}. Retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
                    continue;
                }
            }
            throw lastError;
        }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${retries} retries`);
}
