import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, AlertTriangle, ArrowUpRight, Bell, CheckCircle, KeyRound, X } from 'lucide-react'
import { useInboxStore } from '@/store/notificationInbox'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { AccountAvatar } from '@/components/accounts/AccountAvatar'
import { platformName } from '@/components/addons/PlatformSourceChip'
import { groupByDay, resolveInboxSignInAction, unreadCount, type InboxEntry, type InboxVariant } from '@/lib/notification-history'
import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const MIN = 60_000
const HOUR = 60 * MIN

function relTime(at: number): string {
  const diff = Date.now() - at
  if (diff < MIN) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`
  if (diff < 24 * HOUR) return `${Math.floor(diff / HOUR)}h ago`
  return `${Math.floor(diff / (24 * HOUR))}d ago`
}

const ICON: Record<InboxVariant, { Icon: typeof CheckCircle; tile: string }> = {
  default: { Icon: CheckCircle, tile: 'border-border/40 bg-muted/45 text-foreground' },
  warning: { Icon: AlertTriangle, tile: 'border-warning/20 bg-warning/10 text-warning' },
  destructive: { Icon: AlertCircle, tile: 'border-destructive/20 bg-destructive/10 text-destructive' },
}

function EntryRow({ entry, onOpen }: { entry: InboxEntry; onOpen: () => void }) {
  const navigate = useNavigate()
  const { Icon, tile } = ICON[entry.variant]
  const account = useAccountStore(s => (entry.accountId ? s.accounts.find(a => a.id === entry.accountId) : undefined))
  // Sign-in fix notices keep their action after the toast is gone. An explicit
  // target opens its own connection's sign-in or, if that connection no longer
  // exists, the profile itself; it never falls through to another connection.
  const signInAction = resolveInboxSignInAction(entry, account)
  const signInTarget = signInAction?.kind === 'signin'
    ? account?.connections?.find(c => c.id === signInAction.connectionId)
    : undefined
  const signInPlatform = entry.actionTarget?.platform ?? signInTarget?.platform
  const signInLabel = signInAction?.kind === 'open-profile'
    ? 'Open profile'
    : signInPlatform
      ? `Sign in to ${platformName(signInPlatform)}`
      : 'Sign in again'
  const openSignIn = () => {
    useInboxStore.getState().markRead(entry.id)
    onOpen()
    if (!account) return
    if (signInAction?.kind === 'open-profile') {
      navigate(`/account/${encodeURIComponent(account.id)}`)
      return
    }
    useUIStore.getState().openAddAccountDialog(account, signInAction?.kind === 'signin' ? { focusConnectionId: signInAction.connectionId } : undefined)
  }
  return (
    <li
      className={cn('relative flex gap-3 px-4 py-3 transition-colors hover:bg-muted/20', !entry.read && 'bg-muted/10')}
      onClick={() => useInboxStore.getState().markRead(entry.id)}
    >
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border', tile)}>
        {entry.actionHint === 'signin' ? <KeyRound className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className={cn('flex-1 text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]', entry.variant === 'destructive' && 'text-destructive', entry.actionHint === 'signin' && 'text-warning')}>
            {entry.title}
            {entry.count > 1 && <span className="ml-1.5 text-xs font-medium tabular-nums text-muted-foreground">x{entry.count}</span>}
          </p>
          {!entry.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" role="img" aria-label="Unread" />}
        </div>
        {entry.description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{entry.description}</p>
        )}
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
          {account && <AccountAvatar account={account} size="xs" showStatus={false} className="h-4 w-4" />}
          <span className="tabular-nums">{relTime(entry.at)}</span>
          {entry.actionHint === 'signin' && account ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openSignIn() }}
              className="inline-flex min-h-8 items-center rounded-full bg-warning px-3.5 py-1.5 text-xs font-semibold text-warning-foreground transition-colors hover:bg-warning/90"
            >
              {signInLabel}
            </button>
          ) : entry.href && (
            <Link
              to={entry.href}
              onClick={() => { useInboxStore.getState().markRead(entry.id); onOpen() }}
              className="inline-flex items-center gap-0.5 font-bold text-primary hover:underline"
            >
              Open
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
    </li>
  )
}

function InboxPanel({ onClose, listClassName }: { onClose: () => void; listClassName: string }) {
  const entries = useInboxStore(s => s.entries)
  const markAllRead = useInboxStore(s => s.markAllRead)
  const clear = useInboxStore(s => s.clear)

  const unread = useMemo(() => unreadCount(entries), [entries])
  const groups = useMemo(() => groupByDay(entries, Date.now()), [entries])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 bg-muted/20 px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Notifications</div>
        <div className="text-[13px] font-bold tabular-nums">{unread > 0 ? `${unread} new` : ''}</div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={markAllRead} disabled={unread === 0} className="h-7 px-2 text-xs font-bold text-primary hover:bg-primary/10">
            Mark all read
          </Button>
          <Button variant="ghost" size="sm" onClick={clear} disabled={entries.length === 0} className="h-7 px-2 text-xs font-bold text-muted-foreground hover:text-destructive">
            Clear
          </Button>
        </div>
      </div>
      <div className={cn('custom-scrollbar overflow-y-auto overscroll-contain', listClassName)}>
        {entries.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Bell className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">You are all caught up</p>
          </div>
        ) : (
          ([['Today', groups.today], ['Earlier', groups.earlier]] as const).map(([label, items]) => items.length > 0 && (
            <section key={label}>
              <div className="sticky top-0 z-10 border-b border-border/30 bg-card px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
              <ul className="divide-y divide-border/20">
                {items.map(e => <EntryRow key={e.id} entry={e} onOpen={onClose} />)}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function BottomSheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        aria-label={label}
        hideClose
        className="flex flex-col gap-0 overflow-hidden p-0 pb-[env(safe-area-inset-bottom,0px)] max-h-[85vh]"
      >
        <div className="flex shrink-0 items-center justify-end px-2 pt-1">
          <Button variant="ghost" onClick={onClose} className="h-11 w-11 p-1 text-muted-foreground/60 hover:text-foreground" aria-label="Close notifications">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  )
}

const DESKTOP_QUERY = '(min-width: 768px)'
const subscribeDesktop = (notify: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const isDesktopNow = () => window.matchMedia(DESKTOP_QUERY).matches

export function InboxBell({ placement }: { placement: 'desktop' | 'mobile' }) {
  const entries = useInboxStore(s => s.entries)
  const [open, setOpen] = useState(false)
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true)

  useEffect(() => {
    const load = () => useInboxStore.getState().load(getActiveWorkspaceId() || 'local')
    load()
    return subscribeWorkspaceChanges(load)
  }, [])

  const setOpenAndSee = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) useInboxStore.getState().markSeen()
  }, [])
  const close = useCallback(() => setOpenAndSee(false), [setOpenAndSee])

  const unread = useMemo(() => unreadCount(entries), [entries])
  const badge = unread > 0 && (
    <span
      aria-hidden="true"
      className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none tabular-nums text-primary-foreground"
    >
      {unread > 9 ? '9+' : unread}
    </span>
  )

  if ((placement === 'desktop') !== desktop) return null

  if (placement === 'mobile') {
    return (
      <>
        <button type="button" aria-label="Notifications" onClick={() => setOpenAndSee(true)} className="relative flex min-h-10 shrink-0 items-center px-2.5">
          <span className="relative">
            <Bell className="h-3.5 w-3.5" />
            {badge}
          </span>
          {unread > 0 && <span className="sr-only">{unread} unread</span>}
        </button>
        <BottomSheet open={open} onClose={close} label="Notification inbox">
          <InboxPanel onClose={close} listClassName="min-h-0 flex-1" />
        </BottomSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpenAndSee}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-theme-part="button"
          data-theme-segment="inbox"
          data-variant="ghost"
          aria-label="Notifications"
          className="relative flex h-full items-center rounded-r-lg border-l border-border/30 px-2.5 transition-colors hover:bg-muted/20"
        >
          <span className="relative">
            <Bell className="h-3 w-3 text-muted-foreground" />
            {badge}
          </span>
          {unread > 0 && <span className="sr-only">{unread} unread</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="flex w-[min(400px,92vw)] flex-col overflow-hidden rounded-2xl border-border/40 p-0 shadow-2xl">
        <InboxPanel onClose={close} listClassName="max-h-[420px]" />
      </PopoverContent>
    </Popover>
  )
}
