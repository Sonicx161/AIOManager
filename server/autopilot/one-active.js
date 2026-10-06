// Shared one-active flag derivation, extracted from engine.js for testability.

function normalizeAddonUrl(url) {
    if (!url) return ''
    let normalized = String(url).trim()
    if (!/^(?:https?|stremio):\/\//i.test(normalized)) normalized = `https://${normalized}`
    normalized = normalized.replace(/^stremio:\/\//i, 'https://')
    normalized = normalized.replace(/^http:\/\//i, 'https://')
    normalized = normalized.replace(/\/manifest\.json$/i, '')
    normalized = normalized.replace(/\/+$/, '')
    normalized = normalized.replace(/\?.*$/, '')
    return normalized.toLowerCase()
}

/**
 * Rewrites the chain members of `list` so exactly the addon at `activeUrl`
 * is enabled and every other chain member is disabled.
 *
 * Chain membership is by normalized transport URL, with the engine's
 * manifest-id fallback: an addon whose URL is NOT in the chain but whose
 * unique manifest id maps to a chain member is treated as that member
 * (the swapped-URL case). Manifest ids that appear more than once in the
 * list are unreliable for that mapping and are skipped.
 *
 * Non-chain addons pass through untouched. `violationDetected` is true when
 * any chain member's stored flag disagreed with the derived state — the
 * engine consumes it for snapshotLooksClean/needsSync; other callers log it.
 *
 * @param {Array} list addon list (objects with transportUrl/flags/manifest)
 * @param {Array} chainUrls chain member URLs (raw or pre-normalized)
 * @param {string} activeUrl the tier that must end up enabled
 * @returns {{ list: Array, violationDetected: boolean }}
 */
// Fold the flags of every chain an account manages into one account-wide list. The invariant
// is per-account, not per-writer: the list a rule pushes carries the members of every chain,
// so a writer that only derives its own chain publishes its stale copy of the others and
// silently reverts a sibling chain's failover (last writer wins).
export function applyAccountChainFlags(list, chains) {
    let out = Array.isArray(list) ? list : []
    const skipped = []
    for (const chain of (Array.isArray(chains) ? chains : [])) {
        if (!chain || !Array.isArray(chain.urls) || chain.urls.length === 0 || !chain.target) continue
        // Only derive a chain this list can fully express: if the target member is absent we
        // cannot know whether the chain is being retired or the list is simply out of date, and
        // disabling the member we DO see would be the destructive guess. Report it instead so the
        // caller can fall back to the platform's own member set for that chain only.
        const urls = new Set(out.map(a => normalizeAddonUrl(a?.transportUrl || '')))
        if (!urls.has(normalizeAddonUrl(chain.target))) { skipped.push(chain); continue }
        out = applyOneActiveFlags(out, chain.urls, chain.target).list
    }
    return { list: out, skipped }
}

export function applyOneActiveFlags(list, chainUrls, activeUrl) {
    const addonList = Array.isArray(list) ? list : []
    const normalizedChain = (Array.isArray(chainUrls) ? chainUrls : []).map(u => normalizeAddonUrl(u))
    const normalizedTarget = normalizeAddonUrl(activeUrl)

    // Duplicate manifest ids cannot identify a chain member reliably.
    const idCounts = new Map()
    addonList.forEach(addon => {
        if (!addon.manifest?.id) return
        idCounts.set(addon.manifest.id, (idCounts.get(addon.manifest.id) || 0) + 1)
    })
    const duplicateIds = new Set([...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id))

    // manifest id -> chain URL, for addons whose URL was swapped but whose
    // identity still pins them to a chain slot.
    const chainIdMap = new Map()
    addonList.forEach(addon => {
        if (!addon.manifest?.id) return
        if (duplicateIds.has(addon.manifest.id)) return
        const normUrl = normalizeAddonUrl(addon.transportUrl)
        const idx = normalizedChain.indexOf(normUrl)
        if (idx !== -1) chainIdMap.set(addon.manifest.id, normalizedChain[idx])
    })

    let violationDetected = false
    const updatedList = addonList.map(addon => {
        const normUrl = normalizeAddonUrl(addon.transportUrl)
        let effectiveUrl = normUrl
        let isChainMember = normalizedChain.includes(normUrl)

        if (!isChainMember && addon.manifest?.id && chainIdMap.has(addon.manifest.id)) {
            isChainMember = true
            effectiveUrl = chainIdMap.get(addon.manifest.id)
        }

        if (isChainMember) {
            const shouldBeEnabled = effectiveUrl === normalizedTarget
            if (addon.flags?.enabled !== shouldBeEnabled) violationDetected = true
            return {
                ...addon,
                flags: { ...(addon.flags || {}), enabled: shouldBeEnabled }
            }
        }
        return addon
    })

    return { list: updatedList, violationDetected }
}

// One predicate for every guard site. A write may never leave a managed chain without an enabled
// active member: the account's list is shared by one rule per chain, so a list that drops a
// sibling chain's active member silently reverts that chain's failover (last writer wins). Note
// this deliberately still allows a chain with several enabled members - that is the multi-enabled
// violation the engine writes to repair - while refusing the state that loses the active tier.
//
// Pure on purpose, and in this module rather than the reconciler: the guard is a predicate over
// the candidate list, so it is unit-testable without a database, and the reconcile path evaluates
// the same predicate inside the platform write slot.
//
// `list` is an enabled-only list (the caller's canonical list), so membership IS enabledness, and
// an addon that is present but disabled must not be passed in. Matching is by normalized URL, the
// same key the flag derivation above uses.
export function chainGuardFailure(list, managedChains) {
    const enabled = new Set((list || []).map(a => normalizeAddonUrl(a?.transportUrl || '')).filter(Boolean))
    for (const chain of (managedChains || [])) {
        const members = (chain?.urls || []).map(u => normalizeAddonUrl(u))
        if (members.length === 0) continue
        const survivors = members.filter(u => enabled.has(u))
        const target = normalizeAddonUrl(chain?.target || '')
        if (survivors.length === 0 || (target && !survivors.includes(target))) {
            return `${members.length} member(s), survivors ${survivors.length}, active present ${survivors.includes(target)}`
        }
    }
    return null
}
