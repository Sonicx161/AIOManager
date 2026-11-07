import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { maskContext, truncateUrl } from '../../utils/log-helpers.js'
import { urlRef } from './url-ref.js'
import { preserveLiveMembers } from '../one-active.js'

export function createMerge({ fastify, stremioDriver, checkAddonHealthInternal, recordFailoverHistory, isSubstantial, fetchManifestRaw, siblingChainPlans = null, runtimeState = null }) {
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
                    fastify.log.info({ category: 'Sync' }, `[Merge] Skipping ghost addon: ${urlRef(normRemote)} (Replaced by chain member)`)
                    return;
                }
                finalAddons.push(remoteAddon);
            }
        });

        return finalAddons
    }

    /**
     * Sync to Stremio (Manager-Mirror Mode).
     * Behaves exactly like the Manager's toggle buttons.
     */
    const buildReconciledList = async (authKey, chain, activeUrl, accountId, ruleId, storedAddonList = [], forceReinstall = false, ownerSyncUser = undefined) => {
        const remoteAddons = await stremioDriver.readAddons(authKey)

        const plans = siblingChainPlans ? await siblingChainPlans(accountId, ruleId, chain, ownerSyncUser, null, storedAddonList) : []
        if (plans.readFailed) throw new Error('Sibling rule state could not be read safely. Enforcement will retry.')
        const preserved = plans.contestedUrls || []
        const held = runtimeState?.conflicts.getHold(ruleId)
        if (preserved.includes(normalizeAddonUrl(activeUrl))) {
            const code = held ? 'contested_by_other_writer' : 'chain_overlap'
            const message = held ? 'Another writer keeps changing these addons. Enforcement is paused.' : 'This addon belongs to multiple Autopilot rules. Remove it from one.'
            runtimeState?.setRuleCheckError(ruleId, accountId, code, message, held || { affectedRefs: (plans.overlapUrls || []).map(url => urlRef(url)) })
            throw Object.assign(new Error(message), { code })
        }
        chain = chain.filter(url => !preserved.includes(normalizeAddonUrl(url)))
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

                // Autopilot answers from the shared per-target health state; there is no per-call manifest confirm.
                let isHealthy = await checkAddonHealthInternal(chain[idx], 'Autopilot')
                if (!isHealthy) {
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Skipping restoration for DEAD addon: ${urlRef(chain[idx])}`)
                    continue
                }

                let recoveredManifest = null;
                if (isHealthy) {
                    const currentBest = remote?.manifest || remoteById?.manifest || stored?.manifest;
                    if (!isSubstantial(currentBest)) {
                        fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Restoration Recovery: Attempting manifest fetch for ${urlRef(chain[idx])}`);
                        recoveredManifest = await fetchManifestRaw(chain[idx], accountId);
                        if (recoveredManifest && isSubstantial(recoveredManifest)) {
                            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Restoration Success! Recovered metadata for ${recoveredManifest.name}`);
                        }
                    }
                }

                if (remote) {
                    baseAddonList.push(recoveredManifest ? { ...remote, manifest: recoveredManifest } : remote);
                } else if (remoteById) {
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Recovered manifest for swapped URL: ${urlRef(chain[idx])}`)
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
        const driftLog = []
        const auditedAddons = mergedAddons.map(addon => {
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            const effectiveUrl = normalizedChainSet.has(normUrl)
                ? normUrl
                : (addon.manifest?.id && mergedChainIdMap.has(addon.manifest.id) ? mergedChainIdMap.get(addon.manifest.id) : null)
            if (!effectiveUrl) return addon
            const shouldBeEnabled = effectiveUrl === normalizedActive
            if ((addon.flags?.enabled !== false) === shouldBeEnabled) return addon
            drifted.push({ url: truncateUrl(normUrl), effective: truncateUrl(effectiveUrl), enabled: shouldBeEnabled })
            driftLog.push(`${shouldBeEnabled ? 'enabled' : 'disabled'} ${urlRef(normUrl)}${effectiveUrl !== normUrl ? ` (chain: ${urlRef(effectiveUrl)})` : ''}`)
            return { ...addon, flags: { ...(addon.flags || {}), enabled: shouldBeEnabled } }
        })
        if (drifted.length > 0) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] One-active drift repaired during sync: ${driftLog.join(', ')}`)
            await recordFailoverHistory({ id: ruleId, account_id: accountId }, 'self-healing', `Repaired chain state: ${drifted.map(d => `${d.enabled ? 'enabled' : 'disabled'} ${d.url}`).join(', ')}.`, '', '', { driftRepair: drifted })
        }

        return { canonical: preserveLiveMembers(auditedAddons, remoteAddons, preserved), remoteAddons, normalizedActive, ...(preserved.length > 0 ? { preserveUrls: preserved } : {}) }
    }

    return { mergeAddons, buildReconciledList }
}
