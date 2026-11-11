import { Routes, Route, Navigate } from 'react-router-dom'
import { NotFoundPage } from '@/pages/NotFoundPage'

import { Suspense } from 'react'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { AppLoader } from '@/components/common/LoadingScreen'
import { lazyChunk } from '@/lib/lazy-chunk'

const DashboardPage = lazyChunk(() => import('@/pages/admin/DashboardPage').then(m => ({ default: m.DashboardPage })))

const AccountsPage = lazyChunk(() => import('@/pages/AccountsPage').then(m => ({ default: m.AccountsPage })))
const AccountDetailPage = lazyChunk(() => import('@/pages/AccountDetailPage').then(m => ({ default: m.AccountDetailPage })))
const SavedAddonsPage = lazyChunk(() => import('@/pages/SavedAddonsPage').then(m => ({ default: m.SavedAddonsPage })))
const AIOStreamsPage = lazyChunk(() => import('@/pages/AIOStreamsPage').then(m => ({ default: m.AIOStreamsPage })))
const AIOMetadataPage = lazyChunk(() => import('@/pages/AIOMetadataPage').then(m => ({ default: m.AIOMetadataPage })))

const KronoriumPage = lazyChunk(() => import('@/pages/kronorium/KronoriumPage').then(m => ({ default: m.KronoriumPage })))
const KronoriumDocsLayout = lazyChunk(() => import('@/components/kronorium/KronoriumDocsLayout').then(m => ({ default: m.KronoriumDocsLayout })))

const ReplayPage = lazyChunk(() => import('@/pages/ReplayPage').then(m => ({ default: m.ReplayPage })))
const ReplaySharePage = lazyChunk(() => import('@/pages/ReplaySharePage').then(m => ({ default: m.ReplaySharePage })))
const ActivityPage = lazyChunk(() => import('@/pages/ActivityPage').then(m => ({ default: m.ActivityPage })))
const FailoverOverviewPage = lazyChunk(() => import('@/pages/FailoverOverviewPage').then(m => ({ default: m.FailoverOverviewPage })))
const MetricsPage = lazyChunk(() => import('@/pages/MetricsPage').then(m => ({ default: m.MetricsPage })))
const SettingsPage = lazyChunk(() => import('@/pages/SettingsPage').then(m => ({ default: m.SettingsPage })))
const NotesPage = lazyChunk(() => import('@/pages/NotesPage').then(m => ({ default: m.NotesPage })))
const VaultPage = lazyChunk(() => import('@/pages/VaultPage').then(m => ({ default: m.VaultPage })))
const ThemeEditorPage = lazyChunk(() => import('@/pages/ThemeEditorPage').then(m => ({ default: m.ThemeEditorPage })))
const fallback = <AppLoader variant="route" />

// Boot-time / intent-time route chunk matching. Resolves the lazyChunk factory for
// a pathname so the chunk download overlaps boot init and navigation intent instead
// of waiting for the route to render. Palette targets carry hashes and queries
// (`/saved-addons#discover`, `/notes?note=...`), so strip them before matching.
// Returns the loader promise (which never rejects) so callers can await a chunk.
export function preloadRouteChunk(pathname: string): Promise<unknown> | undefined {
    const path = pathname.split(/[?#]/)[0]
    if (path === '/' || path === '/accounts') return AccountsPage.preload()
    if (path === '/saved-addons' || path === '/discover' || path === '/addons') return SavedAddonsPage.preload()
    if (path.startsWith('/account/')) {
        if (path.includes('/aiostreams/')) return AIOStreamsPage.preload()
        if (path.includes('/aiometadata/')) return AIOMetadataPage.preload()
        return AccountDetailPage.preload()
    }
    if (path === '/activity') return ActivityPage.preload()
    if (path === '/metrics') return MetricsPage.preload()
    if (path === '/failover') return FailoverOverviewPage.preload()
    if (path.startsWith('/replay/share/')) return ReplaySharePage.preload()
    if (path === '/replay') return ReplayPage.preload()
    if (path === '/settings') return SettingsPage.preload()
    if (path === '/settings/theme/editor') return ThemeEditorPage.preload()
    if (path === '/notes') return NotesPage.preload()
    if (path === '/vault') return VaultPage.preload()
    if (path.startsWith('/kronorium') || path === '/faq') {
        void KronoriumPage.preload()
        return KronoriumDocsLayout.preload()
    }
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ErrorBoundary><Suspense fallback={fallback}><AccountsPage /></Suspense></ErrorBoundary>} />
      <Route path="/accounts" element={<Navigate to="/" replace />} />
      <Route path="/saved-addons" element={<ErrorBoundary><Suspense fallback={fallback}><SavedAddonsPage /></Suspense></ErrorBoundary>} />
      <Route path="/discover" element={<Navigate to="/saved-addons#discover" replace />} />
      <Route path="/addons" element={<Navigate to="/saved-addons" replace />} />

      <Route path="/account/:accountId" element={<ErrorBoundary><Suspense fallback={fallback}><AccountDetailPage /></Suspense></ErrorBoundary>} />
      <Route path="/account/:accountId/aiostreams/:uuid" element={<ErrorBoundary><Suspense fallback={fallback}><AIOStreamsPage /></Suspense></ErrorBoundary>} />
      <Route path="/account/:accountId/aiometadata/:uuid" element={<ErrorBoundary><Suspense fallback={fallback}><AIOMetadataPage /></Suspense></ErrorBoundary>} />


      <Route path="/activity" element={<ErrorBoundary><Suspense fallback={fallback}><ActivityPage /></Suspense></ErrorBoundary>} />
      <Route path="/metrics" element={<ErrorBoundary><Suspense fallback={fallback}><MetricsPage /></Suspense></ErrorBoundary>} />
      <Route path="/failover" element={<ErrorBoundary><Suspense fallback={fallback}><FailoverOverviewPage /></Suspense></ErrorBoundary>} />
      <Route path="/replay" element={<ErrorBoundary><Suspense fallback={fallback}><ReplayPage /></Suspense></ErrorBoundary>} />
      <Route path="/replay/share/:token" element={<ErrorBoundary><Suspense fallback={fallback}><ReplaySharePage /></Suspense></ErrorBoundary>} />
      <Route path="/settings" element={<ErrorBoundary><Suspense fallback={fallback}><SettingsPage /></Suspense></ErrorBoundary>} />
      <Route path="/settings/theme/editor" element={<ErrorBoundary><Suspense fallback={fallback}><ThemeEditorPage /></Suspense></ErrorBoundary>} />
      <Route path="/notes" element={<ErrorBoundary><Suspense fallback={fallback}><NotesPage /></Suspense></ErrorBoundary>} />

      <Route path="/vault" element={<ErrorBoundary><Suspense fallback={fallback}><VaultPage /></Suspense></ErrorBoundary>} />
      <Route path="/vault/:groupSlug" element={<Navigate to="/vault" replace />} />

      {/* Dashboard (instance admin UI) renders only when the status endpoint reports enabled. */}
      <Route path="/dashboard" element={<ErrorBoundary><Suspense fallback={fallback}><DashboardPage /></Suspense></ErrorBoundary>} />
      <Route path="/dashboard/:section" element={<ErrorBoundary><Suspense fallback={fallback}><DashboardPage /></Suspense></ErrorBoundary>} />
      <Route path="/dashboard/users/:userId" element={<ErrorBoundary><Suspense fallback={fallback}><DashboardPage /></Suspense></ErrorBoundary>} />

      <Route path="/kronorium" element={<ErrorBoundary><Suspense fallback={fallback}><KronoriumDocsLayout><KronoriumPage /></KronoriumDocsLayout></Suspense></ErrorBoundary>} />
      <Route path="/kronorium/*" element={<ErrorBoundary><Suspense fallback={fallback}><KronoriumDocsLayout><KronoriumPage /></KronoriumDocsLayout></Suspense></ErrorBoundary>} />
      <Route path="/faq" element={<Navigate to="/kronorium" replace />} />

      <Route path="/404" element={<NotFoundPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
