import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, RefreshCw, Shield, Zap } from 'lucide-react'
import { getAutopilot, type AutopilotInfo } from '@/api/admin'
import { adminRetry } from '@/lib/admin-queries'
import { Chip, HBar, Kpi, LegendNote, Panel, PanelHead, ScreenHeader, SignalRow } from '../AdminWidgets'

export function AutopilotScreen({ data, notice }: { data: AutopilotInfo; notice?: ReactNode }) {
  const { tripwire, worker } = data
  return (
    <div>
      <ScreenHeader title="Autopilot" subtitle="Cycle timing, rules and the write-budget tripwire." />
      {notice}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Rules" value={data.rules.total.toLocaleString('en-US')} detail={`${data.rules.active.toLocaleString('en-US')} active, ${data.rules.automatic.toLocaleString('en-US')} automatic`} />
        <Kpi label="Last cycle" value={worker.lastCycleLabel} detail={worker.lastCycleDetail} tone={worker.disabledReason ? 'warn' : 'ok'} />
        <Kpi label="Tripwire" value={tripwire.safeMode ? 'Safe mode' : tripwire.enabled ? 'Armed' : 'Off'} detail={`${tripwire.statementsPct}% of hourly statements`} tone={tripwire.safeMode ? 'bad' : tripwire.enabled ? 'ok' : undefined} />
        <Kpi label="Failover events" value={`${data.failovers24h.reduce((a, f) => a + f.count, 0)} in 24 h`} detail={data.failovers24h.map(f => `${f.count} ${f.type}`).join(', ') || 'none'} />
      </div>

      <div className="mt-4 space-y-4">
        <Panel>
          <PanelHead icon={<Clock />} title="Worker" detail="The engine keeps its own interval and lock; only the last cycle is kept, so no history is drawn." />
          <div className="divide-y divide-border/30 text-xs">
            {([
              ['Schedule', worker.intervalLabel],
              ['Last run started', worker.lastRunLabel],
              ['Last cycle ended', worker.lastCycleLabel],
              ['Last cycle', worker.lastCycleDetail],
              ['Recheck interval', worker.recheckLabel],
              ['Cycle budget', worker.budgetLabel || 'n/a'],
            ] as const).map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
                <span className="text-muted-foreground">{label}</span>
                <span className="text-right">{value}</span>
              </div>
            ))}
          </div>
          {worker.disabledReason && <LegendNote className="mt-3">Worker disabled: {worker.disabledReason}.</LegendNote>}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHead icon={<Zap />} title="Rules by platform" detail="Counts from one cached query, refreshed on open." />
            {data.rulesByPlatform.map(p => (
              <HBar key={p.platform} label={p.platform} pct={p.pct} value={`${p.active.toLocaleString('en-US')} active of ${p.count.toLocaleString('en-US')}`} />
            ))}
            {data.healthCacheEntries !== null && (
              <LegendNote className="mt-3">Health cache holds {data.healthCacheEntries.toLocaleString('en-US')} entries (see Cache).</LegendNote>
            )}
          </Panel>
          <Panel>
            <PanelHead icon={<RefreshCw />} title="Failover events, 24 h" detail="Counts by type only. Failover history rows carry addon names and stay unexposed." />
            {data.failovers24h.length === 0 && <p className="py-2 text-xs text-muted-foreground">No failover events in the last 24 hours.</p>}
            {data.failovers24h.map(f => (
              <SignalRow key={f.type} tone="ok" title={`${f.count.toLocaleString('en-US')} ${f.type.replace(/-/g, ' ')}`} detail="count only" />
            ))}
          </Panel>
        </div>

        <Panel>
          <PanelHead
            icon={<Shield />}
            title="Write budget tripwire"
            detail={tripwire.note}
            actions={
              <>
                <Chip tone={tripwire.safeMode ? 'bad' : tripwire.enabled ? 'ok' : undefined}>{tripwire.safeMode ? 'Safe mode on' : tripwire.enabled ? 'Armed' : 'Off'}</Chip>
              </>
            }
          />
          <HBar label={`Statements, ${tripwire.statementsLabel}`} pct={tripwire.statementsPct} value={`${tripwire.statementsPct}% of hourly budget`} />
          <HBar label={`Bytes, ${tripwire.bytesLabel}`} pct={tripwire.bytesPct} value={`${tripwire.bytesPct}% of hourly budget`} />
          {tripwire.safeMode && (
            <LegendNote className="mt-3">
              In safe mode since {tripwire.safeModeSinceLabel}: {tripwire.safeModeReason ?? 'write budget exceeded'}. No DB writes, no pushes, no swaps, no webhooks until restart.
            </LegendNote>
          )}
        </Panel>
      </div>
    </div>
  )
}

export function useAutopilotQuery(enabled: boolean) {
  return useQuery({ queryKey: ['admin-autopilot'], queryFn: getAutopilot, enabled, staleTime: 30_000, retry: adminRetry })
}
