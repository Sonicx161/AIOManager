export type LightboxFocusTarget = 'next' | 'previous' | 'close'

// When the focused arrow disappears at either end, keep keyboard focus on the arrow that is left.
export function lightboxFocusAfterStep(focusLost: boolean, hasPrevious: boolean, hasNext: boolean): LightboxFocusTarget | null {
    if (!focusLost) return null
    if (hasNext) return 'next'
    if (hasPrevious) return 'previous'
    return 'close'
}

export type LightboxStrayAction = 'close' | 'previous' | 'next' | 'swallow' | 'focus'

// Keys that arrive while focus sits outside the lightbox (on the page body or behind it).
export function lightboxStrayKey(e: { key: string; altKey: boolean }, index: number, count: number): LightboxStrayAction | null {
    if (e.key === 'Escape') return 'close'
    if (e.key === 'Tab') return 'focus'
    if (e.key === 'ArrowLeft') return index > 0 ? 'previous' : e.altKey ? 'swallow' : null
    if (e.key === 'ArrowRight') return index < count - 1 ? 'next' : e.altKey ? 'swallow' : null
    return null
}
