/**
 * Shared presentational pieces for the Dashboard screens, built only from the
 * app's real tokens and panel/badge/card patterns (Metrics cards, Settings
 * panels, the pill nav). No new palette.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ChevronRight, Loader2, ShieldCheck, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusChip } from '@/components/ui/status-chip'
import { Button } from '@/components/ui/button'
import type { GuaranteeEntry, MetricCardView, MetricsRequestsView, MetricsInfo, Tone } from '@/api/admin'
import type { WorkerFreshnessRow } from '@/lib/admin-metrics'

/**
 * Metrics query state the panes pass into the screens. The screens never
 * depend on the metrics read succeeding: undefined data renders a quiet
 * loading or unavailable note and the rest of the screen keeps working.
 */
export interface MetricsPane {
    data: MetricsInfo | undefined
    error: unknown
    retry: () => void
    retrying: boolean
}

export function PaneLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading
    </div>
  )
}

/** A failed load: the message, a manual Retry while retrying makes sense, and optional extra actions. */
export function PaneError({ message, onRetry, retrying, children }: { message: string; onRetry?: () => void; retrying?: boolean; children?: ReactNode }) {
  return (
    <div className="py-16 text-center" role="alert">
      <p className="text-sm text-muted-foreground">{message}</p>
      {(onRetry || children) && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Retrying' : 'Retry'}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

/** Above cached content after a failed refresh: the data stays, with a quiet note and Retry. */
export function StaleNotice({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="status" data-stale-notice className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{message}</span>
      <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying' : 'Retry'}
      </Button>
    </div>
  )
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
  info: 'text-info',
}

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  info: 'bg-info',
}

const TONE_CHIP: Record<Tone, 'success' | 'warning' | 'destructive' | 'primary'> = {
  ok: 'success',
  warn: 'warning',
  bad: 'destructive',
  info: 'primary',
}

/** Tables and lists sit on the same surface as the app's own list rows. */
export const TABLE_SURFACE = 'overflow-hidden rounded-2xl border border-border/45 bg-card shadow-sm'
export const TABLE_HEAD = 'border-b border-border/40 bg-foreground/[0.025] text-xs font-medium text-muted-foreground'
export const TABLE_ROW = 'border-b border-border/40 text-xs text-foreground/80 transition-colors last:border-b-0 hover:bg-foreground/[0.035]'

// The acct- handle is the stable, non-reversible label the server provides:
// show it in full everywhere (rows, aria-labels, detail, dialogs).

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-theme-part="panel" className={cn('rounded-[1.75rem] border border-border/45 bg-card/80 p-4 shadow-sm sm:p-5', className)}>
      {children}
    </div>
  )
}

export function PanelHead({ icon, title, detail, actions }: { icon: ReactNode; title: string; detail?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <div className="min-w-[12rem] flex-1">
        <h3 className="text-sm font-semibold sm:text-base">{title}</h3>
        {detail && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Kpi({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <div data-theme-part="panel" className="min-w-0 rounded-2xl border border-border/45 bg-card/80 p-3.5 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn('mt-1.5 truncate text-2xl font-bold tabular-nums tracking-tight', tone && TONE_TEXT[tone])}>{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>
    </div>
  )
}

export function SignalRow({ tone, title, detail, action }: { tone: Tone; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-t border-border/30 py-2.5 first:border-t-0 first:pt-0">
      <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-snug">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</div>
      </div>
      {action && <div className="flex shrink-0 items-center">{action}</div>}
    </div>
  )
}

export function HBar({ label, pct, value, tone }: { label: string; pct: number | null; value: string; tone?: Tone }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 py-1.5">
      <span className="w-40 shrink-0 basis-40 text-xs leading-tight text-muted-foreground">{label}</span>
      <span className="h-1.5 min-w-10 flex-1 basis-24 overflow-hidden rounded-full bg-muted/60">
        <i
          className={cn('block h-full rounded-full', tone ? TONE_DOT[tone] : 'bg-foreground/35')}
          style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
        />
      </span>
      <span className="max-w-full flex-1 basis-24 text-right text-xs text-foreground/80">{value}</span>
    </div>
  )
}

export function MiniBars({ values, className, ariaLabel, tone, compact }: { values: number[]; className?: string; ariaLabel?: string; tone?: Tone; compact?: boolean }) {
  if (values.length === 0) return null
  const max = Math.max(...values, 1)
  return (
    <div
      className={cn('flex items-end', compact ? 'h-9 gap-[2px]' : 'h-16 gap-[3px]', className)}
      role="img"
      aria-label={ariaLabel ?? 'Recent samples'}
    >
      {values.map((v, i) => (
        <i
          key={i}
          className={cn(
            'flex-1 rounded-t-md',
            compact ? 'min-h-[2px]' : 'min-h-[4px]',
            i === values.length - 1 ? (tone ? TONE_DOT[tone] : 'bg-primary') : 'bg-foreground/15',
          )}
          style={{ height: `${Math.max(5, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

/** One host metric card with its 60 minute sparkline; the tone colors the newest bar. */
export function MetricCard({ label, value, detail, note, tone, spark }: { label: string; value: string; detail: string; note?: string; tone?: Tone; spark?: { values: number[]; ariaLabel: string } | null }) {
  return (
    <div data-theme-part="panel" className="min-w-0 rounded-2xl border border-border/45 bg-card/80 p-3.5 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn('mt-1.5 truncate text-2xl font-bold tabular-nums tracking-tight', tone && TONE_TEXT[tone])}>{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>
      {note && <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80" title={note}>{note}</div>}
      {spark && spark.values.length > 0 && <MiniBars values={spark.values} ariaLabel={spark.ariaLabel} tone={tone} compact className="mt-2.5" />}
    </div>
  )
}

/** The six host and storage cards, the same row on Overview and System. */
export function MetricCards({ cards }: { cards: MetricCardView[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map(c => <MetricCard key={c.id} label={c.label} value={c.value} detail={c.detail} note={c.note} tone={c.tone} spark={c.spark} />)}
    </div>
  )
}

/** Quiet metrics-outage note with Retry; the rest of the screen keeps working. */
export function MetricsUnavailableNote({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 basis-64">{message}</span>
      <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying' : 'Retry'}
      </Button>
    </div>
  )
}

/** Per-minute request and error counts for the same window as the sparklines. */
export function MetricsRequestsPanel({ requests }: { requests: MetricsRequestsView }) {
  return (
    <Panel>
      <PanelHead icon={<Activity />} title="Requests and errors" detail="Per-minute counts for the same 60-minute window." />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-muted-foreground">Requests</span>
            <span className="font-semibold tabular-nums">{requests.totalLabel}</span>
          </div>
          <MiniBars values={requests.reqBars} ariaLabel={requests.reqAria} compact />
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-muted-foreground">Errors</span>
            <span className={cn('font-semibold tabular-nums', requests.errorTone && TONE_TEXT[requests.errorTone])}>{requests.errorsLabel}</span>
          </div>
          <MiniBars values={requests.errBars} ariaLabel={requests.errAria} tone={requests.errorTone} compact />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 basis-64">{requests.note}</span>
        {requests.showLogLink && <OpenSectionLink section="logs" label="Open Logs" />}
      </div>
    </Panel>
  )
}

/** Background worker freshness rows, each with an Open link to its screen. */
export function MetricsWorkersPanel({ rows }: { rows: WorkerFreshnessRow[] }) {
  return (
    <Panel>
      <PanelHead icon={<Zap />} title="Worker freshness" detail="The last cycle each background worker completed." />
      <div>
        {rows.map(r => (
          <SignalRow key={r.id} tone={r.tone} title={r.title} detail={r.detail} action={<OpenSectionLink section={r.section} />} />
        ))}
      </div>
    </Panel>
  )
}

export function LegendNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground/80', className)}>
      {children}
    </div>
  )
}

export function Chip({ tone, icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return <StatusChip variant={tone ? TONE_CHIP[tone] : 'muted'} size="sm" icon={icon}>{children}</StatusChip>
}

export function ScreenHeader({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}

export function Callout({ tone, title, children, className }: { tone: Tone | 'neutral'; title?: string; children: ReactNode; className?: string }) {
  const border = tone === 'warn' ? 'border-warning/25 bg-warning/5'
    : tone === 'bad' ? 'border-destructive/25 bg-destructive/10'
    : tone === 'ok' ? 'border-success/25 bg-success/5'
    : 'border-border/40 bg-muted/20'
  return (
    <div className={cn('rounded-2xl border p-3.5', border, className)}>
      {title && <div className={cn('text-[13px] font-semibold', tone === 'bad' && 'text-destructive')}>{title}</div>}
      <div className="mt-1 space-y-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

/** The binding guarantees, stated the same way on Overview. */
export function GuaranteesPanel({ guarantees }: { guarantees: GuaranteeEntry[] }) {
  return (
    <Panel>
      <PanelHead
        icon={<ShieldCheck />}
        title="What the dashboard can never do"
        detail="Binding on every screen and enforced in server code on every dashboard route, not by convention. Stated to users in the same words."
        actions={<Chip tone="ok" icon={<ShieldCheck className="h-3 w-3" />}>By design</Chip>}
      />
      <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
        {guarantees.map(g => (
          <SignalRow key={g.title} tone="ok" title={g.title} detail={g.detail} />
        ))}
      </div>
    </Panel>
  )
}

/** Link styled like the mockup's small "Open" affordance on signal rows. */
export function OpenSectionLink({ section, label }: { section: string; label?: string }) {
  return (
    <Link
      to={`/dashboard/${section}`}
      className="inline-flex min-h-10 items-center gap-0.5 rounded-lg border border-border/40 px-2.5 text-xs font-semibold text-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
    >
      {label ?? 'Open'}
      <ChevronRight className="h-3 w-3" aria-hidden />
    </Link>
  )
}

/** Account status chip: active, disabled, or deleted. */
export function StatusBadge({ status }: { status: 'active' | 'disabled' | 'deleted' }) {
  if (status === 'active') return <Chip tone="ok">active</Chip>
  if (status === 'disabled') return <Chip tone="warn">disabled</Chip>
  return <Chip tone="bad">deleted</Chip>
}
