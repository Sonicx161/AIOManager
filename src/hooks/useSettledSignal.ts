import { useEffect, useRef, useState } from 'react'

interface SettleOptions {
    quietMs?: number
    /** Longest an unsettled period may last before it is treated as settled. */
    maxWaitMs?: number
}

/**
 * True while `signal` has been unchanged for `quietMs` and `hold` is false. Flips to false in
 * the same render the signal changes, so a half-loaded value is never presented as final.
 * `maxWaitMs` bounds a signal that never stops changing or a hold that never lifts.
 */
export function useSettledSignal(signal: unknown, hold: boolean, { quietMs = 700, maxWaitMs = 12000 }: SettleOptions = {}): boolean {
    const [box, setBox] = useState<{ signal: unknown; forced: boolean } | null>(null)
    const sinceRef = useRef<number | null>(null)
    const settled = box !== null && Object.is(box.signal, signal) && (!hold || box.forced)

    useEffect(() => {
        if (settled) {
            sinceRef.current = null
            return
        }
        const now = Date.now()
        sinceRef.current ??= now
        const remaining = Math.max(0, maxWaitMs - (now - sinceRef.current))
        const delay = hold ? remaining : Math.min(quietMs, remaining)
        const timer = setTimeout(() => setBox({ signal, forced: hold || delay >= remaining }), delay)
        return () => clearTimeout(timer)
    }, [settled, signal, hold, quietMs, maxWaitMs])

    return settled
}

/** Sticky variant: once settled it stays true, so later refreshes keep their numbers. */
export function useSettledOnce(signal: unknown, hold: boolean, options?: SettleOptions): boolean {
    const settled = useSettledSignal(signal, hold, options)
    const [once, setOnce] = useState(false)
    if (settled && !once) setOnce(true)
    return once || settled
}
