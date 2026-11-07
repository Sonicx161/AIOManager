import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Info, MoreHorizontal, Search, ShieldAlert, Trash2, X, Zap } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import {
    AdminApiError,
    bulkDeletePreview,
    bulkDeleteUsers,
    disableUser,
    enableUser,
    restoreUser,
    signoutDevicesUser,
    softDeleteUser,
    type UserFilterId,
    type UserRow,
} from '@/api/admin'
import { paneErrorCopy, paneView, staleNoteCopy, uniqueRows, usersFooterText, usersQueryOptions } from '@/lib/admin-queries'
import { STATUS_LEGEND, platformName, sortPlatforms, storagePct, tileChars, userStatus, type StatusTone } from '@/lib/admin-users'
import { formatCount } from '@/lib/admin-format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PlatformLogo } from '@/components/providers/ConnectionPrimitives'
import { useTheme } from '@/contexts/ThemeContext'
import { Chip, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, StatusBadge, TABLE_HEAD, TABLE_ROW, TABLE_SURFACE, TONE_TEXT } from '../AdminWidgets'
import { TypedActionDialog } from '../TypedActionDialog'

const FILTERS: { id: UserFilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active-today', label: 'Active today' },
  { id: 'with-rules', label: 'With rules' },
  { id: 'with-failover', label: 'With failover' },
  { id: 'inactive-180', label: 'Inactive 180 d+' },
]

const SPLIT_PLATFORMS = ['stremio', 'nuvio', 'realstream', 'hydra']

// The server's search contract: a lowercase acct- handle prefix, nothing else.
const QUERY_RE = /^acct-[0-9a-f]{0,12}$/

// One shared column template for the header and every row so columns align:
// Account, Status, First seen, Last seen, Connections, Rules, Storage, Actions.
// The table renders from md up only; the last track is fixed so the header and
// the row actions size alike.
const USERS_GRID =
  'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,0.7fr)_minmax(0,1.25fr)_minmax(0,0.75fr)_minmax(0,1.05fr)_96px] items-center gap-3 px-3.5'

const STATUS_CHIP: Record<StatusTone, string> = {
  ok: 'border-success/25 bg-success/10 text-success',
  info: 'border-primary/25 bg-primary/12 text-primary',
  muted: 'border-border/40 bg-muted/40 text-foreground/80',
  idle: 'border-border/40 bg-muted/40 text-foreground/80 [&>i]:opacity-55',
  warn: 'border-warning/25 bg-warning/10 text-warning',
}

type SortColumn = 'created' | 'lastseen'
type SortOrder = 'asc' | 'desc'
type RowActionKind = 'disable' | 'enable' | 'signout' | 'delete' | 'restore'

const ROW_ACTION_COPY: Record<RowActionKind, { title: string; description: string; word: string; label: string; destructive: boolean }> = {
  disable: {
    title: 'Disable this account?',
    description: 'Reversible any time. Blocks sync sign-ins and pushes; data is kept. The user sees a notice at the next sign-in attempt, and the action with its reason is audited.',
    word: 'DISABLE', label: 'Disable account', destructive: true,
  },
  enable: {
    title: 'Enable this account?',
    description: 'Sign-ins and pushes work again. The reason is audited and the user sees a notice.',
    word: 'ENABLE', label: 'Enable account', destructive: false,
  },
  signout: {
    title: 'Revoke sessions on this account?',
    description: 'Signs the account out everywhere by retiring its device credentials. Passwords and connections keep working. The reason is audited and the user sees a notice.',
    word: 'SIGNOUT', label: 'Revoke sessions', destructive: true,
  },
  delete: {
    title: 'Delete this account? (soft)',
    description: 'Sign-ins and sync are blocked and the account is hidden now. Data is kept until you restore the account here. Nothing is purged automatically. The reason is audited.',
    word: 'DELETE', label: 'Delete account', destructive: true,
  },
  restore: {
    title: 'Restore this account?',
    description: 'Sign-ins and sync work again. The reason is audited and the user sees a notice.',
    word: 'RESTORE', label: 'Restore account', destructive: false,
  },
}

function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span data-theme-part="badge" className={cn('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium', STATUS_CHIP[tone])}>
      <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

function PopHead({ title }: { title: string }) {
  return <div className="mb-1.5 text-[13px] font-semibold">{title}</div>
}

function StatusLegend({ user }: { user?: UserRow }) {
  return (
    <>
      <PopHead title="Status, from last seen" />
      {STATUS_LEGEND.map(s => (
        <div key={s.label} className="flex items-center justify-between gap-2.5 border-t border-border/50 py-1.5 text-xs text-muted-foreground first-of-type:border-t-0">
          <StatusPill label={s.label} tone={s.tone} />
          <span>{s.detail}</span>
        </div>
      ))}
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {user ? `${user.handle} was last seen ${user.lastSeenLabel}. ` : ''}Only the sign-in date is used, never what the account holds.
      </p>
    </>
  )
}

/** Last-seen pill plus the operator account-state chip (disabled, deleted with window). */
function StatusWithState({ user }: { user: UserRow }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <StatusButton user={user} />
      {user.status && user.status !== 'active' && (
        <StatusBadge status={user.status} />
      )}
    </span>
  )
}

function StatusButton({ user }: { user: UserRow }) {
  const status = userStatus(user.inactiveDays)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="relative z-10 -my-1 inline-flex min-h-8 items-center rounded-full max-md:after:absolute max-md:after:inset-x-[-2px] max-md:after:top-1/2 max-md:after:h-10 max-md:after:-translate-y-1/2" aria-label={`Status ${status.label}, last seen ${user.lastSeenLabel}`}>
          <StatusPill label={status.label} tone={status.tone} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] rounded-2xl p-3">
        <StatusLegend user={user} />
      </PopoverContent>
    </Popover>
  )
}

// Hydra and RealStream ship white logos: on light themes their image tile gets a dark plate.
const WHITE_LOGOS = new Set(['hydra', 'realstream'])

function PlatformIcon({ platform }: { platform: string }) {
  const { isLight } = useTheme()
  return (
    <PlatformLogo
      platform={platform}
      isHydra={platform === 'hydra'}
      className={cn('h-[22px] w-[22px] shrink-0 rounded-md [&_img]:p-[3px]', isLight && WHITE_LOGOS.has(platform) && 'bg-foreground/85')}
    />
  )
}

function Connections({ user }: { user: UserRow }) {
  if (!user.connectionCount) return <span className="text-muted-foreground">None</span>
  const present = sortPlatforms(user.connections)
  const split = sortPlatforms([
    ...SPLIT_PLATFORMS.map(p => ({ platform: p, count: user.connections.find(c => c.platform === p)?.count ?? 0 })),
    ...user.connections.filter(c => !SPLIT_PLATFORMS.includes(c.platform)),
  ])
  const total = user.connectionCount
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative z-10 -mx-1.5 -my-1 inline-flex min-h-8 flex-wrap items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-foreground/[0.04] max-md:after:absolute max-md:after:inset-x-[-2px] max-md:after:top-1/2 max-md:after:h-10 max-md:after:-translate-y-1/2"
          aria-label={`${total} connection${total === 1 ? '' : 's'}, open the breakdown`}
        >
          {present.map(c => (
            <span key={c.platform} className="inline-flex items-center gap-[3px] text-xs font-semibold text-foreground" title={platformName(c.platform)}>
              <PlatformIcon platform={c.platform} />{c.count}
            </span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] rounded-2xl p-3">
        <PopHead title={`${total} connection${total === 1 ? '' : 's'}`} />
        {split.map(c => (
          <div key={c.platform} className="flex items-center justify-between gap-2.5 border-t border-border/50 py-1.5 text-xs text-muted-foreground first-of-type:border-t-0">
            <span className="inline-flex items-center gap-1.5 font-semibold text-foreground/80"><PlatformIcon platform={c.platform} />{platformName(c.platform)}</span>
            <b className="font-semibold tabular-nums text-foreground/80">{c.count}</b>
          </div>
        ))}
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Counts of connection types only. No addons, URLs or credentials.</p>
      </PopoverContent>
    </Popover>
  )
}

function RulesPill({ count, quiet }: { count: number; quiet?: boolean }) {
  if (count <= 0) return quiet ? null : <span className="text-muted-foreground">0</span>
  return (
    <span data-theme-part="badge" className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/40 bg-muted/40 px-2 text-xs font-medium text-foreground">
      <Zap className="h-3.5 w-3.5 fill-warning text-warning" aria-hidden />
      {count} {count === 1 ? 'rule' : 'rules'}
    </span>
  )
}

function StorageBar({ user, max }: { user: UserRow; max: number }) {
  const pct = storagePct(user.storageBytes, max)
  return (
    <span className="flex w-full items-center justify-end gap-2">
      <span className="h-1.5 max-w-20 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]" aria-hidden>
        <i className={cn('block h-full rounded-full', max && user.storageBytes === max ? 'bg-primary' : 'bg-foreground/45')} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('min-w-[58px] text-right tabular-nums', user.storageBytes ? 'text-foreground' : 'text-muted-foreground')}>{user.storageLabel}</span>
    </span>
  )
}

/** Neutral grey, like every account avatar; two hash characters, never a name. */
function HandleTile({ handle }: { handle: string }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted font-mono text-[11px] font-bold text-foreground/85" aria-hidden>
      {tileChars(handle)}
    </span>
  )
}

/** The per-row kebab: state-aware account actions, each opening a typed dialog. */
function RowMenu({ user, onAction, phone }: { user: UserRow; onAction: (kind: RowActionKind) => void; phone?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${user.handle}${user.status && user.status !== 'active' ? `, ${user.status}` : ''}`}
          className={cn(
            'relative z-10 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
            phone && 'max-md:h-10 max-md:w-10',
          )}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem]" sheetHeader={
        <span className="min-w-0">
          <span className="block truncate font-mono text-[13px] font-semibold">{user.handle}</span>
          <span className="block text-xs text-muted-foreground">Account actions, audited with a reason</span>
        </span>
      }>
        {user.status !== 'deleted' && (
          user.status === 'disabled'
            ? <DropdownMenuItem onClick={() => onAction('enable')}>Enable account</DropdownMenuItem>
            : <DropdownMenuItem onClick={() => onAction('disable')}>Disable account</DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onAction('signout')}>Revoke sessions</DropdownMenuItem>
        {user.status === 'deleted'
          ? <DropdownMenuItem onClick={() => onAction('restore')}>Restore account</DropdownMenuItem>
          : <DropdownMenuItem destructive onClick={() => onAction('delete')}>Soft delete</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function KpiCard({ label, value, detail, tone, active, onClick }: { label: string; value: string; detail: string; tone?: 'ok' | 'info' | 'warn'; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-theme-part="panel"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'min-w-0 rounded-2xl border p-3.5 text-left shadow-sm transition-colors',
        active ? 'border-primary/50 bg-primary/[0.07]' : 'border-border/45 bg-card/80 hover:border-foreground/25',
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn('mt-1.5 truncate text-2xl font-bold tabular-nums tracking-tight', tone && TONE_TEXT[tone])}>{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</div>
    </button>
  )
}

export function UsersScreen() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<UserFilterId>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortColumn>('lastseen')
  const [order, setOrder] = useState<SortOrder>('desc')
  const [rowAction, setRowAction] = useState<{ kind: RowActionKind; user: UserRow } | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkPreparing, setBulkPreparing] = useState(false)
  // The server re-checks the inactive set at request time; a 409 carries the
  // count it now expects, which overrides the preview until the next refetch.
  const [bulkExpected, setBulkExpected] = useState<number | null>(null)

  // Debounced server-side search: only a well-formed handle prefix is sent.
  useEffect(() => {
    const trimmed = searchInput.trim().toLowerCase()
    const next = trimmed && QUERY_RE.test(trimmed) ? trimmed : ''
    if (next === search) return
    const t = setTimeout(() => setSearch(next), 300)
    return () => clearTimeout(t)
  }, [searchInput, search])

  // One paged query per filter, search and sort: a control change never
  // appends to another result set, and a null cursor ends paging.
  const users = useInfiniteQuery(usersQueryOptions(filter, { q: search || undefined, sort, order }))
  const { isFetching, refetch } = users
  const data = users.data?.pages[0]
  const view = paneView(users)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    queryClient.invalidateQueries({ queryKey: ['admin-overview'] })
  }

  const rowMutation = useMutation({
    mutationFn: ({ kind, user, reason, confirm }: { kind: RowActionKind; user: UserRow; reason: string; confirm: string }) => {
      if (kind === 'disable') return disableUser(user.handle, reason, confirm).then(() => 'Account disabled. The user sees a notice at the next sign-in attempt.')
      if (kind === 'enable') return enableUser(user.handle, reason, confirm).then(() => 'Account enabled again. The user sees a notice.')
      if (kind === 'signout') return signoutDevicesUser(user.handle, reason, confirm).then(r => `Sessions revoked; ${r.devices} device credential${r.devices === 1 ? '' : 's'} retired. The user sees a notice.`)
      if (kind === 'delete') return softDeleteUser(user.handle, reason, confirm).then(() => 'Account soft deleted. Restore it here any time; the user sees a notice.')
      return restoreUser(user.handle, reason, confirm).then(() => 'Account restored. The user sees a notice.')
    },
    onSuccess: (message: string) => {
      setRowAction(null)
      toast({ title: 'Done', description: message })
      invalidate()
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Action failed', description: e.message }),
  })

  const bulk = useMutation({
    mutationFn: (input: { reason: string; confirm: string }) => bulkDeleteUsers(input),
    onSuccess: (result) => {
      setBulkOpen(false)
      setBulkExpected(null)
      toast({ title: 'Bulk delete done', description: `${result.deleted} account${result.deleted === 1 ? '' : 's'} soft deleted. Restore them here any time. Each user sees a notice.` })
      invalidate()
    },
    onError: (e: Error) => {
      if (e instanceof AdminApiError && e.status === 409) {
        // The set changed under us (or is empty): refresh the count and ask again.
        const expected = e.expected ?? 0
        setBulkExpected(expected)
        invalidate()
        toast({
          variant: expected > 0 ? 'default' : 'destructive',
          title: 'The inactive set changed',
          description: expected > 0
            ? `The server now counts ${expected} matching account${expected === 1 ? '' : 's'}. Review the new count and confirm again.`
            : 'No accounts match any more. Nothing was deleted.',
        })
        if (expected === 0) setBulkOpen(false)
      } else {
        toast({ variant: 'destructive', title: 'Bulk delete failed', description: e.message })
      }
    },
  })

  const prepareBulk = async () => {
    setBulkPreparing(true)
    try {
      // The preview is the count the server will hold us to at confirm time.
      const preview = await bulkDeletePreview()
      setBulkExpected(preview.expected)
      setBulkOpen(true)
    } catch (e) {
      toast({ variant: 'destructive', title: 'Preview failed', description: e instanceof Error ? e.message : 'Try again.' })
    } finally {
      setBulkPreparing(false)
    }
  }

  const rows = useMemo(() => uniqueRows(users.data?.pages, u => u.handle), [users.data])
  const maxStorage = useMemo(() => rows.reduce((m, u) => Math.max(m, u.storageBytes), 0), [rows])

  const searching = search.length > 0
  const searchTyping = searchInput.trim().length > 0
  const invalidSearch = searchTyping && !QUERY_RE.test(searchInput.trim().toLowerCase())
  const inactiveCount = data?.filters.inactive180 ?? 0
  const previewCount = bulkExpected ?? Math.min(inactiveCount, data?.bulkCap ?? 25)
  const pick = (id: UserFilterId) => { setFilter(id); setBulkExpected(null) }
  const toggleKpi = (id: UserFilterId) => pick(filter === id ? 'all' : id)
  const toggleSort = (column: SortColumn) => {
    if (sort === column) setOrder(order === 'asc' ? 'desc' : 'asc')
    else { setSort(column); setOrder('desc') }
  }
  const accountsDetail = data
    ? filter === 'all' && !searching && !users.hasNextPage ? `all ${formatCount(data.filters.accounts)} loaded` : filter === 'all' && !searching ? `${formatCount(rows.length)} loaded, ${formatCount(data.total - rows.length)} more` : 'tap to show all'
    : ''

  const sortAria = (column: SortColumn, label: string) =>
    `Sort by ${label}, currently ${sort === column ? (order === 'asc' ? 'ascending' : 'descending') : 'not sorted'}`

  return (
    <div>
      <ScreenHeader
        title="Users"
        subtitle="Counts, stable labels and machinery only. There is no view into account contents at any point."
      />

      {data && (
        <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
          <KpiCard label="Accounts" value={formatCount(data.filters.accounts)} detail={accountsDetail} active={filter === 'all'} onClick={() => pick('all')} />
          <KpiCard label="Synced today" value={formatCount(data.filters.syncedToday)} detail="seen in the last 24 h" tone="ok" active={filter === 'active-today'} onClick={() => toggleKpi('active-today')} />
          <KpiCard label="Active 7 d" value={formatCount(data.filters.active7d)} detail="accounts seen this week" tone="info" active={filter === 'active-7d'} onClick={() => toggleKpi('active-7d')} />
          <KpiCard label="Inactive 180 d+" value={formatCount(inactiveCount)} detail="no sync for 180 days" tone="warn" active={filter === 'inactive-180'} onClick={() => toggleKpi('inactive-180')} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => pick(f.id)}
            className={cn(
              'flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors max-md:min-h-10',
              filter === f.id ? 'border-primary/25 bg-primary/10 text-primary' : 'border-border/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {f.label}{f.id === 'inactive-180' && data ? ` (${inactiveCount})` : ''}
          </button>
        ))}
        {isFetching && data && <span className="text-xs text-muted-foreground" role="status">Refreshing</span>}
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search label prefix, e.g. acct-4f"
            aria-label="Search accounts by label prefix on the server"
            className="h-8 rounded-full pl-8 text-xs max-md:min-h-11 max-md:text-[15px]"
          />
          {searchTyping && (
            <button type="button" className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground" aria-label="Clear search" onClick={() => setSearchInput('')}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {invalidSearch && (
        <p className="mb-3 text-xs text-muted-foreground" role="status">
          Labels start with acct- followed by hex characters, for example acct-4f. The search runs on the server once the prefix is well formed.
        </p>
      )}

      {view === 'stale' && <StaleNotice message={staleNoteCopy(users.error)} onRetry={() => refetch()} retrying={isFetching} />}
      {view === 'loading' ? (
        <PaneLoading />
      ) : view === 'gone' || !data ? (
        <PaneError message={paneErrorCopy(users.error, 'The account list')} onRetry={() => refetch()} retrying={isFetching} />
      ) : (
      <>
      {/* Phone: tile, handle, then status, platforms and rules; the row opens the detail page. */}
      <div className={cn(TABLE_SURFACE, 'md:hidden')}>
        {rows.map(u => (
          <div key={u.handle} className={cn(TABLE_ROW, 'relative flex min-h-12 w-full items-center gap-3 px-3.5 py-2')}>
            <Link
              to={`/dashboard/users/${encodeURIComponent(u.handle)}`}
              aria-label={`Open detail for ${u.handle}, last seen ${u.lastSeenLabel}`}
              className="absolute inset-0"
            />
            <HandleTile handle={u.handle} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px] font-semibold text-foreground">{u.handle}</span>
              <span className="mt-[3px] flex flex-wrap items-center gap-2">
                <StatusWithState user={u} />
                {u.connectionCount > 0 && <Connections user={u} />}
                <RulesPill count={u.ruleCount} quiet />
              </span>
            </span>
            <RowMenu user={u} phone onAction={kind => setRowAction({ kind, user: u })} />
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {searching ? `No accounts match ${search} in this filter.` : 'No accounts match this filter.'}
          </div>
        )}
      </div>

      {/* Desktop: the shared-column table with sortable seen columns. */}
      <div className={cn(TABLE_SURFACE, 'hidden md:block')} role="table" aria-label="Accounts">
        <div className={cn(USERS_GRID, TABLE_HEAD, 'min-h-[34px]')} role="row">
          <span role="columnheader" aria-sort="none">Account</span>
          <span role="columnheader" aria-sort="none">
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="inline-flex min-h-[30px] items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" aria-label="Status legend">
                  Status <Info className="h-3.5 w-3.5" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[260px] rounded-2xl p-3">
                <StatusLegend />
              </PopoverContent>
            </Popover>
          </span>
          <span role="columnheader" aria-sort={sort === 'created' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" onClick={() => toggleSort('created')} aria-label={sortAria('created', 'first seen')} className="inline-flex min-h-[30px] items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              First seen
              {sort === 'created' && (order === 'asc'
                ? <ArrowUp className="h-3 w-3" aria-hidden />
                : <ArrowDown className="h-3 w-3" aria-hidden />)}
            </button>
          </span>
          <span role="columnheader" aria-sort={sort === 'lastseen' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" onClick={() => toggleSort('lastseen')} aria-label={sortAria('lastseen', 'last seen')} className="inline-flex min-h-[30px] items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              Last seen
              {sort === 'lastseen' && (order === 'asc'
                ? <ArrowUp className="h-3 w-3" aria-hidden />
                : <ArrowDown className="h-3 w-3" aria-hidden />)}
            </button>
          </span>
          <span role="columnheader" aria-sort="none">Connections</span>
          <span role="columnheader" aria-sort="none">Rules</span>
          <span role="columnheader" aria-sort="none" className="text-right">Storage</span>
          <span role="columnheader" aria-sort="none" className="text-right">Actions</span>
        </div>
        {rows.map(u => (
          <div key={u.handle} className={cn(USERS_GRID, TABLE_ROW, 'min-h-[52px] py-2')} role="row">
            <span role="cell" className="flex min-w-0 items-center gap-2.5">
              <HandleTile handle={u.handle} />
              <span className="block truncate font-mono text-[12px] font-semibold text-foreground">{u.handle}</span>
            </span>
            <span role="cell"><StatusWithState user={u} /></span>
            <span role="cell">{u.createdLabel}</span>
            <span role="cell">{u.lastSeenLabel}</span>
            <span role="cell"><Connections user={u} /></span>
            <span role="cell"><RulesPill count={u.ruleCount} /></span>
            <span role="cell" className="flex justify-end"><StorageBar user={u} max={maxStorage} /></span>
            <span role="cell" className="flex items-center justify-end gap-0.5">
              <RowMenu user={u} onAction={kind => setRowAction({ kind, user: u })} />
              <Button variant="outline" size="sm" asChild>
                <Link to={`/dashboard/users/${encodeURIComponent(u.handle)}`} aria-label={`Open detail for ${u.handle}`}>
                  Detail
                </Link>
              </Button>
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {searching ? `No accounts match ${search} in this filter.` : 'No accounts match this filter.'}
          </div>
        )}
      </div>
      </>
      )}
      {data && (
        <p className="mt-2.5 text-xs text-muted-foreground">
          {usersFooterText({ searching, matching: rows.length, total: data.total, query: search, hasNextPage: users.hasNextPage })}
        </p>
      )}
      {users.hasNextPage && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => users.fetchNextPage()} disabled={users.isFetchingNextPage}>
            {users.isFetchingNextPage ? 'Loading' : 'Load more'}
          </Button>
          {users.isFetchNextPageError && <span className="text-xs text-destructive" role="alert">More rows could not be loaded. Try again.</span>}
        </div>
      )}

      <div className="mt-5">
        <Panel>
          <PanelHead
            icon={<ShieldAlert />}
            title="Bulk delete, bounded"
            detail="Only accounts inactive 180+ days, capped at 25 per action, count previewed before typing, reason required. The server re-checks the set when you confirm."
          />
          <div className="rounded-2xl border border-destructive/25 bg-destructive/10 p-3.5">
            <div className="mb-2 flex flex-wrap gap-2">
              <Chip tone="info">{inactiveCount} match: inactive 180 d+</Chip>
              <Chip>cap {data?.bulkCap ?? 25} per action</Chip>
            </div>
            <div className="text-[13px] font-semibold">Delete {previewCount} accounts?</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Each one is hidden and blocked now, and kept until you restore it here. Nothing is purged automatically. The search, count, reason and cap are all logged.
            </p>
            <div className="mt-3">
              <Button variant="destructive" size="sm" className="max-md:min-h-10" onClick={() => void prepareBulk()} disabled={bulkPreparing || (previewCount === 0 && inactiveCount === 0)}>
                <Trash2 className="h-3.5 w-3.5" /> {bulkPreparing ? 'Previewing' : 'Prepare bulk delete'}
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      {bulkOpen && (
      <TypedActionDialog
        open={bulkOpen}
        onOpenChange={open => { setBulkOpen(open); if (!open) setBulkExpected(null) }}
        title={`Delete ${previewCount} accounts? (soft)`}
        description="Inactive 180+ days only. Hidden and blocked now, kept until you restore them here. Nothing is purged automatically. The count, reason and cap land in the audit log and every user sees a notice."
        confirmWord={`DELETE ${previewCount}`}
        actionLabel={`Delete ${previewCount} accounts`}
        destructive
        busy={bulk.isPending}
        onConfirm={(reason, confirm) => bulk.mutate({ reason, confirm })}
      />
      )}

      {rowAction && (() => {
        const copy = ROW_ACTION_COPY[rowAction.kind]
        return (
          <TypedActionDialog
            open
            onOpenChange={open => { if (!open) setRowAction(null) }}
            title={copy.title.replace('this account', rowAction.user.handle)}
            description={copy.description}
            confirmWord={copy.word}
            actionLabel={copy.label}
            destructive={copy.destructive}
            busy={rowMutation.isPending}
            onConfirm={(reason, confirm) => rowMutation.mutate({ kind: rowAction.kind, user: rowAction.user, reason, confirm })}
          />
        )
      })()}
    </div>
  )
}
