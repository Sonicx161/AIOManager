import type { AddonManifest } from '@/types/addon'

const BASE_URL = 'https://stremio-addons.net/api/v0'

// The directory sends Cache-Control: public, max-age=86400, so a day of local caching is the
// intended use. The manual refresh clears this plus a short bypass window so its requests
// actually re-fetch instead of answering from the fresh cache they just repopulated.
const CACHE_TTL = 24 * 60 * 60 * 1000
const REFRESH_BYPASS_MS = 5000
const _cache = new Map<string, { data: unknown; expires: number }>()
let _refreshUntil = 0

export function invalidateDiscoverCache(): void {
  _cache.clear()
  _refreshUntil = Date.now() + REFRESH_BYPASS_MS
}

const isCacheFresh = (expires: number) => Date.now() < expires && Date.now() >= _refreshUntil

// A cached answer keeps only the freshness its sender had left (max-age less its Age or
// time since Date), so server data near expiry does not restart a full local day.
function freshUntil(res: Response): number {
  const now = Date.now()
  const maxAge = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')
  if (!maxAge) return now + CACHE_TTL
  const ageHeader = Number(res.headers.get('age'))
  const sentAt = Date.parse(res.headers.get('date') ?? '')
  const ageMs = Math.max(0, Number.isFinite(ageHeader) ? ageHeader * 1000 : 0, Number.isFinite(sentAt) ? now - sentAt : 0)
  return now + Math.min(Number(maxAge[1]) * 1000 - ageMs, CACHE_TTL)
}

function storeCached(key: string, data: unknown, expires: number): void {
  if (expires > Date.now()) _cache.set(key, { data, expires })
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
  nextCursor?: string | null
}

export interface DiscoverAddonsResponse {
  addons: DiscoverAddon[]
  pagination: DiscoverPagination
  nextCursor?: string | null
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
  cursor?: string
  limit?: number
}

// stremio-addons.net fetches go through the server's /api/discover-proxy when a sync session
// exists (shared cache + single-flight upstream). Falls back to the direct fetch so responses,
// statuses and error messages stay the same when the proxy is unavailable.
// The proxy context (endpoint + auth headers) is resolved once per sync session and shared by
// every Discover call, instead of repeating two dynamic imports and a token build per request.
interface ProxyAuthContext { apiPath: string; headers: Record<string, string> }
let _proxyAuth: { id: string | null; promise: Promise<ProxyAuthContext | null> | null } = { id: null, promise: null }

function getProxyAuth(id: string): Promise<ProxyAuthContext | null> {
  if (_proxyAuth.id === id && _proxyAuth.promise) return _proxyAuth.promise
  const promise = (async () => {
    try {
      const { useSyncStore } = await import('@/store/syncStore')
      const { getSyncPasswordHeader } = await import('@/lib/sync-auth')
      const { auth, serverUrl } = useSyncStore.getState()
      if (!auth.isAuthenticated || auth.id !== id) return null
      const syncToken = await getSyncPasswordHeader(auth)
      const baseUrl = serverUrl || ''
      const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
      return { apiPath, headers: { 'x-sync-user': auth.id, 'x-sync-password': syncToken } }
    } catch {
      return null
    }
  })()
  _proxyAuth = { id, promise }
  return promise
}

let _unsubscribed = true
async function fetchDiscover(path: string, signal?: AbortSignal): Promise<Response> {
  const refreshNeeded = Date.now() < _refreshUntil
  let viaProxy: Promise<Response> | null = null
  try {
    const { useSyncStore } = await import('@/store/syncStore')
    if (_unsubscribed) {
      _unsubscribed = false
      // A different account, a sign-out or a password rotation invalidates the cached headers.
      useSyncStore.subscribe((state, prev) => {
        if (state.auth.id !== prev.auth.id || state.auth.isAuthenticated !== prev.auth.isAuthenticated || state.auth.password !== prev.auth.password) {
          _proxyAuth = { id: null, promise: null }
        }
      })
    }
    const { auth } = useSyncStore.getState()
    if (auth.isAuthenticated) {
      const ctx = await getProxyAuth(auth.id)
      if (ctx) {
        viaProxy = fetch(`${ctx.apiPath}/discover-proxy?refresh=${refreshNeeded ? '1' : '0'}&url=${encodeURIComponent(`${BASE_URL}${path}`)}`, {
          headers: ctx.headers,
          signal,
        })
      }
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
  // Continuation goes by cursor (page/after are deprecated upstream). A cursor request re-sends
  // search, nsfw and category and never carries page with it.
  if (query.cursor) {
    params.set('cursor', query.cursor)
  } else if (query.page != null) {
    params.set('page', String(query.page))
  }
  if (query.limit != null) params.set('limit', String(query.limit))
  for (const slug of query.category ?? []) params.append('category', slug)

  const key = `addons:${params.toString()}`
  const cached = _cache.get(key)
  if (cached && isCacheFresh(cached.expires)) return cached.data as DiscoverAddonsResponse

  const res = await fetchDiscover(`/addons?${params.toString()}`, signal)
  if (!res.ok) throw new Error(`Discover request failed (${res.status})`)
  const data = (await res.json()) as DiscoverAddonsResponse
  const result = {
    addons: Array.isArray(data.addons) ? data.addons : [],
    pagination: data.pagination,
    nextCursor: typeof data.pagination?.nextCursor === 'string' && data.pagination.nextCursor ? data.pagination.nextCursor : null,
  }
  if (!signal?.aborted) storeCached(key, result, freshUntil(res))
  return result
}

export async function fetchDiscoverCategories(signal?: AbortSignal): Promise<DiscoverCategory[]> {
  const key = 'categories'
  const cached = _cache.get(key)
  if (cached && isCacheFresh(cached.expires)) return cached.data as DiscoverCategory[]

  const res = await fetchDiscover('/categories', signal)
  if (!res.ok) throw new Error(`Discover categories request failed (${res.status})`)
  const data = (await res.json()) as { categories?: DiscoverCategory[] }
  const result = Array.isArray(data.categories) ? data.categories : []
  if (!signal?.aborted) storeCached(key, result, freshUntil(res))
  return result
}

export async function fetchDiscoverAddon(slugOrUuid: string, signal?: AbortSignal): Promise<DiscoverAddonDetail> {
  const key = `addon:${slugOrUuid}`
  const cached = _cache.get(key)
  if (cached && isCacheFresh(cached.expires)) return cached.data as DiscoverAddonDetail

  const res = await fetchDiscover(`/addons/${encodeURIComponent(slugOrUuid)}`, signal)
  if (!res.ok) throw new Error(`Discover detail request failed (${res.status})`)
  const result = (await res.json()) as DiscoverAddonDetail
  if (!signal?.aborted) storeCached(key, result, freshUntil(res))
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
