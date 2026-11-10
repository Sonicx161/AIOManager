
import { SavedAddon } from '@/types/saved-addon'
import { useSyncStore } from '@/store/syncStore'
import { getSyncPasswordHeader } from '@/lib/sync-auth'
import { normalizeAddonUrl } from '@/lib/utils'
import { trace } from '@/lib/trace'

export interface HealthStatus {
  isOnline: boolean
  error?: string
  latencyMs?: number
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
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[addon-health] Invalid URL:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// Identical concurrent health checks share one request (the same URL cannot answer
// two different ways at once). Settled results are never cached, so freshness is unchanged.
const inflightHealthChecks = new Map<string, Promise<HealthStatus>>()

export function checkAddonHealth(addonUrl: string): Promise<HealthStatus> {
  const inflight = inflightHealthChecks.get(addonUrl)
  if (inflight) return inflight
  const promise = checkAddonHealthOnce(addonUrl).finally(() => {
    if (inflightHealthChecks.get(addonUrl) === promise) inflightHealthChecks.delete(addonUrl)
  })
  inflightHealthChecks.set(addonUrl, promise)
  return promise
}

async function checkAddonHealthOnce(addonUrl: string): Promise<HealthStatus> {
  const startTime = Date.now()
  trace('health', 'check-start', { url: addonUrl })

  if (isLocalOrPrivateUrl(addonUrl)) {
    trace('health', 'check-result', { url: addonUrl, isOnline: false, latencyMs: Date.now() - startTime })
    return { isOnline: false, error: 'Local addon unreachable from server', latencyMs: Date.now() - startTime }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const { auth } = useSyncStore.getState()
    const headers: Record<string, string> = {}
    if (auth.isAuthenticated && auth.id) {
      headers['x-sync-user'] = auth.id
      headers['x-sync-password'] = await getSyncPasswordHeader(auth)
    }

    const response = await fetch(`/api/addon-health?url=${encodeURIComponent(addonUrl)}`, {
      signal: controller.signal,
      headers,
    })

    if (!response.ok) {
      throw new Error(`Health endpoint returned ${response.status}`)
    }

    const data = await response.json()
    trace('health', 'check-result', { url: addonUrl, isOnline: Boolean(data?.isOnline), latencyMs: Date.now() - startTime })
    return {
      isOnline: Boolean(data?.isOnline),
      error: data?.error,
      latencyMs: Date.now() - startTime,
    }
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[addon-health] Connection failed:', err instanceof Error ? err.message : String(err))
    trace('health', 'check-result', { url: addonUrl, isOnline: false, latencyMs: Date.now() - startTime })
    return { isOnline: false, error: 'Connection Failed', latencyMs: Date.now() - startTime }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function checkAllAddonsHealth(
  addons: SavedAddon[],
  onProgress?: (completed: number, total: number) => void
): Promise<SavedAddon[]> {
  const CONCURRENT_LIMIT = 5
  const BUDGET_MS = 30000
  const budgetStart = Date.now()
  const budgetExceeded = () => Date.now() - budgetStart > BUDGET_MS
  const results: SavedAddon[] = [...addons]
  const originHealthCache = new Map<string, boolean>()
  const inflightByUrl = new Map<string, Promise<HealthStatus>>()
  const settledByUrl = new Map<string, HealthStatus>()

  const checkOnce = (addon: SavedAddon): Promise<HealthStatus> => {
    const urlKey = normalizeAddonUrl(addon.installUrl)

    const settled = settledByUrl.get(urlKey)
    if (settled) return Promise.resolve(settled)

    const inflight = inflightByUrl.get(urlKey)
    if (inflight) return inflight

    let origin = ''
    try {
      origin = new URL(addon.installUrl).origin
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('[addon-health] Invalid URL for origin:', err instanceof Error ? err.message : String(err))
      origin = addon.installUrl
    }

    if (originHealthCache.get(origin) === true) {
      const fast: HealthStatus = { isOnline: true }
      settledByUrl.set(urlKey, fast)
      return Promise.resolve(fast)
    }

    const promise = checkAddonHealth(addon.installUrl)
      .then(status => {
        if (status.isOnline) originHealthCache.set(origin, true)
        settledByUrl.set(urlKey, status)
        inflightByUrl.delete(urlKey)
        return status
      })
      .catch((): HealthStatus => {
        const failed: HealthStatus = { isOnline: false, error: 'Connection Failed' }
        settledByUrl.set(urlKey, failed)
        inflightByUrl.delete(urlKey)
        return failed
      })

    inflightByUrl.set(urlKey, promise)
    return promise
  }

  let nextIndex = 0
  let completed = 0

  // Bounded pool: a worker takes the next addon as soon as it frees, so one slow check
  // never parks the other slots for the addons queued behind it. Checks past the budget
  // never start; in-flight ones still finish and write their result.
  const worker = async (): Promise<void> => {
    while (nextIndex < addons.length && !budgetExceeded()) {
      const globalIndex = nextIndex++
      const addon = addons[globalIndex]
      const status = await checkOnce(addon)

      results[globalIndex] = {
        ...addon,
        health: {
          isOnline: status.isOnline,
          error: status.error,
          lastChecked: Date.now(),
          latencyMs: status.latencyMs,
        },
      }

      completed++
      if (onProgress) onProgress(completed, addons.length)
    }
  }

  const workerCount = Math.min(CONCURRENT_LIMIT, addons.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}

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

export async function checkAddonFunctionality(addonUrl: string): Promise<{ isHealthy: boolean; message?: string; latency?: number }> {
  const start = Date.now()
  const manifestUrl = addonUrl.endsWith('/manifest.json') ? addonUrl : `${addonUrl}/manifest.json`

  try {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 10000)

    let manifest: { catalogs?: Array<{ type: string; id: string }>; resources?: Array<string | { name?: string }> } | null = null
    try {
      const res = await fetch(manifestUrl, { signal: controller.signal })
      if (res.ok) manifest = await res.json()
    } catch {
      try {
        const { useSyncStore } = await import('@/store/syncStore')
        const { auth } = useSyncStore.getState()
        const headers: Record<string, string> = {}
        if (auth.isAuthenticated && auth.id) {
          headers['x-sync-user'] = auth.id
          headers['x-sync-password'] = await getSyncPasswordHeader(auth)
        }
        const proxyUrl = `/api/meta-proxy?url=${encodeURIComponent(manifestUrl)}`
        const res = await fetch(proxyUrl, { signal: controller.signal, headers })
        if (res.ok) manifest = await res.json()
      } catch (err) {
        if (import.meta.env?.DEV) console.warn('[addon-health] Both direct and proxy manifest fetch failed:', err instanceof Error ? err.message : String(err))
      }
    }
    clearTimeout(id)

    if (!manifest) return { isHealthy: false, message: "Manifest unreachable" }

    let verifyUrl = ''

    if (manifest.catalogs && manifest.catalogs.length > 0) {
      const cat = manifest.catalogs[0]
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/catalog/${cat.type}/${cat.id}.json`
    } else if (manifest.resources && (manifest.resources.includes('stream') || manifest.resources.some(r => typeof r === 'object' && r?.name === 'stream'))) {
      // Try Big Buck Bunny (tt0054215)
      verifyUrl = `${addonUrl.replace('/manifest.json', '')}/stream/movie/tt0054215.json`
    }

    if (!verifyUrl) {
      return { isHealthy: true, message: "Manifest OK (No verifiable resources found)", latency: Date.now() - start }
    }

    const vController = new AbortController()
    const vId = setTimeout(() => vController.abort(), 10000)

    let verifySuccess = false
    try {
      const res = await fetch(verifyUrl, { signal: vController.signal })
      if (res.ok) {
        const data = await res.json()
        if (data.metas || data.streams) verifySuccess = true
      }
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('[addon-health] Resource verification failed:', err instanceof Error ? err.message : String(err))
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
