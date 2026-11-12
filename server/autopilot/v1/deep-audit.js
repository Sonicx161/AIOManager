import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { maskContext } from '../../utils/log-helpers.js'
import { isExcludedFromDestinations } from '../../utils/addon-destinations.js'
import { loadCanonicalDestinations, resolveStremioConnectionId, stremioExcludedUrlsFromPolicy } from './destinations.js'
import { customCheckUrlsFor } from './failover-evaluate.js'
import { scrubUrls } from './url-ref.js'

export function createDeepAudit({ fastify, nowMs, rand, bootAt, reconciler, stremioDriver, checkAddonHealthInternal, checkCustomUrlsHealth, RULE_DEEP_AUDIT_MS, RULE_FIRST_DEEP_AUDIT_MAX_MS }) {
    const seedDeepAuditPhase = (rule) => (rule.updated_at ?? 0) > bootAt
        ? null
        : nowMs() - RULE_DEEP_AUDIT_MS + rand() * RULE_FIRST_DEEP_AUDIT_MAX_MS

    const auditStremio = async ({ rule, authKey, chain, normalizedChainUrls, normalizedChainSet, customChecks, currentActiveNorm, preserveUrls = [] }) => {
        let drift = false
        let canonicalTarget = null
        let observation = null
        const preserved = new Set(preserveUrls.map(normalizeAddonUrl))
        try {
            // First healthy member by chain order; fall back to the stored active addon
            for (let ci = 0; ci < chain.length; ci++) {
                const cUrl = chain[ci]
                const cNorm = normalizedChainUrls[ci]
                if (preserved.has(cNorm)) continue
                if (!await checkAddonHealthInternal(cUrl)) continue
                const checkUrls = customCheckUrlsFor(customChecks, cNorm)
                if (checkUrls.length > 0 && !await checkCustomUrlsHealth(checkUrls, rule.id, rule.account_id)) continue
                canonicalTarget = cNorm
                break
            }
            const auditReference = canonicalTarget ?? currentActiveNorm

            const liveAddons = await stremioDriver.readAddons(authKey)
            // R4: members deliberately excluded from stremio by destination
            // policy are intentionally absent/disabled there, never drift.
            const auditConnectionId = await resolveStremioConnectionId(rule.account_id, rule.owner_sync_user, authKey, rule.connection_id)
            const auditStremioExcluded = stremioExcludedUrlsFromPolicy(await loadCanonicalDestinations(rule.account_id, rule.owner_sync_user), auditConnectionId)
            const liveIdCounts = new Map()
            liveAddons.forEach(a => {
                if (a.manifest?.id) liveIdCounts.set(a.manifest.id, (liveIdCounts.get(a.manifest.id) || 0) + 1)
            })
            const liveChainIdMap = new Map()
            liveAddons.forEach(a => {
                if (!a.manifest?.id || liveIdCounts.get(a.manifest.id) > 1) return
                const normUrl = normalizeAddonUrl(a.transportUrl).toLowerCase()
                if (normalizedChainSet.has(normUrl)) liveChainIdMap.set(a.manifest.id, normUrl)
            })
            const reverted = []
            drift = liveAddons.some(a => {
                const normUrl = normalizeAddonUrl(a.transportUrl).toLowerCase()
                if (auditStremioExcluded.has(normUrl) || preserved.has(normUrl)) return false
                const effectiveUrl = normalizedChainSet.has(normUrl)
                    ? normUrl
                    : (a.manifest?.id && liveChainIdMap.has(a.manifest.id) ? liveChainIdMap.get(a.manifest.id) : null)
                if (!effectiveUrl) return false
                if (auditStremioExcluded.has(effectiveUrl) || preserved.has(effectiveUrl)) return false
                return (a.flags?.enabled !== false) !== (effectiveUrl === auditReference)
            })
            for (const addon of liveAddons) {
                const url = normalizeAddonUrl(addon.transportUrl || '')
                if (normalizedChainSet.has(url) && !preserved.has(url) && !auditStremioExcluded.has(url)
                    && (addon.flags?.enabled !== false) !== (url === auditReference)) reverted.push(url)
            }
            observation = { scope: 'stremio', target: auditReference, reverted, complete: true }
            if (drift) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit found live collection drift from the one-active chain state. Forcing enforcement.`)
            }
        } catch (auditErr) {
            observation = { scope: 'stremio', complete: false }
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit read failed: ${scrubUrls(auditErr.message)}`)
        }
        return { drift, canonicalTarget, observation }
    }

    // Hourly drift audit of the native connections (Nuvio, RealStream, Hydra): catches platform-side changes and
    // failed pushes the echo and reconcile paths miss. A Stremio rule audits every native connection of the
    // account (its swaps push to all of them); a connection-only rule audits its own.
    const auditConnections = async ({ rule, normalizedChainSet, normalizedTarget, ownConnectionOnly = true, preserveUrls = [] }) => {
        let drift = false
        const driftedIds = []
        const observations = []
        const preserved = new Set(preserveUrls.map(normalizeAddonUrl))
        try {
            const auditTargets = (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user) || [])
                .filter(c => c.enabled && c.platform !== 'stremio' && (!ownConnectionOnly || !rule.connection_id || c.id === rule.connection_id))
            if (auditTargets.length > 0) {
                const audits = await reconciler.auditConnections(rule.account_id, auditTargets)
                // R4: per-connection destination policy. A member this login
                // deliberately excludes is intentionally absent there, and an
                // excluded ACTIVE tier means the correct steady state is "no
                // enabled chain member on this connection", never a forced backup.
                const auditPolicyByUrl = await loadCanonicalDestinations(rule.account_id, rule.owner_sync_user)
                for (const audit of audits) {
                    if (!Array.isArray(audit.addons)) { observations.push({ scope: audit.connectionId || audit.id, complete: false }); continue }
                    const excludedForConn = new Set()
                    for (const [url, destinations] of auditPolicyByUrl) {
                        if (isExcludedFromDestinations(destinations, { platform: audit.platform, connectionId: audit.connectionId || audit.id })) excludedForConn.add(url)
                    }
                    const enabledChain = new Set()
                    for (const live of audit.addons) {
                        const norm = normalizeAddonUrl(live.transportUrl || live.url || '').toLowerCase()
                        if (excludedForConn.has(norm) || preserved.has(norm)) continue
                        if (normalizedChainSet.has(norm) && (live.flags?.enabled ?? live.enabled) !== false) enabledChain.add(norm)
                    }
                    const targetExcludedHere = excludedForConn.has(normalizedTarget) || preserved.has(normalizedTarget)
                    const steady = targetExcludedHere
                        ? enabledChain.size === 0
                        : (enabledChain.size === 1 && enabledChain.has(normalizedTarget))
                    const reverted = [...normalizedChainSet].filter(url => !excludedForConn.has(url) && !preserved.has(url)
                        && enabledChain.has(url) !== (url === normalizedTarget))
                    observations.push({ scope: audit.connectionId || audit.id, target: normalizedTarget, reverted, complete: true })
                    if (!steady) {
                        drift = true
                        driftedIds.push(audit.connectionId || audit.id)
                        fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit (connection) found live collection drift from the one-active chain state on ${audit.platform}. Forcing enforcement.`)
                        if (ownConnectionOnly) break
                    }
                }
            }
        } catch (auditErr) {
            observations.push({ scope: null, complete: false })
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit (connection) read failed: ${scrubUrls(auditErr.message)}`)
        }
        return { drift, driftedIds, observations }
    }

    // Steady rules never read the live collection; re-check it on the deep-audit cadence.
    const runDeepAudit = async ({ rule, lastDeepAudit, authKey, hasConnectionTarget, snapshotLooksClean, ...ctx }) => {
        let lastDeepAuditToSave = lastDeepAudit ?? null
        if (lastDeepAuditToSave == null) lastDeepAuditToSave = seedDeepAuditPhase(rule)
        let drift = false
        let canonicalTarget = null
        let connectionDrift = []
        const observations = []
        const canAuditConnections = !!(reconciler?.resolveConnections && reconciler.auditConnections)
        const due = () => nowMs() - (lastDeepAuditToSave || 0) >= RULE_DEEP_AUDIT_MS
        if (snapshotLooksClean && authKey) {
            if (due()) {
                lastDeepAuditToSave = nowMs()
                const result = await auditStremio({ rule, authKey, ...ctx })
                drift = result.drift
                canonicalTarget = result.canonicalTarget
                if (result.observation) observations.push(result.observation)
                // Mirrored native connections are repaired by the connection retry, never by a Stremio write.
                if (canAuditConnections) {
                    const native = await auditConnections({ rule, ...ctx, ownConnectionOnly: false })
                    connectionDrift = native.driftedIds
                    observations.push(...native.observations)
                }
            }
        } else if (snapshotLooksClean && hasConnectionTarget && canAuditConnections) {
            if (due()) {
                lastDeepAuditToSave = nowMs()
                const native = await auditConnections({ rule, ...ctx })
                drift = native.drift
                observations.push(...native.observations)
            }
        }
        return { lastDeepAudit: lastDeepAuditToSave, drift, canonicalTarget, connectionDrift, ...(observations.length > 0 ? { observations } : {}) }
    }

    return { runDeepAudit }
}
