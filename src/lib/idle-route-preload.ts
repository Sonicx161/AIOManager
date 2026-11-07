// Idle page preloading, like Cider's preloadSidebarPages: once the browser is
// idle, prefetch the lazy route chunks of the main navigation pages so tab
// switches render without a chunk round trip. Skipped on Save-Data and slow
// connections.

export const IDLE_PRELOAD_ROUTES: readonly string[] = [
    '/', '/saved-addons', '/activity', '/vault', '/notes', '/metrics', '/replay', '/kronorium', '/settings',
]

export interface IdlePreloadConnection {
    saveData?: boolean
    effectiveType?: string
}

export function shouldSkipIdlePreload(connection: IdlePreloadConnection | undefined): boolean {
    if (connection?.saveData) return true
    return connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g'
}

export interface IdlePreloadOptions {
    routes?: readonly string[]
    /** Returns the route loader's promise when it exposes one; the next route waits for it. */
    preload: (path: string) => unknown
    connection?: () => IdlePreloadConnection | undefined
    /** Session gate: scheduling and every later route stop while it returns false. */
    active?: () => boolean
}

/**
 * Prefetch each route's chunk in sequence, one idle opportunity apart, rechecking
 * the network and session gates before every route. Returns cancellation.
 */
export function scheduleIdleRoutePreload(options: IdlePreloadOptions): () => void {
    if (typeof window === 'undefined') return () => { }
    const routes = options.routes ?? IDLE_PRELOAD_ROUTES
    const connection = options.connection ?? (() => (navigator as (Navigator & { connection?: IdlePreloadConnection }) | undefined)?.connection)
    const active = options.active ?? (() => true)
    const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void }
    let cancelled = false
    let idleHandle: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const whenIdle = (run: () => void) => {
        if ('requestIdleCallback' in window) idleHandle = window.requestIdleCallback(() => { idleHandle = null; run() }, { timeout: 3000 })
        else timer = setTimeout(() => { timer = null; run() }, 2500)
    }
    const halt = () => {
        cancelled = true
        if (idleHandle != null) idleWindow.cancelIdleCallback?.(idleHandle)
        if (timer) clearTimeout(timer)
    }
    const gatesHold = () => {
        if (cancelled || !active()) return false
        return !shouldSkipIdlePreload(connection())
    }
    const run = (index: number) => {
        if (index >= routes.length) return
        if (!gatesHold()) { halt(); return }
        let loaded: unknown
        try { loaded = options.preload(routes[index]) } catch { /* a failed prefetch never blocks the rest */ }
        // Await the loader so a slow download finishes before the next route starts.
        Promise.resolve(loaded).catch(() => { }).then(() => {
            if (cancelled) return
            if (index + 1 >= routes.length) return
            whenIdle(() => run(index + 1))
        })
    }
    whenIdle(() => {
        if (!gatesHold()) { halt(); return }
        run(0)
    })
    return halt
}
