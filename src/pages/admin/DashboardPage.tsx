import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { endAdminSession, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, LogOut, Shield } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { adminLogout, getAdminStatus, AdminApiError } from '@/api/admin'
import { resolveAdminGate } from '@/components/admin/admin-gate'
import { DASHBOARD_GROUPS, DASHBOARD_SECTIONS } from '@/components/admin/sections'
import { PaneError, PaneLoading, StaleNotice } from '@/components/admin/AdminWidgets'
import { SignInScreen } from '@/components/admin/screens/SignInScreen'
import { OverviewScreen, useOverviewQuery } from '@/components/admin/screens/OverviewScreen'
import { SystemScreen, useSystemQuery } from '@/components/admin/screens/SystemScreen'
import { useMetricsQuery } from '@/components/admin/useMetricsQuery'
import { UsersScreen } from '@/components/admin/screens/UsersScreen'
import { UserDetailScreen } from '@/components/admin/screens/UserDetailScreen'
import { AutopilotScreen, useAutopilotQuery } from '@/components/admin/screens/AutopilotScreen'
import { ActivityEngineScreen, useActivityEngineQuery } from '@/components/admin/screens/ActivityEngineScreen'
import { TasksScreen } from '@/components/admin/screens/TasksScreen'
import { CacheScreen } from '@/components/admin/screens/CacheScreen'
import { LogsScreen } from '@/components/admin/screens/LogsScreen'
import { SettingsScreen } from '@/components/admin/screens/SettingsScreen'
import { AuditScreen } from '@/components/admin/screens/AuditScreen'
import { SessionsScreen } from '@/components/admin/screens/SessionsScreen'

function OverviewPane({ readOnlyReplica }: { readOnlyReplica?: boolean }) {
  const query = useOverviewQuery(true)
  const metrics = useMetricsQuery(true)
  const view = paneView(query)
  if (view === 'loading') return <PaneLoading />
  if (view === 'gone' || !query.data) return <PaneError message={paneErrorCopy(query.error, 'The overview')} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const notice = view === 'stale' ? <StaleNotice message={staleNoteCopy(query.error)} onRetry={() => query.refetch()} retrying={query.isFetching} /> : null
  const metricsPane = { data: metrics.data, error: metrics.error, retry: () => { void metrics.refetch() }, retrying: metrics.isFetching }
  return <OverviewScreen data={query.data} readOnlyReplica={readOnlyReplica} notice={notice} metrics={metricsPane} />
}

function SystemPane() {
  const query = useSystemQuery(true)
  const metrics = useMetricsQuery(true)
  const view = paneView(query)
  if (view === 'loading') return <PaneLoading />
  if (view === 'gone' || !query.data) return <PaneError message={paneErrorCopy(query.error, 'The system report')} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const notice = view === 'stale' ? <StaleNotice message={staleNoteCopy(query.error)} onRetry={() => query.refetch()} retrying={query.isFetching} /> : null
  const metricsPane = { data: metrics.data, error: metrics.error, retry: () => { void metrics.refetch() }, retrying: metrics.isFetching }
  return <SystemScreen data={query.data} notice={notice} metrics={metricsPane} />
}

function AutopilotPane() {
  const query = useAutopilotQuery(true)
  const view = paneView(query)
  if (view === 'loading') return <PaneLoading />
  if (view === 'gone' || !query.data) return <PaneError message={paneErrorCopy(query.error, 'The Autopilot report')} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const notice = view === 'stale' ? <StaleNotice message={staleNoteCopy(query.error)} onRetry={() => query.refetch()} retrying={query.isFetching} /> : null
  return <AutopilotScreen data={query.data} notice={notice} />
}

function ActivityEnginePane() {
  const query = useActivityEngineQuery(true)
  const view = paneView(query)
  if (view === 'loading') return <PaneLoading />
  if (view === 'gone' || !query.data) return <PaneError message={paneErrorCopy(query.error, 'The activity engine report')} onRetry={() => query.refetch()} retrying={query.isFetching} />
  const notice = view === 'stale' ? <StaleNotice message={staleNoteCopy(query.error)} onRetry={() => query.refetch()} retrying={query.isFetching} /> : null
  return <ActivityEngineScreen data={query.data} notice={notice} />
}

function SectionView({ id }: { id: string }) {
  switch (id) {
    case 'overview': return <OverviewPane />
    case 'users': return <UsersScreen />
    case 'system': return <SystemPane />
    case 'autopilot': return <AutopilotPane />
    case 'activity-engine': return <ActivityEnginePane />
    case 'tasks': return <TasksScreen />
    case 'cache': return <CacheScreen />
    case 'logs': return <LogsScreen />
    case 'settings': return <SettingsScreen />
    case 'audit': return <AuditScreen />
    case 'sessions': return <SessionsScreen />
    default: return <NotFoundPage />
  }
}

/** Phone-only back header above a drilled-in page. */
function BackHeader({ label }: { label: string }) {
  const navigate = useNavigate()
  return (
    <div className="mb-3 flex items-center gap-2 md:hidden">
      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        aria-label="Back to the Dashboard home"
        className="flex h-11 min-w-[96px] items-center gap-0.5 rounded-full pl-1 pr-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Dashboard
      </button>
      <h2 className="min-w-0 flex-1 truncate text-center text-base font-bold">{label}</h2>
      <span className="min-w-[96px]" aria-hidden />
    </div>
  )
}

/** Phone home: Settings-style grouped list, pages slide in from here. */
function DrillInHome({ userCount }: { userCount: number | null }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
          <Shield className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-xs text-muted-foreground">Power over the instance, never over people.</p>
        </div>
      </div>

      {DASHBOARD_GROUPS.map(group => {
        const rows = DASHBOARD_SECTIONS.filter(s => s.group === group)
        return (
          <section key={group} aria-label={group}>
            <h3 className="mb-1.5 mt-4 px-1.5 text-xs font-semibold text-muted-foreground">{group}</h3>
            <div className="rounded-2xl border border-border/45 bg-card/80 px-2.5 py-1 shadow-sm">
              {rows.map(row => {
                const Icon = row.icon
                return (
                  <Link
                    key={row.id}
                    to={`/dashboard/${row.id}`}
                    className="flex min-h-[48px] items-center gap-3 rounded-xl px-1.5 py-2.5 transition-colors hover:bg-muted/25"
                  >
                    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/35 text-muted-foreground">
                      <Icon className="h-[15px] w-[15px]" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.label}</span>
                    {row.id === 'users' && userCount !== null && (
                      <span className="shrink-0 text-xs text-muted-foreground">{userCount}</span>
                    )}
                    {row.id === 'logs' && <span className="shrink-0 text-xs text-muted-foreground">live</span>}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
                  </Link>
                )
              })}
            </div>
          </section>
        )
      })}

      <p className="mt-5 px-1.5 text-xs leading-relaxed text-muted-foreground">
        Every screen states what the dashboard can never do. User contents are never shown here.
      </p>
    </motion.div>
  )
}

function DashboardShell({ section, userId, readOnlyReplica }: { section?: string; userId?: string; readOnlyReplica?: boolean }) {
  const location = useLocation()
  const queryClient = useQueryClient()
  // Desktop home is the Overview; phone home is the drill-in list.
  const overview = useOverviewQuery(true)
  const userCount = overview.data?.accountsRaw ?? null

  const signOut = async () => {
    try {
      await adminLogout()
      toast({ title: 'Signed out of the dashboard' })
    } catch {
      toast({ variant: 'destructive', title: 'Sign out failed' })
    }
    // The status refetch inside confirms the outcome with the server.
    endAdminSession(queryClient)
  }

  const activeSection = userId ? 'users' : section
  const activeSpec = DASHBOARD_SECTIONS.find(s => s.id === activeSection)
  if (section && !activeSpec) return <NotFoundPage />

  const content = userId
    ? <UserDetailScreen />
    : section
      ? <SectionView id={section} />
      : null

  return (
    <div>
      {/* Desktop nav lives in the header: the dashboard pills replace the app nav there. */}

      {!section && !userId && (
        <>
          <div className="md:hidden">
            <DrillInHome userCount={userCount} />
            <button
              type="button"
              onClick={signOut}
              className="mt-5 flex min-h-[48px] w-full items-center gap-3 rounded-2xl border border-border/45 bg-card/80 px-3 text-sm font-semibold text-muted-foreground shadow-sm transition-colors hover:text-destructive"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign out of the dashboard
            </button>
          </div>
          <div className="hidden md:block">
            <OverviewPane readOnlyReplica={readOnlyReplica} />
          </div>
        </>
      )}

      {(section || userId) && (
        <>
          <BackHeader label={activeSpec?.label ?? 'Dashboard'} />
          <motion.div
            key={`${userId ?? section ?? ''}-${location.key}`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            {content}
          </motion.div>
        </>
      )}
    </div>
  )
}

/**
 * The /dashboard route. Renders only when GET /api/admin/status reports enabled;
 * otherwise the normal 404. In dev builds with localStorage 'aiomAdminMock' = '1'
 * the contract-shaped mock serves the data; it never ships.
 */
export function DashboardPage() {
  useDocumentTitle('Dashboard')
  const [mockReady, setMockReady] = useState(!import.meta.env.DEV)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    let flag = false
    try {
      flag = localStorage.getItem('aiomAdminMock') === '1'
    } catch {
      // storage unavailable: run against the real server
    }
    if (!flag) {
      // No mock: unblock the status query immediately (a persisted cache from an
      // earlier mock session must not freeze the gate).
      setMockReady(true)
      return
    }
    import('@/api/admin-mock')
      .then(m => {
        if (cancelled) return
        m.installAdminMock()
        setMockReady(true)
      })
      .catch(() => setMockReady(true))
    return () => { cancelled = true }
  }, [])

  const { section, userId } = useParams()
  const status = useQuery({
    queryKey: ['admin-status'],
    queryFn: getAdminStatus,
    enabled: mockReady,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  })

  if (!mockReady || status.isPending) {
    return <PaneLoading />
  }

  const statusError = status.error instanceof AdminApiError
    ? { status: status.error.status }
    : status.error ? { status: 0 } : null
  const gate = resolveAdminGate(status.data, statusError)

  if (gate === 'disabled') return <NotFoundPage />
  if (gate === 'setup') return <SignInScreen mode="setup" setupAvailable={status.data?.setupAvailable ?? true} readOnlyReplica={status.data?.readOnlyReplica ?? false} rememberedBrowser={status.data?.rememberedBrowser ?? false} />
  if (gate === 'signin') return <SignInScreen mode="signin" readOnlyReplica={status.data?.readOnlyReplica ?? false} rememberedBrowser={status.data?.rememberedBrowser ?? false} />
  return <DashboardShell section={section} userId={userId} readOnlyReplica={status.data?.readOnlyReplica ?? false} />
}
