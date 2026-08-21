import db from '../db.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { encrypt, decrypt, generateRandomKey } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { globalHealthCache, healthCheckInFlight, serverState } from '../state.js'
import { isSafeUrlResolved } from '../utils/ssrf.js'
import { safeFetchWithRedirects } from '../utils/safe-fetch.js'
import { deriveAddonName, maskContext, truncateUrl } from '../utils/log-helpers.js'
import { trace } from '../utils/trace.js'
import { createStremioDriver } from '../providers/stremio-driver.js'
import { isUnifiedEnforcement } from '../config.js'

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
    const HEALTH_CACHE_TTL_MS = Math.max(10000, parseInt(process.env.AUTOPILOT_HEALTH_CACHE_TTL_MS || '30000', 10) || 30000)
    const RULE_RECHECK_MS = Math.max(10000, parseInt(process.env.AUTOPILOT_RULE_RECHECK_MS || '30000', 10) || 30000)
    const HEARTBEAT_PERSIST_MS = Math.max(30000, parseInt(process.env.AUTOPILOT_HEARTBEAT_PERSIST_MS || '300000', 10) || 300000)
    const ruleRuntimeState = new Map()

    const RULE_CACHE_MAX_BYTES = Math.max(0, parseInt(process.env.AUTOPILOT_RULE_CACHE_MAX_BYTES || String(256 * 1024 * 1024), 10) || 0)
    const RULE_CACHE_TTL_MS = Math.max(60000, parseInt(process.env.AUTOPILOT_RULE_CACHE_TTL_MS || '600000', 10) || 600000)
    const ruleFetchCache = new Map()
    let ruleFetchCacheBytes = 0
    const ruleCacheStats = { hits: 0, misses: 0, bytesSaved: 0, windowStart: Date.now() }

    const customCheckCache = new Map()
    const customCheckInFlight = new Map()
    const CUSTOM_CHECK_CACHE_TTL = 30000

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

    const checkAddonHealthInternal = async (url, context = 'Autopilot') => {
        const normalizedUrl = normalizeAddonUrl(url).toLowerCase()

        const cached = globalHealthCache.get(normalizedUrl)
        if (cached && Date.now() - cached.timestamp < HEALTH_CACHE_TTL_MS) {
            return cached.isHealthy
        }

        const inFlight = healthCheckInFlight.get(normalizedUrl)
        if (inFlight) return inFlight

        const healthPromise = _performHealthCheck(url, normalizedUrl, context)
        healthCheckInFlight.set(normalizedUrl, healthPromise)
        return healthPromise
    }

    const getHealthLatency = (url) => {
        const normalizedUrl = normalizeAddonUrl(url).toLowerCase()
        return globalHealthCache.get(normalizedUrl)?.latencyMs ?? null
    }

    const _performHealthCheck = async (url, normalizedUrl, context = 'Autopilot') => {
        try {
            const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            let domain = url
            try { domain = new URL(url).origin } catch (e) { }

            const performCheck = async (target, timeoutMs, retries = 1) => {
                let checkQueueKey = target
                try { checkQueueKey = new URL(target).origin } catch (e) { }
                return enqueueProxyRequest(target, async () => {
                    for (let attempt = 0; attempt <= retries; attempt++) {
                        try {
                            const controller1 = new AbortController()
                            const timeout1 = setTimeout(() => controller1.abort(), timeoutMs)

                            const res1 = await fetch(target, {
                                method: 'HEAD',
                                signal: controller1.signal,
                                redirect: 'manual',
                                headers: { 'User-Agent': userAgent, 'Accept': 'application/json, text/plain, */*' }
                            })
                            clearTimeout(timeout1)
                            if (res1.ok || res1.status === 405 || res1.status === 401 || res1.status === 403 || (res1.status >= 300 && res1.status < 400)) return true

                            const controller2 = new AbortController()
                            const timeout2 = setTimeout(() => controller2.abort(), timeoutMs)

                            const res2 = await fetch(target, {
                                method: 'GET',
                                signal: controller2.signal,
                                redirect: 'manual',
                                headers: { 'User-Agent': userAgent, 'Accept': 'application/json, text/plain, */*' }
                            })
                            clearTimeout(timeout2)
                            if (res2.ok || res2.status === 401 || res2.status === 403 || (res2.status >= 300 && res2.status < 400)) return true

                            if (res2.status === 429) {
                                fastify.log.warn({ category: 'Autopilot' }, `Health check rate limited (429), deferring: ${truncateUrl(normalizedUrl)}`)
                                return true
                            }

                            if (res2.status >= 500 && attempt < retries) continue
                            return false
                        } catch (err) {
                            const isTimeout = err.name === 'AbortError'
                            const isNetworkError = ['ECONNRESET', 'ETIMEDOUT', 'EADDRINUSE', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code)
                            const isTLSError = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_ERROR'].some(c => err.message?.includes(c) || err.code === c)

                            if (isTLSError) return true
                            if (attempt < retries && (isTimeout || isNetworkError)) {
                                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
                                continue
                            }
                            return false
                        }
                    }
                    return false
                }, checkQueueKey)
            }

            const startTime = Date.now()
            const isHealthy = await performCheck(domain, 15000) || await performCheck(url, 15000)
            const latencyMs = Date.now() - startTime

            if (!isHealthy) {
                fastify.log.warn({ category: context }, `[Health] Host ${domain} is unreachable.`)
            }

            if (globalHealthCache.size > 20000) {
                const pruneNow = Date.now()
                for (const [key, val] of globalHealthCache.entries()) {
                    if (pruneNow - val.timestamp > HEALTH_CACHE_TTL_MS) globalHealthCache.delete(key)
                }
                if (globalHealthCache.size > 15000) {
                    while (globalHealthCache.size > 10000) {
                        const oldestKey = globalHealthCache.keys().next().value
                        if (oldestKey === undefined) break
                        globalHealthCache.delete(oldestKey)
                    }
                }
            }
            globalHealthCache.set(normalizedUrl, { isHealthy, latencyMs, timestamp: Date.now() })
            return isHealthy
        } finally {
            healthCheckInFlight.delete(normalizedUrl)
        }
    }

    const CUSTOM_CHECK_TIMEOUT_MS = 10000

    const performSingleCustomCheck = async (checkUrl) => {
        if (!(await isSafeUrlResolved(checkUrl))) {
            return false
        }
        let queueKey = checkUrl
        try { queueKey = new URL(checkUrl).origin } catch (e) { }
        return enqueueProxyRequest(checkUrl, async () => {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), CUSTOM_CHECK_TIMEOUT_MS)
            try {
                const res = await safeFetchWithRedirects(checkUrl, { signal: controller.signal, methodFallback: true })
                if (!res) return false
                return res.ok || res.status === 401 || res.status === 403
            } finally {
                clearTimeout(timeout)
            }
        }, queueKey)
    }

    const checkCustomUrlsHealth = async (urls, ruleId, accountId) => {
        if (!Array.isArray(urls) || urls.length === 0) return true
        trace('autopilot.customCheck', 'start', { ruleId, urlCount: urls.length })
        const results = await mapConcurrent(urls, 5, async (checkUrl) => {
            const normalized = normalizeAddonUrl(checkUrl).toLowerCase()
            const cached = customCheckCache.get(normalized)
            if (cached && Date.now() - cached.ts < CUSTOM_CHECK_CACHE_TTL) {
                return cached.healthy
            }
            const existing = customCheckInFlight.get(normalized)
            if (existing) return existing
            const promise = (async () => {
                let healthy = false
                try {
                    healthy = await performSingleCustomCheck(checkUrl)
                } catch (err) {
                    healthy = false
                    trace('autopilot.customCheck', 'error', { ruleId, url: checkUrl, error: err?.message || String(err) })
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Custom check error for ${truncateUrl(checkUrl)}: ${err?.message}`)
                }
                customCheckCache.set(normalized, { healthy, ts: Date.now() })
                if (customCheckCache.size > 2000) {
                    const nowTs = Date.now()
                    for (const [key, val] of customCheckCache.entries()) {
                        if (nowTs - val.ts > CUSTOM_CHECK_CACHE_TTL) customCheckCache.delete(key)
                    }
                }
                if (!healthy) {
                    trace('autopilot.customCheck', 'failed', { ruleId, url: checkUrl })
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Custom check failed for ${truncateUrl(checkUrl)}`)
                } else {
                    trace('autopilot.customCheck', 'passed', { ruleId, url: checkUrl })
                }
                return healthy
            })()
            customCheckInFlight.set(normalized, promise)
            promise.finally(() => customCheckInFlight.delete(normalized))
            return promise
        })
        return results.every(r => r === true)
    }

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
        const finalAddons = [];

        const isObsoleteGhost = (remoteAddon) => {
            if (managedChain.length === 0) return false;
            const normRemote = normalizeAddonUrl(remoteAddon.transportUrl).toLowerCase();
            const id = remoteAddon.manifest?.id;
            if (!id) return false;

            if (managedChain.includes(normRemote)) return false;

            return (localAddons || []).some(local =>
                local.manifest?.id === id &&
                managedChain.includes(normalizeAddonUrl(local.transportUrl).toLowerCase())
            );
        };

        (localAddons || []).forEach(localAddon => {
            const normLocal = normalizeAddonUrl(localAddon.transportUrl).toLowerCase()
            const idLocal = localAddon.manifest?.id

            let remoteAddon = remoteAddonMap.get(normLocal);

            if (!remoteAddon && idLocal) {
                const potentialSwap = remoteIdMap.get(idLocal)
                if (potentialSwap) {
                    const isClaimedByExactUrl = (localAddons || []).some(l =>
                        l !== localAddon && normalizeAddonUrl(l.transportUrl).toLowerCase() === normalizeAddonUrl(potentialSwap.transportUrl).toLowerCase()
                    )
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
        const normalizedActive = normalizeAddonUrl(activeUrl).toLowerCase();

        const baseAddonList = (storedAddonList && storedAddonList.length > 0)
            ? [...storedAddonList]
            : [...remoteAddons];

        for (let idx = 0; idx < normalizedChain.length; idx++) {
            const normUrl = normalizedChain[idx];
            const exists = baseAddonList.some(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);
            if (!exists) {
                const remote = remoteAddons.find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);

                const remoteById = remoteAddons.find(a =>
                    a.manifest?.id &&
                    storedAddonList.some(s => s.manifest?.id === a.manifest.id && normalizeAddonUrl(s.transportUrl).toLowerCase() === normUrl)
                );

                const stored = (storedAddonList || []).find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl);

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
            }
        }

        const updatedLocalAddons = baseAddonList.map(addon => {
            const normalizedUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            if (normalizedChain.includes(normalizedUrl)) {
                const isTarget = normalizedUrl === normalizedActive
                return {
                    ...addon,
                    flags: { ...(addon.flags || {}), enabled: isTarget }
                }
            }
            return addon
        })

        const mergedAddons = mergeAddons(updatedLocalAddons, remoteAddons, normalizedChain)
        return { canonical: mergedAddons, remoteAddons, normalizedActive }
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

    const enforceConnectionOnly = async (rule, reconciledAddons) => {
        if (!reconciler?.enforceAccount) return { synced: [] }
        const connections = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
        const targets = (connections || []).filter(c =>
            c.enabled && c.platform !== 'stremio' && (!rule.connection_id || c.id === rule.connection_id)
        )
        if (targets.length === 0) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only rule has no matching enabled connection. Skipping enforcement.`)
            return { synced: [] }
        }
        const result = await reconciler.enforceAccount(rule.account_id, targets, reconciledAddons, {})
        if (result.synced.length > 0) {
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only enforcement pushed to ${result.synced.join(', ')}.`)
        }
        return { synced: result.synced }
    }

    const syncStremioLive = async (authKeyOrDescriptor, chain, activeUrl, accountId, ruleId, storedAddonList = [], forceReinstall = false) => {
        const descriptor = typeof authKeyOrDescriptor === 'string' ? { authKey: authKeyOrDescriptor } : (authKeyOrDescriptor || {})
        const authKey = descriptor.authKey
        if (!authKey) {
            const rule = { account_id: accountId, id: ruleId, owner_sync_user: descriptor.ownerSyncUser, connection_id: descriptor.connectionId, platform: descriptor.platform }
            await enforceConnectionOnly(rule, storedAddonList)
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
                const prevFailures = stabilization[normUrl]?.failures || 0
                const newFailures = Math.min(prevFailures + 1, FAILOVER_THRESHOLD)
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
        const normalizedTarget = normalizeAddonUrl(targetActiveUrl).toLowerCase()
        const normalizedChain = normalizedChainUrls

        const idCounts = new Map()
        addonList.forEach(addon => {
            if (!addon.manifest?.id) return
            idCounts.set(addon.manifest.id, (idCounts.get(addon.manifest.id) || 0) + 1)
        })
        const duplicateIds = new Set([...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id))

        const chainIdMap = new Map()
        addonList.forEach(addon => {
            if (!addon.manifest?.id) return
            if (duplicateIds.has(addon.manifest.id)) return
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            const idx = normalizedChain.indexOf(normUrl)
            if (idx !== -1) chainIdMap.set(addon.manifest.id, normalizedChain[idx])
        })

        let violationDetected = false
        const updatedAddonList = addonList.map(addon => {
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
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

        const hasChanged = normalizedTarget !== decryptedNormalizedActive

        const needsSync = hasChanged || violationDetected

        let reconciledList = null
        let syncSucceeded = !needsSync
        if (needsSync) {
            const statusMsg = foundOnline ? `Swapping to: ${truncateUrl(normalizedTarget)}` : `Outage! Primary offline, keeping/forcing ${truncateUrl(normalizedTarget)}`
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] [Enforcement] ${statusMsg} (Swap: ${hasChanged}, Multi-Enabled: ${violationDetected})`)

            try {
                if (!decryptedAuthKey) {
                    const { synced } = await enforceConnectionOnly(rule, updatedAddonList)
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
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Synced ${truncateUrl(normalizedTarget)} to ${syncedPlatforms.join(', ')}.`)
                } else {
                    reconciledList = await syncStremioLive(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, rule.id, updatedAddonList, hasChanged)
                    syncSucceeded = true

                    const syncedPlatforms = ['Stremio']
                    if (hasChanged && reconciler) {
                        try {
                            const conns = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
                            const targets = conns.filter(c => c.platform !== 'stremio')
                            if (targets.length > 0) {
                                await reconciler.reconcileAccount(rule.account_id, null, conns, reconciledList ?? updatedAddonList)
                                syncedPlatforms.push(...targets.map(c => c.platform))
                            }
                        } catch (connErr) {
                            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection sync failed: ${connErr.message}`)
                        }
                    }
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Synced ${truncateUrl(normalizedTarget)} to ${syncedPlatforms.join(', ')}.`)
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
                        const decryptedWebhook = rule.webhook_url ? decrypt(rule.webhook_url, FALLBACK_KEYS) : null
                        if (!decryptedWebhook) {
                            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook decryption failed or empty. Skipping notification.`)
                        } else {
                            await sendNotification(decryptedWebhook, {
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
                            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook sent: ${type}`)
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
            activeUrl: needsSync && !syncSucceeded ? decryptedActiveUrl : targetActiveUrl
        })

        const lastPersistedCheck = Number(rule.last_check) || 0
        const heartbeatDue = now - lastPersistedCheck >= HEARTBEAT_PERSIST_MS

        if (!needsColdUpdate && !needsStatsUpdate && !heartbeatDue) {
            return null
        }

        const stabilizationToSave = encrypt(stabilizationJson, PRIMARY_KEY)
        const statsParams = [rule.id, stabilizationToSave, now, lastNotificationToSave, now]

        if (needsColdUpdate) {
            const activeUrlToSave = (hasChanged || !decryptedActiveUrl) ? encrypt(targetActiveUrl, PRIMARY_KEY) : null
            const addonListToSave = encrypt(JSON.stringify(reconciledList ?? updatedAddonList), PRIMARY_KEY)

            return {
                type: 'full',
                ruleParams: [activeUrlToSave, addonListToSave, now, rule.id],
                statsParams
            }
        } else {
            return {
                type: 'heartbeat',
                statsParams
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
                                    stabilization = EXCLUDED.stabilization,
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
