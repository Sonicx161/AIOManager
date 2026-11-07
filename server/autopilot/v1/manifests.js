import { enqueueProxyRequest } from '../../proxy-queue.js'
import { guardedWebFetch } from '../../utils/safe-fetch.js'
import { deriveAddonName } from '../../utils/log-helpers.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { fetchWithHops } from '../health-checks.js'
import { urlRef, scrubUrls } from './url-ref.js'

const MANIFEST_TIMEOUT_MS = 10000
const MANIFEST_MAX_BYTES = 5 * 1024 * 1024

// Connect-time guarded transport with a decompressed size cap; redirects stay caller-driven (fetchWithHops).
const guardedManifestFetch = (url, { method, headers, signal, redirect = 'manual', timeoutMs = MANIFEST_TIMEOUT_MS } = {}) =>
    guardedWebFetch(url, { method, headers, signal, redirect, maxBytes: MANIFEST_MAX_BYTES, connectTimeoutMs: timeoutMs, totalTimeoutMs: timeoutMs + 1000 })

export function createManifests({ fastify, nowMs, fetchImpl = guardedManifestFetch }) {
    const sanitizeManifest = (manifest, transportUrl = '') => {
        const isUnknown = !manifest?.name || manifest?.name === 'Unknown Addon' || manifest?.name === 'Restoring Addon...'
        const name = isUnknown && transportUrl ? deriveAddonName(transportUrl) : (manifest?.name || 'Unknown Addon')

        return {
            ...manifest,
            name,
            id: manifest?.id || `synth-${nowMs()}`,
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
                const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
                try {
                    const res = await fetchWithHops(fetchImpl, url, {
                        method: 'GET',
                        signal: controller.signal,
                        headers: { 'x-stremio-account': accountId || 'autopilot-sync' },
                        timeoutMs: MANIFEST_TIMEOUT_MS,
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
            fastify.log.warn({ category: 'Autopilot' }, `Manifest fetch failed for ${urlRef(url)}: ${scrubUrls(err?.message)}`)
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

    return {
        sanitizeManifest,
        isSubstantial,
        fetchManifestRaw,
        areCollectionsDifferent,
        prepareAddonsForStremio,
        fetchAndRefreshManifest,
    }
}
