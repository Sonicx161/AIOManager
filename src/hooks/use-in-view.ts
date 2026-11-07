import { useEffect, useRef, useState } from 'react'
import { observeIntersection } from '@/lib/shared-in-view'

export function useInView<T extends HTMLElement>(threshold = 0.1) {
    const ref = useRef<T>(null)
    const [inView, setInView] = useState(false)

    useEffect(() => {
        const el = ref.current
        if (!el) return

        if (typeof IntersectionObserver === 'undefined') {
            setInView(true)
            return
        }

        let raf1 = 0
        let raf2 = 0

        const trigger = () => {
            if (raf1) cancelAnimationFrame(raf1)
            raf1 = requestAnimationFrame(() => {
                raf2 = requestAnimationFrame(() => setInView(true))
            })
        }

        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight + 50 && rect.bottom > -50) {
            trigger()
            return () => {
                cancelAnimationFrame(raf1)
                cancelAnimationFrame(raf2)
            }
        }

        const disposeObserver = observeIntersection(el, { threshold, rootMargin: '50px' }, entry => {
            if (entry.isIntersecting && entry.target.getBoundingClientRect().height > 0) {
                setInView(true)
                disposeObserver()
            }
        })

        return () => {
            cancelAnimationFrame(raf1)
            cancelAnimationFrame(raf2)
            disposeObserver()
        }
    }, [threshold])

    return { ref, inView }
}
