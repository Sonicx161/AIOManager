
import { SavedAddon } from '@/types/saved-addon'

export interface HealthStatus {
  isOnline: boolean
  error?: string
}

export function isLocalOrPrivateUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    )
  } catch {
    return false
  }
}

/**
 * Check if an addon URL is accessible
 * @param addonUrl The addon install URL
 * @returns HealthStatus object
 */
export async function checkAddonHealth(addonUrl: string): Promise<HealthStatus> {
  if (isLocalOrPrivateUrl(addonUrl)) {
    return { isOnline: false, error: 'Local addon unreachable from server' }
  }

  let domain = addonUrl;
  try { domain = new URL(addonUrl).origin } catch (e) { console.warn('[AddonHealth] Invalid URL for origin extraction:', addonUrl) }

  const performCheck = async (target: string, timeoutMs: number): Promise<{ ok: boolean, error?: string }> => {
    try {
      const controller = new AbortController()
      const id = setTimeout(() => controller.abort(), timeoutMs)

      const fetchUrl = target;

      // Priority 1: HEAD
      try {
        const response = await fetch(fetchUrl, {
          method: 'HEAD',
          signal: controller.signal,
          mode: 'no-cors',
          cache: 'no-cache'
        })

        if (response.ok || (response.type as string) === 'opaque' || response.status === 405 || response.status === 302) {
          clearTimeout(id)
          return { ok: true }
        }
      } catch (headErr) {
        // Fall through to GET if HEAD fails (often CORS restricts HEAD but allows GET, or proxy needed)
      }

      // Priority 2: GET
      const response2 = await fetch(fetchUrl, {
        method: 'GET',
        signal: controller.signal,
        mode: 'no-cors',
        cache: 'no-cache'
      })

      clearTimeout(id)
      if (response2.ok || (response2.type as string) === 'opaque' || response2.status === 302) return { ok: true }
      return { ok: false, error: (response2.type as string) === 'opaque' ? 'Network Error' : `HTTP ${response2.status}: ${response2.statusText}` }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'Request Timeout' }
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown Network Error' }
    }
  }

  // 1. Silent Domain-Only Check (Direct)
  const domainCheck = await performCheck(domain, 5000)
  if (domainCheck.ok) {
    return { isOnline: true }
  }

  // 2. Definitive Manifest Check (Direct)
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`
  const manifestCheck = await performCheck(manifestUrl, 5000)
  if (manifestCheck.ok) {
    return { isOnline: true }
  }

  // 3. Server-side Proxy Fallback
  try {
    const response = await fetch(`/api/addon-health?url=${encodeURIComponent(addonUrl)}`);
    if (!response.ok) {
      return { isOnline: false, error: 'Connection Failed' };
    }
    const data = await response.json();
    return {
      isOnline: data.isOnline,
      error: data.error
    };
  } catch (err) {
    return { isOnline: false, error: 'Connection Failed' };
  }
}

/**
 * Update a saved addon with health status
 */
export async function updateAddonHealth(addon: SavedAddon): Promise<SavedAddon> {
  const status = await checkAddonHealth(addon.installUrl)

  return {
    ...addon,
    health: {
      isOnline: status.isOnline,
      error: status.error,
      lastChecked: Date.now(),
    },
  }
}

/**
 * Check health for multiple addons with concurrency control
 * @param addons Array of saved addons to check
 * @param onProgress Optional callback for progress updates
 * @returns Array of addons with updated health status
 */
export async function checkAllAddonsHealth(
  addons: SavedAddon[],
  onProgress?: (completed: number, total: number) => void
): Promise<SavedAddon[]> {
  const CONCURRENT_LIMIT = 5
  const results: SavedAddon[] = [...addons]
  const domainHealthCache: Record<string, boolean> = {}
  const PENDING_CHECKS: Record<string, Promise<HealthStatus>> = {}

  for (let i = 0; i < addons.length; i += CONCURRENT_LIMIT) {
    const batch = addons.slice(i, i + CONCURRENT_LIMIT)

    await Promise.all(batch.map(async (addon, batchIndex) => {
      const globalIndex = i + batchIndex

      let origin = ''
      try {
        origin = new URL(addon.installUrl).origin
      } catch (e) {
        origin = addon.installUrl
      }

      let status: HealthStatus
      if (domainHealthCache[origin] === true) {
        status = { isOnline: true }
      } else {
        // Use shared promise for in-flight checks to the same origin
        if (!PENDING_CHECKS[origin]) {
          PENDING_CHECKS[origin] = checkAddonHealth(addon.installUrl).then(s => {
            if (s.isOnline) {
              domainHealthCache[origin] = true
            }
            // Temporarily keep it in the cache to collapse other simultaneous requests
            setTimeout(() => delete PENDING_CHECKS[origin], 2000)
            return s
          })
        }

        const sharedStatus = await PENDING_CHECKS[origin]
        if (sharedStatus.isOnline) {
          status = sharedStatus
        } else {
          // If the shared/first check failed, don't assume everyone on this domain is dead.
          // This specific addon gets to try its own URL as a fallback.
          status = await checkAddonHealth(addon.installUrl)
          if (status.isOnline) {
            domainHealthCache[origin] = true
          }
        }
      }

      results[globalIndex] = {
        ...addon,
        health: {
          isOnline: status.isOnline,
          error: status.error,
          lastChecked: Date.now(),
        },
      }
    }))

    // Report progress
    if (onProgress) {
      onProgress(Math.min(i + CONCURRENT_LIMIT, addons.length), addons.length)
    }
  }

  return results
}

/**
 * Get health summary statistics
 */
export function getHealthSummary(addons: SavedAddon[]): {
  online: number
  offline: number
  unchecked: number
} {
  let online = 0
  let offline = 0
  let unchecked = 0

  for (const addon of addons) {
    if (!addon.health) {
      unchecked++
    } else if (addon.health.isOnline) {
      online++
    } else {
      offline++
    }
  }

  return { online, offline, unchecked }
}

/**
 * Perform a deep functional check on an addon
 * 1. Fetches manifest
 * 2. Fetches a catalog (if available) or a meta item (Big Buck Bunny) to verify response data
 */
export async function checkAddonFunctionality(addonUrl: string): Promise<{ isHealthy: boolean; message?: string; latency?: number }> {
  const start = Date.now()
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`

  try {
    // 1. Fetch Manifest
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    // Check direct first, then proxy (simplified for this snippet, reusing logic would be better)
    let manifest: any = null
    try {
      const res = await fetch(manifestUrl, { signal: controller.signal })
      if (res.ok) manifest = await res.json()
    } catch {
      // Try proxy
      const proxyUrl = `/api/meta-proxy?url=${encodeURIComponent(manifestUrl)}`
      const res = await fetch(proxyUrl, { signal: controller.signal })
      if (res.ok) manifest = await res.json()
    }
    clearTimeout(id)

    if (!manifest) return { isHealthy: false, message: "Manifest unreachable" }

    // 2. Determine Verification Capability
    // Priority: Catalog (easiest) -> Stream (needs ID) -> Meta (needs ID)
    let verifyUrl = ''

    if (manifest.catalogs && manifest.catalogs.length > 0) {
      const cat = manifest.catalogs[0]
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/catalog/${cat.type}/${cat.id}.json`
    } else if (manifest.resources && (manifest.resources.includes('stream') || manifest.resources.some((r: any) => r.name === 'stream'))) {
      // Try Big Buck Bunny (tt0054215)
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/stream/movie/tt0054215.json`
    }

    if (!verifyUrl) {
      return { isHealthy: true, message: "Manifest OK (No verifiable resources found)", latency: Date.now() - start }
    }

    // 3. Fetch Verification Resource
    const vController = new AbortController()
    const vId = setTimeout(() => vController.abort(), 10000)

    let verifySuccess = false
    try {
      const res = await fetch(verifyUrl, { signal: vController.signal })
      if (res.ok) {
        const data = await res.json()
        if (data.metas || data.streams) verifySuccess = true
      }
    } catch {
      // Direct only
    }
    clearTimeout(vId)

    if (verifySuccess) {
      return { isHealthy: true, message: "Functional (Returned Data)", latency: Date.now() - start }
    } else {
      return { isHealthy: false, message: "Manifest OK but Resource Fetch Failed" }
    }

  } catch (err) {
    return { isHealthy: false, message: err instanceof Error ? err.message : "Unknown Error" }
  }
}
