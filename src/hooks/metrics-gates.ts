import type { MetricsResult } from './useMetricsWorker'

/** A settled same-scope result may commit even when superseded (shown as refreshing); another scope's never. */
export function metricsCommitGate(latest: MetricsResult | null | undefined, dataSettled: boolean): boolean {
    return !!latest && dataSettled
}
