import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle, ArrowLeft, Clock, Flame, Heart, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { TabsTrigger } from '@/components/ui/tabs'
import { WorkspaceTabs } from '@/components/ui/workspace-tabs'
import { useToast } from '@/hooks/use-toast'
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore } from '@/store/accountStore'
import { useProfileStore } from '@/store/profileStore'
import { cn, normalizeAddonUrl } from '@/lib/utils'
import { mapConcurrent } from '@/lib/concurrency'
import { trace } from '@/lib/trace'
import {
  fetchDiscoverAddons,
  fetchDiscoverCategories,
  getAddonResources,
  getConfigureUrl,
  invalidateDiscoverCache,
  type DiscoverAddon,
  type DiscoverCategory,
  type DiscoverSortBy,
} from '@/api/discover'
import { StaggerContainer, StaggerItem } from '@/components/ui/stagger'
import { DiscoverToolbar } from './DiscoverToolbar'
import { DiscoverCard } from './DiscoverCard'
import { DiscoverHero } from './DiscoverHero'
import { DiscoverRow } from './DiscoverRow'
import { DiscoverDeck } from './DiscoverDeck'
import { DiscoverDetailModal } from './DiscoverDetailModal'
import { DiscoverSaveDialog, type DiscoverSavePayload } from './DiscoverSaveDialog'
import { DiscoverInjectDialog, type DiscoverInjectSelection } from './DiscoverInjectDialog'
import { AccountPickerDialog } from '@/components/accounts/AccountPickerDialog'
import { useAIOStreamsInstances } from '@/hooks/useAIOStreamsInstances'
import { performInjection } from '@/lib/aiostreams-inject'

const PAGE_SIZE = 36
const SHELF_SIZE = 18
// Trending feeds both the hero (up to 10) and the row, so pull a deeper pool.
const TRENDING_SIZE = 30

// Favorites are bookmarked addons the user wants to revisit without installing. The full
// DiscoverAddon is persisted (not just the id) so the shelf renders offline without refetching.
const FAVORITES_KEY = 'aio-discover-favorites'
const PREFS_KEY = 'aio-discover-prefs'
const LAST_VISIT_KEY = 'aio-discover-last-visit'

type DiscoverViewMode = 'store' | 'deck'

interface DiscoverPrefs {
  sortBy?: DiscoverSortBy
  showAdult?: boolean
  selectedCategories?: string[]
  compact?: boolean
  viewMode?: DiscoverViewMode
}

function shuffle<T>(input: T[]): T[] {
  const arr = [...input]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function loadFavorites(): DiscoverAddon[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveFavorites(list: DiscoverAddon[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
  } catch {
    // Best-effort: a full localStorage quota shouldn't break the page.
  }
}

function loadPrefs(): DiscoverPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePrefs(prefs: DiscoverPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort; ignore quota errors
  }
}

export function DiscoverPanel({ replayKey = 0 }: { replayKey?: number }) {
  const { toast } = useToast()
  const library = useAddonStore((state) => state.library)
  const createSavedAddon = useAddonStore((state) => state.createSavedAddon)
  const createProfile = useProfileStore((state) => state.createProfile)
  const accounts = useAccountStore((state) => state.accounts)

  const { instances: aioStreamsInstances } = useAIOStreamsInstances()

  const initialPrefs = useMemo(() => loadPrefs(), [])

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sortBy, setSortBy] = useState<DiscoverSortBy>(initialPrefs.sortBy === 'createdAt' ? 'createdAt' : 'stars')
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    Array.isArray(initialPrefs.selectedCategories) ? initialPrefs.selectedCategories : []
  )
  const [selectedResources, setSelectedResources] = useState<string[]>([])
  const [selectedTypes, setSelectedTypes] = useState<string[]>([])
  const [showAdult, setShowAdult] = useState<boolean>(!!initialPrefs.showAdult)
  const [forceGrid, setForceGrid] = useState(false)
  const [compact, setCompact] = useState<boolean>(!!initialPrefs.compact)
  const [favorites, setFavorites] = useState<DiscoverAddon[]>(() => loadFavorites())

  const [viewMode, setViewMode] = useState<DiscoverViewMode>('store')
  const [deckPool, setDeckPool] = useState<DiscoverAddon[]>([])
  const [deckLoading, setDeckLoading] = useState(false)
  const [deckKey, setDeckKey] = useState(0)

  const initialLastVisit = useMemo(() => {
    const raw = Number(localStorage.getItem(LAST_VISIT_KEY))
    return Number.isFinite(raw) && raw > 0 ? raw : null
  }, [])

  const [trending, setTrending] = useState<DiscoverAddon[]>([])
  const [newest, setNewest] = useState<DiscoverAddon[]>([])
  const [storeLoading, setStoreLoading] = useState(true)
  const [storeRefreshing, setStoreRefreshing] = useState(false)
  const [storeError, setStoreError] = useState(false)
  const [storeRefreshFailed, setStoreRefreshFailed] = useState(false)
  const [storeUpdatedAt, setStoreUpdatedAt] = useState<number | null>(null)
  const [storeReloadKey, setStoreReloadKey] = useState(0)
  const [allCategories, setCategories] = useState<DiscoverCategory[]>([])
  const categories = useMemo(
    () => (showAdult ? allCategories : allCategories.filter((c) => !/^nsfw$/i.test(c.slug) && !/^nsfw$/i.test(c.name))),
    [allCategories, showAdult],
  )
  const [categoryShelves, setCategoryShelves] = useState<{ category: DiscoverCategory; addons: DiscoverAddon[] }[]>([])

  const [addons, setAddons] = useState<DiscoverAddon[]>([])
  const [page, setPage] = useState(1)
  const cursorRef = useRef<string | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [detailAddon, setDetailAddon] = useState<DiscoverAddon | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailSession, setDetailSession] = useState(0)
  const [reopenDetailAfterChild, setReopenDetailAfterChild] = useState(false)
  const [saveAddon, setSaveAddon] = useState<DiscoverAddon | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [deployAddon, setDeployAddon] = useState<DiscoverAddon | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [injectAddon, setInjectAddon] = useState<DiscoverAddon | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)

  const requestRef = useRef(0)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const storeHasContentRef = useRef(false)

  const isFiltering = debouncedSearch.trim() !== '' || selectedCategories.length > 0 || selectedResources.length > 0 || selectedTypes.length > 0
  const gridMode = isFiltering || forceGrid

  const isFavorite = useCallback((addon: DiscoverAddon) => favorites.some((f) => f.uuid === addon.uuid), [favorites])
  const toggleFavorite = useCallback((addon: DiscoverAddon) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.uuid === addon.uuid)
      const next = exists ? prev.filter((f) => f.uuid !== addon.uuid) : [addon, ...prev]
      saveFavorites(next)
      return next
    })
  }, [])

  const handleSearchChange = (val: string) => {
    setSearch(val)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => setDebouncedSearch(val), 300)
  }

  const categoryKey = selectedCategories.join(',')

  useEffect(() => {
    savePrefs({ sortBy, showAdult, selectedCategories, compact, viewMode })
  }, [sortBy, showAdult, selectedCategories, compact, viewMode])

  useEffect(() => {
    return () => { try { localStorage.setItem(LAST_VISIT_KEY, String(Date.now())) } catch {} }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    fetchDiscoverCategories(ac.signal).then(setCategories).catch(() => {})
    return () => ac.abort()
  }, [storeReloadKey])

  useEffect(() => {
    if (categories.length === 0) return
    const ac = new AbortController()
    const nsfw = showAdult ? undefined : 'exclude'
    const picks = categories.slice(0, 6)
    Promise.all(
      picks.map((category) =>
        fetchDiscoverAddons({ category: [category.slug], sortBy: 'stars', order: 'desc', nsfw, limit: SHELF_SIZE }, ac.signal)
          .then((res) => ({ category, addons: res.addons }))
          .catch(() => {
            if (ac.signal.aborted) throw new Error('aborted')
            return { category, addons: [] as DiscoverAddon[] }
          })
      )
    ).then((shelves) => {
      if (!ac.signal.aborted) setCategoryShelves(shelves.filter((s) => s.addons.length >= 4))
    }).catch(() => {})
    return () => ac.abort()
  }, [categories, showAdult])

  useEffect(() => {
    const ac = new AbortController()
    const hasContent = storeHasContentRef.current
    if (hasContent) setStoreRefreshing(true)
    else setStoreLoading(true)
    setStoreError(false)
    setStoreRefreshFailed(false)
    const nsfw = showAdult ? undefined : 'exclude'
    Promise.all([
      fetchDiscoverAddons({ sortBy: 'stars', order: 'desc', nsfw, limit: TRENDING_SIZE }, ac.signal).catch(() => null),
      fetchDiscoverAddons({ sortBy: 'createdAt', order: 'desc', nsfw, limit: SHELF_SIZE }, ac.signal).catch(() => null),
    ])
      .then(([top, fresh]) => {
        if (ac.signal.aborted) return
        if (top) setTrending(top.addons)
        if (fresh) setNewest(fresh.addons)
        if (top || fresh) {
          storeHasContentRef.current = true
          setStoreUpdatedAt(Date.now())
        } else if (hasContent) {
          setStoreRefreshFailed(true)
        } else {
          setStoreError(true)
        }
      })
      .catch(() => {
        if (ac.signal.aborted) return
        if (hasContent) setStoreRefreshFailed(true)
        else setStoreError(true)
      })
      .finally(() => {
        if (ac.signal.aborted) return
        setStoreLoading(false)
        setStoreRefreshing(false)
      })
    return () => ac.abort()
  }, [showAdult, storeReloadKey])

  const runQuery = useCallback(
    async (targetPage: number, signal?: AbortSignal) => {
      const token = ++requestRef.current
      if (targetPage === 1) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      if (targetPage === 1) cursorRef.current = null
      try {
        const res = await fetchDiscoverAddons({
          search: debouncedSearch,
          sortBy,
          order: 'desc',
          category: selectedCategories,
          nsfw: showAdult ? undefined : 'exclude',
          page: targetPage,
          cursor: targetPage > 1 ? (cursorRef.current ?? undefined) : undefined,
          limit: PAGE_SIZE,
        }, signal)
        if (token !== requestRef.current) return
        cursorRef.current = res.nextCursor ?? null
        setAddons((prev) => (targetPage === 1 ? res.addons : [...prev, ...res.addons]))
        setHasNextPage(res.pagination?.hasNextPage ?? Boolean(res.nextCursor))
        setPage(targetPage)
      } catch (err) {
        if (token !== requestRef.current) return
        setError(err instanceof Error ? err.message : 'Failed to load addons')
        if (targetPage === 1) setAddons([])
      } finally {
        if (token === requestRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [debouncedSearch, sortBy, selectedCategories, showAdult]
  )

  useEffect(() => {
    if (!gridMode) return
    const ac = new AbortController()
    runQuery(1, ac.signal)
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridMode, debouncedSearch, sortBy, categoryKey, showAdult, storeReloadKey])

  // Infinite scroll: auto-load the next page when the sentinel nears the viewport. The visible
  // "Load more" button remains as a manual fallback.
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasNextPage || loading || loadingMore) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) runQuery(page + 1) },
      { rootMargin: '400px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [gridMode, hasNextPage, loading, loadingMore, page, runQuery])

  const savedIndex = useMemo(() => {
    const ids = new Set<string>()
    const urls = new Set<string>()
    for (const addon of Object.values(library)) {
      if (addon.manifest?.id) ids.add(addon.manifest.id)
      if (addon.installUrl) urls.add(normalizeAddonUrl(addon.installUrl))
    }
    return { ids, urls }
  }, [library])

  const isSaved = useCallback(
    (addon: DiscoverAddon) => {
      if (addon.manifest?.id && savedIndex.ids.has(addon.manifest.id)) return true
      return savedIndex.urls.has(normalizeAddonUrl(addon.manifestUrl))
    },
    [savedIndex]
  )

  const deploymentIndex = useMemo(
    () =>
      accounts.map((acc) => {
        const ids = new Set<string>()
        const urls = new Set<string>()
        for (const a of acc.addons || []) {
          if (a?.flags?.enabled === false) continue
          if (a.manifest?.id) ids.add(a.manifest.id)
          if (a.transportUrl) urls.add(normalizeAddonUrl(a.transportUrl))
        }
        return { ids, urls }
      }),
    [accounts]
  )

  const deployedCount = useCallback(
    (addon: DiscoverAddon) => {
      const id = addon.manifest?.id
      const url = normalizeAddonUrl(addon.manifestUrl)
      let n = 0
      for (const acc of deploymentIndex) {
        if ((id && acc.ids.has(id)) || acc.urls.has(url)) n++
      }
      return n
    },
    [deploymentIndex]
  )
  const accountTotal = accounts.length

  const isSavedRef = useRef(isSaved)
  isSavedRef.current = isSaved
  const isFavoriteRef = useRef(isFavorite)
  isFavoriteRef.current = isFavorite

  useEffect(() => {
    if (viewMode !== 'deck') return
    if (categories.length === 0) return
    trace('discover', 'deck-effect', { viewMode, catCount: categories.length, deckKey })
    const ac = new AbortController()
    setDeckLoading(true)
    const nsfw = showAdult ? undefined : 'exclude'
    const catPicks = shuffle(categories).slice(0, 3)
    Promise.all([
      fetchDiscoverAddons({ sortBy: 'stars', order: 'desc', nsfw, page: 2, limit: 40 }, ac.signal).catch((err) => { console.error('[deck fetch]', err?.message || err); return null }),
      fetchDiscoverAddons({ sortBy: 'createdAt', order: 'desc', nsfw, limit: 30 }, ac.signal).catch((err) => { console.error('[deck fetch]', err?.message || err); return null }),
      ...catPicks.map((c) =>
        fetchDiscoverAddons({ category: [c.slug], sortBy: 'stars', order: 'desc', nsfw, page: 2, limit: 20 }, ac.signal).catch((err) => { console.error('[deck fetch]', err?.message || err); return null })
      ),
    ])
      .then((results) => {
        if (ac.signal.aborted) return
        const seen = new Set<string>()
        const merged: DiscoverAddon[] = []
        for (const res of results) {
          if (!res) continue
          for (const addon of res.addons ?? []) {
            if (seen.has(addon.uuid)) continue
            if (isSavedRef.current(addon) || isFavoriteRef.current(addon)) continue
            seen.add(addon.uuid)
            merged.push(addon)
          }
        }
        setDeckPool(shuffle(merged))
        trace('discover', 'deck-result', { total: results.length, nulls: results.filter(r => !r).length, merged: merged.length })
      })
      .catch(() => { if (!ac.signal.aborted) setDeckPool([]) })
      .finally(() => { if (!ac.signal.aborted) setDeckLoading(false) })
    return () => ac.abort()
  }, [viewMode, deckKey, categories, showAdult])

  const newSinceVisit = useMemo(() => {
    if (!initialLastVisit) return []
    return newest.filter((a) => {
      const t = new Date(a.createdAt).getTime()
      return Number.isFinite(t) && t > initialLastVisit
    })
  }, [newest, initialLastVisit])

  const featuredList = useMemo(() => {
    const isTorrentio = (a: DiscoverAddon) => a.slug === 'torrentio' || a.manifest?.id === 'com.stremio.torrentio.addon'
    const eligible = trending.filter((a) => !isTorrentio(a))
    const withBg = eligible.filter((a) => a.manifest?.background)
    const pool = withBg.length >= 3 ? withBg : eligible
    if (pool.length <= 10) return pool
    const dayOffset = Math.floor(Date.now() / 86400000) % pool.length
    const rotated = [...pool.slice(dayOffset), ...pool.slice(0, dayOffset)]
    return rotated.slice(0, 10)
  }, [trending])
  const featuredIds = useMemo(() => new Set(featuredList.map((a) => a.uuid)), [featuredList])
  const trendingRow = useMemo(
    () => trending.filter((a) => !featuredIds.has(a.uuid)),
    [trending, featuredIds]
  )
  const trendingThisWeek = useMemo(() => trendingRow.slice(0, 12), [trendingRow])
  const recentlyUpdated = useMemo(
    () =>
      [...trending]
        .filter((a) => a.updatedAt && Number.isFinite(new Date(a.updatedAt).getTime()))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, SHELF_SIZE),
    [trending]
  )

  const visibleAddons = useMemo(() => {
    if (selectedResources.length === 0 && selectedTypes.length === 0) return addons
    return addons.filter((a) => {
      const res = getAddonResources(a)
      const types = Array.isArray(a.manifest?.types) ? a.manifest.types : []
      const resOk = selectedResources.length === 0 || selectedResources.some((r) => res.includes(r))
      const typeOk = selectedTypes.length === 0 || selectedTypes.some((t) => types.includes(t as string))
      return resOk && typeOk
    })
  }, [addons, selectedResources, selectedTypes])

  // Child dialogs never stack on the detail: close it first and reopen it when the child
  // closes. The session key stays the same, so the detail keeps its place in the nav stack.
  const closeDetailForChild = useCallback(() => {
    if (detailOpen) {
      setDetailOpen(false)
      setReopenDetailAfterChild(true)
    }
  }, [detailOpen])

  const maybeReopenDetail = useCallback(() => {
    if (reopenDetailAfterChild) {
      setReopenDetailAfterChild(false)
      setDetailOpen(true)
    }
  }, [reopenDetailAfterChild])

  const openSave = (addon: DiscoverAddon) => { closeDetailForChild(); setSaveAddon(addon); setSaveOpen(true) }
  const openDeploy = (addon: DiscoverAddon) => { closeDetailForChild(); setDeployAddon(addon); setDeployOpen(true) }
  const openInject = useCallback((addon: DiscoverAddon) => { closeDetailForChild(); setInjectAddon(addon); setInjectOpen(true) }, [closeDetailForChild])
  const openDetail = (addon: DiscoverAddon) => { setDetailAddon(addon); setDetailSession((s) => s + 1); setDetailOpen(true) }

  const handleConfigure = (addon: DiscoverAddon) => {
    const url = getConfigureUrl(addon)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    else toast({ title: 'No configuration page', description: 'This addon does not expose a configure URL.', variant: 'destructive' })
  }

  const handleSaveConfirm = async (payload: DiscoverSavePayload) => {
    if (!saveAddon) return
    setSavingKey(saveAddon.uuid)
    try {
      let profileId = payload.profileId
      if (payload.newProfileName) {
        const profile = await createProfile(payload.newProfileName)
        profileId = profile.id
      }
      await createSavedAddon(payload.name, saveAddon.manifestUrl, payload.tags, profileId, saveAddon.manifest)
      toast({ title: 'Saved to Library', description: `${payload.name} is now in your library.` })
      setSaveOpen(false)
      maybeReopenDetail()
    } catch (err) {
      toast({ title: 'Save Failed', description: err instanceof Error ? err.message : 'Could not save this addon', variant: 'destructive' })
    } finally {
      setSavingKey(null)
    }
  }

  const handleDeployConfirm = async (accountIds: string[]) => {
    if (!deployAddon || accountIds.length === 0) return
    const accountStore = useAccountStore.getState()
    let ok = 0
    let fail = 0
    await mapConcurrent(accountIds, 5, async (id) => {
      try {
        await accountStore.installAddonToAccount(id, deployAddon.manifestUrl)
        ok++
      } catch {
        fail++
      }
    })
    toast({
      title: 'Deploy Complete',
      description: `Installed to ${ok} account${ok !== 1 ? 's' : ''}.${fail > 0 ? ` Failed: ${fail}.` : ''}`,
      variant: fail > 0 && ok === 0 ? 'destructive' : 'default',
    })
    setDeployOpen(false)
    maybeReopenDetail()
  }

  const handleInjectConfirm = async (selected: DiscoverInjectSelection[]) => {
    if (!injectAddon || selected.length === 0) return
    const name = injectAddon.manifest?.name?.trim() || injectAddon.slug || 'Addon'
    const manifestUrl = injectAddon.manifestUrl
    let succeeded = 0
    let failed = 0
    let alreadyExists = 0
    let reinstallFailed = 0
    for (const { baseUrl, uuid, password, accounts, transportUrl } of selected) {
      const result = await performInjection(baseUrl, uuid, password, name, manifestUrl)
      if (result.success && !result.alreadyExists) {
        succeeded++
        for (const { accountId } of accounts) {
          try {
            await useAccountStore.getState().reinstallAddon(accountId, transportUrl)
          } catch (e) {
            reinstallFailed++
            if (import.meta.env.DEV) console.warn('[AIOStreams Inject] Reinstall failed:', e)
          }
        }
      } else if (result.alreadyExists) {
        alreadyExists++
      } else {
        failed++
      }
    }
    if (failed > 0) {
      throw new Error(`${failed} of ${selected.length} instance${selected.length !== 1 ? 's' : ''} failed. ${succeeded} succeeded, ${alreadyExists} already had this addon.`)
    }
    if (reinstallFailed > 0) {
      throw new Error(`Injected into ${succeeded} instance${succeeded !== 1 ? 's' : ''}, but ${reinstallFailed} reinstall${reinstallFailed !== 1 ? 's' : ''} failed. The addon may not appear until you manually refresh.`)
    }
    setInjectOpen(false)
    maybeReopenDetail()
  }

  const toggleCategory = (slug: string) => {
    setSelectedCategories((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))
  }
  const toggleResource = (resource: string) => {
    setSelectedResources((prev) => (prev.includes(resource) ? prev.filter((r) => r !== resource) : [...prev, resource]))
  }
  const toggleType = (type: string) => {
    setSelectedTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]))
  }
  const clearFilters = () => { setSearch(''); setDebouncedSearch(''); setSelectedCategories([]); setSelectedResources([]); setSelectedTypes([]) }

  const refreshDirectory = () => {
    if (storeLoading || storeRefreshing) return
    setStoreRefreshFailed(false)
    if (storeHasContentRef.current) setStoreRefreshing(true)
    else setStoreLoading(true)
    invalidateDiscoverCache()
    setStoreReloadKey((key) => key + 1)
  }

  const seeAll = (sort: DiscoverSortBy) => { setSortBy(sort); setForceGrid(true) }
  const seeAllCategory = (slug: string) => { setSelectedCategories([slug]); setSortBy('stars') }
  const backToStore = () => { setForceGrid(false); setSortBy('stars'); setSelectedResources([]); setSelectedTypes([]) }

  const cardCallbacks = {
    onSave: openSave,
    onDeploy: openDeploy,
    onConfigure: handleConfigure,
    onOpenDetail: openDetail,
    onToggleFavorite: toggleFavorite,
    deployedCount,
    accountTotal,
    onInjectAIOStreams: aioStreamsInstances.length > 0 ? openInject : undefined,
    hasAIOStreams: aioStreamsInstances.length > 0,
  }

  return (
    <WorkspaceTabs value={viewMode} panelValue={viewMode} onValueChange={(v) => setViewMode(v as DiscoverViewMode)} label="Discover views" contentClassName="space-y-5" tabs={<>
          <TabsTrigger value="store">Browse</TabsTrigger>
          <TabsTrigger value="deck">Deck</TabsTrigger>
    </>}>

      {viewMode === 'deck' && (
          <DiscoverDeck
            pool={deckPool}
            loading={deckLoading}
            onReshuffle={() => setDeckKey((k) => k + 1)}
            isSaved={isSaved}
            savingKey={savingKey}
            onSave={openSave}
            onOpenDetail={openDetail}
            onDeploy={openDeploy}
            deployedCount={deployedCount}
            accountTotal={accountTotal}
          />
      )}

      {viewMode === 'store' && (
        <DiscoverToolbar
          search={search}
          onSearchChange={handleSearchChange}
          sortBy={sortBy}
          onSortByChange={(s) => { setSortBy(s); setForceGrid(true) }}
          categories={categories}
          selectedCategories={selectedCategories}
          onToggleCategory={toggleCategory}
          selectedResources={selectedResources}
          onToggleResource={toggleResource}
          selectedTypes={selectedTypes}
          onToggleType={toggleType}
          showAdult={showAdult}
          onToggleAdult={() => setShowAdult((v) => !v)}
          showSort={gridMode}
          compact={compact}
          onToggleCompact={() => setCompact((v) => !v)}
          refreshing={storeLoading || storeRefreshing}
          refreshStatus={storeUpdatedAt ? `Checked ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(storeUpdatedAt)}` : null}
          refreshFailed={storeRefreshFailed}
          onRefresh={refreshDirectory}
        />
      )}

      {/* Keyed so the entrance animation replays each time Discover is opened, without refetching. */}
      {viewMode === 'store' && (
      <div key={replayKey} className="flex flex-col gap-5">

      {!gridMode && (
        <>
          {storeLoading && (
            <>
              <Skeleton className="h-56 w-full rounded-xl" />
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-52 w-[260px] sm:w-[300px] shrink-0 rounded-xl" />)}
              </div>
            </>
          )}

          {!storeLoading && storeError && (
            <Card className="border-destructive">
              <CardContent className="flex flex-col items-start gap-3 pt-6">
                <p className="text-destructive">Could not reach the addon directory. Check your connection and try again.</p>
                <Button variant="outline" size="sm" onClick={refreshDirectory}>Retry</Button>
              </CardContent>
            </Card>
          )}

          {!storeLoading && !storeError && featuredList.length > 0 && (
            <DiscoverHero
              addons={featuredList}
              isSaved={isSaved}
              savingKey={savingKey}
              onSave={openSave}
              onConfigure={handleConfigure}
              onOpenDetail={openDetail}
              onDeploy={openDeploy}
              deployedCount={deployedCount}
              accountTotal={accountTotal}
              hasAIOStreams={aioStreamsInstances.length > 0}
              onInjectAIOStreams={aioStreamsInstances.length > 0 ? openInject : undefined}
            />
          )}

          {newSinceVisit.length > 0 && (
            <DiscoverRow
              title="New Since Your Last Visit"
              icon={<Clock className="h-4 w-4 text-primary" />}
              addons={newSinceVisit}
              isSaved={isSaved}
              savingKey={savingKey}
              onSeeAll={() => seeAll('createdAt')}
              isFavorite={isFavorite}
              {...cardCallbacks}
            />
          )}
          {favorites.length > 0 && (
            <DiscoverRow
              title="Favorites"
              icon={<Heart className="h-4 w-4 fill-primary text-primary" />}
              addons={favorites}
              isSaved={isSaved}
              savingKey={savingKey}
              isFavorite={isFavorite}
              {...cardCallbacks}
            />
          )}

          {!storeLoading && !storeError && (
            <>
              <DiscoverRow
                title="Popular"
                icon={<Flame className="h-4 w-4 text-warning" />}
                addons={trendingThisWeek}
                isSaved={isSaved}
                savingKey={savingKey}
                onSeeAll={() => seeAll('stars')}
                isFavorite={isFavorite}
                {...cardCallbacks}
              />
              <DiscoverRow
                title="Popular Updates"
                icon={<RefreshCw className="h-4 w-4 text-primary" />}
                addons={recentlyUpdated}
                isSaved={isSaved}
                savingKey={savingKey}
                onSeeAll={() => seeAll('stars')}
                isFavorite={isFavorite}
                {...cardCallbacks}
              />
              <DiscoverRow
                title="New Arrivals"
                icon={<Sparkles className="h-4 w-4 text-primary" />}
                addons={newest}
                isSaved={isSaved}
                savingKey={savingKey}
                onSeeAll={() => seeAll('createdAt')}
                isFavorite={isFavorite}
                {...cardCallbacks}
              />
              {categoryShelves.map(({ category, addons: shelf }) => (
                <DiscoverRow
                  key={category.slug}
                  title={category.name}
                  icon={<Sparkles className="h-4 w-4 text-primary" />}
                  addons={shelf}
                  isSaved={isSaved}
                  savingKey={savingKey}
                  onSeeAll={() => seeAllCategory(category.slug)}
                  isFavorite={isFavorite}
                  {...cardCallbacks}
                />
              ))}
            </>
          )}

        </>
      )}

      <p className="pt-1 text-center text-xs text-muted-foreground">
        Addon data from{' '}
        <a href="https://stremio-addons.net" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
          stremio-addons.net
        </a>
      </p>

      {gridMode && (
        <>
          {forceGrid && !isFiltering && (
            <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
              <Button variant="ghost" size="sm" className="h-8 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground" onClick={backToStore}>
                <ArrowLeft className="h-4 w-4" />
                Back to Discover
              </Button>
            </ToolbarShell>
          )}

          {error && (
            <Card className="border-destructive/50 bg-destructive/5">
              <CardContent className="flex items-start gap-3 pt-6">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div className="flex-1">
                  <p className="font-medium text-destructive">Couldn't load addons</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => runQuery(1)}>Retry</Button>
              </CardContent>
            </Card>
          )}

          {loading && (
            <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4', compact && 'gap-2 lg:grid-cols-3 xl:grid-cols-3')}>
              {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className={cn('rounded-xl', compact ? 'h-20' : 'h-[252px]')} />)}
            </div>
          )}

          {!loading && !error && visibleAddons.length === 0 && (
            <Card className="border-border/40 bg-muted/20">
              <CardContent className="flex flex-col items-center py-12 text-center">
                <Search className="mb-3 h-10 w-10 text-muted-foreground/40" />
                <p className="text-lg font-medium">No addons found</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {(selectedResources.length > 0 || selectedTypes.length > 0) && addons.length > 0
                    ? 'None of the loaded addons match these refine filters.'
                    : 'Try a different search or clear your filters.'}
                </p>
                {isFiltering && (
                  <Button variant="ghost" size="sm" className="mt-4" onClick={clearFilters}>Clear filters</Button>
                )}
              </CardContent>
            </Card>
          )}

          {!loading && visibleAddons.length > 0 && (
            <StaggerContainer className={cn(
              'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
              compact ? 'gap-2 lg:grid-cols-3 xl:grid-cols-3' : 'gap-4'
            )}>
              {visibleAddons.map((addon) => (
                <StaggerItem key={addon.uuid}>
                  <DiscoverCard
                    addon={addon}
                    saved={isSaved(addon)}
                    saving={savingKey === addon.uuid}
                    favorite={isFavorite(addon)}
                    compact={compact}
                    {...cardCallbacks}
                  />
                </StaggerItem>
              ))}
            </StaggerContainer>
          )}

          {!loading && hasNextPage && (
            <div ref={loadMoreRef} className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => runQuery(page + 1)} disabled={loadingMore} className="gap-2">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
      </div>
      )}

      <DiscoverDetailModal
        addon={detailAddon}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        sessionKey={detailSession}
        saved={detailAddon ? isSaved(detailAddon) : false}
        isSaved={isSaved}
        onSave={openSave}
        onDeploy={openDeploy}
        onConfigure={handleConfigure}
        onInjectAIOStreams={aioStreamsInstances.length > 0 ? openInject : undefined}
        hasAIOStreams={aioStreamsInstances.length > 0}
        onOpenAddon={openDetail}
      />

      <DiscoverSaveDialog
        addon={saveAddon}
        open={saveOpen}
        onOpenChange={(open) => {
          setSaveOpen(open)
          if (!open) maybeReopenDetail()
        }}
        saving={savingKey === saveAddon?.uuid}
        onSave={handleSaveConfirm}
      />

      <AccountPickerDialog
        open={deployOpen}
        onOpenChange={(open) => {
          setDeployOpen(open)
          if (!open) maybeReopenDetail()
        }}
        title="Deploy Addon"
        description={`Install "${deployAddon?.manifest?.name ?? 'this addon'}" to the selected accounts.`}
        onConfirm={handleDeployConfirm}
        confirmLabel="Deploy"
        confirmPendingLabel="Deploying..."
      />

      <DiscoverInjectDialog
        open={injectOpen}
        onOpenChange={(open) => {
          setInjectOpen(open)
          if (!open) maybeReopenDetail()
        }}
        addonName={injectAddon?.manifest?.name?.trim() || injectAddon?.slug || ''}
        instances={aioStreamsInstances}
        onConfirm={handleInjectConfirm}
      />
    </WorkspaceTabs>
  )
}
