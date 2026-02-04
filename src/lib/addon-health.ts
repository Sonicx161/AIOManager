
import { SavedAddon } from '@/types/saved-addon'

/**
 * Check if an addon URL is accessible
 * @param addonUrl The addon install URL
 * @returns true if online (200 response), false otherwise
 */
export async function checkAddonHealth(addonUrl: string): Promise<boolean> {
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`

  // 1. Try direct fetch first (fastest, works for CORS-enabled addons)
  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(manifestUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-cache',
      headers: {
        'Accept': 'application/json'
      }
    })

    clearTimeout(id)
    if (response.ok) {
      // Validate content is JSON
      try {
        await response.json()
        return true
      } catch (e) {
        // Not JSON, likely an error page
        return false
      }
    }
  } catch (error) {
    // Continue to proxy
  }

  // 2. Fallback to CORS proxy (slower but reliable)
  try {
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(manifestUrl)}`
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(proxyUrl, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-cache'
    })

    clearTimeout(id)
    if (response.ok) {
      // Validate content is JSON
      try {
        await response.json()
        return true
      } catch (e) {
        // Not JSON, likely an error page
        return false
      }
    }
    return false
  } catch (err) {
    return false
  }
}

/**
 * Update a saved addon with health status
 */
export async function updateAddonHealth(addon: SavedAddon): Promise<SavedAddon> {
  const isOnline = await checkAddonHealth(addon.installUrl)

  return {
    ...addon,
    health: {
      isOnline,
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
  const results: SavedAddon[] = []

  for (let i = 0; i < addons.length; i += CONCURRENT_LIMIT) {
    const batch = addons.slice(i, i + CONCURRENT_LIMIT)
    const checked = await Promise.all(batch.map((addon) => updateAddonHealth(addon)))
    results.push(...checked)

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
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(manifestUrl)}`
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
      // Try proxy
      const proxyVerifyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(verifyUrl)}`
      const res = await fetch(proxyVerifyUrl, { signal: vController.signal })
      if (res.ok) {
        const data = await res.json()
        if (data.metas || data.streams) verifySuccess = true
      }
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
