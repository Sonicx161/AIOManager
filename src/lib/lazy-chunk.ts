import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

const CHUNK_RETRY_KEY = 'aiom:chunk-retry'

type LazyFactory = Parameters<typeof lazy>[0]
// React's own inference for this factory shape; props stay as loose as before.
type LazyExoticOfFactory = LazyExoticComponent<Awaited<ReturnType<LazyFactory>>['default']>

export type LazyChunk<T extends { default: ComponentType<never> }> = LazyExoticOfFactory & {
    // Fetches (and caches) the chunk without mounting. Safe to call on
    // intent (hover/focus/touch) and during boot.
    preload: () => Promise<T | null>
}

// A failed dynamic import (deploy window, transient network error) is otherwise
// fatal for the tab. Reload once; a second failure surfaces to the boundary.
export function lazyChunk<T extends { default: ComponentType<never> }>(load: () => Promise<T>): LazyChunk<T> {
    let inflight: Promise<T> | null = null
    const start = (): Promise<T> => {
        if (!inflight) {
            inflight = load().catch((error: unknown) => {
                // Allow a fresh attempt after a failure instead of caching it forever.
                inflight = null
                throw error
            })
        }
        return inflight
    }
    const chunk = lazy((async (): Promise<T> => {
        try {
            const mod = await start()
            sessionStorage.removeItem(CHUNK_RETRY_KEY)
            return mod
        } catch (error) {
            if (!sessionStorage.getItem(CHUNK_RETRY_KEY)) {
                sessionStorage.setItem(CHUNK_RETRY_KEY, '1')
                window.location.reload()
            }
            throw error
        }
    }) as unknown as LazyFactory) as unknown as LazyChunk<T>
    // A failed preload stays silent: the mount-time load retries and owns the
    // one-shot reload guard.
    chunk.preload = () => start().catch(() => null)
    return chunk
}

// Same failure guard as lazyChunk for non-component chunks: a failed dynamic
// import (deploy window, transient network error) would otherwise surface as a
// bare rejected action. Reload once; a second failure surfaces to the caller.
export function guardedImport<T>(load: () => Promise<T>): () => Promise<T> {
    return () => load().catch((error: unknown) => {
        if (!sessionStorage.getItem(CHUNK_RETRY_KEY)) {
            sessionStorage.setItem(CHUNK_RETRY_KEY, '1')
            window.location.reload()
        }
        throw error
    })
}
