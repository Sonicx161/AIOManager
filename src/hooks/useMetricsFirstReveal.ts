import { useEffect, useRef, useState } from 'react'
import { useSettledSignal, useSettledOnce } from './useSettledSignal.ts'
import { metricsCommitGate } from './metrics-gates.ts'
import type { MetricsResult } from './useMetricsWorker.ts'

export interface MetricsFirstRevealInput {
    history: unknown
    cacheLoading: boolean
    /** Jellyfin media reads or identity enrichment still in flight. */
    mediaSettling: boolean
    latest: MetricsResult | null
    /** True when latest was computed for the current source snapshot. */
    isCurrent: boolean
    /** Session/workspace identity; a change re-arms the first-reveal hold. */
    scope: string
}

/**
 * First-reveal commit state for Metrics: the first result waits for settled history, Jellyfin
 * media reads plus identity enrichment and a worker result computed from that settled data,
 * capped at 20 s and re-armed on scope switches. A commit released by the cap stays
 * provisional until media settled and a current result arrived.
 */
export function useMetricsFirstReveal({ history, cacheLoading, mediaSettling, latest, isCurrent, scope }: MetricsFirstRevealInput): {
    committed: { scope: string; value: MetricsResult } | null
    dataSettled: boolean
    provisional: boolean
} {
    const dataSettled = useSettledSignal(history, cacheLoading)
    const firstSettled = useSettledOnce(history, mediaSettling || !isCurrent, { maxWaitMs: 20000, resetKey: scope })
    const [committed, setCommitted] = useState<{ scope: string; value: MetricsResult } | null>(null)
    const [capped, setCapped] = useState(false)
    const [cappedScope, setCappedScope] = useState(scope)
    const firstCommit = useRef(false)
    if (cappedScope !== scope) {
        setCappedScope(scope)
        setCapped(false)
        firstCommit.current = false
    }
    const provisional = capped && (mediaSettling || !isCurrent)
    useEffect(() => {
        if (!latest || !metricsCommitGate(latest, dataSettled && firstSettled)) return
        if (!firstCommit.current) {
            firstCommit.current = true
            if (mediaSettling || !isCurrent) setCapped(true)
        }
        setCommitted(prev => (prev && prev.scope === scope && prev.value === latest ? prev : { scope, value: latest }))
    }, [latest, dataSettled, firstSettled, scope, mediaSettling, isCurrent])
    useEffect(() => {
        if (capped && !mediaSettling && isCurrent) setCapped(false)
    }, [capped, mediaSettling, isCurrent])
    return { committed, dataSettled, provisional }
}
