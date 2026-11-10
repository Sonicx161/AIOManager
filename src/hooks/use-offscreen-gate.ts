import { useLayoutEffect, type RefObject, useState } from 'react'
import { observeIntersection } from '@/lib/shared-in-view'

// Paint containment changes on-screen glyph rasterization, so the skip class is held
// only while the item is offscreen; a layout effect resolves the first state before paint.
export function useOffscreenGate<T extends HTMLElement>(ref: RefObject<T | null>, skipClass: string | undefined) {
    const [offscreen, setOffscreen] = useState(Boolean(skipClass))
    useLayoutEffect(() => {
        const el = ref.current
        if (!el || !skipClass) return
        const rect = el.getBoundingClientRect()
        setOffscreen(rect.bottom <= 0 || rect.top >= window.innerHeight)
        if (typeof IntersectionObserver === 'undefined') {
            setOffscreen(false)
            return
        }
        return observeIntersection(el, { rootMargin: '0px', threshold: 0 }, entry => setOffscreen(!entry.isIntersecting))
    }, [ref, skipClass])
    return offscreen ? skipClass : undefined
}
