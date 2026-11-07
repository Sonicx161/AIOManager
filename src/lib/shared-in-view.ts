// One shared IntersectionObserver per option set (T3 #25630 pattern): list widgets
// register/unregister elements instead of creating an observer per item.
// Subscriptions are per (observer, element, callback): the same element can be
// observed under several option sets at once, and each observeIntersection call
// returns its own dispose function.

type EntryCallback = (entry: IntersectionObserverEntry) => void

interface SharedObserver {
    observer: IntersectionObserver
    /** Callbacks per element; the element is unobserved when its set empties. */
    handlers: Map<Element, Set<EntryCallback>>
}

const OBSERVERS = new Map<string, SharedObserver>()

function observerKey(rootMargin: string | undefined, threshold: number): string {
    return `${rootMargin ?? ''}|${threshold}`
}

function getSharedObserver(rootMargin: string | undefined, threshold: number): SharedObserver {
    const key = observerKey(rootMargin, threshold)
    let shared = OBSERVERS.get(key)
    if (!shared) {
        shared = {
            observer: new IntersectionObserver(entries => {
                for (const entry of entries) {
                    for (const handler of shared!.handlers.get(entry.target) ?? []) handler(entry)
                }
            }, { rootMargin, threshold }),
            handlers: new Map(),
        }
        OBSERVERS.set(key, shared)
    }
    return shared
}

/**
 * Observe `el` with `onEntry` until the returned disposer is called. Safe to call
 * again for the same element (including under the same options): each subscription
 * is independent.
 */
export function observeIntersection(el: Element, options: { rootMargin?: string; threshold?: number }, onEntry: EntryCallback): () => void {
    const shared = getSharedObserver(options.rootMargin, options.threshold ?? 0)
    let callbacks = shared.handlers.get(el)
    if (!callbacks) {
        callbacks = new Set()
        shared.handlers.set(el, callbacks)
        shared.observer.observe(el)
    }
    callbacks.add(onEntry)
    return () => {
        const set = shared.handlers.get(el)
        if (!set?.delete(onEntry)) return
        if (set.size === 0) {
            shared.handlers.delete(el)
            shared.observer.unobserve(el)
        }
    }
}
