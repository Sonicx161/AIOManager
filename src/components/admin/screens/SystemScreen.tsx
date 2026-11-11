import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Copy, HardDrive, Info, Package, Server } from 'lucide-react'
import { getSystem, type SystemInfo } from '@/api/admin'
import { formatDiagnosticsText } from '@/lib/admin-diagnostics'
import { adminRetry } from '@/lib/admin-queries'
import { toast } from '@/hooks/use-toast'
import { copyTextToClipboard } from '@/components/ui/copy-button'
import { redactCopyText } from '@/lib/redact-copy'
import { Button } from '@/components/ui/button'
import {
  HBar, Kpi, LegendNote, MetricCards, MetricsPane, MetricsRequestsPanel, MetricsUnavailableNote,
  MetricsWorkersPanel, MiniBars, Panel, PanelHead, ScreenHeader,
} from '../AdminWidgets'

/** Fact rows shared by the environment cards; each value truncates with a title tooltip, never overflows. */
function FactRows({ rows }: { rows: [string, string][] }) {
  return (
    <div className="divide-y divide-border/30 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate text-right" title={value}>{value}</span>
        </div>
      ))}
    </div>
  )
}

export function SystemScreen({ data, notice, metrics }: { data: SystemInfo; notice?: ReactNode; metrics?: MetricsPane }) {
  const m = metrics?.data
  const ok = m?.available === true
  const metricsOut = metrics !== undefined && ((metrics.error !== null && metrics.error !== undefined) || (m !== undefined && !m.available))
  const env = data.environment
  // The node version already lives on the Version and mode Runtime row, so the
  // environment cards and the copied text never repeat it.
  const factRows = (pairs: readonly (readonly [string, string | null])[]): [string, string][] =>
    pairs.flatMap(([label, value]) => (value ? [[label, value] as [string, string]] : []))
  const hostRows = !env ? [] : factRows([
    ['Operating system', env.os],
    ['CPU', env.cpu],
    ['Memory', env.memory],
    ['Timezone', env.timezone],
  ])
  const runtimeRows = !env ? [] : factRows([
    ['Container', env.container],
    ['Database', env.database],
    ['Data folder', env.dataDir],
    ['Build', env.build],
  ])
  const copyDiagnostics = () => {
    if (!env) return
    const text = redactCopyText(formatDiagnosticsText({ version: data.version, mode: data.mode, runtime: data.runtime, environment: env }))
    void copyTextToClipboard(text).then(copied => {
      if (copied) {
        toast({ title: 'Diagnostics copied', description: 'Plain text with version, host, runtime and build facts. No addresses, names or secrets.' })
      } else {
        toast({ variant: 'destructive', title: 'Copy unavailable', description: 'The clipboard is blocked on this connection (http). Select the text and copy it manually.' })
      }
    })
  }
  return (
    <div>
      <ScreenHeader
        title="System"
        subtitle="Host and process health, version and storage. Sampled in memory once a minute, cached 30 s with single-flight; nothing is written by watching."
      />
      {notice}

      {metricsOut && metrics && (
        <div className="mb-4">
          <MetricsUnavailableNote
            message={ok ? 'Showing the last good host metrics; the latest refresh failed.' : 'Host metrics are unavailable right now; this screen keeps working from the system read.'}
            onRetry={metrics.retry}
            retrying={metrics.retrying}
          />
        </div>
      )}

      {ok && m ? <MetricCards cards={m.cards} /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data.kpis.map(k => <Kpi key={k.id} label={k.label} value={k.value} detail={k.detail} tone={k.tone} />)}
        </div>
      )}

      {ok && m && (m.requests !== null || m.workers.length > 0) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {m.requests !== null && <MetricsRequestsPanel requests={m.requests} />}
          {m.workers.length > 0 && <MetricsWorkersPanel rows={m.workers} />}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <Panel>
          <PanelHead icon={<Clock />} title="Recent history" detail={ok && m ? m.samplingLabel : data.ringNote} />
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {(ok && m ? m.rings : data.rings).map(r => (
              <div key={r.label}>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">{r.label}</div>
                <MiniBars values={r.values} ariaLabel={r.label} />
              </div>
            ))}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHead icon={<Info />} title="Version and mode" detail="From the server process, cached 30 s." />
            <div className="divide-y divide-border/30 text-xs">
              {([
                ['Version', data.version, ''],
                ['Mode', data.mode, ''],
                ['Runtime', data.runtime, ''],
                ['Started', data.startedLabel, ''],
                ['Uptime', data.uptimeLabel, ''],
                ['Event loop', data.eventLoopLabel, ''],
              ] as const).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="text-right">{value}</span>
                </div>
              ))}
            </div>
          </Panel>
          {env && hostRows.length > 0 && (
            <Panel>
              <PanelHead icon={<Server />} title="Host" detail="Facts of the machine this server runs on, read once per process." />
              <FactRows rows={hostRows} />
            </Panel>
          )}
          <Panel>
            <PanelHead icon={<HardDrive />} title="Storage" detail="Plain sizes only. This console does not track cost, WAL trends or table internals." />
            {ok && m && m.disk && (
              <HBar label="Host disk free" pct={m.disk.pctFree} value={m.disk.label} tone={m.disk.tone} />
            )}
            <HBar label="Database size" pct={null} value={`${data.database.sizeLabel} on disk (${data.database.type})`} />
            <HBar label="Free pages" pct={null} value={data.database.freeLabel} />
            <HBar label="Write-ahead log" pct={null} value={data.database.walLabel} />
            <LegendNote className="mt-3">
              Database health: <b>{data.database.healthy ? 'healthy' : 'not answering health checks'}</b>. One cached read-only size query per open, nothing else. There is no outbound update check, by the privacy stance.
            </LegendNote>
          </Panel>
          {env && runtimeRows.length > 0 && (
            <Panel>
              <PanelHead
                icon={<Package />}
                title="Runtime and build"
                detail="Detected locally, read once per process. The copy carries no addresses, names or secrets."
                actions={(
                  <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={copyDiagnostics}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Copy diagnostics
                  </Button>
                )}
              />
              <FactRows rows={runtimeRows} />
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

export function useSystemQuery(enabled: boolean) {
  return useQuery({ queryKey: ['admin-system'], queryFn: getSystem, enabled, staleTime: 30_000, retry: adminRetry })
}
