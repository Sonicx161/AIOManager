export interface ResilientFetchOptions extends RequestInit {
    timeout?: number;
    retries?: number;
    retryDelay?: number;
}

export async function resilientFetch(
    url: string,
    options: ResilientFetchOptions = {}
): Promise<Response> {
    const {
        timeout = 10000, // 10s default
        retries = 2,
        retryDelay = 1000,
        ...fetchOptions
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal,
            });

            clearTimeout(id);

            // Handle 429 Too Many Requests - consider it a temporary failure
            if (response.status === 429 && attempt < retries) {
                const retryAfter = response.headers.get('Retry-After');
                const delay = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay * Math.pow(2, attempt);
                console.warn(`[API] 429 Too Many Requests. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // Handle 5xx Server Errors - consider them temporary
            if (response.status >= 500 && attempt < retries) {
                console.warn(`[API] Server Error ${response.status}. Retrying in ${retryDelay * Math.pow(2, attempt)}ms...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
                continue;
            }

            return response;
        } catch (err: any) {
            clearTimeout(id);
            lastError = err instanceof Error ? err : new Error(String(err));

            if (attempt < retries) {
                const isTimeout = err.name === 'AbortError';
                const isNetworkError = err.message === 'Failed to fetch';

                if (isTimeout || isNetworkError) {
                    console.warn(`[API] ${isTimeout ? 'Timeout' : 'Network Error'} on attempt ${attempt + 1}. Retrying...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
                    continue;
                }
            }
            throw lastError;
        }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${retries} retries`);
}
