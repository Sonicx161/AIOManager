export type SimulationVerdictTone = 'neutral' | 'failover' | 'warning'
export type SimulationVerdictIcon = 'check' | 'switch' | 'alert'

export interface SimulationVerdict {
    text: string
    tone: SimulationVerdictTone
    icon: SimulationVerdictIcon
}

export interface SimulationChainResult {
    healthy: boolean
    checking: boolean
    error?: string
}

export interface SimulationCheckResult {
    healthy: boolean
    checking: boolean
    error?: string
    code?: number
}

export interface SimulationVerdictInput {
    chainUrls: string[]
    chainResults: Record<string, SimulationChainResult>
    customChecks: Array<{ url: string; appliesTo: string[] }>
    customCheckResults: Record<string, SimulationCheckResult>
    addonName: (url: string) => string
    normalizeUrl: (url: string) => string
}

// Same conclusion wording the simulate panel has always shown, extracted so the
// banner can pick an icon and tone from the same result.
export function simulationVerdict(input: SimulationVerdictInput): SimulationVerdict {
    const { chainUrls, chainResults, customChecks, customCheckResults, addonName, normalizeUrl } = input
    const primaryUrl = chainUrls[0]
    const normalizedChainUrls = chainUrls.map(u => normalizeUrl(u).toLowerCase())
    const failedCustomUrls = [...new Set(customChecks
        .filter(c => {
            const r = customCheckResults[c.url]
            return !!r && !r.checking && !r.healthy
        })
        .map(c => c.url))]
    const isSunkByCustom = (idx: number) => customChecks.some(c => {
        const r = customCheckResults[c.url]
        if (!r || r.checking || r.healthy) return false
        return c.appliesTo.length === 0 || c.appliesTo.some(au => normalizeUrl(au).toLowerCase() === normalizedChainUrls[idx])
    })
    const isEffectivelyHealthy = (idx: number) => Boolean(chainResults[chainUrls[idx]]?.healthy) && !isSunkByCustom(idx)

    const checksFailedPart = failedCustomUrls.length !== 1 ? 's' : ''
    const failedList = failedCustomUrls.join(', ')

    if (isEffectivelyHealthy(0)) {
        return { text: `${addonName(primaryUrl)} is healthy - no failover needed.`, tone: 'neutral', icon: 'check' }
    }

    if (chainResults[primaryUrl]?.healthy && failedCustomUrls.length > 0) {
        const fallbackIdx = chainUrls.findIndex((_, idx) => idx > 0 && isEffectivelyHealthy(idx))
        if (fallbackIdx !== -1) {
            return {
                text: `${addonName(primaryUrl)} is reachable, but custom check${checksFailedPart} failed (${failedList}) - Autopilot would treat it as unhealthy. Would failover to ${addonName(chainUrls[fallbackIdx])}.`,
                tone: 'failover',
                icon: 'switch',
            }
        }
        return {
            text: `${addonName(primaryUrl)} is reachable, but custom check${checksFailedPart} failed (${failedList}) - Autopilot would treat it as unhealthy. No healthy fallback - rule would stay in its current state.`,
            tone: 'warning',
            icon: 'alert',
        }
    }

    const healthyFallbackIdx = chainUrls.findIndex((_, idx) => idx > 0 && isEffectivelyHealthy(idx))
    if (healthyFallbackIdx !== -1) {
        return {
            text: `Would failover from ${addonName(primaryUrl)} to ${addonName(chainUrls[healthyFallbackIdx])} (first healthy fallback).`,
            tone: 'failover',
            icon: 'switch',
        }
    }

    if (failedCustomUrls.length > 0 && chainUrls.some((url, idx) => idx > 0 && chainResults[url]?.healthy)) {
        return {
            text: `No addon passes all health checks - custom check${checksFailedPart} failed (${failedList}). Rule would stay in its current state.`,
            tone: 'warning',
            icon: 'alert',
        }
    }

    return {
        text: 'All addons in the chain are currently unreachable. Rule would stay in its current state.',
        tone: 'warning',
        icon: 'alert',
    }
}
