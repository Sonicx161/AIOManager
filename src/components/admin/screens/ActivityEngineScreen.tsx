import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Shield, CircleAlert } from 'lucide-react'
import { getActivityEngine, type ActivityEngineInfo } from '@/api/admin'
import { adminRetry } from '@/lib/admin-queries'
import { Chip, Kpi, LegendNote, Panel, PanelHead, ScreenHeader } from '../AdminWidgets'

export function ActivityEngineScreen({ data, notice }: { data: ActivityEngineInfo; notice?: ReactNode }) {
  const fmt = (n: number | null) => (n === null ? 'not recorded' : n.toLocaleString('en-US'))
  return (
    <div>
      <ScreenHeader
        title="Activity engine"
        subtitle="Scan cycle summary, breaker state and the honest scope note. Only the last cycle is kept, so there is no history table."
      />
      {notice}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Last scan" value={data.lastScan.agoLabel} detail={`${data.lastScan.everyLabel}, ${data.lastScan.durationLabel} duration`} tone={data.lastCycleError ? 'bad' : 'ok'} />
        <Kpi label="Accounts scanned" value={data.accounts.scanned === null ? 'n/a' : String(data.accounts.scanned)} detail={`${fmt(data.accounts.hashSkipped)} hash-skipped, ${fmt(data.accounts.breakerSkipped)} breaker-skipped`} />
        <Kpi label="Events written" value={data.events.written === null ? 'n/a' : String(data.events.written)} detail={`${fmt(data.events.snapshotDeletes)} snapshot deletes`} />
        <Kpi label="Breaker" value={data.breaker.inBackoff > 0 ? `${data.breaker.inBackoff} in backoff` : 'Clear'} detail="connections waiting out their backoff" tone={data.breaker.inBackoff > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="mt-4 space-y-4">
        {data.lastCycleError && (
          <Panel>
            <PanelHead icon={<CircleAlert />} title="Last cycle failed" detail={`The scanner reported: ${data.lastCycleError}. It retries on the next interval.`} />
          </Panel>
        )}

        <Panel>
          <PanelHead
            icon={<Clock />}
            title="Cycle summary"
            detail="One row per kept cycle: the engine stores only the most recent one. Hash-skipped means the snapshot was unchanged; breaker-skipped means repeated fetch failures put the connection in backoff."
            actions={<Chip tone={data.running ? 'ok' : undefined}>{data.running ? 'Scanning now' : data.enabled ? 'Idle' : 'Disabled'}</Chip>}
          />
          <div className="divide-y divide-border/30 text-xs">
            {([
              ['Accounts scanned', fmt(data.accounts.scanned)],
              ['Hash-skipped', fmt(data.accounts.hashSkipped)],
              ['Breaker-skipped', fmt(data.accounts.breakerSkipped)],
              ['Events written', fmt(data.events.written)],
              ['Snapshot deletes', fmt(data.events.snapshotDeletes)],
              ['Budget exhausted', data.budgetExhausted ? 'yes, the scan stopped at its budget and continues next cycle' : 'no, the scan finished inside its budget'],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
                <span className="text-muted-foreground">{label}</span>
                <span className="text-right">{value}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <PanelHead
            icon={<Shield />}
            title="Scope"
            detail="The console says what the scanner covers instead of showing an empty healthy row."
          />
          <LegendNote>{data.scopeNote}</LegendNote>
        </Panel>
      </div>
    </div>
  )
}

export function useActivityEngineQuery(enabled: boolean) {
  return useQuery({ queryKey: ['admin-activity'], queryFn: getActivityEngine, enabled, staleTime: 30_000, retry: adminRetry })
}
