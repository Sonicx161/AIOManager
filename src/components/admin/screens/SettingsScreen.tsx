import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Download, FileText, KeyRound, Lock, MoreHorizontal, RotateCcw, Search, SlidersHorizontal, Upload, X } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import {
  AdminApiError, adoptSettings, exportSettings, getSettings, importSettings, saveSettings,
  type SettingRow, type SettingsImportRaw, type SettingsInfo,
} from '@/api/admin'
import { adminRetry, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import {
  SOURCE_LABEL, barSummary, changesBody, draftError, formatSetting, importDiffValues, matchesSetting, nextDrafts, rangeHint,
  shownValue, summaryValues, type SettingDraft,
} from '@/lib/admin-settings'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Callout, Chip, LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice } from '../AdminWidgets'

const SETTINGS_KEY = ['admin-settings'] as const

type Sheet =
  | { kind: 'save' }
  | { kind: 'import'; file: unknown; name: string; result: SettingsImportRaw }
  | { kind: 'importEnv' }

function SourceBadge({ row }: { row: SettingRow }) {
  if (row.envOnly) return <Chip tone="warn" icon={<Lock />}>Set in .env only</Chip>
  if (row.source === 'env') return <Chip tone="warn" icon={<Lock />}>{SOURCE_LABEL.env}</Chip>
  if (row.source === 'here') return <Chip tone="info">{SOURCE_LABEL.here}</Chip>
  if (row.source === 'internal') return <Chip>{SOURCE_LABEL.internal}</Chip>
  return <Chip>{SOURCE_LABEL.default}</Chip>
}

function ApplyLabel({ row }: { row: SettingRow }) {
  const restart = row.apply === 'restart'
  return (
    <span className={cn('inline-flex items-center gap-2 before:h-[3px] before:w-[3px] before:rounded-full before:bg-muted-foreground/60', restart ? 'text-foreground/75' : 'text-muted-foreground')}>
      {row.restartPending ? 'Saved, restart to apply' : restart ? 'Restart needed' : 'Applies live'}
    </span>
  )
}

const BOOT_SKIP_REASON: Record<string, string> = {
  invalid: 'it failed validation',
  decrypt: 'it could not be decrypted',
  'not-storable': 'this key can only come from .env',
}

function FieldError({ id, error, className }: { id: string; error: string; className?: string }) {
  return <p id={id} aria-live="polite" className={cn('text-xs text-destructive', error && 'mt-1.5', className)}>{error}</p>
}

function SettingControl({ row, draft, error, locked, onDraft, onReplace }: {
  row: SettingRow
  draft: SettingDraft | undefined
  error: string
  locked: boolean
  onDraft: (draft: SettingDraft | null) => void
  onReplace: () => void
}) {
  const value = shownValue(row, draft)
  const errorId = `setting-error-${row.key}`
  const describedBy = error ? errorId : undefined
  if (row.type === 'secret') {
    const replaced = draft?.kind === 'set'
    const cleared = draft?.kind === 'reset'
    return (
      <div className="flex items-center justify-between gap-2.5 md:justify-end">
        {replaced ? <Chip tone="info">Replaced</Chip> : cleared ? <Chip>Not set</Chip> : row.secretSet ? <Chip tone="ok">Set</Chip> : <Chip>Not set</Chip>}
        {!locked && (
          <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={onReplace}>
            {row.secretSet || replaced ? 'Replace' : 'Set value'}
          </Button>
        )}
      </div>
    )
  }
  if (row.type === 'boolean') {
    const on = value === 'true'
    return (
      <div className="flex items-center justify-between gap-2.5 text-sm text-foreground/80 md:justify-end">
        <span className="md:hidden">{on ? 'On' : 'Off'}</span>
        <span className="flex h-10 w-14 items-center justify-center">
          <Switch checked={on} disabled={locked} aria-label={row.label} onCheckedChange={next => onDraft({ kind: 'set', value: next ? 'true' : 'false' })} />
        </span>
      </div>
    )
  }
  if (row.type === 'select') {
    return (
      <Select value={value} disabled={locked} onValueChange={v => onDraft({ kind: 'set', value: v })}>
        <SelectTrigger aria-label={row.label} className="h-10 w-full rounded-xl md:w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(row.options ?? []).map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
          {value && !(row.options ?? []).includes(value) && <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    )
  }
  if (row.type === 'number') {
    const hint = rangeHint(row)
    const unit = row.unit ? row.unit.label : null
    return (
      <div className="w-full">
        <div className="flex items-center gap-2.5 md:justify-end">
          {hint && <span className="whitespace-nowrap text-xs text-muted-foreground/70">{hint}</span>}
          <span className={cn('relative min-w-0 flex-1', unit ? 'md:w-[140px] md:flex-none' : 'md:w-[120px] md:flex-none')}>
            <Input
              inputMode={unit ? 'decimal' : 'numeric'}
              value={value}
              disabled={locked}
              aria-label={unit ? `${row.label} in ${unit}` : row.label}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={describedBy}
              onChange={e => onDraft({ kind: 'set', value: e.target.value })}
              className={cn('h-10 rounded-[10px]', unit && 'pr-12', error && 'border-destructive focus-visible:ring-destructive/30')}
            />
            {unit && <i className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] not-italic text-muted-foreground">{unit}</i>}
          </span>
        </div>
        <FieldError id={errorId} error={error} className="md:text-right" />
      </div>
    )
  }
  if (row.type === 'longtext') {
    return (
      <div className="w-full">
        <Textarea
          value={value}
          disabled={locked}
          rows={4}
          aria-label={row.label}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          onChange={e => onDraft({ kind: 'set', value: e.target.value })}
          className={cn('min-h-24 rounded-[10px] font-mono text-xs', error && 'border-destructive')}
        />
        <FieldError id={errorId} error={error} />
      </div>
    )
  }
  return (
    <div className="w-full">
      <Input
        value={value}
        disabled={locked}
        aria-label={row.label}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        onChange={e => onDraft({ kind: 'set', value: e.target.value })}
        className={cn('h-10 rounded-[10px]', error && 'border-destructive')}
      />
      <FieldError id={errorId} error={error} />
    </div>
  )
}

function SettingRowView({ row, draft, error, readOnly, onDraft, onAdopt, adoptBusy }: {
  row: SettingRow
  draft: SettingDraft | undefined
  error: string
  readOnly: boolean
  onDraft: (draft: SettingDraft | null) => void
  onAdopt: () => void
  adoptBusy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [secretValue, setSecretValue] = useState('')
  const locked = readOnly || row.locked
  const more = row.envOnly && row.envOnlyReason ? `Set in .env only: ${row.envOnlyReason}${row.more ? ` ${row.more}` : ''}` : row.more
  const showMenu = !readOnly && row.source === 'here'
  const valueText = formatSetting(row, row.value)

  const closeSecret = () => { setSecretOpen(false); setSecretValue('') }

  return (
    <div
      data-settings-row={row.key}
      className={cn(
        'relative grid grid-cols-[minmax(0,1fr)_40px] gap-x-2 border-t border-border/30 py-3.5 first:border-t-0 first:pt-0',
        "[grid-template-areas:'lab_menu'_'key_menu'_'desc_desc'_'ctl_ctl'_'bdg_bdg'_'x_x']",
        "md:grid-cols-[minmax(0,1fr)_260px_40px] md:items-center md:gap-x-5 md:py-3 md:[grid-template-areas:'lab_ctl_menu'_'kb_ctl_menu'_'desc_ctl_menu'_'x_x_x']",
      )}
    >
      <div className="flex min-w-0 items-center gap-[7px] text-sm font-semibold leading-snug [grid-area:lab]">
        {draft && <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-primary" aria-hidden />}
        {draft && <span className="sr-only">Edited</span>}
        <span className="min-w-0">{row.label}</span>
      </div>
      <div className="contents md:mt-[3px] md:flex md:min-w-0 md:items-center md:gap-2.5 md:[grid-area:kb]">
        <code className="mt-0.5 break-all font-mono text-xs font-medium text-muted-foreground [grid-area:key] md:mt-0 md:[grid-area:auto]">{row.key}</code>
        <span className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [grid-area:bdg] md:mt-0 md:[grid-area:auto]">
          <SourceBadge row={row} />
          {!row.envOnly && <ApplyLabel row={row} />}
          {row.canAdopt && !readOnly && row.storedValue === null && (
            <button type="button" className="-my-2 inline-flex min-h-10 items-center px-0.5 text-xs font-semibold text-primary" onClick={() => setAdopting(true)}>
              Use dashboard value
            </button>
          )}
        </span>
      </div>
      <div className={cn('mt-1.5 text-xs leading-relaxed text-muted-foreground [grid-area:desc] md:mt-1', open ? 'md:block' : 'md:flex md:min-w-0')}>
        <span className={cn(!open && 'md:min-w-0 md:truncate')}>
          {row.summary}
          {open && more && <span> {more}</span>}
        </span>
        {more && (
          <button type="button" className="-my-3 ml-1 inline-flex min-h-10 shrink-0 items-center px-0.5 text-xs font-semibold text-foreground/80" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
      <div className="relative mt-2.5 min-w-0 [grid-area:ctl] md:mt-0 md:flex md:flex-col md:items-end md:justify-center">
        <SettingControl row={row} draft={draft} error={error} locked={locked} onDraft={onDraft} onReplace={() => setSecretOpen(true)} />
      </div>
      <div className="relative self-start [grid-area:menu] md:self-center">
        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-full text-muted-foreground" aria-label={`More for ${row.label}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[280px]">
              <DropdownMenuItem className="min-h-10 gap-2.5" onClick={() => onDraft({ kind: 'reset' })}>
                <RotateCcw className="h-4 w-4 text-muted-foreground" />
                <span className="text-left">
                  Reset to default
                  <small className="block text-xs text-muted-foreground">
                    Back to {row.type === 'secret' ? 'Not set' : formatSetting(row, row.defaultValue)}. {row.apply === 'live' ? 'Applies live.' : 'Needs a restart.'}
                  </small>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-10 gap-2.5"
                onClick={() => { void navigator.clipboard?.writeText(row.key); toast({ title: 'Copied', description: row.key }) }}
              >
                <Copy className="h-4 w-4 text-muted-foreground" /> Copy key name
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {row.bootSkipped && !adopting && !secretOpen && (
        <p className="mt-3 text-xs text-warning [grid-area:x] md:mt-2.5 md:ml-auto md:mr-[60px] md:w-full md:max-w-[640px]">
          Stored value was rejected at startup: {BOOT_SKIP_REASON[row.bootSkipped] ?? row.bootSkipped}. The default or .env value is in use.
        </p>
      )}
      {(adopting || secretOpen || (row.source === 'env' && row.storedValue !== null)) && (
        <div className="mt-3 [grid-area:x] md:mt-2.5 md:ml-auto md:mr-[60px] md:w-full md:max-w-[640px]">
          {adopting ? (
            <div className="rounded-2xl border border-border/40 bg-muted/20 p-3.5">
              <h4 className="text-[13px] font-semibold">Use the dashboard value</h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                This copies {valueText} into the dashboard store. It takes effect once you remove {row.key} from .env and restart; until then .env keeps winning.
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => setAdopting(false)}>Cancel</Button>
                <Button type="button" size="sm" className="min-h-10" disabled={adoptBusy} onClick={() => { onAdopt(); setAdopting(false) }}>Copy to dashboard</Button>
              </div>
            </div>
          ) : secretOpen ? (
            <div className="rounded-2xl border border-border/40 bg-muted/20 p-3.5">
              <label htmlFor={`secret-${row.key}`} className="mb-1.5 block text-xs font-medium text-foreground/80">New value for {row.key}</label>
              <Input
                id={`secret-${row.key}`}
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                placeholder="Paste the new value"
                value={secretValue}
                onChange={e => setSecretValue(e.target.value)}
                className="h-10 rounded-[10px]"
                autoFocus
              />
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">Never prefilled and never shown again after saving.</p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={closeSecret}>Cancel</Button>
                <Button type="button" size="sm" className="min-h-10" disabled={!secretValue.trim()} onClick={() => { onDraft({ kind: 'set', value: secretValue }); closeSecret() }}>Replace</Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Dashboard value {formatSetting(row, row.storedValue)} is stored. Remove {row.key} from .env and restart to use it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function SummaryItem({ label, keyName, value, bad, muted, restart }: { label: string; keyName: string; value: ReactNode; bad?: boolean; muted?: boolean; restart?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-border/30 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <b className="block text-[13px] font-semibold">{label}</b>
        <code className="font-mono text-[11.5px] text-muted-foreground">{keyName}</code>
      </div>
      <div className={cn('min-w-0 max-w-[65%] text-right text-[13px] [overflow-wrap:anywhere]', bad ? 'text-destructive' : muted && 'text-muted-foreground')}>
        {value}
        {restart && <div className="mt-1"><Chip>Restart needed</Chip></div>}
      </div>
    </div>
  )
}

function OldNew({ from, to }: { from: string; to: string }) {
  return <><span className="text-muted-foreground">{from}</span> {'→'} {to}</>
}

export function SettingsScreen() {
  const queryClient = useQueryClient()
  const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: SETTINGS_KEY, queryFn: getSettings, staleTime: 30_000, retry: adminRetry })
  const view = paneView({ isPending, data, error })
  const [drafts, setDrafts] = useState<Record<string, SettingDraft>>({})
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [activeChip, setActiveChip] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(() => (data?.groups ?? []).flatMap(g => g.rows), [data])
  const byKey = useMemo(() => new Map(rows.map(r => [r.key, r])), [rows])
  const bar = barSummary(rows, drafts, serverErrors)
  const [adoptErrors, setAdoptErrors] = useState<Record<string, string>>({})
  const readOnly = Boolean(data?.readOnly)

  const applyInfo = (info: SettingsInfo) => queryClient.setQueryData(SETTINGS_KEY, info)

  const save = useMutation({
    mutationFn: () => saveSettings(changesBody(rows, drafts)),
    onSuccess: (result) => {
      applyInfo(result.settings)
      setDrafts({})
      setServerErrors({})
      setSheet(null)
      const n = result.saved
      const rs = result.restartNeeded.length
      toast({ title: `Saved ${n} change${n === 1 ? '' : 's'}`, description: `${rs ? `${rs} need${rs === 1 ? 's' : ''} a restart. ` : ''}Audit entry added.` })
      queryClient.invalidateQueries({ queryKey: ['admin-audit'] })
    },
    onError: (e: Error) => {
      setSheet(null)
      if (e instanceof AdminApiError && e.fieldErrors) {
        const errors = e.fieldErrors
        setServerErrors(errors)
        setQuery('')
        const first = rows.find(r => errors[r.key])
        if (first) setTimeout(() => document.querySelector(`[data-settings-row="${first.key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
      }
      toast({ variant: 'destructive', title: 'Not saved', description: e.message })
    },
  })

  const adopt = useMutation({
    mutationFn: (keys: string[]) => adoptSettings(keys),
    onSuccess: (result, keys) => {
      setAdoptErrors({})
      applyInfo(result.settings)
      setSheet(null)
      toast({
        title: keys.length === 1 ? 'Copied to the dashboard' : `Copied ${result.copied} value${result.copied === 1 ? '' : 's'}`,
        description: keys.length === 1 ? `Remove ${keys[0]} from .env and restart to use it. Audit entry added.` : 'They apply once removed from .env. Audit entry added.',
      })
    },
    onError: (e: Error, keys) => {
      const errors = e instanceof AdminApiError && e.fieldErrors ? e.fieldErrors : {}
      setAdoptErrors(errors)
      const failed = Object.keys(errors)
      toast({ variant: 'destructive', title: 'Not copied', description: failed.length ? `${failed.join(', ')}: ${Object.values(errors)[0]}` : e.message })
      if (keys.length === 1 && failed.length) setSheet(null)
    },
  })

  const runImport = useMutation({
    mutationFn: ({ file, apply }: { file: unknown; name: string; apply: boolean }) => importSettings(file, apply),
    onSuccess: (result, vars) => {
      if (!vars.apply) {
        setSheet({ kind: 'import', file: vars.file, name: vars.name, result })
        return
      }
      if (result.info) applyInfo(result.info)
      setSheet(null)
      const rejected = result.rejected.length
      const skipped = result.skipped.length
      toast({ title: `Imported ${result.applied} change${result.applied === 1 ? '' : 's'}`, description: `${rejected ? `${rejected} rejected, ` : ''}${skipped ? `${skipped} skipped. ` : ''}Audit entry added.` })
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Import failed', description: e.message }),
  })

  const onDraft = (row: SettingRow, draft: SettingDraft | null) => {
    setDrafts(prev => nextDrafts(prev, row, draft))
    if (serverErrors[row.key]) setServerErrors(({ [row.key]: _gone, ...rest }) => rest)
  }

  const doExport = async () => {
    try {
      const file = await exportSettings()
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'aiomanager-settings.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      const left = file.secretsLeftOut
      toast({ title: 'Exported aiomanager-settings.json', description: left.length ? `Left out ${left.length} secret${left.length === 1 ? '' : 's'}: ${left.join(', ')}.` : 'No secrets are set.' })
    } catch (e) {
      toast({ variant: 'destructive', title: 'Export failed', description: (e as Error).message })
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      runImport.mutate({ file: parsed, name: file.name, apply: false })
    } catch {
      toast({ variant: 'destructive', title: 'Not a settings file', description: 'Choose a JSON file exported from this screen.' })
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const jumpTo = (id: string, label: string) => {
    setActiveChip(label)
    setQuery('')
    requestAnimationFrame(() => document.getElementById(`settings-group-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const visibleGroups = (data?.groups ?? []).map(g => ({ ...g, rows: g.rows.filter(r => matchesSetting(r, query)) })).filter(g => g.rows.length)
  const envRows = rows.filter(r => r.source === 'env' && r.canAdopt && r.storedValue !== r.value)
  const envStays = rows.filter(r => r.source === 'env' && !r.canAdopt).map(r => r.key)
  const editedRows = rows.filter(r => drafts[r.key])
  const restartCount = editedRows.filter(r => r.apply === 'restart').length
  const dot = <i className="not-italic max-md:hidden"> {'·'} </i>

  return (
    <div className={cn(bar.count > 0 && 'pb-24')}>
      <ScreenHeader
        title="Settings"
        subtitle="Schema-driven from the server env registry. Secrets never leave the server."
        actions={data && !readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-10 w-10 rounded-full" aria-label="Settings actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[280px]">
              <DropdownMenuItem className="min-h-10 gap-2.5" onClick={() => void doExport()}>
                <Download className="h-4 w-4 text-muted-foreground" />
                <span className="text-left">Export settings<small className="block text-xs text-muted-foreground">JSON. Secrets are left out and listed.</small></span>
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-10 gap-2.5" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="text-left">Import settings<small className="block text-xs text-muted-foreground">Checked first; shows a diff before applying.</small></span>
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-10 gap-2.5" onClick={() => { setAdoptErrors({}); setSheet({ kind: 'importEnv' }) }}>
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-left">Import from .env<small className="block text-xs text-muted-foreground">Copies .env values into the dashboard.</small></span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      />
      <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" aria-hidden tabIndex={-1} onChange={e => void onFile(e.target.files?.[0])} />

      {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}
      {view === 'loading' ? (
        <PaneLoading />
      ) : view === 'gone' || !data ? (
        <PaneError message={paneErrorCopy(error, 'The settings list')} onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <>
          {data.bootReadFailed && (
            <Callout tone="warn" title="Stored settings could not be read at startup." className="mb-4">
              <p>
                {data.bootLiveReapplied
                  ? 'Live settings were applied once the database answered. The rest use .env or their defaults until a restart.'
                  : 'Settings saved here use .env or their defaults until a restart.'}
              </p>
            </Callout>
          )}
          <LegendNote className="mb-4">
            <b>.env</b> wins over <b>Set here</b>, which wins over <b>Default</b>. Values from .env are read-only here.
            {' '}Applies live on this server; other instances on restart.
            {readOnly && ' This is a read-only replica; change settings on the primary.'}
          </LegendNote>

          <div className="relative mb-2.5 md:max-w-[520px]">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className="h-10 rounded-[10px] pl-[38px] pr-11 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0 h-10 w-10 rounded-full text-muted-foreground" aria-label="Clear search" onClick={() => setQuery('')}>
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0 [&::-webkit-scrollbar]:hidden" role="group" aria-label="Jump to a group">
            {data.groups.map(g => (
              <button
                key={g.id}
                type="button"
                onClick={() => jumpTo(g.id, g.chipLabel)}
                className={cn(
                  'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors',
                  activeChip === g.chipLabel ? 'border-foreground/15 bg-foreground/[0.08] text-foreground' : 'border-border/40 bg-foreground/[0.03] text-muted-foreground hover:text-foreground',
                )}
              >
                {g.chipLabel} <em className="text-xs not-italic text-foreground/35">{g.rows.length}</em>
              </button>
            ))}
          </div>

          <div className="space-y-4">
            {visibleGroups.map(group => (
              <div key={group.id} id={`settings-group-${group.id}`} className="scroll-mt-4">
                <Panel>
                  <PanelHead
                    icon={group.rows.some(r => r.type === 'secret') ? <KeyRound /> : <SlidersHorizontal />}
                    title={group.title}
                    detail={group.note ?? undefined}
                  />
                  <div>
                    {group.rows.map(r => (
                      <SettingRowView
                        key={r.key}
                        row={r}
                        draft={drafts[r.key]}
                        error={draftError(r, drafts[r.key]) || serverErrors[r.key] || ''}
                        readOnly={readOnly}
                        onDraft={d => onDraft(r, d)}
                        onAdopt={() => adopt.mutate([r.key])}
                        adoptBusy={adopt.isPending}
                      />
                    ))}
                  </div>
                </Panel>
              </div>
            ))}
            {visibleGroups.length === 0 && (
              <Panel>
                <p className="py-8 text-center text-xs text-muted-foreground">No settings match "{query}".</p>
              </Panel>
            )}
          </div>
        </>
      )}

      {bar.count > 0 && (
        <div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] left-1/2 z-40 w-[calc(100vw-1.25rem)] max-w-[600px] -translate-x-1/2 md:bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)]" data-settings-bar>
          <div data-theme-part="toolbar" className="flex items-center gap-2 rounded-[1.75rem] border border-border/90 bg-card/95 py-2 pl-[18px] pr-2 shadow-[0_18px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="min-w-0 flex-1 text-[13px] leading-snug" role="status">
              <b className="font-semibold">{bar.count} change{bar.count === 1 ? '' : 's'}</b>
              {bar.errors ? (
                <span className="text-destructive max-md:block">{dot}{bar.errors} to fix</span>
              ) : bar.restart ? (
                <span className="text-muted-foreground max-md:block">{dot}{bar.restart} need{bar.restart === 1 ? 's' : ''} a restart</span>
              ) : (
                <span className="text-muted-foreground max-md:block">{dot}all apply live</span>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" className="min-h-10" onClick={() => { setDrafts({}); setServerErrors({}); toast({ title: 'Changes discarded', description: 'Nothing was written.' }) }}>Discard</Button>
            <Button type="button" size="sm" className="min-h-10" disabled={bar.errors > 0 || save.isPending} onClick={() => setSheet({ kind: 'save' })}>Save</Button>
          </div>
        </div>
      )}

      <Dialog open={sheet !== null} onOpenChange={open => { if (!open) setSheet(null) }}>
        <DialogContent className="max-w-lg">
          {sheet?.kind === 'save' && (
            <>
              <DialogHeader>
                <DialogTitle>Save {editedRows.length} change{editedRows.length === 1 ? '' : 's'}?</DialogTitle>
                <DialogDescription>Check the new values before they are written.</DialogDescription>
              </DialogHeader>
              <div className="rounded-xl border border-border/35 bg-foreground/[0.025] px-3">
                {editedRows.map(r => {
                  const v = summaryValues(r, drafts[r.key])
                  return <SummaryItem key={r.key} label={r.label} keyName={r.key} value={<OldNew from={v.from} to={v.to} />} restart={r.apply === 'restart'} />
                })}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Saved to the dashboard store and added to the audit log. Secret values are never shown or logged.
                {restartCount ? ` ${restartCount} change${restartCount === 1 ? ' takes' : 's take'} effect after a restart.` : ''}
              </p>
              <DialogFooter>
                <Button type="button" variant="outline" className="min-h-10" onClick={() => setSheet(null)}>Cancel</Button>
                <Button type="button" className="min-h-10" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving' : 'Save changes'}</Button>
              </DialogFooter>
            </>
          )}
          {sheet?.kind === 'import' && (
            <>
              <DialogHeader>
                <DialogTitle>Import settings</DialogTitle>
                <DialogDescription>{sheet.name}, checked against the registry. Nothing changes until you apply.</DialogDescription>
              </DialogHeader>
              <div className="rounded-xl border border-border/35 bg-foreground/[0.025] px-3">
                {sheet.result.changes.map(c => {
                  const row = byKey.get(c.key)
                  const v = importDiffValues(row, c)
                  return <SummaryItem key={c.key} label={c.label} keyName={c.key} value={<OldNew from={v.from} to={v.to} />} />
                })}
                {sheet.result.rejected.map(r => <SummaryItem key={r.key} label={r.label ?? r.key} keyName={r.key} bad value={`Rejected: ${r.error}`} />)}
                {sheet.result.skipped.map(s => <SummaryItem key={s.key} label={s.label} keyName={s.key} muted value={`Skipped: ${s.reason.toLowerCase()}`} />)}
                {!sheet.result.changes.length && !sheet.result.rejected.length && !sheet.result.skipped.length && (
                  <p className="py-4 text-center text-xs text-muted-foreground">The file holds no settings.</p>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">Secrets are never in an export, so none are imported.</p>
              <DialogFooter>
                <Button type="button" variant="outline" className="min-h-10" onClick={() => setSheet(null)}>Cancel</Button>
                <Button type="button" className="min-h-10" disabled={!sheet.result.changes.length || runImport.isPending} onClick={() => runImport.mutate({ file: sheet.file, name: sheet.name, apply: true })}>
                  Apply {sheet.result.changes.length} change{sheet.result.changes.length === 1 ? '' : 's'}
                </Button>
              </DialogFooter>
            </>
          )}
          {sheet?.kind === 'importEnv' && (
            <>
              <DialogHeader>
                <DialogTitle>Import from .env</DialogTitle>
                <DialogDescription>Copies these .env values into the dashboard store. Each one takes effect once you remove it from .env.</DialogDescription>
              </DialogHeader>
              <div className="rounded-xl border border-border/35 bg-foreground/[0.025] px-3">
                {envRows.map(r => adoptErrors[r.key]
                  ? <SummaryItem key={r.key} label={r.label} keyName={r.key} bad value={`Not copied: ${adoptErrors[r.key]}`} />
                  : <SummaryItem key={r.key} label={r.label} keyName={r.key} value={formatSetting(r, r.value)} />)}
                {!envRows.length && <p className="py-4 text-center text-xs text-muted-foreground">No .env values can be copied.</p>}
              </div>
              {envStays.length > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">{envStays.join(', ')} stay{envStays.length === 1 ? 's' : ''} in .env: secrets and keys set in .env only.</p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" className="min-h-10" onClick={() => setSheet(null)}>Cancel</Button>
                <Button type="button" className="min-h-10" disabled={!envRows.length || adopt.isPending} onClick={() => adopt.mutate(envRows.map(r => r.key))}>
                  Copy {envRows.length} value{envRows.length === 1 ? '' : 's'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
