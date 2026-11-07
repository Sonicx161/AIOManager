import type { KeyboardEvent } from 'react'

export const PRESSABLE_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'

/** Button semantics for a clickable card that cannot be a <button>: focusable, Enter and Space activate. */
export function pressable(onActivate: () => void, label?: string) {
    return {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': label || undefined,
        onClick: onActivate,
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
            e.preventDefault()
            onActivate()
        },
    }
}
