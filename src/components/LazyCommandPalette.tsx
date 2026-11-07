import { useEffect, useState, type ComponentType } from 'react'

// The palette UI is code-split; the shortcut listeners are not. They stay registered until the
// loaded palette has registered its own, so presses during a slow first load still toggle it.
type PaletteComponent = ComponentType<{ initiallyOpen?: boolean }>

// One shared promise per load: the idle preload, the hover preload, and the
// mount path below all resolve the exact same module. The palette mounts
// directly from the resolved module instead of through Suspense + lazy, whose
// committed fallback throttles the content retry by ~300ms in React.

// Extracted for tests: dedupe concurrent loads into one in-flight promise. A
// failed load clears the cache so the next open retries instead of caching the
// rejection for the whole tab session.
export function createPaletteChunkLoader(load: () => Promise<PaletteComponent>): () => Promise<PaletteComponent> {
    let promise: Promise<PaletteComponent> | null = null
    return () => {
        if (promise) return promise
        promise = load().catch((error: unknown) => {
            promise = null
            throw error
        })
        return promise
    }
}

// Same contract as lazyChunk: one reload picks up new hashed chunks after a
// deploy; a second failure surfaces instead of reload-looping.
const CHUNK_RETRY_KEY = 'aiom:chunk-retry'
const loadPaletteComponent = (): Promise<PaletteComponent> =>
    import('@/components/CommandPalette')
        .then(m => m.CommandPalette)
        .catch((error: unknown) => {
            if (!sessionStorage.getItem(CHUNK_RETRY_KEY)) {
                sessionStorage.setItem(CHUNK_RETRY_KEY, '1')
                window.location.reload()
            }
            throw error
        })

const getPalette = createPaletteChunkLoader(loadPaletteComponent)
const ensurePalette = (): Promise<PaletteComponent> => getPalette()

let preloaded = false

/** Warm the palette's chunks before the first open: keyboard shortcut, search
 * results virtualizer, and the bulk-action registry the index needs. */
export function preloadCommandPalette() {
    if (preloaded) return
    preloaded = true
    ensurePalette().catch(() => { preloaded = false })
    import('@/components/CommandPaletteResults').catch(() => {})
    import('@/components/accounts/bulk-actions/registry').catch(() => {})
}

export function LazyCommandPalette() {
    const [requestedOpen, setRequestedOpen] = useState<boolean | null>(null)
    const [ready, setReady] = useState(false)
    const [Palette, setPalette] = useState<PaletteComponent | null>(null)

    useEffect(() => {
        if (ready) return
        const keyHandler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault()
                setRequestedOpen(open => !open)
            }
        }
        const openHandler = () => setRequestedOpen(true)
        window.addEventListener('keydown', keyHandler)
        window.addEventListener('open-command-palette', openHandler)
        return () => {
            window.removeEventListener('keydown', keyHandler)
            window.removeEventListener('open-command-palette', openHandler)
        }
    }, [ready])

    // The palette used to cost a 6-chunk waterfall on the first Ctrl+K. Load it
    // once the app is idle so that first open pays only the mount.
    useEffect(() => {
        let cancelled = false
        if (typeof requestIdleCallback === 'function') {
            const id = requestIdleCallback(() => { preloadCommandPalette(); ensurePalette().then(m => { if (!cancelled) setPalette(() => m) }).catch(() => {}) }, { timeout: 5000 })
            return () => { cancelled = true; cancelIdleCallback(id) }
        }
        const timer = setTimeout(() => { preloadCommandPalette(); ensurePalette().then(m => { if (!cancelled) setPalette(() => m) }).catch(() => {}) }, 2500)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [])

    // First press beats the idle preload: start loading now (same waterfall as
    // before, but mounted directly from the module once it arrives).
    useEffect(() => {
        if (requestedOpen === null || Palette) return
        let cancelled = false
        ensurePalette().then(m => { if (!cancelled) setPalette(() => m) }).catch(() => {})
        return () => { cancelled = true }
    }, [requestedOpen, Palette])

    useEffect(() => {
        if (Palette && requestedOpen !== null) setReady(true)
    }, [Palette, requestedOpen])

    if (requestedOpen === null || !Palette) return null
    return <Palette initiallyOpen={requestedOpen} />
}
