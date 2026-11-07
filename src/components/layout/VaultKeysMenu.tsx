import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, ExternalLink, EyeOff, KeyRound, Loader2, Lock, MoreHorizontal, RefreshCw, Search, SlidersHorizontal, Star } from 'lucide-react'
import { useVaultStore } from '@/store/vaultStore'
import { useProviderStore } from '@/store/providerStore'
import { useAuthStore } from '@/store/authStore'
import { PROVIDERS, getKeyAbbr, resolveVaultGroup } from '@/lib/constants'
import { vaultKeyLabel } from '@/lib/vault-key-label'
import { registryForKey } from '@/lib/provider-registry-boot'
import {
  buildHeaderRows,
  classifyKey,
  createHealthRequester,
  formatDaysLeft,
  isDefaultVaultHeaderSettings,
  needsPinMigration,
  parseLegacyPins,
  resetVaultHeaderSettings,
  resolveHeaderPins,
  resolveHeaderVisibility,
  setVaultHeaderMode,
  setVaultHeaderShown,
  toggleHeaderPin,
  type HeaderKeyInput,
  type HeaderKeyRow,
  type HeaderKeyStatus,
  type VaultHeaderSettings,
} from '@/lib/vault-header-keys'
import { copyVaultKeyField, copyableFields, filterHeaderEntries, resolveRenewUrl, type CopyDeps, type VaultKeyFieldId } from '@/lib/vault-key-actions'
import { readVaultHeaderSettings, writeVaultHeaderSettings, SYNCED_SETTINGS_EVENT } from '@/lib/synced-settings'
import { triggerSync } from '@/lib/sync-trigger'
import { getActiveWorkspaceId, subscribeWorkspaceChanges } from '@/lib/workspace-persistence'
import { toast } from '@/hooks/use-toast'
import { usePhoneViewport } from '@/hooks/usePhoneViewport'
import { cn, safeHref } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { VaultKey } from '@/types/vault'

type Keyed = HeaderKeyInput & VaultKey
type Row = HeaderKeyRow<Keyed>

interface HeaderEntry {
  key: Keyed
  status: HeaderKeyStatus
  selected: boolean
  forced: boolean
}

const SEARCH_THRESHOLD = 8

const DOT: Record<HeaderKeyStatus, string> = {
  expired: 'bg-destructive',
  expiring: 'bg-warning',
  healthy: 'bg-success',
  error: 'bg-destructive/50',
  unknown: 'bg-muted-foreground/30',
}

const requestHealthOnce = createHealthRequester({
  hydrate: () => useProviderStore.getState().hydrateFromCache(),
  needsCheck: () => {
    const { lastRefreshed, isRefreshing } = useProviderStore.getState()
    return !lastRefreshed && !isRefreshing
  },
  refresh: () => useProviderStore.getState().refreshAll(),
})

function withCategory(k: VaultKey): Keyed {
  const registry = registryForKey(k)
  const resolved = k.group ? resolveVaultGroup(k.provider, k.group) : 'Custom'
  return {
    ...k,
    provider: k.provider === 'other' ? registry.vaultProvider : k.provider,
    group: resolved === 'Custom' ? registry.group : resolved,
  }
}

const legacyPinsKey = () => `aiom:vault-pins:${getActiveWorkspaceId() || 'local'}`

function readLegacyPins(): string[] {
  try {
    return parseLegacyPins(localStorage.getItem(legacyPinsKey()))
  } catch {
    return []
  }
}

function useLegacyPins() {
  const [legacy, setLegacy] = useState<string[]>(readLegacyPins)
  useEffect(() => subscribeWorkspaceChanges(() => setLegacy(readLegacyPins())), [])
  return legacy
}

function useVaultHeaderSettings() {
  const [settings, setSettings] = useState<VaultHeaderSettings>(readVaultHeaderSettings)
  useEffect(() => {
    const handle = (event: Event) => {
      if ((event as CustomEvent<{ vaultHeader?: unknown }>).detail?.vaultHeader) setSettings(readVaultHeaderSettings())
    }
    window.addEventListener(SYNCED_SETTINGS_EVENT, handle)
    return () => window.removeEventListener(SYNCED_SETTINGS_EVENT, handle)
  }, [])
  const update = useCallback((change: (current: VaultHeaderSettings) => VaultHeaderSettings) => {
    setSettings(writeVaultHeaderSettings(change(readVaultHeaderSettings())))
    triggerSync()
  }, [])
  return { settings, update }
}

export function useHeaderVaultRows(): {
  rows: Row[]
  attention: number
  toggle: (id: string) => void
  entries: HeaderEntry[]
  settings: VaultHeaderSettings
  updateSettings: (change: (current: VaultHeaderSettings) => VaultHeaderSettings) => void
} {
  const keys = useVaultStore(s => s.keys)
  const health = useProviderStore(s => s.health)
  const legacyPins = useLegacyPins()
  const { settings, update } = useVaultHeaderSettings()
  const pins = useMemo(() => resolveHeaderPins(settings, legacyPins), [settings, legacyPins])
  const toggle = useCallback((id: string) => update(cur => toggleHeaderPin(cur, readLegacyPins(), id)), [update])
  useEffect(() => {
    const current = readVaultHeaderSettings()
    if (!needsPinMigration(current, legacyPins)) return
    writeVaultHeaderSettings({ ...current, pins: legacyPins })
    triggerSync()
  }, [settings, legacyPins])
  useEffect(() => {
    if (keys.length > 0) void requestHealthOnce()
  }, [keys.length])
  return useMemo(() => {
    const input = keys.map(withCategory)
    const pinned = new Set(pins)
    const now = Date.now()
    const rows = buildHeaderRows(input, health, pinned, now, settings)
    const entries = input.map((key): HeaderEntry => {
      const h = health[key.id]
      const { status } = classifyKey(key, h, now)
      const { selected, forced } = resolveHeaderVisibility(key, h, pinned.has(key.id), settings, status === 'expired' || status === 'expiring')
      return { key, status, selected, forced }
    })
    return { rows, attention: rows.filter(r => r.attention).length, toggle, entries, settings, updateSettings: update }
  }, [keys, health, pins, toggle, settings, update])
}

function rowTone(status: HeaderKeyStatus) {
  return status === 'expired' ? 'text-destructive' : status === 'expiring' ? 'text-warning' : 'text-muted-foreground'
}

function forcedNote(status: HeaderKeyStatus) {
  return status === 'expired' ? 'Shown because it expired' : 'Shown because it expires soon'
}

interface RowActions {
  copy: (id: string, field: VaultKeyFieldId | null) => void
  renew: (url: string) => void
  check: (id: string) => void
  pin: (id: string) => void
  hide: (id: string) => void
  openInVault: (id: string) => void
}

interface ActionItem {
  id: string
  label: string
  icon: ReactNode
  run: () => void
}

const ICON = 'h-3.5 w-3.5'

function IconAction({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

function KeyRow({ row, phone, actions }: { row: Row; phone: boolean; actions: RowActions }) {
  const [open, setOpen] = useState(false)
  const id = row.key.id
  const provider = PROVIDERS.find(p => p.value === row.key.provider)
  const label = vaultKeyLabel(row.key)
  const fields = copyableFields(row.key)
  const renewUrl = resolveRenewUrl(row.key, provider?.url, registryForKey(row.key).credentialUrl)
  const expDate = row.expiresAt && !Number.isNaN(new Date(row.expiresAt).getTime())
    ? new Date(row.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  const moreItems: ActionItem[] = [
    { id: 'check', label: 'Check now', icon: <RefreshCw className={ICON} />, run: () => actions.check(id) },
    { id: 'pin', label: row.pinned ? 'Unpin from favorites' : 'Pin to favorites', icon: <Star className={ICON} />, run: () => actions.pin(id) },
    ...(fields.length > 1 ? fields.map(f => ({ id: `copy-${f.id}`, label: `Copy ${f.label}`, icon: <Copy className={ICON} />, run: () => actions.copy(id, f.id) })) : []),
    { id: 'hide', label: 'Hide from header', icon: <EyeOff className={ICON} />, run: () => actions.hide(id) },
    { id: 'vault', label: 'Open in Vault', icon: <KeyRound className={ICON} />, run: () => actions.openInVault(id) },
  ]
  const sheetItems: ActionItem[] = [
    ...(fields.length === 1 ? [{ id: 'copy', label: `Copy ${fields[0].label}`, icon: <Copy className={ICON} />, run: () => actions.copy(id, null) }] : []),
    ...(renewUrl ? [{ id: 'renew', label: 'Renew', icon: <ExternalLink className={ICON} />, run: () => actions.renew(renewUrl) }] : []),
    ...moreItems,
  ]

  const content = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-foreground">
          <span className="truncate">{label}</span>
          {row.pinned && <Star aria-hidden="true" className="h-3 w-3 shrink-0 fill-current text-warning" />}
        </span>
        <span className={cn('shrink-0 text-xs font-medium tabular-nums', rowTone(row.status))}>
          {row.days !== null ? formatDaysLeft(row.days) : row.checking ? 'Checking…' : row.status === 'error' ? 'Check failed' : 'No expiry'}
        </span>
      </span>
      {(expDate || provider || row.forced) && (
        <span className={cn('mt-0.5 block truncate text-[11px]', row.forced ? rowTone(row.status) : 'text-muted-foreground')}>
          {row.forced ? forcedNote(row.status) : expDate ?? provider?.label}
        </span>
      )}
    </>
  )

  return (
    <div className="group relative mx-1.5 rounded-xl transition-colors hover:bg-muted/30 has-[:focus-visible]:bg-muted/30">
      <div className="flex items-center gap-2 pl-3 pr-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[row.status])} />
        <div data-theme-part="badge" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/50 text-[11px] font-bold text-muted-foreground">
          {getKeyAbbr(row.key)}
        </div>
        {phone ? (
          <button type="button" aria-label={`${label}, key actions`} aria-haspopup="menu" onClick={() => setOpen(true)} className="min-h-[44px] min-w-0 flex-1 py-2.5 text-left">
            {content}
          </button>
        ) : (
          <div className="min-w-0 flex-1 py-2.5">{content}</div>
        )}
      </div>
      {!phone && (
        <div
          className={cn(
            'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-lg border border-border/40 bg-card p-0.5 shadow-sm transition-opacity',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100'
          )}
        >
          {fields.length > 0 && (
            <IconAction label={`Copy ${label} key`} onClick={() => actions.copy(id, null)}><Copy className={ICON} /></IconAction>
          )}
          {renewUrl && (
            <IconAction label={`Renew ${label}`} onClick={() => actions.renew(renewUrl)}><ExternalLink className={ICON} /></IconAction>
          )}
          <IconAction label={row.pinned ? `Unpin ${label}` : `Pin ${label}`} pressed={row.pinned} onClick={() => actions.pin(id)}>
            <Star className={cn(ICON, row.pinned && 'fill-current text-warning')} />
          </IconAction>
          <button
            type="button"
            aria-label={`More actions for ${label}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(o => !o)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className={ICON} />
          </button>
        </div>
      )}
      {!phone && open && (
        <div role="menu" aria-label={`${label} actions`} className="mb-2 ml-12 mr-2 overflow-hidden rounded-lg border border-border/40 bg-muted/20 p-0.5">
          {moreItems.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.run() }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
            >
              <span className="text-muted-foreground">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      {phone && (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuContent
            sheetHeader={
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{label}</div>
                <div className={cn('text-xs', rowTone(row.status))}>{row.days !== null ? formatDaysLeft(row.days) : provider?.label ?? 'Vault key'}</div>
              </div>
            }
          >
            {sheetItems.map(item => (
              <DropdownMenuItem key={item.id} onClick={item.run}>
                <span className="text-muted-foreground">{item.icon}</span>
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-4 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
      <span>{label}</span>
      <span className="ml-auto tabular-nums text-muted-foreground/70">{count}</span>
    </div>
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative px-3 pb-1 pt-3">
      <Search aria-hidden="true" className="pointer-events-none absolute left-6 top-1/2 mt-1 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Search keys"
        aria-label="Search keys"
        className="h-9 pl-8 text-xs"
      />
    </div>
  )
}

const providerLabel = (provider: string) => PROVIDERS.find(p => p.value === provider)?.label ?? provider

function CustomizeList({
  entries,
  settings,
  update,
  query,
}: {
  entries: HeaderEntry[]
  settings: VaultHeaderSettings
  update: (change: (current: VaultHeaderSettings) => VaultHeaderSettings) => void
  query: string
}) {
  const visible = useMemo(() => filterHeaderEntries(entries, query, providerLabel), [entries, query])
  const shownIds = useMemo(() => entries.filter(e => e.selected).map(e => e.key.id), [entries])
  return (
    <div>
      <div className="space-y-3 border-b border-border/30 px-4 py-3">
        <div role="group" aria-label="Which keys to show" className="grid grid-cols-2 gap-1 rounded-lg bg-muted/30 p-0.5">
          {([['auto', 'Automatic'], ['custom', 'Only my picks']] as const).map(([mode, text]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={settings.mode === mode}
              onClick={() => update(cur => setVaultHeaderMode(cur, mode, shownIds))}
              className={cn(
                'min-h-[44px] rounded-md px-2 text-xs font-semibold transition-colors sm:min-h-8',
                settings.mode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {text}
            </button>
          ))}
        </div>
        <label className="flex min-h-[44px] items-center justify-between gap-3 sm:min-h-0">
          <span className="text-xs font-medium text-foreground">Always show keys that expire soon or have expired</span>
          <Switch
            checked={settings.alwaysShowExpiring}
            aria-label="Always show keys that expire soon or have expired"
            onCheckedChange={checked => update(cur => ({ ...cur, alwaysShowExpiring: checked }))}
          />
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">{entries.length === 0 ? 'Your vault has no keys yet.' : 'No keys match your search.'}</p>
      ) : (
        <ul className="py-1">
          {visible.map(entry => (
            <li key={entry.key.id}>
              <label className="mx-1.5 flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-muted/30 sm:min-h-0">
                <Checkbox
                  checked={entry.selected}
                  onCheckedChange={checked => update(cur => setVaultHeaderShown(cur, entry.key.id, checked === true))}
                  aria-label={`Show ${vaultKeyLabel(entry.key)} in header`}
                />
                <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[entry.status])} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-foreground">{vaultKeyLabel(entry.key)}</span>
                  <span className={cn('block truncate text-[11px]', entry.forced ? rowTone(entry.status) : 'text-muted-foreground')}>
                    {entry.forced ? forcedNote(entry.status) : providerLabel(entry.key.provider)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function VaultKeysMenu({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const phone = usePhoneViewport()
  const { rows, entries, settings, updateSettings, toggle } = useHeaderVaultRows()
  const isRefreshing = useProviderStore(s => s.isRefreshing)
  const forceRefreshAll = useProviderStore(s => s.forceRefreshAll)
  const encryptionKey = useAuthStore(s => s.encryptionKey)
  const vaultLoading = useVaultStore(s => s.loading)
  const vaultCount = useVaultStore(s => s.keys.length)
  const [view, setView] = useState<'list' | 'customize'>('list')
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    const scope = root?.closest('[role="dialog"]')
    if (!root || !scope) return
    const onMountFocus = (event: Event) => {
      event.preventDefault()
      root.focus({ preventScroll: true })
    }
    scope.addEventListener('focusScope.autoFocusOnMount', onMountFocus)
    return () => scope.removeEventListener('focusScope.autoFocusOnMount', onMountFocus)
  }, [])

  const locked = !encryptionKey
  const openVault = useCallback(() => { navigate('/vault'); onClose() }, [navigate, onClose])
  const unlock = useCallback(() => { window.location.reload() }, [])

  const copyDeps = useMemo<CopyDeps>(() => ({
    getKey: id => useVaultStore.getState().keys.find(k => k.id === id),
    isLocked: () => !useAuthStore.getState().encryptionKey,
    writeText: text => navigator.clipboard.writeText(text),
    notify: toast,
    promptUnlock: unlock,
    openVault,
  }), [unlock, openVault])

  const actions = useMemo<RowActions>(() => ({
    copy: (id, field) => { void copyVaultKeyField(id, field, copyDeps) },
    renew: url => { window.open(safeHref(url), '_blank', 'noopener,noreferrer') },
    check: id => { void useProviderStore.getState().refreshProvider(id) },
    pin: toggle,
    hide: id => {
      updateSettings(cur => setVaultHeaderShown(cur, id, false))
      toast({
        title: 'Hidden from header',
        description: 'Change this any time with Customize.',
        history: false,
        duration: 4000,
        action: { label: 'Undo', onClick: () => updateSettings(cur => setVaultHeaderShown(cur, id, true)) },
      })
    },
    openInVault: id => { navigate(`/vault?key=${encodeURIComponent(id)}`); onClose() },
  }), [copyDeps, toggle, updateSettings, navigate, onClose])

  const customizing = view === 'customize'
  const showSearch = rows.length > SEARCH_THRESHOLD
  const filtered = useMemo(() => filterHeaderEntries(rows, query, providerLabel), [rows, query])
  const sections = [
    { label: 'Favorites', rows: filtered.filter(r => r.pinned) },
    { label: 'Needs attention', rows: filtered.filter(r => !r.pinned && r.attention) },
    { label: 'Other keys', rows: filtered.filter(r => !r.pinned && !r.attention) },
  ].filter(s => s.rows.length > 0)
  const showLabels = sections.length > 1 || sections[0]?.label !== 'Other keys'

  const goCustomize = () => { setQuery(''); setView('customize') }
  const goList = () => { setQuery(''); setView('list') }

  const renderBody = () => {
    if (locked) {
      return (
        <div className="px-4 py-8 text-center">
          <Lock className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">Your vault is locked</p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">Unlock it to see and copy your keys.</p>
          <Button size="sm" variant="outline" onClick={unlock} className="mt-3 h-9 text-xs font-bold">Unlock</Button>
        </div>
      )
    }
    if (vaultLoading && vaultCount === 0) {
      return (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading keys
        </div>
      )
    }
    if (customizing) {
      return <CustomizeList entries={entries} settings={settings} update={updateSettings} query={query} />
    }
    if (rows.length === 0) {
      return (
        <div className="px-4 py-8 text-center">
          <KeyRound className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">No keys shown</p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            {isDefaultVaultHeaderSettings(settings) ? 'Debrid and other keys with an expiry show up here.' : 'Pick which keys appear in this menu.'}
          </p>
          <Button size="sm" variant="outline" onClick={goCustomize} className="mt-3 h-9 text-xs font-bold">
            <SlidersHorizontal className={ICON} />
            Customize
          </Button>
        </div>
      )
    }
    return (
      <>
        {showSearch && <SearchBox value={query} onChange={setQuery} />}
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">No keys match your search.</p>
        ) : (
          sections.map(section => (
            <section key={section.label}>
              {showLabels && <SectionLabel label={section.label} count={section.rows.length} />}
              {section.rows.map(r => <KeyRow key={r.key.id} row={r} phone={phone} actions={actions} />)}
            </section>
          ))
        )}
      </>
    )
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col outline-none">
      <div className="flex items-center gap-2 border-b border-border/30 bg-muted/20 px-4 py-3">
        {customizing && (
          <button type="button" aria-label="Back to keys" onClick={goList} className="-ml-2 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{customizing ? 'Customize header keys' : 'Vault'}</div>
        {!customizing && <div className="ml-auto text-[13px] font-bold">{rows.length} key{rows.length !== 1 ? 's' : ''}</div>}
      </div>
      {customizing && !locked && <SearchBox value={query} onChange={setQuery} />}
      <div className="custom-scrollbar max-h-[380px] overflow-y-auto pb-2">{renderBody()}</div>
      {customizing ? (
        <div className="flex items-center gap-2 border-t border-border/30 bg-muted/20 px-3 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={isDefaultVaultHeaderSettings(settings)}
            onClick={() => updateSettings(resetVaultHeaderSettings)}
            className="h-9 flex-1 text-xs font-bold"
          >
            Reset to automatic
          </Button>
          <Button variant="outline" size="sm" onClick={goList} className="h-9 flex-1 text-xs font-bold">Done</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-border/30 bg-muted/20 px-3 py-2.5">
          <Button variant="ghost" size="sm" onClick={openVault} className="h-9 flex-1 px-2 text-xs font-bold text-primary hover:bg-primary/10">
            <KeyRound className={ICON} />
            Open Vault
          </Button>
          <Button variant="ghost" size="sm" onClick={goCustomize} disabled={locked} className="h-9 flex-1 px-2 text-xs font-bold">
            <SlidersHorizontal className={ICON} />
            Customize
          </Button>
          <Button variant="outline" size="sm" onClick={() => { void forceRefreshAll() }} disabled={isRefreshing || rows.length === 0 || locked} className="h-9 flex-1 px-2 text-xs font-bold">
            <RefreshCw className={cn(ICON, isRefreshing && 'animate-spin')} />
            {isRefreshing ? 'Checking...' : 'Check all'}
          </Button>
        </div>
      )}
    </div>
  )
}
