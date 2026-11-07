import type { AddonManifest } from '@/types/addon'

const BASE_URL = 'https://stremio-addons.net/api/v0'

const CACHE_TTL = 10 * 60 * 1000
const _cache = new Map<string, { data: unknown; ts: number }>()

export function invalidateDiscoverCache(): void {
  _cache.clear()
}

export type DiscoverSortBy = 'stars' | 'createdAt'
export type DiscoverOrder = 'asc' | 'desc'
export type DiscoverNsfw = 'only' | 'exclude'

export interface DiscoverCategory {
  name: string
  slug: string
}

export interface DiscoverAddon {
  uuid: string
  url: string
  manifestUrl: string
  manifest: AddonManifest
  slug: string
  stars: number
  categories: DiscoverCategory[]
  configureUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface DiscoverPagination {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface DiscoverAddonsResponse {
  addons: DiscoverAddon[]
  pagination: DiscoverPagination
}

export interface DiscoverAddonDetail extends DiscoverAddon {
  documentation: string | null
  instances: DiscoverAddon[]
}

export interface DiscoverQuery {
  search?: string
  category?: string[]
  sortBy?: DiscoverSortBy
  order?: DiscoverOrder
  nsfw?: DiscoverNsfw
  page?: number
  after?: string
  limit?: number
}

// stremio-addons.net fetches go through the server's /api/discover-proxy when a sync session
// exists (shared cache + single-flight upstream). Falls back to the direct fetch so responses,
// statuses and error messages stay the same when the proxy is unavailable.
async function fetchDiscover(path: string, signal?: AbortSignal): Promise<Response> {
  let viaProxy: Promise<Response> | null = null
  try {
    const { useSyncStore } = await import('@/store/syncStore')
    const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
    const { auth, serverUrl } = useSyncStore.getState()
    if (auth.isAuthenticated) {
      const syncToken = await getSyncPasswordHeader(auth)
      const baseUrl = serverUrl || ''
      const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
      viaProxy = fetch(`${apiPath}/discover-proxy?url=${encodeURIComponent(`${BASE_URL}${path}`)}`, {
        headers: { 'x-sync-user': auth.id, 'x-sync-password': syncToken },
        signal,
      })
    }
  } catch { /* fall back to the direct fetch */ }
  if (viaProxy) {
    try {
      const res = await viaProxy
      // An empty 200 (an older server build, possibly still in the HTTP cache) falls through to the direct fetch.
      if (res.ok && res.headers.get('content-length') !== '0') return res
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }
  return fetch(`${BASE_URL}${path}`, { signal })
}

export async function fetchDiscoverAddons(query: DiscoverQuery = {}, signal?: AbortSignal): Promise<DiscoverAddonsResponse> {
  const params = new URLSearchParams()
  if (query.search?.trim()) params.set('search', query.search.trim())
  if (query.sortBy) params.set('sort_by', query.sortBy)
  if (query.order) params.set('order', query.order)
  if (query.nsfw) params.set('nsfw', query.nsfw)
  if (query.page != null) params.set('page', String(query.page))
  if (query.after) params.set('after', query.after)
  if (query.limit != null) params.set('limit', String(query.limit))
  for (const slug of query.category ?? []) params.append('category', slug)

  const key = `addons:${params.toString()}`
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data as DiscoverAddonsResponse

  const res = await fetchDiscover(`/addons?${params.toString()}`, signal)
  if (!res.ok) throw new Error(`Discover request failed (${res.status})`)
  const data = (await res.json()) as DiscoverAddonsResponse
  const result = {
    addons: Array.isArray(data.addons) ? data.addons : [],
    pagination: data.pagination,
  }
  if (!signal?.aborted) _cache.set(key, { data: result, ts: Date.now() })
  return result
}

export async function fetchDiscoverCategories(signal?: AbortSignal): Promise<DiscoverCategory[]> {
  const key = 'categories'
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data as DiscoverCategory[]

  const res = await fetchDiscover('/categories', signal)
  if (!res.ok) throw new Error(`Discover categories request failed (${res.status})`)
  const data = (await res.json()) as { categories?: DiscoverCategory[] }
  const result = Array.isArray(data.categories) ? data.categories : []
  if (!signal?.aborted) _cache.set(key, { data: result, ts: Date.now() })
  return result
}

export async function fetchDiscoverAddon(slugOrUuid: string, signal?: AbortSignal): Promise<DiscoverAddonDetail> {
  const key = `addon:${slugOrUuid}`
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data as DiscoverAddonDetail

  const res = await fetchDiscover(`/addons/${encodeURIComponent(slugOrUuid)}`, signal)
  if (!res.ok) throw new Error(`Discover detail request failed (${res.status})`)
  const result = (await res.json()) as DiscoverAddonDetail
  if (!signal?.aborted) _cache.set(key, { data: result, ts: Date.now() })
  return result
}

export const RESOURCE_LABELS: Record<string, string> = {
  stream: 'Streams',
  catalog: 'Catalog',
  meta: 'Metadata',
  subtitles: 'Subtitles',
  addon_catalog: 'Addons',
}

// manifest.resources may be a list of strings ("stream") or objects ({ name: "stream" }).
export function getAddonResources(addon: DiscoverAddon): string[] {
  const resources = addon.manifest?.resources
  if (!Array.isArray(resources)) return []
  return resources
    .map((r) => (typeof r === 'string' ? r : (r as { name?: string })?.name))
    .filter((name): name is string => typeof name === 'string')
}

export function requiresConfiguration(addon: DiscoverAddon): boolean {
  return addon.manifest?.behaviorHints?.configurationRequired === true
}

export function lastUpdatedLabel(addon: { updatedAt?: string }): string | null {
  if (!addon.updatedAt) return null
  const ts = new Date(addon.updatedAt).getTime()
  if (!Number.isFinite(ts)) return null
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return 'Updated today'
  if (days === 1) return 'Updated 1d ago'
  if (days < 30) return `Updated ${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Updated ${months}mo ago`
  return `Updated ${Math.floor(months / 12)}y ago`
}

export function getConfigureUrl(addon: DiscoverAddon): string | null {
  if (addon.configureUrl) return addon.configureUrl
  if (addon.manifest?.behaviorHints?.configurable !== true) return null
  try {
    const base = new URL(addon.manifestUrl)
    base.pathname = base.pathname.replace(/\/manifest\.json$/i, '') + '/configure'
    return base.toString()
  } catch {
    return null
  }
}
