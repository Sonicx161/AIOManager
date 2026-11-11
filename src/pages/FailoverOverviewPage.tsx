import { memo, useDeferredValue, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Activity, AlertTriangle, ArrowRight, Check, ChevronRight, Pause, Search, X, type LucideIcon } from 'lucide-react'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { StatusChip } from '@/components/ui/status-chip'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-relative-time'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import {
  AUTOPILOT_PARTIAL_DETAIL, AUTOPILOT_SAFE_MODE_DETAIL, AUTOPILOT_UNREACHABLE_DETAIL, AUTOPILOT_WORKER_OFF_DETAIL, AUTOPILOT_WORKER_OFF_TITLE,
  isAutopilotServerLive, recordFirstSeen,
} from '@/lib/autopilot-freshness'
import {
  OVERVIEW_STATES, OVERVIEW_STATE_LABEL, buildFailoverOverview, countByState, matchesSearch,
  type OverviewRow, type OverviewState,
} from '@/lib/failover-overview'
import { getPlatformEntry } from '@/lib/platform-registry'
import { cn, maskNameLevel } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import type { Account } from '@/types/account'
import { useFailoverStore } from '@/store/failoverStore'
import { useUIStore } from '@/store/uiStore'

const CHIP: Record<OverviewState, { variant: 'destructive' | 'warning' | 'success' | 'muted'; icon: LucideIcon }> = {
  need: { variant: 'destructive', icon: AlertTriangle },
  bk: { variant: 'warning', icon: ArrowRight },
  ok: { variant: 'success', icon: Check },
  pause: { variant: 'muted', icon: Pause },
}

const VIRTUAL_FROM = 40

function groupLimit(state: OverviewState, phone: boolean) {
  if (phone) return 4
  return state === 'ok' ? 6 : 8
}

const OverviewRowItem = memo(function OverviewRowItem({ row, account }: { row: OverviewRow; account: Account | undefined }) {
  const chip = CHIP[row.state]
  const Icon = chip.icon
  return (
    <div
      data-theme-part="panel"
      data-testid="failover-overview-row"
      className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-[1.35rem] border border-border/45 bg-card/80 px-3 py-3 shadow-sm sm:gap-x-3 sm:px-4 md:flex-nowrap"
    >
      {account && <AccountAvatar account={account} size="md" />}
      <div className="min-w-0 flex-1 md:flex-none md:basis-[28%]">
        <p className="truncate text-sm font-semibold tracking-tight">{row.accountName}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {row.chain || 'No addons in the chain'}{row.moreRules > 0 ? ` · +${row.moreRules} more rule${row.moreRules === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      <Button asChild size="sm" variant="outline" className="h-8 gap-1 md:order-last">
        <Link to={`/account/${encodeURIComponent(row.accountId)}?tab=failover`} aria-label={`Open ${row.accountName} Autopilot`}>
          Open<ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
      <div className="flex min-w-0 basis-full items-center gap-2 text-sm md:flex-1 md:basis-0">
        <StatusChip variant={chip.variant} icon={<Icon aria-hidden="true" />} className="shrink-0">{OVERVIEW_STATE_LABEL[row.state]}</StatusChip>
        <span className="min-w-0 text-foreground/80 md:truncate" title={row.reason}>{row.reason}</span>
      </div>
    </div>
  )
})

function VirtualRows({ rows, accounts, phone }: { rows: readonly OverviewRow[]; accounts: Map<string, Account>; phone: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (phone ? 96 : 64),
    overscan: 8,
  })
  return (
    <div ref={scrollRef} className="max-h-[min(70dvh,40rem)] overflow-y-auto overscroll-contain" data-testid="failover-overview-virtual">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => (
          <div
            key={rows[item.index].accountId}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full pb-2"
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <OverviewRowItem row={rows[item.index]} account={accounts.get(rows[item.index].accountId)} />
          </div>
        ))}
      </div>
    </div>
  )
}

function OverviewGroup({ state, rows, accounts, phone, expanded, onToggle }: {
  state: OverviewState
  rows: readonly OverviewRow[]
  accounts: Map<string, Account>
  phone: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const limit = groupLimit(state, phone)
  const shown = expanded ? rows : rows.slice(0, limit)
  const virtual = expanded && rows.length > VIRTUAL_FROM
  const Icon = CHIP[state].icon
  return (
    <section aria-label={OVERVIEW_STATE_LABEL[state]} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold">{OVERVIEW_STATE_LABEL[state]}</h2>
        </div>
        <StatusChip variant="muted" className="shrink-0 rounded-lg bg-background/70 px-2 tabular-nums">{rows.length}</StatusChip>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing here.</p>}
      {virtual
        ? <VirtualRows rows={rows} accounts={accounts} phone={phone} />
        : <div className="flex flex-col gap-2">{shown.map(row => <OverviewRowItem key={row.accountId} row={row} account={accounts.get(row.accountId)} />)}</div>}
      {rows.length > limit && (
        <Button type="button" variant="outline" className="w-full" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Show fewer' : `Show all ${rows.length}`}
        </Button>
      )}
    </section>
  )
}

export function FailoverOverviewPage() {
  useDocumentTitle('Failover overview')
  const rules = useFailoverStore(s => s.rules)
  const accounts = useAccountStore(s => s.accounts)
  const lastCycle = useFailoverStore(s => s.lastCycle)
  const safeMode = useFailoverStore(s => s.safeMode)
  const workerEnabled = useFailoverStore(s => s.workerEnabled)
  const statePullFailed = useFailoverStore(s => s.statePullFailed)
  const statePullPartial = useFailoverStore(s => s.statePullPartial)
  const lastWorkerRun = useFailoverStore(s => s.lastWorkerRun)
  const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
  const phone = usePhoneViewport()
  const now = useNow()
  const firstSeenRef = useRef(new Map<string, number>())

  const rows = useMemo(() => {
    recordFirstSeen(firstSeenRef.current, rules, now)
    return buildFailoverOverview({
      rules, accounts, now, budgetHit: lastCycle?.budgetHit, firstSeen: firstSeenRef.current, safeMode,
      maskName: name => maskNameLevel(name, privacyLevel),
      platformLabel: id => getPlatformEntry(id)?.name ?? 'Connection',
    })
  }, [rules, accounts, now, lastCycle?.budgetHit, safeMode, privacyLevel])

  const accountById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts])
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [picked, setPicked] = useState<OverviewState | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<OverviewState>>(new Set())

  const matched = useMemo(() => rows.filter(row => matchesSearch(row, deferredQuery)), [rows, deferredQuery])
  const counts = useMemo(() => countByState(matched), [matched])
  const totals = useMemo(() => countByState(rows), [rows])
  const filter: OverviewState = picked ?? (totals.need + totals.bk > 0 ? 'need' : 'ok')
  const groups = filter === 'need' ? (['need', 'bk'] as const) : ([filter] as const)
  const byState = useMemo(() => {
    const grouped: Record<OverviewState, OverviewRow[]> = { need: [], bk: [], ok: [], pause: [] }
    for (const row of matched) grouped[row.state].push(row)
    return grouped
  }, [matched])

  const notice = workerEnabled === false ? { label: AUTOPILOT_WORKER_OFF_TITLE, detail: AUTOPILOT_WORKER_OFF_DETAIL }
    : safeMode ? { label: 'Autopilot paused', detail: AUTOPILOT_SAFE_MODE_DETAIL }
      : statePullFailed ? { label: AUTOPILOT_UNREACHABLE_DETAIL, detail: AUTOPILOT_UNREACHABLE_DETAIL }
        : statePullPartial ? { label: AUTOPILOT_PARTIAL_DETAIL, detail: AUTOPILOT_PARTIAL_DETAIL }
          : rows.length > 0 && !isAutopilotServerLive(lastWorkerRun, now) ? { label: 'Autopilot server is offline.', detail: 'Autopilot server is offline.' }
            : null

  const toggle = (state: OverviewState) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(state)) next.delete(state)
    else next.add(state)
    return next
  })

  return (
    <div className="space-y-6" data-testid="failover-overview">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="h-5 w-5" aria-hidden="true" />
          Failover overview
        </h1>
        {notice && (
          <Tooltip content={notice.detail} side="bottom">
            <StatusChip variant="warning" role="status">{notice.label}</StatusChip>
          </Tooltip>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="No Failover rules yet"
          description="Add a rule from an account's Autopilot tab."
        />
      ) : (
        <>
          <ToolbarShell contentClassName="gap-2 sm:gap-3">
            <div className="relative w-full min-w-0 sm:w-80 sm:flex-none">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search accounts or addons"
                placeholder="Search accounts or addons..."
                className="h-8 w-full border border-border/40 bg-muted/30 pl-9 pr-9 text-xs transition-colors focus:bg-muted/40"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 transition-colors hover:bg-accent">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            <div role="group" aria-label="Filter by state" data-theme-part="tabs-list" className="flex flex-wrap items-center gap-0.5 rounded-lg border border-border/40 bg-muted/50 p-0.5">
              {OVERVIEW_STATES.map(state => (
                <Button
                  key={state}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={filter === state}
                  data-theme-part="tab"
                  data-state={filter === state ? 'active' : 'inactive'}
                  onClick={() => setPicked(state)}
                  className={cn('h-8 gap-1.5 rounded-lg px-3', filter === state ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                >
                  {OVERVIEW_STATE_LABEL[state]}
                  <span className="tabular-nums">{counts[state]}</span>
                </Button>
              ))}
            </div>
          </ToolbarShell>

          <div className="space-y-6">
            {groups.map(state => (
              <OverviewGroup
                key={state}
                state={state}
                rows={byState[state]}
                accounts={accountById}
                phone={phone}
                expanded={expanded.has(state)}
                onToggle={() => toggle(state)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
