// Per-addon destination policy — server twin of src/lib/addon-destinations.ts.
// The client pushes the full canonical list (each descriptor carries its own
// `destinations`); the server projects per connection with these helpers before
// any platform write. Semantics must stay identical to the client module — the
// parity tests in server/tests/addon-destinations.test.js mirror the client's.
//
// Exclusions are a deny-list on the hub row: absent policy = sync everywhere.
// Platform entries cover every login of that platform (present and future);
// connection ids are exact stable login ids. Exclusion removes the target's copy
// on its next sync — it never deletes the hub row and never leaks onto the
// provider wire (drivers receive the already-projected list).
import { normalizeAddonUrl } from './addon-url.js'

export function normalizeDestinations(destinations) {
    if (!destinations || typeof destinations !== 'object') return undefined
    const cleanList = (values) => {
        if (!Array.isArray(values)) return undefined
        const cleaned = [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))].sort()
        return cleaned.length > 0 ? cleaned : undefined
    }
    const excludedPlatforms = cleanList(destinations.excludedPlatforms)
    const excludedConnections = cleanList(destinations.excludedConnections)
    if (!excludedPlatforms && !excludedConnections) return undefined
    return {
        ...(excludedPlatforms ? { excludedPlatforms } : {}),
        ...(excludedConnections ? { excludedConnections } : {}),
    }
}

export function isExcludedFromDestinations(destinations, target) {
    if (!destinations || typeof destinations !== 'object') return false
    const platform = String(target?.platform || '').toLowerCase()
    if (platform && (destinations.excludedPlatforms || []).some((p) => String(p || '').trim().toLowerCase() === platform)) return true
    const connId = target?.connectionId
    if (connId && (destinations.excludedConnections || []).includes(connId)) return true
    return false
}

// Connection-shaped projection: a resolved server connection carries its stable id
// and platform. Policy attaches to the login identity, never its live state.
export function isAddonExcludedFrom(addon, connection) {
    return isExcludedFromDestinations(addon?.destinations, { platform: connection?.platform, connectionId: connection?.id })
}

export function connectionEffectiveAddons(addons, connection) {
    return (Array.isArray(addons) ? addons : []).filter((a) => !isAddonExcludedFrom(a, connection))
}

// Normalized transport URLs the connection's policy removes — feeds shrink
// authorization and the exclusion-aware chain guard below.
export function connectionExcludedUrls(addons, connection) {
    const out = new Set()
    for (const a of Array.isArray(addons) ? addons : []) {
        if (isAddonExcludedFrom(a, connection)) {
            const url = normalizeAddonUrl(a?.transportUrl || '')
            if (url) out.add(url)
        }
    }
    return out
}

// Exclusion-aware chain guard. The original guard (one-active.js chainGuardFailure)
// protects a managed chain against ACCIDENTAL drops: a list that would lose the
// active tier must never reach a platform. Destination exclusions are deliberate:
// for THIS connection, a member in `excludedUrls` is intentionally absent, so it
// leaves the chain the guard protects here — its absence can neither block the
// whole write (that would globally disable the chain for one policy choice) nor
// demand a backup be enabled to compensate.
//
// `preList`  the per-connection list BEFORE the write-time merge steps ran
// `postList` the candidate write list AFTER them (foreign-chain mirror, repairs)
// `deliberatelyAbsentUrls` (optional, normalized) — URLs the merge steps remove BY
//   DESIGN beyond policy exclusions: the foreign-chain mirror rebuilds a sibling
//   chain's member set from the live platform, so a canon-carried foreign member
//   absent from the live list is an INTENTIONAL drop, not an accidental one. Unlike
//   `excludedUrls`, this set never waives the zero-survivor floor or the active-tier
//   requirement — those follow the original guard exactly.
// Verdict parity with chainGuardFailure when both sets are empty:
//  - floor: a managed chain left with ZERO members in the write list blocks —
//    unless every member the canon carried for this connection was deliberately
//    excluded (the absence is explained by policy, not by an accident);
//  - the active tier must be present unless it is itself excluded;
//  - a canon-carried member that is not excluded (and not a by-design foreign
//    drop) must survive the merge steps.
// An excluded row appearing in `postList` never satisfies any requirement.
export function chainGuardFailureWithExclusions(preList, postList, managedChains, excludedUrls, deliberatelyAbsentUrls = null) {
    const excluded = excludedUrls instanceof Set && excludedUrls.size > 0 ? excludedUrls : new Set()
    const byDesign = deliberatelyAbsentUrls instanceof Set && deliberatelyAbsentUrls.size > 0 ? deliberatelyAbsentUrls : null
    const urlOf = (a) => normalizeAddonUrl(a?.transportUrl || '')
    const pre = new Set((preList || []).map(urlOf).filter(Boolean))
    const post = new Set((postList || []).filter(row => row?.flags?.enabled !== false && row?.enabled !== false).map(urlOf).filter(Boolean))
    // A provider can return a chain member under a swapped transport URL while
    // retaining its unique manifest id. Treat that as the same member as the
    // one-active derivation does. Duplicate ids remain deliberately ambiguous.
    const preIdCounts = new Map()
    const postIdCounts = new Map()
    for (const row of preList || []) {
        const id = row?.manifest?.id
        if (id) preIdCounts.set(id, (preIdCounts.get(id) || 0) + 1)
    }
    for (const row of postList || []) {
        if (row?.flags?.enabled === false || row?.enabled === false) continue
        const id = row?.manifest?.id
        if (id) postIdCounts.set(id, (postIdCounts.get(id) || 0) + 1)
    }
    const uniqueChainIds = new Map()
    for (const chain of managedChains || []) {
        const members = new Set((chain?.urls || []).map((u) => normalizeAddonUrl(u)).filter(Boolean))
        for (const row of preList || []) {
            const id = row?.manifest?.id
            const url = urlOf(row)
            if (!id || preIdCounts.get(id) !== 1 || !members.has(url)) continue
            uniqueChainIds.set(id, url)
        }
    }
    const postEffective = new Set(post)
    for (const row of postList || []) {
        const id = row?.manifest?.id
        const mapped = id && postIdCounts.get(id) === 1 ? uniqueChainIds.get(id) : null
        if (mapped) postEffective.add(mapped)
    }
    for (const chain of managedChains || []) {
        const members = (chain?.urls || []).map((u) => normalizeAddonUrl(u)).filter(Boolean)
        if (members.length === 0) continue
        const target = normalizeAddonUrl(chain?.target || '')
        const carried = members.filter((u) => pre.has(u))
        const carriedDeliberatelyExcluded = carried.length > 0 && carried.every((u) => excluded.has(u))
        if (!carriedDeliberatelyExcluded) {
            // Parity floor: the write may not leave the chain with no members at all.
            const survivors = members.filter((u) => postEffective.has(u))
            if (survivors.length === 0) {
                return `${members.length} member(s), survivors 0, active present ${target ? postEffective.has(target) : 'n/a'}`
            }
            if (target && !excluded.has(target) && !postEffective.has(target)) {
                return `${members.length} member(s), active tier ${target} missing`
            }
        }
        for (const u of carried) {
            if (excluded.has(u)) continue
            if (byDesign && byDesign.has(u)) continue
            if (!postEffective.has(u)) {
                return `${members.length} member(s), dropped ${u}, active present ${target ? postEffective.has(target) : 'n/a'}`
            }
        }
    }
    return null
}
