/**
 * Three-way merge for the server-readable canonical addon store (the D2 "client is
 * the single merger" path).
 *
 * Background: non-Stremio Hubs (Nuvio-only / local-only) expose their addon list to
 * inbound partners (e.g. AIOStreams) through `account_canonical_addons` on the server.
 * That store is the ONE place a writer other than this client can change a Hub. When the
 * client syncs it must fold any inbound changes into `account.addons` BEFORE pushing,
 * or its push clobbers them.
 *
 * Why a three-way merge (not a union or a mirror):
 *   - A plain UNION resurrects addons the user deleted locally (the deletion looks
 *     identical to "remote still has it").
 *   - A MIRROR of the newer side drops additions made on the other side.
 * Only a three-way merge against a common ancestor (`base`, the canonical this client
 * last reconciled to) can tell a local delete from an inbound add.
 *
 * Default policy: inbound adds/updates propagate into the Hub; inbound DELETES do not
 * shrink it (AIOStreams is an add/update writer; removals stay an AIOManager action).
 * Flip with `inboundDeletesShrink: true`. This is the only behavioural knob; everything
 * else is forced by correctness.
 */

export interface CanonicalAddon {
    transportUrl: string
    [key: string]: unknown
}

export interface ThreeWayMergeOptions {
    /**
     * When true, an addon present in `base` but absent from `remote` is treated as an
     * inbound deletion and removed. Default false: inbound writers add/update only.
     */
    inboundDeletesShrink?: boolean
}

export interface ThreeWayMergeResult {
    /** The merged addon list, ordered local-first then inbound-added. */
    addons: CanonicalAddon[]
    /** True when `addons` differs from `local`; the client must adopt and re-push. */
    changed: boolean
}

function keyOf(a: CanonicalAddon | undefined): string {
    if (!a || typeof a !== 'object') return ''
    const url = (a.transportUrl ?? (a as Record<string, unknown>).url) as unknown
    return typeof url === 'string' ? url : ''
}

/** Deterministic stringify (recursively key-sorted) for value-equality comparison. */
function stable(value: unknown): string {
    return JSON.stringify(sortDeep(value))
}

type StableOf = (value: CanonicalAddon) => string

function memoStable(): StableOf {
    const memo = new WeakMap<object, string>()
    return (value) => {
        if (!value || typeof value !== 'object') return stable(value)
        let s = memo.get(value)
        if (s === undefined) { s = stable(value); memo.set(value, s) }
        return s
    }
}

function listsDiffer(a: CanonicalAddon[], b: CanonicalAddon[], stableOf: StableOf): boolean {
    if (a.length !== b.length) return true
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i]
        if (x === y) continue
        const bothObjects = !!x && typeof x === 'object' && !!y && typeof y === 'object'
        if (bothObjects ? stableOf(x) !== stableOf(y) : stable([x]) !== stable([y])) return true
    }
    return false
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortDeep)
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortDeep((value as Record<string, unknown>)[k])
        }
        return out
    }
    return value
}

/**
 * Merge an inbound `remote` canonical list with the client's `local` addons against the
 * `base` (the canonical this client last reconciled to; pass null/[] if none recorded).
 *
 * First-run safety: with no recorded base the client has never folded this Hub, so a
 * populated remote is external inbound content (API-key writers) — NOT evidence of the
 * client's own last push. Every remote entry is treated as an inbound add and folded in;
 * local deletes can only exist once a base exists to compare against. (The previous
 * first-run behaviour treated remote as the ancestor, which silently swallowed every
 * external write to a fold-virgin Hub — the exact data the feature exists to carry.)
 */
export function threeWayMergeCanonical(
    base: CanonicalAddon[] | null | undefined,
    local: CanonicalAddon[],
    remote: CanonicalAddon[],
    opts: ThreeWayMergeOptions = {},
): ThreeWayMergeResult {
    const inboundDeletesShrink = opts.inboundDeletesShrink ?? false
    const stableOf = memoStable()
    const hasRecordedBase = !!(base && base.length)
    if (!hasRecordedBase) {
        const localMap = new Map<string, CanonicalAddon>()
        for (const a of local) { const k = keyOf(a); if (k) localMap.set(k, a) }
        const result: CanonicalAddon[] = [...local]
        for (const a of remote) {
            const k = keyOf(a)
            if (!k || localMap.has(k)) continue
            localMap.set(k, a)
            result.push(a)
        }
        return { addons: result, changed: listsDiffer(result, local, stableOf) }
    }
    const effectiveBase = base

    const localMap = new Map<string, CanonicalAddon>()
    for (const a of local) { const k = keyOf(a); if (k) localMap.set(k, a) }
    const remoteMap = new Map<string, CanonicalAddon>()
    for (const a of remote) { const k = keyOf(a); if (k) remoteMap.set(k, a) }
    const baseMap = new Map<string, CanonicalAddon>()
    for (const a of effectiveBase) { const k = keyOf(a); if (k) baseMap.set(k, a) }

    // Local ordering first (preserves user-curated priority), inbound-added appended.
    const orderedKeys: string[] = []
    const seen = new Set<string>()
    for (const a of local) { const k = keyOf(a); if (k && !seen.has(k)) { seen.add(k); orderedKeys.push(k) } }
    for (const a of remote) { const k = keyOf(a); if (k && !seen.has(k)) { seen.add(k); orderedKeys.push(k) } }

    const result: CanonicalAddon[] = []
    for (const k of orderedKeys) {
        const L = localMap.get(k)
        const R = remoteMap.get(k)
        const B = baseMap.get(k)
        const inL = !!L, inR = !!R, inB = !!B

        if (inL && inR) {
            // Present both sides → resolve updates. Inbound update wins when remote
            // diverged from base; otherwise keep local (carries client-side edits).
            const remoteChanged = inB ? R !== B && stableOf(R as CanonicalAddon) !== stableOf(B as CanonicalAddon) : true
            const localChanged = inB ? L !== B && stableOf(L as CanonicalAddon) !== stableOf(B as CanonicalAddon) : true
            if (!remoteChanged && localChanged) result.push(L as CanonicalAddon)
            else if (remoteChanged) result.push(R as CanonicalAddon) // inbound wins ties
            else result.push(L as CanonicalAddon)
        } else if (inL && !inR) {
            if (inB) {
                // In base + local, gone from remote → inbound deletion.
                if (!inboundDeletesShrink) result.push(L as CanonicalAddon)
            } else {
                // Not in base → client added it since last sync → keep.
                result.push(L as CanonicalAddon)
            }
        } else if (!inL && inR) {
            if (inB) {
                // In base + remote, gone from local → client deleted it → honour (drop).
            } else {
                // Not in base, not local → inbound add → take it.
                result.push(R as CanonicalAddon)
            }
        }
        // !inL && !inR → removed everywhere → omit.
    }

    return { addons: result, changed: listsDiffer(result, local, stableOf) }
}
