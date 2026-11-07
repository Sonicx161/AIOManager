import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle2, Cpu, History } from 'lucide-react'
import { getOverview, type OverviewInfo } from '@/api/admin'
import { adminRetry, overviewRefetchInterval } from '@/lib/admin-queries'
import { AlertTriangle } from 'lucide-react'
import {
    Chip, GuaranteesPanel, Kpi, MetricCards, MetricsPane, MetricsRequestsPanel, MetricsUnavailableNote,
    MetricsWorkersPanel, OpenSectionLink, Panel, PaneLoading, PanelHead, ScreenHeader, SignalRow,
} from '../AdminWidgets'

export function OverviewScreen({ data, readOnlyReplica = false, notice, metrics }: { data: OverviewInfo; readOnlyReplica?: boolean; notice?: ReactNode; metrics?: MetricsPane }) {
  const { verdict } = data
  // Healthy and watch both render success styling per the mockup; the watch
  // count is said in the title. Amber-red is reserved for a down instance.
  const down = verdict.state === 'down'
  const m = metrics?.data?.available === true ? metrics.data : null
  const metricsOut = metrics !== undefined && ((metrics.error !== null && metrics.error !== undefined) || (metrics.data !== undefined && !metrics.data.available))
  return (
    <div>
      <ScreenHeader
        title="Overview"
        subtitle="The verdict, ranked signals and the guarantees. Updated every 30 s while open; nothing is written by watching."
      />
      {notice}

      <div
        className={`flex flex-wrap items-center gap-3 rounded-2xl border p-4 ${down ? 'border-destructive/25 bg-destructive/10' : 'border-success/25 bg-success/5'}`}
        role="status"
      >
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${down ? 'border-destructive/25 bg-destructive/10 text-destructive' : 'border-success/25 bg-success/10 text-success'}`}>
          {down ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        </span>
        <div className="min-w-[12rem] flex-1">
          <div className="text-base font-semibold">{verdict.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{verdict.detail}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {readOnlyReplica && <Chip tone="warn" icon={<AlertTriangle className="h-3 w-3" />}>Read-only replica</Chip>}
          {verdict.watching > 0 && <Chip tone="warn" icon={<AlertTriangle className="h-3 w-3" />}>{verdict.watching} watch</Chip>}
        </div>
      </div>

      {/* Five cards, one balanced row on desktop; database size lives in the Host and process panel. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        {data.kpis.map(k => <Kpi key={k.id} label={k.label} value={k.value} detail={k.detail} tone={k.tone} />)}
      </div>

      <div className="mt-4">
        <Panel>
          <PanelHead
            icon={<Cpu />}
            title="Host and process"
            detail={m ? m.samplingLabel : 'Host metrics come from their own read; watching them writes nothing.'}
          />
          {m ? (
            <>
              <MetricCards cards={m.cards} />
              {metrics?.error && (
                <div className="mt-3">
                  <MetricsUnavailableNote
                    message="Showing the last good host metrics; the latest refresh failed."
                    onRetry={metrics.retry}
                    retrying={metrics.retrying}
                  />
                </div>
              )}
            </>
          ) : metricsOut ? (
            <MetricsUnavailableNote
              message="Host metrics are unavailable right now; the rest of this screen keeps working from the system read."
              onRetry={metrics.retry}
              retrying={metrics.retrying}
            />
          ) : (
            <PaneLoading />
          )}
        </Panel>
      </div>

      {m && m.requests !== null && m.workers.length > 0 && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <MetricsRequestsPanel requests={m.requests} />
          <MetricsWorkersPanel rows={m.workers} />
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHead icon={<Bell />} title="Needs attention" detail="Ranked signals, memoised for 30 s. Every warning links to where it is acted on." />
          <div>
            {data.signals.length === 0 && (
              <SignalRow tone="ok" title="All clear" detail="No signals need attention right now." />
            )}
            {data.signals.map(s => (
              <SignalRow
                key={s.id}
                tone={s.tone}
                title={s.title}
                detail={s.detail}
                action={s.section ? <OpenSectionLink section={s.section} /> : undefined}
              />
            ))}
          </div>
        </Panel>
        <Panel>
          <PanelHead icon={<History />} title="Recent dashboard activity" detail="From the audit log; the full trail is append-only." />
          <div>
            {data.recentAudit.length === 0 && (
              <SignalRow tone="info" title="Nothing yet" detail="No dashboard actions have been audited so far." />
            )}
            {data.recentAudit.map((a, i) => (
              <SignalRow key={`${a.hashPrefix}-${i}`} tone="info" title={a.action} detail={`${a.detail} \u00b7 ${a.at}`} />
            ))}
          </div>
        </Panel>
      </div>

      <div className="mt-4">
        <GuaranteesPanel guarantees={data.guarantees} />
      </div>
    </div>
  )
}

export function useOverviewQuery(enabled: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['admin-overview'],
    queryFn: getOverview,
    enabled,
    staleTime: 30_000,
    retry: adminRetry,
    // Stops as soon as the session ends, so no 401s after sign-out.
    refetchInterval: overviewRefetchInterval(queryClient),
  })
}
