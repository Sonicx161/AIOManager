// Idle page preloading, like Cider's preloadSidebarPages: after the first
// authenticated screen has settled plus idle, prefetch the lazy chunks of the
// most likely next routes so tab switches render without a chunk round trip.
// Earlier than that the fetches contend with login-critical chunks; every other
// route stays covered by hover/intent prefetch. Skipped on Save-Data and slow
// connections.

export const IDLE_PRELOAD_ROUTES: readonly string[] = ['/saved-addons', '/activity']

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
    /** Network-quiet stretch required before the first prefetch arms; it still starts only at idle. */
    armQuietMs?: number}

/**
 * Prefetch each route's chunk in sequence, one idle opportunity apart, rechecking
 * the network and session gates before every route. The first fetch waits for a
 * network-quiet stretch after the session opens, so it never lands inside the
 * first screen's own download window. Returns cancellation.
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
    let observer: PerformanceObserver | null = null
    let armTimer: ReturnType<typeof setTimeout> | null = null
    let lastStart = performance.now()
    const whenIdle = (run: () => void) => {
        if ('requestIdleCallback' in window) idleHandle = window.requestIdleCallback(() => { idleHandle = null; run() }, { timeout: 3000 })
        else timer = setTimeout(() => { timer = null; run() }, 2500)
    }
    const stopArmWatch = () => {
        if (armTimer) { clearTimeout(armTimer); armTimer = null }
        if (observer) { observer.disconnect(); observer = null }
    }
    const halt = () => {
        cancelled = true
        if (idleHandle != null) idleWindow.cancelIdleCallback?.(idleHandle)
        if (timer) clearTimeout(timer)
        stopArmWatch()
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
    const arm = () => whenIdle(() => {
        if (!gatesHold()) { halt(); return }
        run(0)
    })
    const quietMs = options.armQuietMs ?? 4000
    const armWhenSettled = () => {
        const began = performance.now()
        const tick = () => {
            if (cancelled) { stopArmWatch(); return }
            const now = performance.now()
            const quietFor = now - lastStart
            if ((quietFor >= quietMs && now - began >= 3000) || now - began >= 20000) { stopArmWatch(); arm(); return }
            armTimer = setTimeout(tick, 500)
        }
        armTimer = setTimeout(tick, 500)
    }
    try {
        observer = new PerformanceObserver(list => {
            for (const e of list.getEntries()) lastStart = Math.max(lastStart, e.startTime)
        })
        observer.observe({ type: 'resource', buffered: true })
        armWhenSettled()
    } catch {
        observer = null
        timer = setTimeout(arm, 7000)
    }
    return halt
}
