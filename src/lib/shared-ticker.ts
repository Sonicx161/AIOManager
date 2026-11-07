interface TickerEnv {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
    isHidden: () => boolean
    onVisible: (fn: () => void) => () => void
}

export interface SharedTicker {
    subscribe: (fn: () => void) => () => void
    size: () => number
}

const browserEnv = (): TickerEnv => ({
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    onVisible: fn => {
        const handler = () => { if (!document.hidden) fn() }
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
    },
})

/** One interval shared by all subscribers; paused while the tab is hidden, fires once on return. */
export function createSharedTicker(intervalMs: number, env: TickerEnv = browserEnv()): SharedTicker {
    const subscribers = new Set<() => void>()
    let handle: unknown = null
    let offVisible: (() => void) | null = null

    const notify = () => { for (const fn of subscribers) fn() }

    const start = () => {
        if (handle !== null) return
        handle = env.setInterval(() => { if (!env.isHidden()) notify() }, intervalMs)
        offVisible = env.onVisible(notify)
    }

    const stopIfIdle = () => {
        if (subscribers.size > 0 || handle === null) return
        env.clearInterval(handle)
        handle = null
        offVisible?.()
        offVisible = null
    }

    return {
        subscribe: fn => {
            subscribers.add(fn)
            start()
            return () => {
                subscribers.delete(fn)
                stopIfIdle()
            }
        },
        size: () => subscribers.size,
    }
}
