// The deduplicated canonicalAddons push form is used only while the server that
// advertised it is the one answering. The state is scoped to the API endpoint and
// sync identity, and every V2 push must come back with an explicit acknowledgment:
// a rolled-back server accepts the blob but ignores the unknown field, so a reply
// without it means the canonical part was never applied.
//
// Servers advertise canonicalAddonsV2Ack alongside canonicalAddonsV2 once they
// acknowledge; a server advertising only the older flag gets inline pushes. A
// missing acknowledgment or a negative probe holds legacy-only for this scope until
// the recheck interval passes, so mixed or older deployments are not sent V2 plus
// an inline repair on every changed push.

export interface CanonicalV2Latch {
    scope: string
    supported: boolean
    at: number
}

export const CANONICAL_V2_ACK = 'accepted'
export const CANONICAL_V2_RECHECK_MS = 30 * 60 * 1000

export type CanonicalV2Probe = 'supported' | 'unsupported' | 'unknown'
export type CanonicalV2Decision = 'v2' | 'legacy' | 'probe'

export function canonicalV2Scope(apiPath: string, syncUserId: string): string {
    return `${apiPath}\n${syncUserId}`
}

export function readCanonicalV2Probe(health: unknown): CanonicalV2Probe {
    if (!health || typeof health !== 'object') return 'unknown'
    const caps = (health as Record<string, unknown>).capabilities as Record<string, unknown> | undefined
    return caps?.canonicalAddonsV2 === true && caps?.canonicalAddonsV2Ack === true ? 'supported' : 'unsupported'
}

export function canonicalV2Decision(latch: CanonicalV2Latch | null, scope: string, now: number): CanonicalV2Decision {
    if (!latch || latch.scope !== scope) return 'probe'
    if (latch.supported) return 'v2'
    return now - latch.at < CANONICAL_V2_RECHECK_MS ? 'legacy' : 'probe'
}

// State after a probe; an unreachable health endpoint leaves the question open.
export function latchAfterProbe(previous: CanonicalV2Latch | null, scope: string, probe: CanonicalV2Probe, now: number): CanonicalV2Latch | null {
    if (probe === 'unknown') return previous && previous.scope === scope ? previous : null
    return { scope, supported: probe === 'supported', at: now }
}

export function latchAfterMissingAck(scope: string, now: number): CanonicalV2Latch {
    return { scope, supported: false, at: now }
}

export function canonicalV2Acknowledged(response: unknown): boolean {
    return !!response && typeof response === 'object' && (response as Record<string, unknown>).canonicalAddonsV2 === CANONICAL_V2_ACK
}

export type CanonicalV2PushOutcome = 'complete' | 'retry-legacy'

// What to do with a push reply. A conflict never carries receipts, so it falls
// through to the normal conflict handling either way.
export function canonicalV2PushOutcome(sentV2: boolean, response: unknown): CanonicalV2PushOutcome {
    if (!sentV2) return 'complete'
    if (response && typeof response === 'object' && (response as Record<string, unknown>).conflict) return 'complete'
    return canonicalV2Acknowledged(response) ? 'complete' : 'retry-legacy'
}
