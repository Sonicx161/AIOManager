import db from '../db.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { encrypt, decrypt, generateRandomKey } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { globalHealthCache, healthCheckInFlight, serverState } from '../state.js'
import { isSafeUrlResolved } from '../utils/ssrf.js'
import { safeFetchWithRedirects } from '../utils/safe-fetch.js'
import { deriveAddonName, maskContext, truncateUrl } from '../utils/log-helpers.js'
import { createStremioDriver } from '../providers/stremio-driver.js'
import { isUnifiedEnforcement } from '../config.js'
import { applyOneActiveFlags, applyAccountChainFlags } from './one-active.js'
import { getGlobalWebhook } from './global-webhook.js'
import { createHealthChecker, HEALTH_CACHE_TTL_MS } from './health-checks.js'

async function mapConcurrent(items, limit, worker) {
    const results = new Array(items.length)
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const i = nextIndex++
            results[i] = await worker(items[i], i)
        }
    })
    await Promise.all(workers)
    return results
}

export function createAutopilotEngine(fastify, reconciler = null) {

    const stremioDriver = createStremioDriver()

    const RULE_RUNTIME_TTL_MS = 24 * 60 * 60 * 1000
    const MAX_RULE_RUNTIME_ENTRIES = 100000
    const AUTOPILOT_SCAN_CHUNK_SIZE = Math.max(100, parseInt(process.env.AUTOPILOT_SCAN_CHUNK_SIZE || '500', 10) || 500)
    const AUTOPILOT_MAX_RULES_PER_CYCLE = Math.max(AUTOPILOT_SCAN_CHUNK_SIZE, parseInt(process.env.AUTOPILOT_MAX_RULES_PER_CYCLE || '10000', 10) || 10000)
    const AUTOPILOT_CYCLE_BUDGET_MS = Math.max(5000, parseInt(process.env.AUTOPILOT_CYCLE_BUDGET_MS || '120000', 10) || 120000)
    const RULE_RECHECK_MS = Math.max(10000, parseInt(process.env.AUTOPILOT_RULE_RECHECK_MS || '30000', 10) || 30000)
    // Steady-rule heartbeat cadence; keeps persisted last_check fresh well under the client's 15-min staleness threshold
    const RULE_HEARTBEAT_MS = Math.max(30_000, parseInt(process.env.AUTOPILOT_HEARTBEAT_MS || '300000', 10) || 300000)
    // How often a steady rule re-checks the live collection for drift
    const RULE_DEEP_AUDIT_MS = Math.max(300_000, parseInt(process.env.AUTOPILOT_DEEP_AUDIT_MS || '3600000', 10) || 3600000)
    const ruleRuntimeState = new Map()

    const RULE_CACHE_MAX_BYTES = Math.max(0, parseInt(process.env.AUTOPILOT_RULE_CACHE_MAX_BYTES || String(256 * 1024 * 1024), 10) || 0)
    const RULE_CACHE_TTL_MS = Math.max(60000, parseInt(process.env.AUTOPILOT_RULE_CACHE_TTL_MS || '600000', 10) || 600000)
    const ruleFetchCache = new Map()
    let ruleFetchCacheBytes = 0
    const ruleCacheStats = { hits: 0, misses: 0, bytesSaved: 0, windowStart: Date.now() }

    const ruleCacheEntryBytes = (row) =>
        Buffer.byteLength(row.addon_list || '', 'utf8') +
        Buffer.byteLength(row.priority_chain || '', 'utf8') +
        Buffer.byteLength(row.active_url || '', 'utf8')

    const ruleCacheGet = (id, updatedAt) => {
        if (RULE_CACHE_MAX_BYTES <= 0 || updatedAt == null) return null
        const hit = ruleFetchCache.get(id)
        if (!hit || hit.updatedAt !== updatedAt) return null
        if (hit.expires <= Date.now()) {
            ruleFetchCache.delete(id)
            ruleFetchCacheBytes -= hit.bytes
            return null
        }
        ruleFetchCache.delete(id)
        ruleFetchCache.set(id, hit)
        return hit
    }

    const ruleCacheSet = (id, updatedAt, row) => {
        if (RULE_CACHE_MAX_BYTES <= 0 || updatedAt == null) return
        const existing = ruleFetchCache.get(id)
        if (existing) { ruleFetchCache.delete(id); ruleFetchCacheBytes -= existing.bytes }
        const entry = { updatedAt, row, bytes: ruleCacheEntryBytes(row), expires: Date.now() + RULE_CACHE_TTL_MS }
        ruleFetchCache.set(id, entry)
        ruleFetchCacheBytes += entry.bytes
        while (ruleFetchCacheBytes > RULE_CACHE_MAX_BYTES && ruleFetchCache.size > 0) {
            const oldest = ruleFetchCache.keys().next().value
            const o = ruleFetchCache.get(oldest)
            ruleFetchCache.delete(oldest)
            ruleFetchCacheBytes -= o.bytes
        }
    }
    const pruneRuleRuntimeState = () => {
        if (ruleRuntimeState.size <= MAX_RULE_RUNTIME_ENTRIES) return
        const cutoff = Date.now() - RULE_RUNTIME_TTL_MS
        for (const [ruleId, state] of ruleRuntimeState.entries()) {
            if (ruleRuntimeState.size <= MAX_RULE_RUNTIME_ENTRIES) break
            if ((state.lastCheck || 0) < cutoff) ruleRuntimeState.delete(ruleId)
        }
        while (ruleRuntimeState.size > MAX_RULE_RUNTIME_ENTRIES) {
            const oldestRuleId = ruleRuntimeState.keys().next().value
            if (oldestRuleId === undefined) break
            ruleRuntimeState.delete(oldestRuleId)
        }
    }

    const setRuleRuntimeState = (ruleId, state) => {
        if (!ruleId) return
        if (ruleRuntimeState.has(ruleId)) ruleRuntimeState.delete(ruleId)
        ruleRuntimeState.set(ruleId, state)
        pruneRuleRuntimeState()
    }

    const getRuleRuntimeState = (ruleId) => {
        return ruleRuntimeState.get(ruleId) || null
    }

    const clearRuleRuntimeState = (ruleId) => {
        ruleRuntimeState.delete(ruleId)
    }

    const clearAccountRuleRuntimeState = (accountId) => {
        for (const [ruleId, state] of ruleRuntimeState.entries()) {
            if (state.accountId === accountId) ruleRuntimeState.delete(ruleId)
        }
    }

    const shouldSkipRuleCheck = (ruleId, staleCutoff) => {
        const runtime = ruleRuntimeState.get(ruleId)
        return !!runtime?.lastCheck && runtime.lastCheck >= staleCutoff
    }

    const recordRuleDecryptFailure = async (rule) => {
        const runtime = getRuleRuntimeState(rule.id) || {}
        const decryptFailures = (runtime.decryptFailures || 0) + 1
        const now = Date.now()
        setRuleRuntimeState(rule.id, {
            ...runtime,
            accountId: rule.account_id,
            lastCheck: now,
            decryptFailures
        })
        if (decryptFailures >= 3) {
            await db.run('UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2', [now, rule.id])
            clearRuleRuntimeState(rule.id)
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Disabled rule ${rule.id} after repeated decrypt failures.`)
        }
    }
    const { checkAddonHealthInternal, getHealthLatency, checkCustomUrlsHealth } = createHealthChecker(fastify)


    const sanitizeManifest = (manifest, transportUrl = '') => {
        const isUnknown = !manifest?.name || manifest?.name === 'Unknown Addon' || manifest?.name === 'Restoring Addon...'
        const name = isUnknown && transportUrl ? deriveAddonName(transportUrl) : (manifest?.name || 'Unknown Addon')

        return {
            ...manifest,
            name,
            id: manifest?.id || `synth-${Date.now()}`,
            version: manifest?.version || '0.0.0',
            types: manifest?.types || [],
            resources: manifest?.resources || []
        }
    }

    /**
     * Helper to check if a manifest is substantial (has real metadata)
     */
    function isSubstantial(manifest) {
        if (!manifest) return false;
        if (manifest.name === 'Restoring Addon...' || manifest.name === 'Unknown Addon') return false;
        const hasMeta = manifest.logo || manifest.description || (manifest.catalogs && manifest.catalogs.length > 0) || (manifest.resources && manifest.resources.length > 0);
        return !!hasMeta;
    }

    /**
     * Internal manifest fetcher that respects proxy limits
     */
    async function fetchManifestRaw(url, accountId) {
        try {
            const response = await enqueueProxyRequest(url, async () => {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 10000)
                try {
                    const res = await safeFetchWithRedirects(url, {
                        method: 'GET',
                        signal: controller.signal,
                        headers: { 'x-stremio-account': accountId || 'autopilot-sync' }
                    })
                    if (!res) throw new Error(`Manifest redirect to unsafe URL`)
                    if (!res.ok) throw new Error(`Manifest fetch ${res.status}`)
                    return await res.json()
                } finally {
                    clearTimeout(timeout)
                }
            });
            const manifest = response?.manifest || response;
            if (manifest && manifest.id && manifest.name) {
                return manifest;
            }
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `Manifest fetch failed for ${truncateUrl(url)}: ${err.message}`)
        }
        return null;
    }

    /**
     * Helper to compare two collections to avoid redundant writes.
     */
    function areCollectionsDifferent(collA, collB) {
        if (collA.length !== collB.length) return true;
        for (let i = 0; i < collA.length; i++) {
            const a = collA[i];
            const b = collB[i];
            if (normalizeAddonUrl(a.transportUrl).toLowerCase() !== normalizeAddonUrl(b.transportUrl).toLowerCase()) return true;
            if ((a.flags?.enabled !== false) !== (b.flags?.enabled !== false)) return true;

            if (a.manifest?.version !== b.manifest?.version) return true;
            if (a.manifest?.name !== b.manifest?.name) return true;
            if ((a.manifest?.logo || null) !== (b.manifest?.logo || null)) return true;
            if ((a.manifest?.description || null) !== (b.manifest?.description || null)) return true;
        }
        return false;
    }

    const mergeAddons = (localAddons, remoteAddons, managedChain = []) => {
        const remoteAddonMap = new Map((remoteAddons || []).map(a => [normalizeAddonUrl(a.transportUrl).toLowerCase(), a]));
        const remoteIdMap = new Map((remoteAddons || []).filter(a => a.manifest?.id).map(a => [a.manifest.id, a]));
        const processedRemoteNormUrls = new Set();
        const managedChainSet = new Set(managedChain);
        const localNormUrlCounts = new Map();
        const localIdsInChain = new Set();
        for (const l of (localAddons || [])) {
            const norm = normalizeAddonUrl(l.transportUrl).toLowerCase();
            localNormUrlCounts.set(norm, (localNormUrlCounts.get(norm) || 0) + 1);
            if (l.manifest?.id && managedChainSet.has(norm)) localIdsInChain.add(l.manifest.id);
        }
        const finalAddons = [];

        const isObsoleteGhost = (remoteAddon) => {
            if (managedChain.length === 0) return false;
            const normRemote = normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase();
            const id = remoteAddon.manifest?.id;
            if (!id) return false;

            if (managedChainSet.has(normRemote)) return false;

            return localIdsInChain.has(id);
        };

        (localAddons || []).forEach(localAddon => {
            const normLocal = normalizeAddonUrl(localAddon.transportUrl).toLowerCase()
            const idLocal = localAddon.manifest?.id

            let remoteAddon = remoteAddonMap.get(normLocal);

            if (!remoteAddon && idLocal) {
                const potentialSwap = remoteIdMap.get(idLocal)
                if (potentialSwap) {
                    const swapNorm = normalizeAddonUrl(potentialSwap.transportUrl).toLowerCase()
                    const isClaimedByExactUrl = (localNormUrlCounts.get(swapNorm) || 0) > (normLocal === swapNorm ? 1 : 0)
                    if (!isClaimedByExactUrl) {
                        remoteAddon = potentialSwap
                    }
                }
            }

            if (remoteAddon) {
                const remoteManifest = remoteAddon.manifest;
                const localManifest = localAddon.manifest;
                const useLocalManifest = isSubstantial(localManifest) && !isSubstantial(remoteManifest);

                finalAddons.push({
                    ...remoteAddon,
                    transportUrl: localAddon.transportUrl,
                    manifest: useLocalManifest ? localManifest : remoteManifest,
                    flags: {
                        ...(remoteAddon.flags || {}),
                        protected: localAddon.flags?.protected,
                        enabled: localAddon.flags?.enabled ?? true
                    },
                    metadata: localAddon.metadata
                });
                processedRemoteNormUrls.add(normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase());
            } else {
                finalAddons.push(localAddon);
            }
        });

        (remoteAddons || []).forEach(remoteAddon => {
            const normRemote = normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase()
            if (!processedRemoteNormUrls.has(normRemote)) {
                if (isObsoleteGhost(remoteAddon)) {
                    fastify.log.info({ category: 'Sync' }, `[Merge] Skipping ghost addon: ${normRemote.substring(0, 40)} (Replaced by chain member)`)
                    return;
                }
                finalAddons.push(remoteAddon);
            }
        });

        return finalAddons
    }

    const prepareAddonsForStremio = (addons) => {
        return (addons || [])
            .filter(addon => addon.flags?.enabled !== false)
            .map(addon => {
                const baseManifest = sanitizeManifest(addon.manifest, addon.transportUrl)
                const meta = addon.metadata || {}

                let manifest = baseManifest
                if (meta.customName || meta.customDescription || meta.customLogo) {
                    manifest = {
                        ...baseManifest,
                        name: meta.customName || baseManifest.name || '',
                        logo: meta.customLogo || baseManifest.logo || undefined,
                        description: meta.customDescription || baseManifest.description || '',
                    }
                }
                if (meta.hideConfigure) {
                    manifest = { ...manifest, behaviorHints: { ...manifest.behaviorHints, configurable: false } }
                }
                const prepared = {
                    transportUrl: addon.transportUrl,
                    manifest
                }
                if (addon.flags) {
                    prepared.flags = addon.flags
                }
                return prepared
            })
    }

    /**
     * Helper to fetch a fresh manifest for the active addon.
     * This is used to force Stremio to refresh its catalog cache.
     */
    const fetchAndRefreshManifest = async (url, accountId) => {
        try {
            const manifest = await fetchManifestRaw(url, accountId)
            return isSubstantial(manifest) ? manifest : null
        } catch (e) {
            return null
        }
    }

    /**
     * Sync to Stremio (Manager-Mirror Mode).
     * Behaves exactly like the Manager's toggle buttons.
     */
    const buildReconciledList = async (authKey, chain, activeUrl, accountId, ruleId, storedAddonList = [], forceReinstall = false) => {
        const remoteAddons = await stremioDriver.readAddons(authKey)

        const normalizedChain = chain.map(u => normalizeAddonUrl(u).toLowerCase());
        const normalizedChainSet = new Set(normalizedChain);
        const normalizedActive = normalizeAddonUrl(activeUrl).toLowerCase();

        const baseAddonList = (storedAddonList && storedAddonList.length > 0)
            ? [...storedAddonList]
            : [...remoteAddons];

        // Indexes preserve first-match order; baseNormSet must grow with every push below.
        const remoteByNormUrl = new Map();
        for (const a of remoteAddons) {
            const key = normalizeAddonUrl(a.transportUrl).toLowerCase();
            if (!remoteByNormUrl.has(key)) remoteByNormUrl.set(key, a);
        }
        const storedByNormUrl = new Map();
        const storedIdsByNormUrl = new Map();
        for (const s of storedAddonList || []) {
            const key = normalizeAddonUrl(s.transportUrl).toLowerCase();
            if (!storedByNormUrl.has(key)) storedByNormUrl.set(key, s);
            if (s.manifest?.id) {
                if (!storedIdsByNormUrl.has(key)) storedIdsByNormUrl.set(key, new Set());
                storedIdsByNormUrl.get(key).add(s.manifest.id);
            }
        }
        const baseNormSet = new Set(baseAddonList.map(a => normalizeAddonUrl(a.transportUrl).toLowerCase()));

        for (let idx = 0; idx < normalizedChain.length; idx++) {
            const normUrl = normalizedChain[idx];
            const exists = baseNormSet.has(normUrl);
            if (!exists) {
                const remote = remoteByNormUrl.get(normUrl);

                const candidateIds = storedIdsByNormUrl.get(normUrl);
                const remoteById = candidateIds
                    ? remoteAddons.find(a => a.manifest?.id && candidateIds.has(a.manifest.id))
                    : undefined;

                const stored = storedByNormUrl.get(normUrl);

                let isHealthy = await checkAddonHealthInternal(chain[idx])
                if (!isHealthy) {
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Skipping restoration for DEAD addon: ${truncateUrl(chain[idx])}`)
                    continue
                }

                let recoveredManifest = null;
                if (isHealthy) {
                    const currentBest = remote?.manifest || remoteById?.manifest || stored?.manifest;
                    if (!isSubstantial(currentBest)) {
                        fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Restoration Recovery: Attempting manifest fetch for ${truncateUrl(chain[idx])}`);
                        recoveredManifest = await fetchManifestRaw(chain[idx], accountId);
                        if (recoveredManifest && isSubstantial(recoveredManifest)) {
                            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Restoration Success! Recovered metadata for ${recoveredManifest.name}`);
                        }
                    }
                }

                if (remote) {
                    baseAddonList.push(recoveredManifest ? { ...remote, manifest: recoveredManifest } : remote);
                } else if (remoteById) {
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Recovered manifest for swapped URL: ${truncateUrl(chain[idx])}`)
                    baseAddonList.push({ ...remoteById, transportUrl: chain[idx], manifest: recoveredManifest || remoteById.manifest });
                } else if (stored && isSubstantial(stored.manifest)) {
                    baseAddonList.push({
                        ...stored,
                        flags: { ...(stored.flags || {}), enabled: false }
                    });
                } else {
                    baseAddonList.push({
                        transportUrl: chain[idx],
                        manifest: {
                            id: `restoring-${accountId}-${idx}`,
                            name: 'Restoring Addon...',
                            version: '1.0.0',
                            types: ['other'],
                            resources: []
                        },
                        flags: { enabled: false },
                        metadata: stored?.metadata || remoteById?.metadata || {}
                    });
                }
                baseNormSet.add(normUrl);
            }
        }

        const updatedLocalAddons = baseAddonList.map(addon => {
            const normalizedUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            if (normalizedChainSet.has(normalizedUrl)) {
                const isTarget = normalizedUrl === normalizedActive
                return {
                    ...addon,
                    flags: { ...(addon.flags || {}), enabled: isTarget }
                }
            }
            return addon
        })

        const mergedAddons = mergeAddons(updatedLocalAddons, remoteAddons, normalizedChain)

        // The snapshot can drift from the live collection; repair it before writing back
        const mergedIdCounts = new Map()
        mergedAddons.forEach(a => {
            if (a.manifest?.id) mergedIdCounts.set(a.manifest.id, (mergedIdCounts.get(a.manifest.id) || 0) + 1)
        })
        const mergedChainIdMap = new Map()
        mergedAddons.forEach(a => {
            if (!a.manifest?.id || mergedIdCounts.get(a.manifest.id) > 1) return
            const normUrl = normalizeAddonUrl(a.transportUrl).toLowerCase()
            if (normalizedChainSet.has(normUrl)) mergedChainIdMap.set(a.manifest.id, normUrl)
        })
        const drifted = []
        const auditedAddons = mergedAddons.map(addon => {
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            const effectiveUrl = normalizedChainSet.has(normUrl)
                ? normUrl
                : (addon.manifest?.id && mergedChainIdMap.has(addon.manifest.id) ? mergedChainIdMap.get(addon.manifest.id) : null)
            if (!effectiveUrl) return addon
            const shouldBeEnabled = effectiveUrl === normalizedActive
            if ((addon.flags?.enabled !== false) === shouldBeEnabled) return addon
            drifted.push({ url: truncateUrl(normUrl), effective: truncateUrl(effectiveUrl), enabled: shouldBeEnabled })
            return { ...addon, flags: { ...(addon.flags || {}), enabled: shouldBeEnabled } }
        })
        if (drifted.length > 0) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] One-active drift repaired during sync: ${drifted.map(d => `${d.enabled ? 'enabled' : 'disabled'} ${d.url}${d.effective !== d.url ? ` (chain: ${d.effective})` : ''}`).join(', ')}`)
            await recordFailoverHistory({ id: ruleId, account_id: accountId }, 'self-healing', `Repaired chain state: ${drifted.map(d => `${d.enabled ? 'enabled' : 'disabled'} ${d.url}`).join(', ')}.`, '', '', { driftRepair: drifted })
        }

        return { canonical: auditedAddons, remoteAddons, normalizedActive }
    }

    const writeStremioCollection = async (authKey, canonical, { remoteAddons = [], normalizedActive, accountId }) => {
        const refreshedMerged = await mapConcurrent(canonical || [], 5, async addon => {
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            if (normUrl === normalizedActive && addon.flags?.enabled !== false) {
                const freshManifest = await fetchAndRefreshManifest(addon.transportUrl, accountId)
                if (freshManifest) {
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Refreshed manifest for active addon: ${truncateUrl(addon.transportUrl)}`)
                    return { ...addon, manifest: freshManifest }
                }
            }
            return addon
        })

        const finalAddons = prepareAddonsForStremio(refreshedMerged)

        if (finalAddons.length === 0 && remoteAddons.length > 0) {
            throw new Error('Sync produced an empty list, aborting to prevent wiping Stremio collection.')
        }

        if (areCollectionsDifferent(finalAddons, remoteAddons)) {
            await stremioDriver.writeAddons(authKey, finalAddons)
        }
        return finalAddons
    }

    // Sibling chains of the same account: chain membership is stable (only the active member
    // moves), so reading it from the rule rows is safe; the sibling's *target* is read from
    // the current cycle first (a rule persists active_url only after the whole account batch,
    // so the DB value is one cycle stale exactly when two chains fail over together) and from
    // the persisted row second.
    const cycleTargets = new Map()

    const parseChainValue = (raw) => {
        const decrypted = decrypt(raw, FALLBACK_KEYS)
        let parsed = []
        try {
            if (Array.isArray(decrypted)) parsed = decrypted
            else if (typeof decrypted === 'string' && decrypted.startsWith('[')) parsed = JSON.parse(decrypted)
            else if (typeof raw === 'string' && raw.startsWith('[')) parsed = JSON.parse(raw)
        } catch { }
        return Array.isArray(parsed) ? parsed : []
    }

    // One plan per sibling rule: the chain members another rule owns, plus that chain's target.
    const siblingChainPlans = async (accountId, ownRuleId, ownChain) => {
        const own = new Set((ownChain || []).map(u => normalizeAddonUrl(u).toLowerCase()))
        let rows = []
        try {
            rows = await db.query('SELECT id, priority_chain, active_url FROM autopilot_rules WHERE account_id = $1 AND is_active = 1 AND id <> $2', [accountId, ownRuleId])
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Sibling chain read failed: ${err.message}`)
            return []
        }
        const plans = []
        for (const row of (rows || [])) {
            const urls = []
            for (const url of parseChainValue(row.priority_chain)) {
                const norm = normalizeAddonUrl(url).toLowerCase()
                if (!norm || own.has(norm) || urls.includes(norm)) continue
                urls.push(norm)
            }
            if (urls.length === 0) continue
            const inCycle = cycleTargets.get(row.id)
            const persisted = normalizeAddonUrl(decrypt(row.active_url, FALLBACK_KEYS) || row.active_url || '').toLowerCase()
            const target = urls.includes(inCycle) ? inCycle : (urls.includes(persisted) ? persisted : null)
            // No derivable target: leave that chain's flags untouched rather than disabling it.
            if (!target) continue
            plans.push({ ruleId: row.id, urls, target })
        }
        return plans
    }

    const enforceConnectionOnly = async (rule, reconciledAddons, chain = [], activeUrl = null, siblingPlans = null, mirrorUrls = null) => {
        if (!reconciler?.enforceAccount) return { synced: [] }
        const connections = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
        const targets = (connections || []).filter(c =>
            c.enabled && c.platform !== 'stremio' && (!rule.connection_id || c.id === rule.connection_id)
        )
        if (targets.length === 0) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only rule has no matching enabled connection. Skipping enforcement.`)
            return { synced: [] }
        }
        // Chain guard: refuses writes that would drop the managed chain or its active tier.
        const guardOpts = (Array.isArray(chain) && chain.length > 0)
            ? { requiredUrls: chain, requiredActiveUrl: activeUrl }
            : {}
        const plans = siblingPlans || (await siblingChainPlans(rule.account_id, rule.id, chain))
        const result = await reconciler.enforceAccount(rule.account_id, targets, reconciledAddons, {
            ...guardOpts,
            // Only the chains this rule cannot derive are mirrored from the platform: a decided
            // target outranks a platform list that has not caught up with it yet, and mirroring a
            // decided chain would make the guard refuse a perfectly valid write.
            foreignChainUrls: mirrorUrls ?? plans.flatMap(p => p.urls),
            // Guard scope: every chain this account manages, not just this rule's.
            managedChains: [{ urls: chain, target: activeUrl }, ...plans],
        })
        if (result.synced.length > 0) {
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only enforcement pushed to ${result.synced.join(', ')}.`)
        }
        return { synced: result.synced, chainGuardSkipped: result.chainGuardSkipped === true }
    }

    const syncStremioLive = async (authKeyOrDescriptor, chain, activeUrl, accountId, ruleId, storedAddonList = [], forceReinstall = false) => {
        const descriptor = typeof authKeyOrDescriptor === 'string' ? { authKey: authKeyOrDescriptor } : (authKeyOrDescriptor || {})
        const authKey = descriptor.authKey
        if (!authKey) {
            const rule = { account_id: accountId, id: ruleId, owner_sync_user: descriptor.ownerSyncUser, connection_id: descriptor.connectionId, platform: descriptor.platform }
            const result = await enforceConnectionOnly(rule, storedAddonList, chain, activeUrl, await siblingChainPlans(accountId, ruleId, chain))
            if (result.chainGuardSkipped) {
                // Broken chain state: skip so the engine can reconstitute on the next pass.
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Chain guard skipped enforcement for rule ${ruleId}: stored addon list does not carry the active chain tier.`)
                return null
            }
            return storedAddonList
        }
        try {
            const built = await buildReconciledList(authKey, chain, activeUrl, accountId, ruleId, storedAddonList, forceReinstall)
            await writeStremioCollection(authKey, built.canonical, { remoteAddons: built.remoteAddons, normalizedActive: built.normalizedActive, accountId })
            return built.canonical
        } catch (err) {
            if (err.status === 401) {
                fastify.log.error({ category: 'Autopilot' }, `[${maskContext(accountId)}] Auth Key Expired (401). Disabling rule.`)
                await db.run('UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2', [Date.now(), ruleId])
            }
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(accountId)}] Mirror sync failed: ${err.message}`)
            throw err
        }
    }

    const resolveMessageTemplate = (template, payload) => {
        if (!template) return payload.message
        const values = {
            account: payload.accountName || payload.accountId || 'Unknown',
            rule: payload.ruleName || 'Unnamed Rule',
            primary: payload.fromName || payload.fromUrl || 'Unknown',
            backup: payload.activeName || payload.activeUrl || 'Unknown',
            addon: payload.activeName || 'Unknown',
            from: payload.fromName || payload.fromUrl || 'Unknown',
            to: payload.activeName || payload.activeUrl || 'Unknown',
            status: payload.type === 'failover' ? 'Failed Over' : payload.type === 'recovery' ? 'Recovered' : payload.type,
            provider: payload.provider || 'Unknown',
        }
        return template.replace(/\{{1,2}\s*(account|rule|primary|backup|addon|from|to|status|provider)\s*\}{1,2}/gi, (match, key) => {
            const value = values[key.toLowerCase()]
            return value !== undefined ? value : match
        })
    }

    const sendNotification = async (webhookUrl, payload) => {
        if (!webhookUrl || !webhookUrl.startsWith('http')) return
        if (!(await isSafeUrlResolved(webhookUrl))) return

        return enqueueProxyRequest(webhookUrl, async () => {
            try {
                const message = resolveMessageTemplate(payload.messageTemplate, payload)
                let body

                if (webhookUrl.includes('discord.com/api/webhooks/')) {
                    body = {
                        username: 'AIOManager Autopilot',
                        avatar_url: 'https://raw.githubusercontent.com/Sonicx161/AIOManager/main/public/logo.png',
                        content: payload.discordMention || undefined,
                        embeds: [{
                            color: payload.type === 'failover' ? 0xff9900 : (payload.type === 'recovery' ? 0x00cc66 : payload.type === 'debrid_down' ? 0xff3333 : 0x3b82f6),
                            title: payload.type === 'failover' ? '⚠️ Failover Triggered' : (payload.type === 'recovery' ? '✅ Recovery' : payload.type === 'debrid_down' ? '🔑 Debrid Provider Down' : '📡 Notification'),
                            description: message,
                            fields: payload.type === 'debrid_down'
                                ? [{ name: 'Provider', value: payload.provider || 'Unknown', inline: true }]
                                : [
                                    { name: 'Account', value: payload.accountName || payload.accountId || 'Unknown', inline: true },
                                    { name: 'Active Addon', value: payload.activeName || 'Unknown', inline: true }
                                ],
                            timestamp: new Date().toISOString()
                        }]
                    }
                } else if (webhookUrl.includes('hooks.slack.com/')) {
                    const emoji = payload.type === 'failover' ? '⚠️' : (payload.type === 'recovery' ? '✅' : payload.type === 'debrid_down' ? '🔑' : '📡')
                    body = {
                        text: `${emoji} *AIOManager Autopilot*\n${message}`,
                        attachments: [{
                            color: payload.type === 'failover' ? 'warning' : (payload.type === 'recovery' ? 'good' : payload.type === 'debrid_down' ? 'danger' : '#3b82f6'),
                            fields: payload.type === 'debrid_down'
                                ? [{ title: 'Provider', value: payload.provider || 'Unknown', short: true }]
                                : [
                                    { title: 'Account', value: payload.accountName || payload.accountId || 'Unknown', short: true },
                                    { title: 'Active Addon', value: payload.activeName || 'Unknown', short: true }
                                ],
                            footer: 'AIOManager Autopilot',
                            ts: Math.floor(Date.now() / 1000)
                        }]
                    }
                } else {
                    body = {
                        source: 'AIOManager Autopilot',
                        type: payload.type,
                        message,
                        accountName: payload.accountName || payload.accountId || 'Unknown',
                        activeName: payload.activeName || 'Unknown',
                        provider: payload.provider || undefined,
                        timestamp: new Date().toISOString()
                    }
                }

                const webhookRes = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    redirect: 'manual'
                })
                if (!webhookRes.ok) {
                    fastify.log.warn({ category: 'Autopilot' }, `Webhook ${webhookUrl.substring(0, 30)} returned status ${webhookRes.status}`)
                }
            } catch (err) {
                fastify.log.error({ category: 'Autopilot' }, `Webhook failed for ${webhookUrl.substring(0, 30)}: ${err.message}`)
            }
        })
    }

    const recordFailoverHistory = async (rule, type, message, primaryUrl, activeUrl, metadata = null, latencyMs = null) => {
        try {
            const id = generateRandomKey().substring(0, 16)

            const encryptedPrimary = encrypt(primaryUrl, PRIMARY_KEY)
            const encryptedActive = encrypt(activeUrl, PRIMARY_KEY)
            const encryptedMsg = encrypt(message, PRIMARY_KEY)
            const encryptedMeta = metadata ? encrypt(JSON.stringify(metadata), PRIMARY_KEY) : null

            await db.run(`
                INSERT INTO failover_history (id, timestamp, type, rule_id, account_id, primary_name, backup_name, message, metadata, latency_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [id, Date.now(), type, rule.id, rule.account_id, encryptedPrimary, encryptedActive, encryptedMsg, encryptedMeta, latencyMs])

            // High-Scale Optimization: Keep only 10 records per account.
            // NOTE: $1 is used twice. For SQLite, the db layer converts $N to ?,
            // so we must pass account_id twice in the params array.
            await db.run(`
                DELETE FROM failover_history 
                WHERE account_id = $1 
                AND id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM failover_history 
                        WHERE account_id = $2 
                        ORDER BY timestamp DESC 
                        LIMIT 10
                    ) AS x
                )
            `, [rule.account_id, rule.account_id])
        } catch (err) {
            fastify.log.error({ category: 'Autopilot' }, `History record failed: ${err.message}`)
        }
    }


    const processAutopilotRule = async (rule) => {
        if (rule.is_automatic === 0) {
            // Skip automatic switching for manual-only rules
            return
        }
        const decryptedAuthKey = decrypt(rule.auth_key, FALLBACK_KEYS)
        const decryptedChainStr = decrypt(rule.priority_chain, FALLBACK_KEYS)
        const hasConnectionTarget = !!rule.connection_id && !!rule.platform && rule.platform !== 'stremio'
        if (!decryptedChainStr || (!decryptedAuthKey && !hasConnectionTarget)) {
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Failed to decrypt rule data. Skipping.`)
            await recordRuleDecryptFailure(rule)
            return
        }
        const decryptedActiveUrl = decrypt(rule.active_url, FALLBACK_KEYS) || rule.active_url
        const decryptedStabilizationStr = rule.stabilization ? decrypt(rule.stabilization, FALLBACK_KEYS) : null
        const decryptedAddonListStr = rule.addon_list ? decrypt(rule.addon_list, FALLBACK_KEYS) : null
        let shouldUpdateNotificationTime = false

        let chain = []
        try {
            if (Array.isArray(decryptedChainStr)) {
                chain = decryptedChainStr
            } else if (typeof decryptedChainStr === 'string' && decryptedChainStr.startsWith('[')) {
                chain = JSON.parse(decryptedChainStr)
            } else if (typeof rule.priority_chain === 'string' && rule.priority_chain.startsWith('[')) {
                chain = JSON.parse(rule.priority_chain)
            }
        } catch (e) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Chain parse failed: ${e.message}`)
        }

        chain = (await Promise.all(chain.map(async url => (await isSafeUrlResolved(url)) ? url : null))).filter(Boolean)

        // Other rules of this account own the other chains; never write their state from
        // this rule's snapshot — it is stale from the moment they swap.
        const siblingPlans = await siblingChainPlans(rule.account_id, rule.id, chain)

        if (!Array.isArray(chain) || chain.length === 0) {
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] No valid priority chain. Skipping.`)
            return
        }

        const normalizedChainUrls = chain.map(u => normalizeAddonUrl(u).toLowerCase())
        const currentActiveNorm = normalizeAddonUrl(decryptedActiveUrl || chain[0]).toLowerCase()

        let addonList = [];
        try {
            if (Array.isArray(decryptedAddonListStr)) {
                addonList = decryptedAddonListStr
            } else if (typeof decryptedAddonListStr === 'string' && decryptedAddonListStr.startsWith('[')) {
                addonList = JSON.parse(decryptedAddonListStr)
            } else if (typeof rule.addon_list === 'string' && rule.addon_list.startsWith('[')) {
                addonList = JSON.parse(rule.addon_list)
            }
        } catch (e) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Addon list parse failed: ${e.message}`)
        }

        let customChecks = []
        try {
            const raw = rule.custom_check_urls
            let parsed = null
            if (typeof raw === 'string' && raw.length > 0) {
                const decrypted = decrypt(raw, FALLBACK_KEYS)
                if (decrypted && decrypted.startsWith('[')) {
                    parsed = JSON.parse(decrypted)
                } else if (raw.startsWith('[')) {
                    parsed = JSON.parse(raw)
                }
            } else if (Array.isArray(raw)) {
                parsed = raw
            }
            if (Array.isArray(parsed)) {
                customChecks = parsed.map(item => {
                    if (typeof item === 'string') return item.trim() ? { url: item, appliesTo: [] } : null
                    if (item && typeof item === 'object' && typeof item.url === 'string') {
                        return { url: item.url, appliesTo: Array.isArray(item.appliesTo) ? item.appliesTo.filter(u => typeof u === 'string') : [] }
                    }
                    return null
                }).filter(Boolean).filter(c => c.url)
            }
        } catch (e) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Custom check URLs parse failed: ${e.message}`)
        }

        let stabilization = {}
        try {
            if (decryptedStabilizationStr && typeof decryptedStabilizationStr === 'object') {
                stabilization = decryptedStabilizationStr
            } else if (typeof decryptedStabilizationStr === 'string' && decryptedStabilizationStr.startsWith('{')) {
                stabilization = JSON.parse(decryptedStabilizationStr)
            } else if (typeof rule.stabilization === 'string' && rule.stabilization.startsWith('{')) {
                stabilization = JSON.parse(rule.stabilization)
            }
        } catch (e) {
            stabilization = {}
        }

        const FAILOVER_THRESHOLD = 2
        const RECOVERY_THRESHOLD = 2

        let targetActiveUrl = decryptedActiveUrl || chain[0]
        let foundOnline = false

        const checkOrder = Array.from({ length: chain.length }, (_, i) => i)

        for (const i of checkOrder) {
            const url = chain[i]
            const normUrl = normalizedChainUrls[i]
            let isHealthy = await checkAddonHealthInternal(url)

            if (isHealthy && customChecks.length > 0) {
                const applicableChecks = customChecks.filter(c =>
                    c.appliesTo.length === 0 ||
                    c.appliesTo.some(au => normalizeAddonUrl(au).toLowerCase() === normUrl)
                )
                if (applicableChecks.length > 0) {
                    const checkUrls = [...new Set(applicableChecks.map(c => c.url))]
                    const customPassed = await checkCustomUrlsHealth(checkUrls, rule.id, rule.account_id)
                    isHealthy = isHealthy && customPassed
                }
            }

            if (isHealthy) {
                const prevSuccesses = stabilization[normUrl]?.successes || 0
                const newSuccesses = Math.min(prevSuccesses + 1, RECOVERY_THRESHOLD)
                if (stabilization[normUrl]?.failures !== 0 || prevSuccesses !== newSuccesses) {
                    stabilization[normUrl] = { failures: 0, successes: newSuccesses, latencyMs: getHealthLatency(url) }
                }
            } else {
                // Unclamped on purpose: the threshold below is a trigger comparison only.
                const prevFailures = stabilization[normUrl]?.failures || 0
                const newFailures = prevFailures + 1
                if (stabilization[normUrl]?.successes !== 0 || prevFailures !== newFailures) {
                    stabilization[normUrl] = { failures: newFailures, successes: 0, latencyMs: null }
                }
            }

            const successes = stabilization[normUrl]?.successes || 0

            if (isHealthy && normUrl === currentActiveNorm) {
                targetActiveUrl = url
                foundOnline = true
                break
            }

            if (isHealthy && successes >= RECOVERY_THRESHOLD) {
                targetActiveUrl = url
                foundOnline = true
                const recoveredAddon = addonList.find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl)
                if (recoveredAddon && !isSubstantial(recoveredAddon.manifest)) {
                    const freshManifest = await fetchManifestRaw(url, rule.account_id)
                    if (freshManifest && isSubstantial(freshManifest)) {
                        addonList = addonList.map(a =>
                            normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl
                                ? { ...a, manifest: freshManifest }
                                : a
                        )
                    }
                }
                break
            }

            const activeStats = stabilization[currentActiveNorm]
            const activeIsDead = (activeStats?.failures || 0) >= FAILOVER_THRESHOLD

            if (isHealthy && activeIsDead) {
                targetActiveUrl = url
                foundOnline = true
                break
            }
        }

        const decryptedNormalizedActive = currentActiveNorm
        let normalizedTarget = normalizeAddonUrl(targetActiveUrl).toLowerCase()
        // Publish this cycle's decision so sibling rules derive this chain from it, not from
        // the persisted active_url (written only after the whole account batch).
        cycleTargets.set(rule.id, normalizedTarget)
        const normalizedChain = normalizedChainUrls
        const normalizedChainSet = new Set(normalizedChain)

        // Every writer must derive identical one-active flags via the shared helper — for every
        // chain this account manages, not only this rule's (applyAccountChainFlags), otherwise
        // the writer publishes its stale copy of the sibling chains. Chains this list cannot
        // express are handed to the write-time mirror instead, so the derivation (this rule's
        // decided targets) always outranks the platform's not-yet-updated member set.
        const ownChain = applyOneActiveFlags(addonList, normalizedChain, normalizedTarget)
        const violationDetected = ownChain.violationDetected
        const folded = siblingPlans.length > 0 ? applyAccountChainFlags(ownChain.list, siblingPlans) : { list: ownChain.list, skipped: [] }
        const updatedAddonList = folded.list
        const mirrorChainUrls = folded.skipped.flatMap(p => p.urls)

        let hasChanged = normalizedTarget !== decryptedNormalizedActive

        // Steady rules never read the live collection; re-check it on the deep-audit cadence
        let lastDeepAuditToSave = getRuleRuntimeState(rule.id)?.lastDeepAudit ?? null
        let deepAuditDrift = false
        const snapshotLooksClean = !hasChanged && !violationDetected
        if (snapshotLooksClean && decryptedAuthKey) {
            if (Date.now() - (lastDeepAuditToSave || 0) >= RULE_DEEP_AUDIT_MS) {
                lastDeepAuditToSave = Date.now()
                try {
                    // First healthy member by chain order; fall back to the stored active addon
                    let canonicalTarget = null
                    for (let ci = 0; ci < chain.length; ci++) {
                        const cUrl = chain[ci]
                        const cNorm = normalizedChainUrls[ci]
                        if (!await checkAddonHealthInternal(cUrl)) continue
                        const applicable = customChecks.filter(c =>
                            c.appliesTo.length === 0 ||
                            c.appliesTo.some(au => normalizeAddonUrl(au).toLowerCase() === cNorm)
                        )
                        const checkUrls = [...new Set(applicable.map(c => c.url))]
                        if (checkUrls.length > 0 && !await checkCustomUrlsHealth(checkUrls, rule.id, rule.account_id)) continue
                        canonicalTarget = cNorm
                        break
                    }
                    const auditReference = canonicalTarget ?? currentActiveNorm

                    const liveAddons = await stremioDriver.readAddons(decryptedAuthKey)
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
                    deepAuditDrift = liveAddons.some(a => {
                        const normUrl = normalizeAddonUrl(a.transportUrl).toLowerCase()
                        const effectiveUrl = normalizedChainSet.has(normUrl)
                            ? normUrl
                            : (a.manifest?.id && liveChainIdMap.has(a.manifest.id) ? liveChainIdMap.get(a.manifest.id) : null)
                        if (!effectiveUrl) return false
                        return (a.flags?.enabled !== false) !== (effectiveUrl === auditReference)
                    })
                    if (deepAuditDrift) {
                        fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit found live collection drift from the one-active chain state. Forcing enforcement.`)
                        if (canonicalTarget && canonicalTarget !== normalizedTarget) {
                            targetActiveUrl = chain[normalizedChainUrls.indexOf(canonicalTarget)] || targetActiveUrl
                            normalizedTarget = canonicalTarget
                            hasChanged = normalizedTarget !== decryptedNormalizedActive
                        }
                    }
                } catch (auditErr) {
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit read failed: ${auditErr.message}`)
                }
            }
        } else if (snapshotLooksClean && hasConnectionTarget && reconciler?.resolveConnections && reconciler.auditConnections) {
            // Hourly drift audit: catches Nuvio-side changes the echo and reconcile paths miss.
            if (Date.now() - (lastDeepAuditToSave || 0) >= RULE_DEEP_AUDIT_MS) {
                lastDeepAuditToSave = Date.now()
                try {
                    const auditTargets = (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user) || [])
                        .filter(c => c.enabled && c.platform !== 'stremio' && (!rule.connection_id || c.id === rule.connection_id))
                    if (auditTargets.length > 0) {
                        const auditCanonical = updatedAddonList.filter(a => a?.flags?.enabled !== false)
                        const audits = await reconciler.auditConnections(rule.account_id, auditTargets, auditCanonical)
                        for (const audit of audits) {
                            if (!Array.isArray(audit.addons)) continue
                            const enabledChain = new Set()
                            for (const live of audit.addons) {
                                const norm = normalizeAddonUrl(live.transportUrl || live.url || '').toLowerCase()
                                if (normalizedChainSet.has(norm) && (live.flags?.enabled ?? live.enabled) !== false) enabledChain.add(norm)
                            }
                            if (!(enabledChain.size === 1 && enabledChain.has(normalizedTarget))) {
                                deepAuditDrift = true
                                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit (connection) found live collection drift from the one-active chain state on ${audit.platform}. Forcing enforcement.`)
                                break
                            }
                        }
                    }
                } catch (auditErr) {
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Deep audit (connection) read failed: ${auditErr.message}`)
                }
            }
        }

        const needsSync = hasChanged || violationDetected || deepAuditDrift

        let reconciledList = null
        let syncSucceeded = !needsSync
        if (needsSync) {
            const statusMsg = foundOnline ? `Swapping to: ${truncateUrl(normalizedTarget)}` : `Outage! Primary offline, keeping/forcing ${truncateUrl(normalizedTarget)}`
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] [Enforcement] ${statusMsg} (Swap: ${hasChanged}, Multi-Enabled: ${violationDetected})`)

            try {
                if (!decryptedAuthKey) {
                    const { synced } = await enforceConnectionOnly(rule, updatedAddonList, chain, targetActiveUrl, siblingPlans, mirrorChainUrls)
                    if (synced.length === 0) throw new Error('Connection enforcement failed')
                    reconciledList = updatedAddonList
                    syncSucceeded = true
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Synced ${truncateUrl(normalizedTarget)} to ${synced.join(', ')}.`)
                } else if (isUnifiedEnforcement() && reconciler?.enforceAccount) {
                    const built = await buildReconciledList(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, rule.id, updatedAddonList, hasChanged)
                    reconciledList = built.canonical

                    const stremioConn = { id: `${rule.account_id}:stremio`, platform: 'stremio', accountId: rule.account_id, enabled: true, status: 'active', credentials: { authKey: decryptedAuthKey }, capabilities: ['addons'], consecutiveFailures: 0 }
                    const connectionTargets = hasChanged ? (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)).filter(c => c.platform !== 'stremio') : []
                    const stremioWriter = async (conn) => {
                        try {
                            await writeStremioCollection(conn.credentials.authKey, built.canonical, { remoteAddons: built.remoteAddons, normalizedActive: built.normalizedActive, accountId: rule.account_id })
                        } catch (err) {
                            if (err.status === 401) {
                                fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Auth Key Expired (401). Disabling rule.`)
                                await db.run('UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2', [Date.now(), rule.id])
                            }
                            throw err
                        }
                    }

                    const result = await reconciler.enforceAccount(rule.account_id, [stremioConn, ...connectionTargets], built.canonical, { stremioWriter })
                    if (!result.synced.includes('stremio')) throw new Error('Stremio enforcement failed')
                    syncSucceeded = true
                    const syncedPlatforms = result.synced.map(p => p === 'stremio' ? 'Stremio' : p)
                    const failedPlatforms = connectionTargets.map(c => c.platform).filter(p => !result.synced.includes(p))
                    const failedNote = failedPlatforms.length > 0 ? ` (push failed: ${failedPlatforms.join(', ')})` : ''
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Synced ${truncateUrl(normalizedTarget)} to ${syncedPlatforms.join(', ')}.${failedNote}`)
                } else {
                    reconciledList = await syncStremioLive(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, rule.id, updatedAddonList, hasChanged)
                    syncSucceeded = true

                    const syncedPlatforms = ['Stremio']
                    const failedPlatforms = []
                    if (hasChanged && reconciler) {
                        try {
                            const conns = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
                            const targets = conns.filter(c => c.platform !== 'stremio')
                            if (targets.length > 0) {
                                await reconciler.reconcileAccount(rule.account_id, null, conns, reconciledList ?? updatedAddonList)
                                syncedPlatforms.push(...targets.map(c => c.platform))
                            }
                        } catch (connErr) {
                            failedPlatforms.push('connection sync')
                            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection sync failed: ${connErr.message}`)
                        }
                    }
                    const failedNote = failedPlatforms.length > 0 ? ` (push failed: ${failedPlatforms.join(', ')})` : ''
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Synced ${truncateUrl(normalizedTarget)} to ${syncedPlatforms.join(', ')}.${failedNote}`)
                }

                if (hasChanged) {
                    const primaryUrl = chain[0]
                    const type = normalizedTarget === normalizeAddonUrl(primaryUrl).toLowerCase() ? 'recovery' : 'failover'
                    const msg = type === 'failover' ? `Primary offline. Switched to backup.` : `Primary recovered. Restored original priority.`

                    await recordFailoverHistory(rule, type, msg, primaryUrl, targetActiveUrl, {
                        chain: normalizedChain,
                        activeUrl: normalizedTarget
                    }, getHealthLatency(targetActiveUrl))

                    const now = Date.now()
                    const lastNotification = rule.last_notification || 0
                    const cooldownMs = rule.cooldown_ms || (10 * 60 * 1000)

                    const isRecovery = type === 'recovery'
                    const cooldownPassed = now - lastNotification >= cooldownMs

                    if (isRecovery || cooldownPassed) {
                        // Resolution order: decrypted per-rule webhook -> owner's global
                        // webhook (the UI's "Use global webhook" default) -> none.
                        let webhookUrl = rule.webhook_url ? decrypt(rule.webhook_url, FALLBACK_KEYS) : null
                        let webhookSource = 'rule'
                        if (rule.webhook_url && !webhookUrl) {
                            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Per-rule webhook blob present but undecryptable; falling back to the global webhook.`)
                        }
                        if (!webhookUrl) {
                            webhookUrl = await getGlobalWebhook(rule.owner_sync_user)
                            webhookSource = 'global'
                        }
                        if (!webhookUrl) {
                            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] No webhook configured (rule + global). Skipping notification.`)
                        } else {
                            await sendNotification(webhookUrl, {
                                type,
                                message: msg,
                                messageTemplate: rule.message_template || null,
                                accountId: rule.account_id,
                                accountName: rule.account_name || null,
                                ruleName: rule.name || null,
                                activeName: targetActiveUrl,
                                fromName: chain[0],
                                fromUrl: chain[0],
                            })
                            shouldUpdateNotificationTime = true
                            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook sent (${webhookSource}): ${type}`)
                        }
                    } else {
                        fastify.log.debug({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook skipped (cooldown: ${Math.round((cooldownMs - (now - lastNotification)) / 1000)}s remaining)`)
                    }
                }
            } catch (syncErr) {
                fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Stremio sync error: ${syncErr.message}`)
            }
        }

        const stabilizationJson = JSON.stringify(stabilization)
        const now = Date.now()
        const stabilizationChanged = stabilizationJson !== decryptedStabilizationStr
        const needsStatsUpdate = stabilizationChanged
        const needsColdUpdate = needsSync && syncSucceeded
        const lastNotificationToSave = shouldUpdateNotificationTime ? now : (rule.last_notification || 0)

        setRuleRuntimeState(rule.id, {
            accountId: rule.account_id,
            lastCheck: now,
            lastNotification: lastNotificationToSave,
            stabilization,
            activeUrl: needsSync && !syncSucceeded ? decryptedActiveUrl : targetActiveUrl,
            ...(lastDeepAuditToSave != null ? { lastDeepAudit: lastDeepAuditToSave } : {})
        })

        if (!needsColdUpdate && !needsStatsUpdate) {
            const steadyHeartbeatDue = rule.last_check == null || now - rule.last_check >= RULE_HEARTBEAT_MS
            if (!steadyHeartbeatDue) return null
        }

        const stabilizationToSave = encrypt(stabilizationJson, PRIMARY_KEY)

        if (needsColdUpdate) {
            const activeUrlToSave = (hasChanged || !decryptedActiveUrl) ? encrypt(targetActiveUrl, PRIMARY_KEY) : null
            const addonListToSave = encrypt(JSON.stringify(reconciledList ?? updatedAddonList), PRIMARY_KEY)

            return {
                type: 'full',
                ruleParams: [activeUrlToSave, addonListToSave, now, rule.id],
                statsParams: [rule.id, stabilizationToSave, now, lastNotificationToSave, now]
            }
        } else {
            // Steady heartbeats (stabilization unchanged) pass null so the upsert keeps the stored encrypted blob instead of rewriting it
            return {
                type: 'heartbeat',
                statsParams: [rule.id, needsStatsUpdate ? stabilizationToSave : null, now, lastNotificationToSave, now]
            }
        }
    }

    const runAutopilot = async () => {
        if (serverState.isWorkerRunning) {
            fastify.log.warn({ category: 'Autopilot' }, 'Autonomous Engine: Previous run still in progress. Skipping cycle.')
            return
        }

        serverState.isWorkerRunning = true
        serverState.lastWorkerRun = Date.now()

        fastify.log.debug({ category: 'Autopilot' }, `Autonomous Engine: Starting budgeted scaling-aware scan.`)

        try {
            const CHUNK_SIZE = AUTOPILOT_SCAN_CHUNK_SIZE
            let lastId = serverState.autopilotScanCursor || ''
            let totalProcessed = 0
            let hasMore = true
            let wrappedScan = false
            const cycleStart = Date.now()
            const staleCutoff = cycleStart - RULE_RECHECK_MS
            const scanDeadline = cycleStart + AUTOPILOT_CYCLE_BUDGET_MS

            while (hasMore && totalProcessed < AUTOPILOT_MAX_RULES_PER_CYCLE && Date.now() < scanDeadline) {
                const candidateLimit = Math.min(CHUNK_SIZE, AUTOPILOT_MAX_RULES_PER_CYCLE - totalProcessed)
                const candidateRules = await db.query(
                    `SELECT r.id, r.account_id, r.is_automatic, r.updated_at,
                            COALESCE(s.last_check, r.last_check) AS last_check
                     FROM autopilot_rules r
                     LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                     WHERE r.is_active = 1
                     AND (r.auth_key IS NOT NULL OR r.connection_id IS NOT NULL)
                     AND r.is_automatic = 1
                     AND r.id > $1
                     AND (COALESCE(s.last_check, r.last_check) IS NULL OR COALESCE(s.last_check, r.last_check) < $2)
                     ORDER BY r.id ASC
                     LIMIT $3`,
                    [lastId, staleCutoff, candidateLimit]
                )

                if (candidateRules.length === 0) {
                    if (lastId && !wrappedScan) {
                        lastId = ''
                        serverState.autopilotScanCursor = ''
                        wrappedScan = true
                        continue
                    } else {
                        hasMore = false
                        serverState.autopilotScanCursor = ''
                        break
                    }
                }

                totalProcessed += candidateRules.length
                lastId = candidateRules[candidateRules.length - 1].id
                serverState.autopilotScanCursor = lastId

                const dueRules = candidateRules.filter(rule => !shouldSkipRuleCheck(rule.id, staleCutoff))

                if (dueRules.length === 0) {
                    if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || Date.now() >= scanDeadline) break
                    continue
                }

                const accountNameMap = new Map()
                const accountNameIds = [...new Set(dueRules.map(r => r.account_id).filter(Boolean))]
                if (accountNameIds.length > 0) {
                    const credPh = accountNameIds.map((_, i) => `$${i + 1}`).join(',')
                    const credRows = await db.query(
                        `SELECT account_id, sync_user, account_name FROM server_credentials
                         WHERE account_name <> '' AND account_id IN (${credPh})`,
                        accountNameIds
                    )
                    for (const c of credRows) {
                        const k = `${c.account_id}\0${c.sync_user || ''}`
                        if (!accountNameMap.has(k)) accountNameMap.set(k, c.account_name)
                    }
                }

                const hitRows = []
                const missIds = []
                for (const candidate of dueRules) {
                    const cached = ruleCacheGet(candidate.id, candidate.updated_at)
                    if (cached) hitRows.push({ id: candidate.id, row: cached.row, bytes: cached.bytes })
                    else missIds.push(candidate.id)
                }

                const rules = []

                if (missIds.length > 0) {
                    const placeholders = missIds.map((_, index) => `$${index + 1}`).join(',')
                    const missRows = await db.query(
                        `SELECT r.id, r.account_id, r.auth_key, r.priority_chain, r.addon_list, r.active_url, r.webhook_url,
                                COALESCE(s.stabilization, r.stabilization) AS stabilization,
                                r.is_active, r.is_automatic,
                                COALESCE(s.last_check, r.last_check) AS last_check,
                                COALESCE(s.last_notification, r.last_notification) AS last_notification,
                                r.name, r.cooldown_ms, r.message_template, r.owner_sync_user,
                                r.platform, r.connection_id, r.updated_at, r.custom_check_urls
                         FROM autopilot_rules r
                         LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                         WHERE r.id IN (${placeholders})
                         ORDER BY r.id ASC`,
                        missIds
                    )
                    for (const row of missRows) {
                        row.account_name = accountNameMap.get(`${row.account_id}\0${row.owner_sync_user || ''}`) || null
                        ruleCacheSet(row.id, row.updated_at, row)
                        ruleCacheStats.misses++
                        rules.push(row)
                    }
                }

                if (hitRows.length > 0) {
                    const hitIds = hitRows.map(h => h.id)
                    const placeholders = hitIds.map((_, index) => `$${index + 1}`).join(',')
                    const volatileRows = await db.query(
                        `SELECT r.id,
                                COALESCE(s.stabilization, r.stabilization) AS stabilization,
                                COALESCE(s.last_check, r.last_check) AS last_check,
                                COALESCE(s.last_notification, r.last_notification) AS last_notification
                         FROM autopilot_rules r
                         LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                         WHERE r.id IN (${placeholders})
                         ORDER BY r.id ASC`,
                        hitIds
                    )
                    const volatileById = new Map(volatileRows.map(v => [v.id, v]))
                    for (const hit of hitRows) {
                    const volatile = volatileById.get(hit.id)
                    if (!volatile) continue
                        volatile.account_name = accountNameMap.get(`${hit.row.account_id}\0${hit.row.owner_sync_user || ''}`) || null
                        rules.push({ ...hit.row, ...volatile })
                        ruleCacheStats.hits++
                        ruleCacheStats.bytesSaved += hit.bytes
                    }
                }

                if (rules.length === 0) {
                    if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || Date.now() >= scanDeadline) break
                    continue
                }

                const BATCH_SIZE = 20
                const dirtyUpdates = []
                for (let i = 0; i < rules.length; i += BATCH_SIZE) {
                    const batch = rules.slice(i, i + BATCH_SIZE)
                    const byAccount = new Map()
                    for (const rule of batch) {
                        const key = rule.account_id || '_none'
                        if (!byAccount.has(key)) byAccount.set(key, [])
                        byAccount.get(key).push(rule)
                    }
                    const accountPromises = []
                    const processRule = async (rule) => {
                        const result = await processAutopilotRule(rule)
                        if (result) dirtyUpdates.push(result)
                    }
                    for (const [, accountRules] of byAccount) {
                        if (accountRules.length === 1) {
                            accountPromises.push(
                                processRule(accountRules[0])
                                    .catch(err => {
                                        fastify.log.error({ category: 'Autopilot' }, `Rule ${accountRules[0].id} error: ${err.message}`)
                                    })
                            )
                        } else {
                            accountPromises.push((async () => {
                                for (const rule of accountRules) {
                                    try {
                                        await processRule(rule)
                                    }
                                    catch (err) { fastify.log.error({ category: 'Autopilot' }, `Rule ${rule.id} error: ${err.message}`) }
                                }
                            })())
                        }
                    }
                    await Promise.all(accountPromises)
                }

                if (dirtyUpdates.length > 0) {
                    const fullUpdates = dirtyUpdates.filter(u => u.type === 'full')
                    const heartbeatUpdates = dirtyUpdates.filter(u => u.type === 'heartbeat')
                    await db.tx(async (conn) => {
                        for (const update of fullUpdates) {
                            await conn.run(`
                                UPDATE autopilot_rules 
                                SET active_url = COALESCE($1, active_url), addon_list = $2, updated_at = $3
                                WHERE id = $4
                            `, update.ruleParams)
                        }
                        const allStats = [...fullUpdates, ...heartbeatUpdates]
                        for (let si = 0; si < allStats.length; si += 100) {
                            const statChunk = allStats.slice(si, si + 100)
                            const statRows = statChunk.map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`).join(',')
                            const statParams = statChunk.flatMap(u => u.statsParams)
                            await conn.run(`
                                INSERT INTO autopilot_rule_stats (rule_id, stabilization, last_check, last_notification, updated_at)
                                VALUES ${statRows}
                                ON CONFLICT (rule_id) DO UPDATE SET
                                    stabilization = COALESCE(EXCLUDED.stabilization, autopilot_rule_stats.stabilization),
                                    last_check = EXCLUDED.last_check,
                                    last_notification = EXCLUDED.last_notification,
                                    updated_at = EXCLUDED.updated_at
                            `, statParams)
                        }
                    })
                }

                if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || Date.now() >= scanDeadline) break
            }

            const budgetHit = totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || Date.now() >= scanDeadline
            serverState.autopilotLastCycleStats = {
                scanned: totalProcessed,
                cursor: serverState.autopilotScanCursor || '',
                budgetHit,
                durationMs: Date.now() - cycleStart
            }

            if (totalProcessed > 0) {
                const cycleDuration = ((Date.now() - cycleStart) / 1000).toFixed(1)
                const suffix = budgetHit ? ` Budget held at ${totalProcessed}/${AUTOPILOT_MAX_RULES_PER_CYCLE}.` : ''
                fastify.log.info({ category: 'Autopilot' }, `Check Summary: Periodic health scan covered ${totalProcessed} candidate rules in ${cycleDuration}s.${suffix}`)
            }

            if (globalHealthCache.size > 10000) {
                const now = Date.now()
                for (const [key, val] of globalHealthCache.entries()) {
                    if (now - val.timestamp > HEALTH_CACHE_TTL_MS) globalHealthCache.delete(key)
                }
            }

            if (Date.now() - ruleCacheStats.windowStart >= 5 * 60 * 1000) {
                const total = ruleCacheStats.hits + ruleCacheStats.misses
                if (total > 0) {
                    const hitPct = Math.round((ruleCacheStats.hits / total) * 100)
                    fastify.log.info({ category: 'Autopilot' }, `Rule cache: ${ruleCacheStats.hits} hits / ${ruleCacheStats.misses} misses (${hitPct}% hit), ~${(ruleCacheStats.bytesSaved / 1048576).toFixed(1)}MB of addon_list reads saved from the DB`)
                }
                ruleCacheStats.hits = 0
                ruleCacheStats.misses = 0
                ruleCacheStats.bytesSaved = 0
                ruleCacheStats.windowStart = Date.now()
            }
        } finally {
            serverState.isWorkerRunning = false
        }
    }

    const startAutopilotWorker = () => {
        if (serverState.autopilotInterval) return
        fastify.log.info({ category: 'Autopilot' }, 'Autonomous Engine started. 🚀')

        runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Startup Error: ${err.message}`))

        serverState.autopilotInterval = setInterval(() => {
            runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Worker Error: ${err.message}`))
        }, 60 * 1000)
    }

    const stopAutopilotWorker = () => {
        if (serverState.autopilotInterval) {
            clearInterval(serverState.autopilotInterval)
            serverState.autopilotInterval = null
        }
    }

    return {
        normalizeAddonUrl,
        checkAddonHealthInternal,
        getHealthLatency,
        syncStremioLive,
        enforceConnectionOnly,
        buildReconciledList,
        writeStremioCollection,
        sendNotification,
        recordFailoverHistory,
        processAutopilotRule,
        getRuleRuntimeState,
        clearRuleRuntimeState,
        clearAccountRuleRuntimeState,
        runAutopilot,
        startAutopilotWorker,
        stopAutopilotWorker
    }
}
