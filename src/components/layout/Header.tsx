import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useMemo, useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { preloadRouteChunk } from '@/routes'
import { useTheme } from '@/contexts/ThemeContext'
import { BrandLogo } from '@/components/common/BrandLogo'
import { useSyncStore } from '@/store/syncStore'
import { useFailoverStore, type FailoverRule } from '@/store/failoverStore'
import { LogOut, Users, Package, Activity, BarChart3, Settings, HelpCircle, KeyRound, StickyNote, MoreHorizontal, X, Search, CloudOff, RefreshCw, Cloud, Zap, ZapOff, AlertTriangle, Check, Eye, EyeOff } from 'lucide-react'
import { PriorityPillNav } from '@/components/ui/priority-nav'
import { useAccountStore, getAccountEmail } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { useAddonStore } from '@/store/addonStore'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDistanceToNow } from '@/lib/format-distance-to-now'
import { cn, maskNameLevel, maskedInitial } from '@/lib/utils'
import { VaultKeysMenu, useHeaderVaultRows } from '@/components/layout/VaultKeysMenu'
import { InboxBell } from '@/components/layout/NotificationInbox'
import { OfflineBanner } from '@/components/layout/OfflineBanner'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { getAllPendingPush, subscribePendingPush } from '@/lib/sync/pending-push'
import { resolveSyncHeaderState, summarizeSyncFailures, syncFailureHeadline, type SyncFailure } from '@/lib/sync/pending-summary'
import type { Account } from '@/types/account'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { syncPendingAndCloud } from '@/lib/sync-now'
import { DashboardNav } from '@/components/admin/DashboardNav'
import { useAdminStatusCache, isDashboardReady } from '@/components/admin/useAdminStatus'
import {
  AUTOPILOT_FIX_DETAIL, AUTOPILOT_PARTIAL_DETAIL, AUTOPILOT_SAFE_MODE_DETAIL, AUTOPILOT_UNREACHABLE_DETAIL, AUTOPILOT_WORKER_OFF_DETAIL, AUTOPILOT_WORKER_OFF_TITLE, autopilotAttention, ruleConflictDetail, isAutopilotServerLive, isAutopilotWarning, liveAccountCheck, recordFirstSeen, resolveAutopilotChip,
  type AutopilotChipStatus, type AutopilotRuleFix, type AutopilotSafeMode,
} from '@/lib/autopilot-freshness'
import { AutopilotRuleFixAction } from '@/components/accounts/RuleConfidenceLayer'
import { useNow } from '@/hooks/use-relative-time'
import { preloadCommandPalette } from '@/components/LazyCommandPalette'
import { useServerRuleResidue } from '@/hooks/useServerRuleResidue'
import { apiFetch } from '@/lib/http-client'

const PRIMARY_NAV = [
  { to: '/', icon: Users, label: 'Accounts', match: (p: string) => p === '/' || p.startsWith('/account/') },
  { to: '/saved-addons', icon: Package, label: 'Addons', match: (p: string) => p === '/saved-addons' },
  { to: '/activity', icon: Activity, label: 'Activity', match: (p: string) => p === '/activity' },
  { to: '/vault', icon: KeyRound, label: 'Vault', match: (p: string) => p === '/vault' || p.startsWith('/vault/') },
]

const MORE_NAV = [
  { to: '/notes', icon: StickyNote, label: 'Notes', match: (p: string) => p === '/notes' },
  { to: '/metrics', icon: BarChart3, label: 'Metrics', match: (p: string) => p === '/metrics' },
  { to: '/replay', icon: null, label: 'Replay', match: (p: string) => p === '/replay' },
  { to: '/kronorium', icon: HelpCircle, label: 'Docs', match: (p: string) => p.startsWith('/kronorium') },
  { to: '/settings', icon: Settings, label: 'Settings', match: (p: string) => p === '/settings' },
]

interface MobileMoreTriggerProps {
  moreOpen: boolean
  setMoreOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  isMoreActive: boolean
}

function MobileMoreTrigger({ moreOpen, setMoreOpen, isMoreActive }: MobileMoreTriggerProps) {
  return (
    <button
      data-theme-part="nav-item"
      data-state={isMoreActive || moreOpen ? 'active' : 'inactive'}
      aria-expanded={moreOpen}
      onClick={() => setMoreOpen(v => !v)}
      className={`relative flex flex-col items-center justify-center pt-3 pb-1 px-1 w-full transition-colors ${isMoreActive || moreOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
      aria-label="More options"
    >
      <AnimatePresence>
        {isMoreActive && !moreOpen && (
          <motion.div
            layoutId="mobile-nav-dot"
            className="absolute top-1 w-1 h-1 rounded-full bg-primary"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          />
        )}
      </AnimatePresence>
      <MoreHorizontal className="h-5 w-5 mb-0.5" />
      <span className="text-xs font-medium tracking-tight">More</span>
    </button>
  )
}

export function MobileBottomNav() {
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const isMoreActive = MORE_NAV.some(item => item.match(location.pathname))
  const barRef = useRef<HTMLDivElement>(null)

  // The More sheet anchors to this bar's border-box height so taller themed bars and safe-area padding never overlap it.
  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const root = document.documentElement
    const syncBarHeight = () => {
      const h = el.getBoundingClientRect().height
      if (h > 0) root.style.setProperty('--aioman-tabbar-height', `${Math.ceil(h)}px`)
    }
    syncBarHeight()
    const observer = new ResizeObserver(syncBarHeight)
    observer.observe(el, { box: 'border-box' })
    return () => {
      observer.disconnect()
      root.style.removeProperty('--aioman-tabbar-height')
    }
  }, [])

  return (
    <div ref={barRef} data-theme-part="mobile-nav" className="md:hidden flex-shrink-0 relative z-50 bg-card/95 backdrop-blur-lg border-t border-border/40 flex items-center justify-around min-h-[80px] pb-[calc(env(safe-area-inset-bottom,0px)+10px)] shadow-[0_-10px_40px_hsl(var(--background)/0.8)]">
      {PRIMARY_NAV.map((item) => {
        const isActive = item.match(location.pathname)
        const Icon = item.icon
        return (
          <Link
            data-theme-part="nav-item"
            data-state={isActive ? 'active' : 'inactive'}
            aria-current={isActive ? 'page' : undefined}
            key={item.to}
            to={item.to}
            onPointerEnter={() => preloadRouteChunk(item.to)}
            onFocus={() => preloadRouteChunk(item.to)}
            onTouchStart={() => preloadRouteChunk(item.to)}
            className={`relative flex flex-col items-center justify-center pt-3 pb-1 px-1 w-full transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <AnimatePresence>
              {isActive && (
                <motion.div
                  layoutId="mobile-nav-dot-bottom"
                  className="absolute top-1 w-1 h-1 rounded-full bg-primary"
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                />
              )}
            </AnimatePresence>
            <Icon className="h-5 w-5 mb-0.5" />
            <span className="text-xs font-medium tracking-tight">{item.label}</span>
          </Link>
        )
      })}
      <MobileMoreTrigger moreOpen={moreOpen} setMoreOpen={setMoreOpen} isMoreActive={isMoreActive} />

      {createPortal(
        <AnimatePresence>
          {moreOpen && (
            <>
              <motion.div
                data-theme-part="dialog-overlay"
                data-theme-overlay=""
                className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setMoreOpen(false)}
              />
              <motion.div
                data-theme-part="menu"
                data-theme-overlay=""
                className="fixed left-0 right-0 z-40 bg-card/95 backdrop-blur-lg rounded-t-3xl border border-b-0 border-border/40 shadow-[0_-10px_40px_hsl(var(--background)/0.8)]"
                style={{ bottom: 'var(--aioman-tabbar-height, 80px)' }}
                initial={{ y: 420 }}
                animate={{ y: 0 }}
                exit={{ y: 420 }}
                transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              >
                <div className="flex items-center justify-between px-5 pt-5 pb-3">
                    <span className="text-xs font-medium uppercase text-foreground/60">More</span>
                    <Button variant="ghost" onClick={() => setMoreOpen(false)} className="h-10 w-10 p-1 text-muted-foreground/60 hover:text-foreground" aria-label="Close menu">
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                <div className="grid grid-cols-3 gap-3 px-4 pb-6">
                    {MORE_NAV.map((item) => {
                        const isActive = item.match(location.pathname)
                        const Icon = item.icon
                        return (
                            <Link
                                data-theme-part="nav-item"
                                data-state={isActive ? 'active' : 'inactive'}
                                aria-current={isActive ? 'page' : undefined}
                                key={item.to}
                                to={item.to}
                                onClick={() => setMoreOpen(false)}
                                onPointerEnter={() => preloadRouteChunk(item.to)}
                                onFocus={() => preloadRouteChunk(item.to)}
                                onTouchStart={() => preloadRouteChunk(item.to)}
                                className={`flex flex-col items-center justify-center py-5 px-3 rounded-2xl transition-colors gap-2.5 ${isActive ? 'bg-primary/12 text-primary' : 'text-foreground/70 hover:bg-muted/50 hover:text-foreground'}`}
                            >
                                {item.to === '/replay' ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="m11 19-9-7 9-7v14z" opacity="0.5" />
                                        <path d="m22 19-9-7 9-7v14z" />
                                    </svg>
                                ) : (
                                    Icon && <Icon className="h-6 w-6" />
                                )}
                                <span className="text-sm font-bold">{item.label}</span>
                            </Link>
                    )
                  })}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}

const NAV_ITEMS = [
  { id: 'accounts', to: '/', icon: Users, label: 'Accounts', badge: 'count' as const, match: (p: string) => p === '/' || p.startsWith('/account/') },
  { id: 'addons', to: '/saved-addons', icon: Package, label: 'Addons', badge: 'count' as const, match: (p: string) => p === '/saved-addons' },
  { id: 'notes', to: '/notes', icon: StickyNote, label: 'Notes', match: (p: string) => p === '/notes' },
  { id: 'vault', to: '/vault', icon: KeyRound, label: 'Vault', match: (p: string) => p === '/vault' || p.startsWith('/vault/') },
  { id: 'activity', to: '/activity', icon: Activity, label: 'Activity', match: (p: string) => p === '/activity' },
  { id: 'metrics', to: '/metrics', icon: BarChart3, label: 'Metrics', match: (p: string) => p === '/metrics' },
  { id: 'replay', to: '/replay', icon: null, label: 'Replay', match: (p: string) => p === '/replay' },
  { id: 'docs', to: '/kronorium', icon: HelpCircle, label: 'Docs', match: (p: string) => p.startsWith('/kronorium') },
  { id: 'settings', to: '/settings', icon: Settings, label: 'Settings', match: (p: string) => p === '/settings' },
]

function NavIcon({ item, active, animated = true, className = 'h-[15px] w-[15px]' }: { item: typeof NAV_ITEMS[number]; active: boolean; animated?: boolean; className?: string }) {
  if (item.to === '/replay') {
    if (!animated) {
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m11 19-9-7 9-7v14z" opacity="0.5" />
          <path d="m22 19-9-7 9-7v14z" />
        </svg>
      )
    }
    return (
      <motion.div initial="initial" animate="animate" className="flex items-center justify-center">
        <motion.svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <motion.path d="m11 19-9-7 9-7v14z" variants={{ initial: { opacity: 0.4 }, animate: { opacity: [0.4, 1, 0.4], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
          <motion.path d="m22 19-9-7 9-7v14z" variants={{ initial: { opacity: 1 }, animate: { opacity: [1, 0.4, 1], transition: { repeat: Infinity, duration: 1.5, ease: 'linear' } } }} />
        </motion.svg>
      </motion.div>
    )
  }
  const Icon = item.icon
  return Icon ? <Icon className={className} strokeWidth={active ? 2.2 : 1.7} /> : null
}

function PrivacyModeButton({ pressed, onToggle, className, iconClassName, segment }: {
  pressed: boolean
  onToggle: () => void
  className: string
  iconClassName: string
  segment?: string
}) {
  return (
    <Tooltip content="Mask personal details" side="bottom">
      <button
        type="button"
        data-theme-part="button"
        data-variant="ghost"
        data-theme-segment={segment}
        onClick={onToggle}
        aria-pressed={pressed}
        aria-label="Privacy mode"
        className={cn(
          'transition-colors text-muted-foreground hover:bg-muted/20 hover:text-foreground',
          !segment && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          className
        )}
      >
        <span className={cn('relative inline-flex items-center justify-center', iconClassName)}>
          <Eye
            aria-hidden
            className={cn(
              'absolute h-full w-full transition-[opacity,transform] duration-200 motion-reduce:transition-none',
              pressed ? 'rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100',
            )}
          />
          <EyeOff
            aria-hidden
            className={cn(
              'absolute h-full w-full transition-[opacity,transform] duration-200 motion-reduce:transition-none',
              pressed ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-50 opacity-0',
            )}
          />
        </span>
      </button>
    </Tooltip>
  )
}

function TabBadge({ count, dotColor, isActive, glow }: { count?: number; dotColor?: string; isActive: boolean; glow?: boolean }) {
  const { isLight } = useTheme()
  if (count !== undefined) {
    return (
      <span data-theme-part="badge" className={cn(
        'ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 text-xs font-semibold tabular-nums',
        isLight
          ? (isActive || glow ? 'bg-muted text-foreground' : 'bg-muted/60 text-muted-foreground')
          : (isActive || glow ? 'bg-white/[0.10] text-foreground' : 'bg-white/[0.06] text-muted-foreground')
      )}>{count}</span>
    )
  }
  if (dotColor) {
    return <span className="ml-0.5 w-1.5 h-1.5 rounded-full" style={{ background: dotColor }} />
  }
  return null
}

const SYNC_STATE_LABEL: Record<string, string> = {
  offline: 'Offline',
  syncing: 'Syncing',
  refreshing: 'Refreshing from cloud',
  error: 'Last sync failed',
  idle: 'Not synced yet',
  synced: 'Up to date',
}

const formatSyncTime = (iso: string | null) => {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return `${formatDistanceToNow(d, { addSuffix: true })} (${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
}

const LIVE_LABELS = new Set(['Offline', 'Syncing', 'Refreshing'])

function compactSyncLabel(label: string, at: number | null): string {
  if (LIVE_LABELS.has(label) || at === null) return label
  const mins = Math.floor((Date.now() - at) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

interface SyncStatusDetailsProps {
  state: string
  isAuthenticated: boolean
  busy: boolean
  lastSyncedAt: string | null
  lastCheckedAt: string | null
  errorMessage: string | null
  failures: readonly SyncFailure[]
  onSyncNow: () => Promise<unknown>
}

const SYNC_FAILURES_SHOWN = 20

export const SYNC_POPOVER_CLASS = 'flex w-[min(20rem,92vw)] max-h-[var(--radix-popover-content-available-height,80vh)] flex-col gap-3 overflow-hidden p-4'

const AUTOPILOT_DETAIL: Record<AutopilotChipStatus, string> = {
  Offline: 'Autopilot server is offline.',
  Standby: 'No rules configured.',
  Live: 'Monitoring active rules.',
  Paused: 'All rules are paused.',
  Stale: 'Server is up, but no rule has been checked recently.',
  Failing: "A rule's last check failed. Open the account's Autopilot tab to see why.",
}

/** One derivation for the header Autopilot segment: a turned-off worker outranks any heartbeat status. */
export function autopilotSegmentContent({ status, safeMode, workerEnabled, activeCount }: { status: AutopilotChipStatus; safeMode: boolean; workerEnabled: boolean; activeCount: number }) {
  const workerOff = workerEnabled === false
  const alert = !workerOff && (isAutopilotWarning(status) || safeMode)
  return {
    dataStatus: workerOff ? 'off' : status.toLowerCase(),
    ping: !workerOff && status === 'Live',
    icon: alert ? 'alert' : !workerOff && status === 'Live' ? 'zap' : 'zap-off',
    label: workerOff ? 'Off' : safeMode ? 'Paused' : status === 'Live' ? activeCount : isAutopilotWarning(status) ? status : status === 'Offline' ? 'Off' : status.charAt(0),
    highlight: !workerOff && (status === 'Live' || isAutopilotWarning(status) || safeMode),
  }
}

interface AutopilotAttentionRow { rule: FailoverRule; fix: AutopilotRuleFix; accountName: string; onRemove?: () => Promise<void> }

const ATTENTION_SHOWN = 5

function AutopilotAttentionList({ rows }: { rows: readonly AutopilotAttentionRow[] }) {
  if (rows.length === 0) return null
  const hidden = rows.length - ATTENTION_SHOWN
  return (
    <div className="space-y-1.5" data-testid="autopilot-attention">
      <ul className="max-h-64 space-y-1.5 overflow-y-auto overscroll-contain">
        {rows.slice(0, ATTENTION_SHOWN).map(({ rule, fix, accountName, onRemove }) => (
          <li key={rule.id} className="min-w-0 space-y-1 rounded-md border border-border/40 bg-background/40 p-2 text-xs">
            <p className="truncate font-medium text-foreground/80">{rule.name || 'Autopilot rule'} <span className="font-normal text-muted-foreground">· {accountName}</span></p>
            <p className="break-words text-muted-foreground">{ruleConflictDetail(rule) || AUTOPILOT_FIX_DETAIL[fix]}</p>
            <AutopilotRuleFixAction rule={rule} fix={fix} onRemove={onRemove} className="flex flex-col items-stretch gap-1" />
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-xs text-muted-foreground">and {hidden} more rule{hidden !== 1 ? 's' : ''}</p>}
    </div>
  )
}

function AutopilotStatusDetails({ status, activeCount, staleCount = 0, uncheckedCount = 0, errorCount = 0, notMonitoredCount = 0, safeMode = null, checkedAt, onRefresh, attention = [], pullFailed = false, pullPartial = false, workerEnabled = true, hasRules = false }: { status: AutopilotChipStatus; activeCount: number; staleCount?: number; uncheckedCount?: number; errorCount?: number; notMonitoredCount?: number; safeMode?: AutopilotSafeMode | null; checkedAt: number | null; onRefresh: () => Promise<void>; attention?: readonly AutopilotAttentionRow[]; pullFailed?: boolean; pullPartial?: boolean; workerEnabled?: boolean; hasRules?: boolean }) {
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    if (busy) return
    setBusy(true)
    try { await onRefresh() } catch { /* surfaced by the store */ } finally { setBusy(false) }
  }
  const workerOff = workerEnabled === false
  const Icon = workerOff ? ZapOff : isAutopilotWarning(status) || safeMode ? AlertTriangle : status === 'Live' ? Zap : ZapOff
  return (
    <div className="space-y-3" data-testid="autopilot-popover">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Autopilot</span>
        <span className={cn('flex items-center gap-1 text-xs font-bold', workerOff ? 'text-foreground' : isAutopilotWarning(status) || status === 'Live' || safeMode ? 'text-warning' : 'text-foreground')} role="status">
          <Icon className="h-3 w-3" aria-hidden="true" />
          {workerOff ? AUTOPILOT_WORKER_OFF_TITLE : status}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{workerOff ? AUTOPILOT_WORKER_OFF_DETAIL : safeMode ? AUTOPILOT_SAFE_MODE_DETAIL : status === 'Offline' && pullFailed ? AUTOPILOT_UNREACHABLE_DETAIL : pullPartial ? AUTOPILOT_PARTIAL_DETAIL : AUTOPILOT_DETAIL[status]}</p>
      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Active rules</dt>
          <dd className="text-right text-foreground/80">{activeCount}</dd>
        </div>
        {safeMode && safeMode.since !== null && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Paused since</dt>
            <dd className="text-right text-foreground/80">{formatDistanceToNow(new Date(safeMode.since), { addSuffix: true })} ({new Date(safeMode.since).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})</dd>
          </div>
        )}
        {staleCount > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Not checked recently</dt>
            <dd className="text-right text-warning">{staleCount} of {activeCount}</dd>
          </div>
        )}
        {uncheckedCount > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Not checked yet</dt>
            <dd className="text-right text-warning">{uncheckedCount} of {activeCount}</dd>
          </div>
        )}
        {notMonitoredCount > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Not monitored</dt>
            <dd className="text-right text-warning">{notMonitoredCount} of {activeCount}</dd>
          </div>
        )}
        {errorCount > 0 && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Last check failed</dt>
            <dd className="text-right text-warning">{errorCount} of {activeCount}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="text-right text-foreground/80">{checkedAt ? `${formatDistanceToNow(new Date(checkedAt), { addSuffix: true })} (${new Date(checkedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})` : 'Never'}</dd>
        </div>
      </dl>
      <AutopilotAttentionList rows={attention} />
      {hasRules && (
        <PopoverClose asChild>
          <Button asChild size="sm" className="w-full">
            <Link to="/failover">Open Failover overview</Link>
          </Button>
        </PopoverClose>
      )}
      <Button size="sm" variant="outline" className="w-full" disabled={busy} onClick={refresh}>
        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {busy ? 'Refreshing...' : 'Refresh status'}
      </Button>
    </div>
  )
}

function useSyncFailures(privacyLevel: number): SyncFailure[] {
  const accounts = useAccountStore(s => s.accounts)
  const entries = useSyncExternalStore(subscribePendingPush, getAllPendingPush)
  return useMemo(() => {
    const names = new Map(accounts.map(a => [a.id, maskNameLevel(a.name || getAccountEmail(a) || 'Unnamed account', privacyLevel)]))
    const errors = new Map(accounts.filter(a => a.status === 'error').map(a => [a.id, a.lastError]))
    return summarizeSyncFailures(entries, names, errors)
  }, [accounts, privacyLevel, entries])
}

function SyncFailureRow({ failure, account }: { failure: SyncFailure; account: Account | undefined }) {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const retry = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await useAccountStore.getState().syncAccount(failure.accountId, true, 'user')
    } catch {
      // failures surface through sync history
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [failure.accountId])
  return (
    <li className="flex min-w-0 items-start gap-1.5" data-testid="sync-failure-row">
      {account && <AccountAvatar account={account} size="xs" showStatus={false} />}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground/80">{failure.name}</p>
        {failure.causes.map(cause => <p key={cause} className="break-words text-muted-foreground">{cause}</p>)}
      </div>
      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" disabled={busy} onClick={retry}>
        {busy ? 'Retrying...' : 'Retry'}
      </Button>
    </li>
  )
}

function SyncFailures({ failures }: { failures: readonly SyncFailure[] }) {
  const accounts = useAccountStore(s => s.accounts)
  const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  if (failures.length === 0) return null
  const hidden = failures.length - SYNC_FAILURES_SHOWN
  return (
    <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs" data-testid="sync-failures">
      <p className="font-semibold text-destructive">{syncFailureHeadline(failures.length)}</p>
      <ul className="space-y-2">
        {failures.slice(0, SYNC_FAILURES_SHOWN).map(f => (
          <SyncFailureRow key={f.accountId} failure={f} account={accountById.get(f.accountId)} />
        ))}
      </ul>
      {hidden > 0 && <p className="text-muted-foreground">and {hidden} more account{hidden !== 1 ? 's' : ''}</p>}
    </div>
  )
}

function SyncStatusDetails({ state, isAuthenticated, busy, lastSyncedAt, lastCheckedAt, errorMessage, failures, onSyncNow }: SyncStatusDetailsProps) {
  const [pushing, setPushing] = useState(false)
  const inFlight = useRef(false)

  const handleSyncNow = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setPushing(true)
    try {
      await onSyncNow()
    } catch {
      // failures surface through sync history
    } finally {
      inFlight.current = false
      setPushing(false)
    }
  }, [onSyncNow])

  return (
    <>
      <div className="shrink-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Sync status</span>
        <span className="text-xs font-bold text-foreground" role="status">{SYNC_STATE_LABEL[state] ?? state}</span>
      </div>
      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd className="text-right text-foreground/80">{formatSyncTime(lastSyncedAt)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="text-right text-foreground/80">{formatSyncTime(lastCheckedAt)}</dd>
        </div>
      </dl>
      </div>
      <div data-testid="sync-popover-scroll" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
      {errorMessage && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive break-words">{errorMessage}</p>
      )}
      <SyncFailures failures={failures} />
      </div>
      <div className="shrink-0 space-y-2">
      <Button
        size="sm"
        className="w-full shrink-0"
        onClick={handleSyncNow}
        disabled={!isAuthenticated || busy || pushing}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', (busy || pushing) && 'animate-spin')} />
        {busy || pushing ? 'Syncing...' : 'Sync now'}
      </Button>
      </div>
    </>
  )
}

export function Header() {
  const location = useLocation()
  const navigate = useNavigate()
  const { isLight, logoUrl } = useTheme()
  // Pills only when the cached dashboard status resolves to a signed-in
  // dashboard; otherwise (off, unprovisioned, signed out) the normal app nav.
  const adminStatus = useAdminStatusCache()
  const dashboardReady = isDashboardReady(adminStatus)
  const onDashboardRoute = location.pathname === '/dashboard' || location.pathname.startsWith('/dashboard/')
  const showDashboardNav = onDashboardRoute && dashboardReady
  const auth = useSyncStore(s => s.auth)
  const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
  const logout = useSyncStore(s => s.logout)
  const isSyncing = useSyncStore(s => s.isSyncing)
  const isRefreshingFromCloud = useSyncStore(s => s.isRefreshingFromCloud)
  const lastSyncedAt = useSyncStore(s => s.lastSyncedAt)
  const lastSyncCheckedAt = useSyncStore(s => s.lastSyncCheckedAt)
  const syncHistory = useSyncStore(s => s.history)
  const syncToRemote = useSyncStore(s => s.syncToRemote)
  const rules = useFailoverStore(s => s.rules)
  const lastWorkerRun = useFailoverStore(s => s.lastWorkerRun)

  const accounts = useAccountStore(s => s.accounts)
  const library = useAddonStore(s => s.library)
  const privacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
  const togglePrivacyMode = useUIStore(s => s.togglePrivacyMode)

  const handleSyncNow = useCallback(() => {
    const { accounts: current, syncAccount } = useAccountStore.getState()
    return syncPendingAndCloud({
      pendingAccountIds: getAllPendingPush().map(([id]) => id),
      knownAccountIds: new Set(current.map(a => a.id)),
      syncAccount,
      syncToRemote: () => syncToRemote(false),
    })
  }, [syncToRemote])

  const activeRulesCount = useMemo(() => rules.filter(r => r.isActive).length, [rules])
  const hasRules = useMemo(() => rules.length > 0, [rules])
  const lastCycle = useFailoverStore(s => s.lastCycle)
  const pullServerState = useFailoverStore(s => s.pullServerState)
  const autopilotSafeMode = useFailoverStore(s => s.safeMode)
  const statePullFailed = useFailoverStore(s => s.statePullFailed)
  const statePullPartial = useFailoverStore(s => s.statePullPartial)
  const pulseUnreachable = useFailoverStore(s => s.pulseUnreachable)
  const autopilotWorkerEnabled = useFailoverStore(s => s.workerEnabled)
  const lastCompletePullAt = useFailoverStore(s => s.lastCompletePullAt)
  const now = useNow()
  const firstSeenRef = useRef(new Map<string, number>())
  const isServerLive = useMemo(() => isAutopilotServerLive(lastWorkerRun, now), [lastWorkerRun, now])

  const {
    status: autopilotStatus, lastCheckedAt: autopilotCheckedAt, staleCount: autopilotStaleCount,
    uncheckedCount: autopilotUncheckedCount, errorCount: autopilotErrorCount, notMonitoredCount: autopilotNotMonitoredCount, safeMode: activeSafeMode,
  } = useMemo(() => {
    recordFirstSeen(firstSeenRef.current, rules, now)
    return resolveAutopilotChip({
      isServerLive, hasRules, rules, budgetHit: lastCycle?.budgetHit, now, safeMode: autopilotSafeMode, firstSeen: firstSeenRef.current,
      statePullFailed, pulseUnreachable, statesPulled: lastCompletePullAt > 0,
    })
  }, [isServerLive, hasRules, rules, lastCycle?.budgetHit, now, autopilotSafeMode, statePullFailed, pulseUnreachable, lastCompletePullAt])
  const showAutopilotChip = autopilotStatus === 'Live' || isAutopilotWarning(autopilotStatus) || !!activeSafeMode
  const autopilotWorkerOff = autopilotWorkerEnabled === false
  const autopilotSegment = autopilotSegmentContent({ status: autopilotStatus, safeMode: !!activeSafeMode, workerEnabled: autopilotWorkerEnabled, activeCount: activeRulesCount })
  const deletedAccounts = useAccountStore(s => s.deletedAccounts)
  const restoredAccounts = useAccountStore(s => s.restoredAccounts)
  const certifiedAccountIds = useSyncStore(s => s.isInitialSyncCompleted && s.lastSyncedAccountIdsEtag === s.lastSyncedCloudEtag ? s.lastSyncedAccountIds : null)
  const syncServerUrl = useSyncStore(s => s.serverUrl)
  const serverResidue = useServerRuleResidue(auth.id, auth.isAuthenticated, syncServerUrl, certifiedAccountIds)
  const serverResidueRules = serverResidue.rules
  const autopilotAttentionRows = useMemo(() => {
    const accountExists = liveAccountCheck(accounts.map(a => a.id), deletedAccounts, restoredAccounts)
    const names = new Map(accounts.map(a => [a.id, maskNameLevel(a.name || getAccountEmail(a) || 'Unnamed account', privacyLevel)]))
    const byId = new Map(rules.map(r => [r.id, r]))
    const attentionRules = [...rules, ...serverResidueRules.filter(rule => !byId.has(rule.id) && !accounts.some(account => account.id === rule.accountId))]
    for (const rule of attentionRules) byId.set(rule.id, rule)
    return autopilotAttention(attentionRules, { now, budgetHit: lastCycle?.budgetHit, firstSeen: firstSeenRef.current, accountExists, safeMode: autopilotSafeMode })
      .flatMap(({ id, fix }) => {
        const rule = byId.get(id)
        if (!rule) return []
        const onRemove = !rules.some(localRule => localRule.id === id) && serverResidueRules.some(residue => residue.id === id) ? async () => {
          const result = await apiFetch(`/autopilot/${encodeURIComponent(id)}`, { method: 'DELETE', baseUrl: syncServerUrl })
          if (!result.ok) throw new Error('Unable to remove rule')
          serverResidue.forget(id)
        } : undefined
        return [{ rule, fix, accountName: names.get(rule.accountId) ?? 'Removed account', onRemove }]
      })
  }, [accounts, deletedAccounts, restoredAccounts, privacyLevel, rules, serverResidueRules, serverResidue, syncServerUrl, now, lastCycle?.budgetHit, autopilotSafeMode])

  const { rows: vaultKeys, attention: vaultAttention } = useHeaderVaultRows()

  const addonCount = useMemo(() => Object.keys(library).length, [library])

  // The newest of "last checked" vs "last synced" so the chip reflects real activity, not the login moment
  const latestSyncAt = useMemo(() => {
    const times = [lastSyncCheckedAt, lastSyncedAt].filter(Boolean).map(t => new Date(t as string).getTime())
    return times.length ? Math.max(...times) : null
  }, [lastSyncCheckedAt, lastSyncedAt])

  const syncTimeAgo = useMemo(() => {
    if (!latestSyncAt) return ''
    return formatDistanceToNow(new Date(latestSyncAt), { addSuffix: true })
    // now re-derives the label on the shared minute ticker so it never freezes between syncs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSyncAt, now])

  const recentSyncError = useMemo(() => {
    const lastError = syncHistory.find(h => h.status === 'error')
    if (!lastError) return null
    const errorAt = new Date(lastError.timestamp).getTime()
    const latestSuccessAt = latestSyncAt ?? 0
    return Number.isFinite(errorAt)
      && errorAt > latestSuccessAt
      && Date.now() - errorAt < 5 * 60 * 1000
      ? lastError
      : null
  }, [syncHistory, latestSyncAt])

  const syncFailures = useSyncFailures(privacyLevel)

  // Expose existing app state for reactive CSS themes without running theme scripts.
  const syncState = resolveSyncHeaderState({
    isAuthenticated: auth.isAuthenticated,
    isSyncing,
    isRefreshing: isRefreshingFromCloud,
    hasRecentError: !!recentSyncError,
    latestSyncAt,
    failedAccounts: syncFailures.length,
  })

  // Red only for a real failure; pending work and decisions keep the normal colors.
  const syncDotColor = useMemo(() => {
    if (!auth.isAuthenticated) return 'bg-muted-foreground/40'
    if (isSyncing || isRefreshingFromCloud) return 'bg-yellow-500 animate-pulse'
    if (syncState === 'error') return 'bg-red-500'
    if (latestSyncAt === null) return 'bg-muted-foreground/40'
    if (Date.now() - latestSyncAt > 5 * 60 * 1000) return 'bg-yellow-500'
    return 'bg-green-500'
  }, [auth.isAuthenticated, isSyncing, isRefreshingFromCloud, latestSyncAt, syncState])

  const [syncLabel, setSyncLabel] = useState('')
  const mobileSyncLabel = useMemo(() => compactSyncLabel(syncLabel, latestSyncAt), [syncLabel, latestSyncAt])
  useEffect(() => {
    const update = () => {
      if (!auth.isAuthenticated) { setSyncLabel('Offline'); return }
      if (isSyncing) { setSyncLabel('Syncing'); return }
      if (isRefreshingFromCloud) { setSyncLabel('Refreshing'); return }
      if (lastSyncCheckedAt || lastSyncedAt) { setSyncLabel(syncTimeAgo); return }
      setSyncLabel('Offline')
    }
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [auth.isAuthenticated, isSyncing, isRefreshingFromCloud, lastSyncCheckedAt, lastSyncedAt, syncTimeAgo])

  const [vaultOpen, setVaultOpen] = useState(false)
  const [signOutOpen, setSignOutOpen] = useState(false)

  const getBadgeData = useCallback((item: typeof NAV_ITEMS[number]): { count?: number; dotColor?: string } => {
    if (item.badge === 'count' && item.to === '/') return { count: accounts.length }
    if (item.badge === 'count' && item.to === '/saved-addons') return { count: addonCount }

    return {}
  }, [accounts.length, addonCount])

  const openCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-command-palette'))
  }, [])

  return (
    <>
    <header data-sync-state={syncState} className="flex-shrink-0 relative z-50 md:sticky md:top-0 pointer-events-none">

      <div data-theme-part="app-header" className={`relative z-[60] pointer-events-auto border-b border-border/40 ${isLight ? 'bg-card/92 backdrop-blur-xl' : 'glass-header backdrop-blur-xl'}`}>
        <div className="max-w-[1800px] mx-auto w-full px-4 h-12 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2 shrink-0 text-foreground hover:opacity-90 transition-opacity" onPointerEnter={() => preloadRouteChunk('/')} onFocus={() => preloadRouteChunk('/')} onTouchStart={() => preloadRouteChunk('/')}>
            <BrandLogo logoUrl={logoUrl} label="" className="h-6 w-6" />
            <span className="text-[13px] font-bold tracking-tight text-foreground/90">AIOManager</span>
          </Link>

          <Button
            variant="ghost"
            type="button"
            onClick={openCommandPalette}
            className="md:hidden ml-auto h-11 w-11 p-1.5 text-muted-foreground hover:text-foreground"
            aria-label="Search"
            onPointerEnter={preloadCommandPalette}
            onFocus={preloadCommandPalette}
            onTouchStart={preloadCommandPalette}
          >
            <Search className="h-4 w-4" />
          </Button>

          <PrivacyModeButton
            pressed={privacyModeEnabled}
            onToggle={togglePrivacyMode}
            iconClassName="h-4 w-4"
            className="md:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
          />

           {auth.isAuthenticated && (
            <Tooltip content="Logout" side="bottom">
              <Button
                variant="ghost"
                type="button"
                onClick={(e) => { e.preventDefault(); setSignOutOpen(true) }}
                className="md:hidden text-muted-foreground hover:text-destructive p-1.5 h-11 w-11"
                aria-label="Sign out"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </Tooltip>
          )}

          <div className="hidden md:flex items-center gap-2 ml-auto">
            <button
              data-theme-part="button"
              data-variant="outline"
              onClick={openCommandPalette}
              onPointerEnter={preloadCommandPalette}
              onFocus={preloadCommandPalette}
              className="h-8 w-60 lg:w-72 rounded-lg bg-muted/40 hover:bg-muted/60 border border-border/40 flex items-center px-2.5 gap-2 transition-colors"
              aria-label="Search"
            >
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="min-w-0 truncate text-[12px] text-muted-foreground flex-1 text-left">Search accounts, addons, keys...</span>
              <kbd data-theme-part="badge" className="text-xs px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/60 shrink-0">⌘K</kbd>
            </button>

            <div data-theme-part="header-status" className="relative flex items-stretch h-8 rounded-lg bg-muted/30 border border-border/40">
              <Popover open={vaultOpen} onOpenChange={setVaultOpen}>
                <PopoverTrigger asChild>
                  <button
                    data-theme-part="button"
                    data-theme-segment="vault"
                    data-variant="ghost"
                    className="relative flex items-center gap-1.5 px-2.5 h-full rounded-l-lg hover:bg-muted/20 transition-colors"
                    aria-label={vaultAttention > 0 ? `Vault keys, ${vaultAttention} need attention` : 'Vault keys'}
                  >
                    <KeyRound className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs font-bold text-foreground/80 tabular-nums">{vaultKeys.length}</span>
                    {vaultAttention > 0 && <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" />}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-[min(380px,92vw)] overflow-hidden rounded-2xl border-border/40 p-0 shadow-2xl">
                  <VaultKeysMenu onClose={() => setVaultOpen(false)} />
                </PopoverContent>
              </Popover>

              <PrivacyModeButton
                pressed={privacyModeEnabled}
                onToggle={togglePrivacyMode}
                iconClassName="h-3 w-3"
                segment="privacy"
                className="border-l border-border/30 flex h-full items-center px-2.5"
              />

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-theme-part="autopilot-status"
                    data-theme-segment="autopilot"
                    data-status={autopilotSegment.dataStatus}
                    className="border-l border-border/30 flex items-center gap-1.5 px-2.5 h-full hover:bg-muted/20 transition-colors"
                    aria-label={autopilotWorkerOff ? AUTOPILOT_WORKER_OFF_TITLE : `Autopilot ${autopilotStatus}`}
                  >
                    {autopilotSegment.ping && (
                      <span className="relative flex w-1.5 h-1.5">
                        <span className="absolute inline-flex w-full h-full rounded-full bg-warning opacity-60 animate-ping" />
                        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-warning" />
                      </span>
                    )}
                    {autopilotSegment.icon === 'alert'
                      ? <AlertTriangle className="h-3 w-3 text-warning" />
                      : autopilotSegment.icon === 'zap'
                        ? <Zap className="h-3 w-3 text-warning" />
                        : <ZapOff className="h-3 w-3 text-muted-foreground" />
                    }
                    <span className={`text-xs font-bold tabular-nums ${autopilotSegment.highlight ? 'text-warning' : 'text-foreground/60'}`}>
                      {autopilotSegment.label}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} collisionPadding={8} className="w-72 p-4">
                  <AutopilotStatusDetails status={autopilotStatus} activeCount={activeRulesCount} staleCount={autopilotStaleCount} uncheckedCount={autopilotUncheckedCount} errorCount={autopilotErrorCount} notMonitoredCount={autopilotNotMonitoredCount} safeMode={activeSafeMode} checkedAt={autopilotCheckedAt} onRefresh={pullServerState} attention={autopilotAttentionRows} pullFailed={statePullFailed || pulseUnreachable} pullPartial={statePullPartial} workerEnabled={autopilotWorkerEnabled} hasRules={hasRules} />
                </PopoverContent>
              </Popover>

              <Popover>
                <Tooltip content={
                  !auth.isAuthenticated ? 'Offline mode'
                    : recentSyncError ? `Sync failed: ${recentSyncError.message}`
                    : isSyncing || isRefreshingFromCloud ? 'Syncing...'
                    : syncFailures.length > 0 ? syncFailureHeadline(syncFailures.length)
                    : `Synced ${syncTimeAgo}`
                } side="bottom">
                  <PopoverTrigger asChild>
                    <button
                      data-theme-part="sync-status"
                      data-theme-segment="sync"
                      data-status={syncState}
                      className="border-l border-border/30 flex items-center gap-1.5 px-2.5 h-full hover:bg-muted/20 transition-colors"
                      aria-label="Sync status"
                    >
                      {!auth.isAuthenticated ? (
                        <CloudOff className="h-3 w-3 text-muted-foreground" />
                      ) : isSyncing || isRefreshingFromCloud ? (
                        <RefreshCw className="h-3 w-3 text-primary animate-spin" />
                      ) : (
                        <Cloud className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${syncDotColor}`} />
                      <span className="text-xs font-bold text-foreground/60 tabular-nums">{syncLabel}</span>
                    </button>
                  </PopoverTrigger>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} collisionPadding={8} className={SYNC_POPOVER_CLASS}>
                  <SyncStatusDetails
                    state={syncState}
                    isAuthenticated={auth.isAuthenticated}
                    busy={isSyncing || isRefreshingFromCloud}
                    lastSyncedAt={lastSyncedAt}
                    lastCheckedAt={lastSyncCheckedAt}
                    errorMessage={recentSyncError?.message ?? null}
                    failures={syncFailures}
                    onSyncNow={handleSyncNow}
                  />
                </PopoverContent>
              </Popover>

              <InboxBell placement="desktop" />
            </div>

            {auth.isAuthenticated && (
              <div className="flex items-center gap-1.5">
                <Tooltip content={maskNameLevel(auth.id, privacyLevel)} side="bottom">
                  <div data-theme-part="avatar" className="h-7 w-7 overflow-hidden rounded-full bg-primary/20 border border-primary/25 flex items-center justify-center text-xs font-bold text-primary cursor-default">
                    {auth.avatar ? (
                      <img src={auth.avatar} alt="" className="h-full w-full object-cover" />
                    ) : (
                      maskedInitial(auth.name || auth.id, privacyLevel)
                    )}
                  </div>
                </Tooltip>
                <Tooltip content="Logout" side="bottom">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={(e) => { e.preventDefault(); setSignOutOpen(true) }}
                    className="text-muted-foreground/60 hover:text-destructive p-1"
                    aria-label="Sign out"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              </div>
            )}
          </div>
        </div>
      </div>

      <OfflineBanner />

      <div data-theme-part="mobile-status" className="md:hidden relative z-50 pointer-events-auto flex flex-nowrap items-center justify-center gap-0.5 h-10 px-1 overflow-hidden whitespace-nowrap border-b border-border/30 bg-card/60 backdrop-blur-sm text-muted-foreground">
        <Link to="/vault" aria-label={vaultAttention > 0 ? `Vault keys, ${vaultAttention} need attention` : 'Vault keys'} className="relative flex shrink-0 items-center gap-1 text-xs min-h-10 px-2.5" onPointerEnter={() => preloadRouteChunk('/vault')} onFocus={() => preloadRouteChunk('/vault')} onTouchStart={() => preloadRouteChunk('/vault')}>
          <KeyRound className="h-3 w-3" />
          <span className="font-semibold tabular-nums">{vaultKeys.length}</span>
          {vaultAttention > 0 && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />}
        </Link>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={autopilotWorkerEnabled === false ? AUTOPILOT_WORKER_OFF_TITLE : `Autopilot ${autopilotStatus}`} className="flex shrink-0 items-center gap-1 text-xs min-h-10 px-2.5">
              {autopilotSegment.icon === 'alert' ? <AlertTriangle className="h-3 w-3 text-warning" /> : autopilotSegment.icon === 'zap' ? <Zap className="h-3 w-3 text-warning" /> : <ZapOff className="h-3 w-3" />}
              <span className={`font-semibold ${showAutopilotChip && autopilotWorkerEnabled !== false ? 'text-warning' : ''}`}>{autopilotWorkerEnabled === false ? 'Off' : autopilotStatus === 'Live' ? `Live · ${activeRulesCount}` : autopilotStatus}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="center" sideOffset={4} collisionPadding={8} className="w-72 p-4">
            <AutopilotStatusDetails status={autopilotStatus} activeCount={activeRulesCount} staleCount={autopilotStaleCount} uncheckedCount={autopilotUncheckedCount} errorCount={autopilotErrorCount} notMonitoredCount={autopilotNotMonitoredCount} safeMode={activeSafeMode} checkedAt={autopilotCheckedAt} onRefresh={pullServerState} attention={autopilotAttentionRows} pullFailed={statePullFailed || pulseUnreachable} pullPartial={statePullPartial} workerEnabled={autopilotWorkerEnabled} hasRules={hasRules} />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Sync status" className="flex min-w-0 shrink items-center gap-1 text-xs min-h-10 px-2.5">
              {!auth.isAuthenticated ? <CloudOff className="h-3 w-3 shrink-0" /> : isSyncing || isRefreshingFromCloud ? <RefreshCw className="h-3 w-3 shrink-0 text-primary animate-spin" /> : <Cloud className="h-3 w-3 shrink-0" />}
              <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${syncDotColor}`} />
              <span className="truncate font-semibold">{mobileSyncLabel}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="center" sideOffset={4} collisionPadding={8} className={SYNC_POPOVER_CLASS}>
            <SyncStatusDetails
              state={syncState}
              isAuthenticated={auth.isAuthenticated}
              busy={isSyncing || isRefreshingFromCloud}
              lastSyncedAt={lastSyncedAt}
              lastCheckedAt={lastSyncCheckedAt}
              errorMessage={recentSyncError?.message ?? null}
              failures={syncFailures}
              onSyncNow={handleSyncNow}
            />
          </PopoverContent>
        </Popover>
        <InboxBell placement="mobile" />
      </div>

      <div className="hidden md:block pointer-events-none">
        <div className="max-w-[1800px] mx-auto w-full px-4">
          {showDashboardNav ? (
            <nav aria-label="Dashboard" className="flex justify-center mt-1.5">
              <DashboardNav isLight={isLight} />
            </nav>
          ) : (
          <nav aria-label="Main" className="flex justify-center mt-1.5">
            <PriorityPillNav
              items={NAV_ITEMS}
              activePath={location.pathname}
              className={cn(
                'pointer-events-auto inline-flex h-auto items-center justify-start gap-1.5 rounded-2xl border border-border/40 bg-card/92 p-1.5 text-muted-foreground shadow-sm backdrop-blur-xl',
                !isLight && 'border-white/10 bg-white/[0.035] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
              )}
              triggerClassName={(open) => cn(
                'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-[transform,opacity,box-shadow]',
                open
                  ? (isLight
                    ? 'border-border/40 bg-background text-foreground shadow-sm'
                    : 'border-white/10 bg-white/[0.08] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]')
                  : (isLight
                    ? 'border-transparent text-muted-foreground hover:bg-background/45 hover:text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-white/[0.055] hover:text-foreground')
              )}
              onNavigate={(item) => { setVaultOpen(false); navigate(item.to) }}
              menuItemClassName="gap-2 pr-2"
              menuContentClassName="min-w-[13rem]"
              renderItem={(item, active, slot) => (
                <Link
                  data-theme-part="nav-item"
                  data-state={active ? 'active' : 'inactive'}
                  aria-current={active ? 'page' : undefined}
                  to={item.to}
                  onClick={() => setVaultOpen(false)}
                  onPointerEnter={() => preloadRouteChunk(item.to)}
                  onFocus={() => preloadRouteChunk(item.to)}
                  className={cn(
                    'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition-[transform,opacity,box-shadow]',
                    active
                      ? (isLight
                        ? 'border border-border/40 bg-background text-foreground shadow-sm'
                        : 'border border-white/10 bg-white/[0.08] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]')
                      : (isLight
                        ? 'text-muted-foreground hover:bg-background/45 hover:text-foreground'
                        : 'text-muted-foreground hover:bg-white/[0.055] hover:text-foreground')
                  )}
                >
                  <NavIcon item={item} active={active} animated={slot !== 'ghost'} />
                  <span>{item.label}</span>
                  <TabBadge count={getBadgeData(item).count} dotColor={getBadgeData(item).dotColor} isActive={active} glow={active && !isLight} />
                </Link>
              )}
              renderMenuItem={(item, active) => (
                <>
                  <span className="flex h-4 w-4 items-center justify-center">
                    <NavIcon item={item} active={false} />
                  </span>
                  <span className={active ? 'font-semibold' : undefined}>{item.label}</span>
                  <span className="ml-auto flex items-center gap-1.5 pl-3">
                    <TabBadge count={getBadgeData(item).count} dotColor={getBadgeData(item).dotColor} isActive={active} glow={active && !isLight} />
                    {active && <Check className="h-3.5 w-3.5" strokeWidth={2.2} />}
                  </span>
                </>
              )}
            />
          </nav>
          )}
        </div>
      </div>
    </header>
    <ConfirmationDialog
      open={signOutOpen}
      onOpenChange={setSignOutOpen}
      title="Sign out?"
      description="Sign out of AIOManager on this device?"
      confirmText="Sign out"
      onConfirm={() => { setSignOutOpen(false); logout() }}
    />
  </>
  )
}
