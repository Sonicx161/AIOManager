import { useAccountStore, getStremioAuthKey } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { useProfileStore } from '@/store/profileStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useSyncStore, markAccountsHydrated } from '@/store/syncStore'
import { useNotesStore } from '@/store/notesStore'
import { preloadRouteChunk } from '@/routes'
import { scheduleIdleRoutePreload, shouldSkipIdlePreload } from '@/lib/idle-route-preload'
import { useNavigate, Routes, Route } from 'react-router-dom'
import { useEffect, useRef, useState, Suspense } from 'react'

import { AppLoader, LoadingScreen } from '@/components/common/LoadingScreen'
import { lazyChunk } from '@/lib/lazy-chunk'
import { isAutoUpdateDue, isRemovalPending, planAutoUpdateRun } from '@/lib/auto-update'
import { pendingUndoTargets } from '@/lib/undo-action'
import { readAutoUpdateSettings } from '@/lib/synced-settings'
import { normalizeAddonUrl } from '@/lib/utils'

const ReplaySharePage = lazyChunk(() => import('@/pages/ReplaySharePage').then(m => ({ default: m.ReplaySharePage })))

const LoginPage = lazyChunk(() => import('@/pages/LoginPage').then(m => ({ default: m.LoginPage })))

// The authenticated shell (header, palette, toasts, modals) and the public
// docs shell are split out of the boot closure: their chunks preload during
// boot init once a session (or docs route) exists, so the login path never
// carries them while authenticated boots overlap hydration with the fetch.
const AuthenticatedShell = lazyChunk(() => import('@/components/app/AuthenticatedShell').then(m => ({ default: m.default })))
const KronoriumShell = lazyChunk(() => import('@/components/app/KronoriumShell').then(m => ({ default: m.default })))

// Timestamp of the last full sync (boot/unlock or gated refocus), shared between the unlock
// effect and the visibility gate so a refocus right after boot does not repeat the boot sync.
let lastFullSyncAt = 0

function App() {
  const navigate = useNavigate()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const initializeAccounts = useAccountStore((state) => state.initialize)
  const initializeAddons = useAddonStore((state) => state.initialize)
  const initializeAuth = useAuthStore((state) => state.initialize)
  const initializeUI = useUIStore((state) => state.initialize)
  const initializeProfiles = useProfileStore((state) => state.initialize)
  const initializeFailover = useFailoverStore((state) => state.initialize)
  const startFailoverAutomation = useFailoverStore((state) => state.startAutomation)
  const initializeNotes = useNotesStore((state) => state.initialize)
  const isLocked = useAuthStore((state) => state.isLocked)
  const encryptionKey = useAuthStore((state) => state.encryptionKey)
  const [baseReady, setBaseReady] = useState(false)
  const [extraReady, setExtraReady] = useState(false)
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  const auth = useSyncStore(s => s.auth)

  // Base init (UI/auth/accounts/probe) is what the login screen needs; the
  // remaining stores hydrate right behind it, off the login critical path.
  // Authenticated sessions still gate rendering on the full set, exactly
  // like the previous single-stage init.
  useEffect(() => {
    const init = async () => {
      const storageProbe = (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            const req = indexedDB.open('__aio_probe__')
            req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('__aio_probe__'); resolve() }
            req.onerror = () => reject(req.error)
            req.onblocked = () => reject(new Error('blocked'))
          })
        } catch {
          setStorageUnavailable(true)
        }
      })()

      try {
        initializeUI()
        const accountsReady = initializeAccounts()
        await Promise.all([initializeAuth(), accountsReady])
        // Download the matched route's chunk (or the login screen) in parallel
        // with the remaining store hydration instead of after it. Mirrors the
        // render guard below so nobody downloads a page they cannot see.
        const syncAuth = useSyncStore.getState().auth
        const locked = useAuthStore.getState().isLocked
        const hasKey = !!useAuthStore.getState().encryptionKey
        const isShareLink = /^\/replay\/share\//.test(window.location.pathname)
        const isKronoriumRoute = window.location.pathname.startsWith('/kronorium')
        if (!syncAuth.isAuthenticated || locked || !hasKey) {
          if (isShareLink || isKronoriumRoute) {
            preloadRouteChunk(window.location.pathname)
            void KronoriumShell.preload()
          } else {
            LoginPage.preload()
          }
        } else {
          preloadRouteChunk(window.location.pathname)
          void AuthenticatedShell.preload()
        }
        await accountsReady
        markAccountsHydrated()

        await storageProbe
        setBaseReady(true)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown initialization error'
        if (import.meta.env.DEV) console.error('[Init] Fatal error:', error)
        setInitError(message)
      }
    }

    init()
  }, [initializeAccounts, initializeAddons, initializeAuth, initializeUI, initializeProfiles, initializeFailover, startFailoverAutomation, initializeNotes])

  // Deferred half of the old init: starts right after the base gate flips,
  // in the background on the login screen and as a render gate for
  // authenticated sessions (identical wait to before for them).
  const extraStarted = useRef(false)
  useEffect(() => {
    if (!baseReady || extraStarted.current) return
    extraStarted.current = true
    const init = async () => {
      try {
        // These can run in parallel after accounts are loaded
        const results = await Promise.allSettled([
          initializeAddons(),
          initializeProfiles(),
          initializeFailover(),
          initializeNotes(),
        ])
        const failures = results.filter(r => r.status === 'rejected')
        if (failures.length > 0) {
          failures.forEach((f, i) => {
            const names = ['Addons', 'Profiles', 'Failover', 'Notes']
            if (import.meta.env.DEV) console.error(`[Init] ${names[i]} failed:`, (f as PromiseRejectedResult).reason)
          })
        }

        startFailoverAutomation()
        setExtraReady(true)
        // The deployment and watch-event chunks are first pulled by the
        // post-unlock sync (keep-in-sync, server event merge). Fetching them at
        // idle keeps their bytes and eval out of the first paint window while
        // still landing well before that sync needs them. On the login screen
        // they would compete with the login form's own chunks, so the deferred
        // slot below picks them up there instead.
        const preloadSplitChunks = () => {
            const syncAuth = useSyncStore.getState().auth
            const locked = useAuthStore.getState().isLocked
            if (!syncAuth.isAuthenticated || locked) return
            import('@/store/addon/addonDeployment').catch(() => {})
            import('@/store/watchEventStore').catch(() => {})
        }
        if ('requestIdleCallback' in window) requestIdleCallback(preloadSplitChunks, { timeout: 1500 })
        else setTimeout(preloadSplitChunks, 200)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown initialization error'
        if (import.meta.env.DEV) console.error('[Init] Fatal error:', error)
        setInitError(message)
      }
    }
    init()
  }, [baseReady, initializeAddons, initializeProfiles, initializeFailover, startFailoverAutomation, initializeNotes])

  // Authenticated is only true when the full store set is hydrated; the login
  // screen itself unlocks at baseReady so the vault unlock and sign-in flows
  // never wait on addon/profile/notes/failover reads.
  const sessionReady = auth.isAuthenticated && !isLocked && !!encryptionKey
  const isInitialized = baseReady && extraReady
  const renderReady = baseReady && (!sessionReady || extraReady)

  // On the login screen the shell chunk would only be pulled after
  // authentication; idle-preload it (same gates as route preloading) once the
  // login form's own chunks have landed, so the prefetch never competes with
  // the login UI for bandwidth and the post-login transition stays as
  // immediate as it was pre-split.
  useEffect(() => {
    if (!renderReady || sessionReady) return
    if (shouldSkipIdlePreload((navigator as (Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }) | undefined)?.connection)) return
    let cancelled = false
    LoginPage.preload()
      .then(() => new Promise<void>(resolve => setTimeout(resolve, 2500)))
      .then(() => {
        if (cancelled) return
        void AuthenticatedShell.preload()
        // The auth-path prefetch chunks skipped their idle slot while the
        // login form was loading; fetch them here too.
        import('@/store/addon/addonDeployment').catch(() => {})
        import('@/store/watchEventStore').catch(() => {})
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [renderReady, sessionReady])

  // Nav pages: once the first authenticated screen has settled (network quiet)
  // plus idle, prefetch the most likely next routes' lazy chunks (Cider's
  // preloadSidebarPages); the other routes rely on hover/intent prefetch and
  // load on demand. Skipped on Save-Data and slow connections. Locking or
  // signing out cancels what has not run.
  useEffect(() => {
    if (!isInitialized || isLocked || !auth.isAuthenticated) return
    return scheduleIdleRoutePreload({ preload: preloadRouteChunk })
  }, [isInitialized, isLocked, auth.isAuthenticated])

  // Trigger sync when app unlocks to ensure parity (debounced to avoid racing visibility handler)
  useEffect(() => {
    if (!isLocked && auth.isAuthenticated && isInitialized) {
      if (import.meta.env.DEV) console.log('[App] Vault unlocked. Triggering fresh cloud pull.')
      const t = setTimeout(() => {
        useSyncStore.getState().refreshFromCloud().then(async () => {
          // Only a sync that really ran seeds the refocus gate.
          if (await useAccountStore.getState().syncAllAccounts()) lastFullSyncAt = Date.now()
        }).catch(e => { if (import.meta.env.DEV) console.error(e); import('@/hooks/use-toast').then(({ toast }) => { toast({ title: 'Sync failed', description: 'Data may be stale. Try refreshing.', variant: 'destructive' }) }) })
         useFailoverStore.getState().syncServerState().catch(e => { if (import.meta.env.DEV) console.error(e); import('@/hooks/use-toast').then(({ toast }) => { toast({ title: 'Sync failed', description: 'Data may be stale. Try refreshing.', variant: 'destructive' }) }) })
      }, 1500)
      return () => clearTimeout(t)
    }
  }, [isLocked, auth.isAuthenticated, isInitialized])

  useEffect(() => {
    // In-memory gates - no DB/localStorage writes
    const SYNC_INTERVAL = 5 * 60 * 1000
    const AUTO_UPDATE_TICK_MS = 30 * 60 * 1000
    const JITTER_MS = 5000  // Spread tab-focus storms across 0-5s to soften thundering-herd on shared instances
    let lastAutoUpdateCheck = 0
    let syncJitterTimer: ReturnType<typeof setTimeout> | null = null
    let autoUpdateJitterTimer: ReturnType<typeof setTimeout> | null = null

    const runAutoUpdate = () => {
        const settings = readAutoUpdateSettings()
        if (!isAutoUpdateDue(settings, lastAutoUpdateCheck, Date.now())) return
        lastAutoUpdateCheck = Date.now()
        if (autoUpdateJitterTimer) clearTimeout(autoUpdateJitterTimer)
        autoUpdateJitterTimer = setTimeout(() => {
            autoUpdateJitterTimer = null
            const allAddons = useAccountStore.getState().accounts.flatMap(a => a.addons)
            if (allAddons.length === 0) return
            let aborted = false
            const timeout = setTimeout(() => { aborted = true }, 60000)
            import('@/api/addons').then(({ checkAddonUpdates }) => {
                if (aborted) return
                checkAddonUpdates(allAddons, 'Auto-Update').then(async updates => {
                    clearTimeout(timeout)
                    if (aborted) return
                    const withUpdates = updates.filter(u => u.hasUpdate)
                    if (withUpdates.length === 0) return

                    useAddonStore.getState().updateLatestVersions(
                        Object.fromEntries(withUpdates.map(u => [u.addonId, u.latestVersion]))
                    )

                    // Settings are re-read here: when auto-update is off the plan is check-only and updates stay indicator-only
                    const latestByUrl = new Map(withUpdates.map(u => [normalizeAddonUrl(u.transportUrl), u.latestVersion]))
                    const { checkOnly, targets } = planAutoUpdateRun(
                        readAutoUpdateSettings(),
                        useAccountStore.getState().accounts.map(a => ({
                            id: a.id,
                            hasStremioAuth: !!getStremioAuthKey(a),
                            connections: a.connections,
                            addons: a.addons,
                        })),
                        latestByUrl,
                        pendingUndoTargets('addon-remove'),
                    )
                    if (checkOnly || targets.length === 0) return

                    const accountsById = new Map(useAccountStore.getState().accounts.map(a => [a.id, a]))
                    const total = { success: 0, failed: 0, errors: [] as string[] }
                    for (const target of targets) {
                        const account = accountsById.get(target.accountId)
                        if (!account) continue
                        const pendingRemovals = pendingUndoTargets('addon-remove')
                        const urls = target.urls.filter(u => !isRemovalPending(pendingRemovals, account.id, u))
                        if (urls.length === 0) continue
                        const result = await useAddonStore.getState().bulkReinstallAddons(
                            urls,
                            [{ id: account.id, authKey: target.includeStremio ? getStremioAuthKey(account) : '' }],
                            true,
                            undefined,
                            { skipConnectionPlatforms: target.skipPlatforms },
                        )
                        total.success += result.success
                        total.failed += result.failed
                        total.errors.push(...result.errors.map(e => e.error))
                    }
                    const href = targets.length === 1 ? `/account/${encodeURIComponent(targets[0].accountId)}` : '/'
                    if (total.success > 0) {
                        import('@/hooks/use-toast').then(({ toast }) => {
                            toast({ title: 'Addons Updated', description: `${total.success} account${total.success !== 1 ? 's' : ''} updated to the latest version.`, href })
                        })
                    }
                    if (total.failed > 0) {
                        import('@/hooks/use-toast').then(({ toast }) => {
                            toast({
                                title: 'Auto-Update Failed',
                                description: `Could not update: ${total.errors.slice(0, 5).join(', ')}${total.errors.length > 5 ? ` and ${total.errors.length - 5} more` : ''}`,
                                variant: 'destructive',
                                href,
                            })
                        })
                    }
                }).catch(err => { clearTimeout(timeout); if (import.meta.env.DEV) console.error(err) })
            })
        }, Math.random() * JITTER_MS)
    }

    const handleVisibility = () => {
        if (document.visibilityState === 'visible' && isInitialized && !isLocked) {
            const now = Date.now()
            if (now - lastFullSyncAt > SYNC_INTERVAL) {
                lastFullSyncAt = now
                if (syncJitterTimer) clearTimeout(syncJitterTimer)
                syncJitterTimer = setTimeout(() => {
                    syncJitterTimer = null
                    useFailoverStore.getState().pullServerState()
                    useAccountStore.getState().syncAllAccounts(true)
                }, Math.random() * JITTER_MS)
            }

            runAutoUpdate()
        }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const autoUpdateTick = setInterval(() => {
        if (document.visibilityState === 'visible' && isInitialized && !isLocked) runAutoUpdate()
    }, AUTO_UPDATE_TICK_MS)
    return () => {
        document.removeEventListener('visibilitychange', handleVisibility)
        clearInterval(autoUpdateTick)
        if (syncJitterTimer) clearTimeout(syncJitterTimer)
        if (autoUpdateJitterTimer) clearTimeout(autoUpdateJitterTimer)
    }
  }, [isInitialized, isLocked])

  // Sync UUID to URL for easy bookmarking/sharing
  useEffect(() => {
    if (auth.isAuthenticated && auth.id && isInitialized) {
      // Share links are stateless and meant for copying; the personal id must never land on them.
      if (/^\/replay\/share\//.test(window.location.pathname)) return
      const url = new URL(window.location.href)
      if (url.searchParams.get('id') !== auth.id) {
        url.searchParams.set('id', auth.id)
        window.history.replaceState({}, '', url.toString())
      }
    }
  }, [auth.isAuthenticated, auth.id, isInitialized])

  // Keyboard Shortcuts
  useEffect(() => {
    let lastKey = ''
    let lastKeyTime = 0

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || e.isComposing) return
      const target = e.target
      if (target instanceof HTMLElement && (
        target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
        || target.closest('[role="textbox"], [role="combobox"], [role="dialog"], [role="menu"]')
      )) {
        return
      }

      const now = Date.now()
      const key = e.key.toLowerCase()

      if (key === '?') {
        setShowShortcuts(true)
        return
      }

      // g + key navigation
      if (lastKey === 'g' && now - lastKeyTime < 500) {
        switch (key) {
          case 'a': navigate('/'); break;
          case 's': navigate('/saved-addons'); break;
          case 'h': navigate('/activity'); break;
          case 'm': navigate('/metrics'); break;
          case 'n': navigate('/notes'); break;
          case 'p': navigate('/settings'); break;
          case 'v': navigate('/vault'); break;
          case 'f': navigate('/kronorium'); break;
          case 'r': navigate('/replay'); break;
        }
      }

      lastKey = key
      lastKeyTime = now
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  // Auth bypass for Share Links - Must run before isInitialized check
  if (/^\/replay\/share\/[^/]+$/.test(window.location.pathname)) {
    return (
      <Routes>
        <Route path="/replay/share/:token" element={
          <Suspense fallback={<AppLoader variant="route" />}>
            <ReplaySharePage />
          </Suspense>
        } />
      </Routes>
    )
  }

  if (storageUnavailable) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-lg font-semibold text-foreground">Storage Unavailable</p>
          <p className="text-sm text-muted-foreground">
            AIOManager requires IndexedDB to store your encrypted account data.
            This is blocked in private/incognito mode in some browsers (e.g. Firefox).
            Try opening the app in a regular window, or use Chrome/Edge in private mode instead.
          </p>
        </div>
      </div>
    )
  }

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-4">
          <p className="text-lg font-semibold text-destructive">Initialization Failed</p>
          <p className="text-sm text-muted-foreground">{initError}</p>
          <button
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            onClick={() => { setInitError(null); window.location.reload() }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!renderReady) {
    return (
      <LoadingScreen />
    )
  }

  // Auth Guard: Force login if not authenticated, if the session is locked, or if we are
  // authenticated but have no encryption key (a keyless state must never render the app).
  // Bypass if visiting a Replay share link (stateless)
  const isShareLink = /^\/replay\/share\//.test(window.location.pathname)
  const isKronoriumRoute = window.location.pathname.startsWith('/kronorium')
  const isAdminRoute = window.location.pathname === '/dashboard' || window.location.pathname.startsWith('/dashboard/')

  if (!sessionReady && !isShareLink && !isKronoriumRoute && !isAdminRoute) {
    // Check for Deep Link (Parity with AIOStreams)
    // If user visits /account/<UUID> directly, we want to pre-fill that UUID
    const path = window.location.pathname
    const match = path.match(/^\/account\/([a-zA-Z0-9-]+)/)

    if (match && match[1]) {
      // Redirect to login with ID param
      const uuid = match[1]
      const currentId = new URLSearchParams(window.location.search).get('id')
      if (currentId !== uuid) {
        window.location.href = `/?id=${uuid}`
        return null // Halt rendering
      }
    }

    return (
      <Suspense fallback={<AppLoader />}>
        <LoginPage />
      </Suspense>
    )
  }

  if (isKronoriumRoute) {
    return (
      <Suspense fallback={<AppLoader variant="route" />}>
        <KronoriumShell />
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<AppLoader variant="route" />}>
      <AuthenticatedShell
        shortcutsOpen={showShortcuts}
        onShortcutsClose={() => setShowShortcuts(false)}
      />
    </Suspense>
  )
}

export default App
