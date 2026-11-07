import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { mapConcurrent } from '@/lib/concurrency'
import type { CloneMode } from '@/lib/clone-mode'
import { cn, getAddonGroupKey } from '@/lib/utils'
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore, getStremioAuthKey } from '@/store/accountStore'
import { AddonIcon } from '@/components/ui/addon-icon'
import { useProfileStore } from '@/store/profileStore'
import { Account } from '@/types/account'
import type { AddonDescriptor } from '@/types/addon'
import type { BulkResult } from '@/types/saved-addon'
import { appendBulkResult, bulkDoneLine } from '@/lib/bulk-result'
import {
  BULK_ACTION_GROUPS,
  BULK_ACTION_OPTIONS,
  buildDefaultBulkPreview,
  getAccountName,
  getBulkActionDefinition,
  getReceiptLabels,
  type BatchPreview,
  type BulkAction,
  type BulkAccountTarget,
  type BulkExecuteContext,
  type BulkPreviewContext,
  type PreviewAccountRow,
  type PreviewStat,
} from './bulk-actions/registry'
import { AccountAvatar } from './AccountAvatar'
import { AddonTag } from '@/components/addons/AddonTag'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Info, LayoutGrid, Library, Loader2, PlusCircle, ShieldCheck, Trash2, Search, Tags, X } from 'lucide-react'
import { useState, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { OperationProgress } from '@/components/ui/operation-progress'


interface BatchOperationsDialogProps {
  selectedAccounts: Account[]
  allAccounts?: Account[]
  initialAction?: BulkAction
  onClose: () => void
}

type BulkProgress = {
  status: 'running' | 'cancelling' | 'cancelled' | 'complete'
  current: number
  total: number
  accountName?: string
}

type ResultSummary = {
  added: number
  updated: number
  removed: number
  skipped: number
  protected: number
  rows: PreviewAccountRow[]
}

function summarizeResult(result: BulkResult, accounts: Account[], action?: BulkAction): ResultSummary {
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  const labels = getReceiptLabels(action)

  return result.details.reduce<ResultSummary>((summary, detail) => {
    const added = detail.result.added.length
    const updated = detail.result.updated.length
    const removed = detail.result.removed?.length ?? 0
    const skipped = detail.result.skipped.length
    const protectedCount = detail.result.protected.length

    summary.added += added
    summary.updated += updated
    summary.removed += removed
    summary.skipped += skipped
    summary.protected += protectedCount

    const parts = [
      added > 0 ? `${added} ${labels.added}` : '',
      updated > 0 ? `${updated} ${labels.updated}` : '',
      removed > 0 ? `${removed} ${labels.removed}` : '',
      skipped > 0 ? `${skipped} ${labels.skipped}` : '',
      protectedCount > 0 ? `${protectedCount} ${labels.protected}` : '',
    ].filter(Boolean)
    const protectedWarning = labels.protectedIsWarning && protectedCount > 0

    summary.rows.push({
      id: detail.accountId,
      name: getAccountName(accountsById.get(detail.accountId)),
      detail: parts.length > 0 ? parts.join(', ') : 'Completed',
      tone: skipped > 0 || protectedWarning ? 'warning' : 'success',
    })

    return summary
  }, { added: 0, updated: 0, removed: 0, skipped: 0, protected: 0, rows: [] })
}

function PreviewStatCard({ stat }: { stat: PreviewStat }) {
  return (
    <div data-theme-tone="status" data-theme-part="panel" className={cn(
      "min-w-0 rounded-xl border bg-background/45 p-2.5",
      stat.tone === 'success' && "border-success/25 bg-success/5",
      stat.tone === 'warning' && "border-warning/25 bg-warning/5",
      stat.tone === 'destructive' && "border-destructive/25 bg-destructive/5",
      (!stat.tone || stat.tone === 'muted') && "border-border/35"
    )}>
      <div className="text-[11px] font-semibold uppercase text-muted-foreground">{stat.label}</div>
      <div className="mt-1 truncate text-base font-bold tabular-nums">{stat.value}</div>
      {stat.detail && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{stat.detail}</div>}
    </div>
  )
}

function BatchImpactPreview({ preview, accounts }: { preview: BatchPreview; accounts: Account[] }) {
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  const maskedAccountLabel = useMaskedAccountLabel()

  return (
    <div data-theme-tone="status" data-theme-part="panel" className={cn(
      "space-y-3 rounded-2xl border border-dashed bg-muted/20 p-3",
      preview.tone === 'warning' && "border-warning/35 bg-warning/5",
      preview.tone === 'destructive' && "border-destructive/35 bg-destructive/5",
      preview.tone === 'success' && "border-success/30 bg-success/5",
      preview.tone === 'muted' && "border-border/45"
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Info className="h-3 w-3" />
            Before You Run This
          </h4>
          <p className="mt-1 text-sm font-medium">{preview.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{preview.description}</p>
        </div>
        <div data-theme-part="badge" className="shrink-0 rounded-full border border-border/35 bg-background/60 px-2.5 py-1 text-xs font-semibold tabular-nums">
          {preview.targetCount} account{preview.targetCount !== 1 ? 's' : ''}
        </div>
      </div>

      {preview.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {preview.stats.map((stat) => (
            <PreviewStatCard key={stat.label} stat={stat} />
          ))}
        </div>
      )}

      {preview.addons.length > 0 && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase text-muted-foreground">Add-ons this touches</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {preview.addons.slice(0, 8).map((addon) => (
              <div data-theme-tone="status"
                key={addon.id}
                data-theme-part="panel"
                className={cn(
                  "flex min-w-[150px] max-w-[190px] items-center gap-2 rounded-xl border border-border/25 bg-background/40 px-2.5 py-2",
                  addon.tone === 'destructive' && "border-destructive/25 bg-destructive/5",
                  addon.tone === 'warning' && "border-warning/25 bg-warning/5",
                  addon.tone === 'success' && "border-success/20 bg-success/5"
                )}
              >
                <AddonIcon
                  name={addon.name}
                  logo={addon.logo}
                  className="h-7 w-7"
                  textClassName="text-xs"
                  imageClassName="p-0.5"
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{addon.name}</div>
                  <div className={cn(
                    "truncate text-[11px] text-muted-foreground",
                    addon.tone === 'destructive' && "text-destructive",
                    addon.tone === 'warning' && "text-warning",
                    addon.tone === 'success' && "text-success"
                  )}>
                    {addon.detail}
                  </div>
                </div>
              </div>
            ))}
            {preview.addons.length > 8 && (
              <div className="flex min-w-20 items-center justify-center rounded-xl border border-border/25 bg-background/35 px-3 text-xs font-semibold text-muted-foreground">
                +{preview.addons.length - 8} more
              </div>
            )}
          </div>
        </div>
      )}

      {preview.rows.length > 0 && (
        <div className="space-y-1.5">
          {preview.rows.slice(0, 4).map((row) => {
            const account = accountsById.get(row.id)
            return (
              <div key={row.id} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/25 bg-background/35 px-2.5 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  {account && <AccountAvatar account={account} size="xs" showStatus={false} />}
                  <span className="min-w-0 truncate text-xs font-medium">{account ? maskedAccountLabel(account) : row.name}</span>
                </span>
                <span className={cn(
                  "max-w-[58%] shrink-0 truncate text-right text-xs text-muted-foreground",
                  row.tone === 'warning' && "text-warning",
                  row.tone === 'destructive' && "text-destructive",
                  row.tone === 'success' && "text-success"
                )}>
                  {row.detail}
                </span>
              </div>
            )
          })}
          {preview.rows.length > 4 && (
            <div className="px-2 text-[11px] text-muted-foreground">+{preview.rows.length - 4} more account{preview.rows.length - 4 !== 1 ? 's' : ''}</div>
          )}
        </div>
      )}

      {preview.notes.length > 0 && (
        <div className="space-y-1 border-t border-border/25 pt-2">
          {preview.notes.map((note) => (
            <p key={note} className="text-[11px] leading-relaxed text-muted-foreground">{note}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultReceipt({ result, accounts, action }: { result: BulkResult; accounts: Account[]; action: BulkAction }) {
  const maskedAccountLabel = useMaskedAccountLabel()
  const summary = summarizeResult(result, accounts, action)
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  const labels = getReceiptLabels(action)
  const hasWarnings = result.failed > 0 || summary.skipped > 0 || (labels.protectedIsWarning && summary.protected > 0)

  return (
    <div data-theme-tone="status" data-theme-part="panel" className={cn(
      "space-y-3 rounded-2xl border p-3 animate-in fade-in slide-in-from-top-2",
      hasWarnings ? "border-warning/25 bg-warning/10" : "border-success/20 bg-success/10"
    )}>
      <div className="flex items-start gap-2">
        <CheckCircle2 className={cn("mt-0.5 h-4 w-4", hasWarnings ? "text-warning" : "text-success")} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium", hasWarnings ? "text-warning" : "text-success")}>
            {bulkDoneLine(result)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {summary.added} {labels.added}, {summary.updated} {labels.updated}, {summary.removed} {labels.removed}, {summary.skipped} {labels.skipped}, {summary.protected} {labels.protected}.
          </p>
        </div>
      </div>

      {summary.rows.length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {summary.rows.slice(0, 6).map((row) => {
            const account = accountsById.get(row.id)
            return (
              <div key={row.id} data-theme-part="panel" className="flex items-center gap-2 rounded-xl border border-border/25 bg-background/35 px-2.5 py-2">
                {account && <AccountAvatar account={account} size="xs" showStatus={false} />}
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{account ? maskedAccountLabel(account) : row.name}</div>
                  <div className={cn(
                    "mt-0.5 truncate text-[11px] text-muted-foreground",
                    row.tone === 'warning' && "text-warning",
                    row.tone === 'success' && "text-success"
                  )}>
                    {row.detail}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {result.errors.length > 0 && (
        <ul className="space-y-1 border-t border-border/25 pt-2 text-xs text-destructive">
          {result.errors.map((entry) => {
            const errorAccount = accounts.find(account => account.id === entry.accountId)
            return (
              <li key={`${entry.accountId}-${entry.error}`}>
                {errorAccount ? maskedAccountLabel(errorAccount) : getAccountName(errorAccount)}: {entry.error}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function BatchOperationsDialog({
  selectedAccounts,
  allAccounts = [],
  initialAction,
  onClose,
}: BatchOperationsDialogProps) {
  const library = useAddonStore(s => s.library)
  const getAllTags = useAddonStore(s => s.getAllTags)
  const bulkApplySavedAddons = useAddonStore(s => s.bulkApplySavedAddons)
  const bulkRemoveAddons = useAddonStore(s => s.bulkRemoveAddons)
  const bulkReinstallAddons = useAddonStore(s => s.bulkReinstallAddons)
  const bulkInstallFromUrls = useAddonStore(s => s.bulkInstallFromUrls)
  const bulkReplaceUrl = useAddonStore(s => s.bulkReplaceUrl)
  const bulkCloneAccount = useAddonStore(s => s.bulkCloneAccount)
  const bulkRemoveByTag = useAddonStore(s => s.bulkRemoveByTag)
  const bulkSyncOrder = useAddonStore(s => s.bulkSyncOrder)
  const loading = useAddonStore(s => s.loading)
  const bulkProtectAddons = useAccountStore(s => s.bulkProtectAddons)
  const bulkSetHideConfigure = useAccountStore(s => s.bulkSetHideConfigure)
  const profiles = useProfileStore(s => s.profiles)
  const maskedAccountLabel = useMaskedAccountLabel()

    const [action, setAction] = useState<BulkAction>(initialAction ?? 'install-from-library')
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [activeActionIndex, setActiveActionIndex] = useState(0)
  const actionTriggerRef = useRef<HTMLButtonElement>(null)
  const actionMenuRef = useRef<HTMLDivElement>(null)
  const [selectedSavedAddonIds, setSelectedSavedAddonIds] = useState<Set<string>>(new Set())
  const [selectedAddonIds, setSelectedAddonIds] = useState<Set<string>>(new Set())
  const [selectedUpdateAddonIds, setSelectedUpdateAddonIds] = useState<Set<string>>(new Set())
  const [selectedBulkTag, setSelectedBulkTag] = useState<string>('')

  const [filterQuery, setFilterQuery] = useState('')
  const [debouncedFilterQuery, setDebouncedFilterQuery] = useState('')
  const filterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleFilterChange = (val: string) => {
    setFilterQuery(val)
    if (filterTimeoutRef.current) clearTimeout(filterTimeoutRef.current)
    filterTimeoutRef.current = setTimeout(() => {
      setDebouncedFilterQuery(val)
    }, 150)
  }
  const [urlList, setUrlList] = useState<string>('')
  const [replaceFindText, setReplaceFindText] = useState<string>('')
  const [replaceWithText, setReplaceWithText] = useState<string>('')
  const [sourceAccountId, setSourceAccountId] = useState<string>('')
  const [overwriteClone, setOverwriteClone] = useState(false)
  const [cloneMode, setCloneMode] = useState<CloneMode>('full-mirror')
  const [mirrorAutopilot, setMirrorAutopilot] = useState(false)
  const [showProtected, setShowProtected] = useState(true)

  const [installMode, setInstallMode] = useState<'profile' | 'tag'>('profile')
  const [selectedInstallProfileId, setSelectedInstallProfileId] = useState<string>('')
  const [selectedInstallTagName, setSelectedInstallTagName] = useState<string>('')

  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)
  const [progress, setProgress] = useState<BulkProgress | null>(null)
  const cancelRequestedRef = useRef(false)
  // Shared by every deploy in one run: Cancel here or on any deploy question stops them all.
  const batchRef = useRef<AbortController | null>(null)
  const isExecuting = progress?.status === 'running' || progress?.status === 'cancelling'
  const actionDefinition = getBulkActionDefinition(action)
  const ActionIcon = actionDefinition.icon
  const selectedActionIndex = BULK_ACTION_OPTIONS.indexOf(action)
  const activeAction = BULK_ACTION_OPTIONS[activeActionIndex] ?? action
  const actionMenuId = 'batch-action-menu'
  const getActionOptionId = (item: BulkAction) => `batch-action-option-${item}`

  useEffect(() => {
    if (!actionMenuOpen) return

    setActiveActionIndex(selectedActionIndex >= 0 ? selectedActionIndex : 0)
    requestAnimationFrame(() => actionMenuRef.current?.focus())

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (actionMenuRef.current?.contains(target) || actionTriggerRef.current?.contains(target)) return
      setActionMenuOpen(false)
    }

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setActionMenuOpen(false)
      actionTriggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleDocumentKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleDocumentKeyDown, true)
    }
  }, [actionMenuOpen, selectedActionIndex])

  const selectAction = (item: BulkAction) => {
    setAction(item)
    setActionMenuOpen(false)
    requestAnimationFrame(() => actionTriggerRef.current?.focus())
  }

  const handleActionMenuKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const moveActive = (nextIndex: number) => {
      setActionMenuOpen(true)
      setActiveActionIndex((nextIndex + BULK_ACTION_OPTIONS.length) % BULK_ACTION_OPTIONS.length)
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveActive(actionMenuOpen ? activeActionIndex + 1 : Math.max(selectedActionIndex, 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        moveActive(actionMenuOpen ? activeActionIndex - 1 : Math.max(selectedActionIndex, 0))
        break
      case 'Home':
        e.preventDefault()
        moveActive(0)
        break
      case 'End':
        e.preventDefault()
        moveActive(BULK_ACTION_OPTIONS.length - 1)
        break
      case 'Enter':
      case ' ':
        if (!actionMenuOpen) return
        e.preventDefault()
        selectAction(activeAction)
        break
      case 'Escape':
        if (!actionMenuOpen) return
        e.preventDefault()
        e.stopPropagation()
        setActionMenuOpen(false)
        actionTriggerRef.current?.focus()
        break
      case 'Tab':
        setActionMenuOpen(false)
        break
    }
  }

  useEffect(() => {
    setSelectedSavedAddonIds(new Set())
    setSelectedAddonIds(new Set())
    setSelectedUpdateAddonIds(new Set())
    setSelectedBulkTag('')
    setReplaceFindText('')
    setReplaceWithText('')
    if (filterTimeoutRef.current) clearTimeout(filterTimeoutRef.current)
    setFilterQuery('') // Reset filter on action switch
    setDebouncedFilterQuery('')
    setError(null)
    setSuccess(false)
    setResult(null)
    setProgress(null)
    cancelRequestedRef.current = false
    setActionMenuOpen(false)
  }, [action])

  const libraryArray = useMemo(() => Object.values(library), [library])

  const sortedSavedAddons = [...libraryArray]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(a => {
      if (!debouncedFilterQuery) return true
      return a.name.toLowerCase().includes(debouncedFilterQuery.toLowerCase()) ||
        a.manifest.name.toLowerCase().includes(debouncedFilterQuery.toLowerCase())
    })

  const allTags = getAllTags()

  const currentTagAddonsCount = selectedInstallTagName
    ? libraryArray.filter((addon) => addon.tags.includes(selectedInstallTagName)).length
    : 0

  const isTagAction = action === 'install-from-library' && installMode === 'tag'
  const isInvalidTag = isTagAction && selectedInstallTagName !== '' && currentTagAddonsCount === 0
  const isInvalidReplace = action === 'replace-url' && !replaceFindText.trim()

  const allAddonsRaw = useMemo(() => {
    const allAddonsMap = new Map<string, { addon: AddonDescriptor, accounts: Account[] }>()

    selectedAccounts.forEach((acc: Account) => {
      acc.addons.forEach((addon: AddonDescriptor) => {
        const key = getAddonGroupKey(addon)
        if (!allAddonsMap.has(key)) {
          allAddonsMap.set(key, { addon, accounts: [] })
        }
        allAddonsMap.get(key)?.accounts.push(acc)
      })
    })

    return Array.from(allAddonsMap.values())
      .sort((a, b) => (a.addon.manifest.name || '').localeCompare(b.addon.manifest.name || ''))
  }, [selectedAccounts])

  const allAddons = (showProtected
    ? allAddonsRaw
    : allAddonsRaw.filter(item => !item.addon.flags?.protected)
  ).filter(item => {
    if (!debouncedFilterQuery) return true
    return (item.addon.manifest.name || '').toLowerCase().includes(debouncedFilterQuery.toLowerCase())
  })

  const selectedSavedAddonsForPreview = useMemo(
    () => Array.from(selectedSavedAddonIds)
      .map(id => library[id])
      .filter(Boolean),
    [library, selectedSavedAddonIds]
  )

  const installGroupAddons = useMemo(() => {
    if (installMode === 'profile' && selectedInstallProfileId) {
      return selectedInstallProfileId === 'unassigned'
        ? libraryArray.filter(addon => !addon.profileId)
        : libraryArray.filter(addon => addon.profileId === selectedInstallProfileId)
    }
    if (installMode === 'tag' && selectedInstallTagName) {
      return libraryArray.filter(addon => addon.tags.includes(selectedInstallTagName))
    }
    return []
  }, [installMode, libraryArray, selectedInstallProfileId, selectedInstallTagName])

  const urlEntries = useMemo(
    () => urlList.split(/\r?\n/).map(url => url.trim()).filter(Boolean),
    [urlList]
  )

  const sourceAccount = useMemo(
    () => allAccounts.find(account => account.id === sourceAccountId),
    [allAccounts, sourceAccountId]
  )

  const effectiveTargetAccounts = useMemo(() => {
    if ((action === 'clone-account' || action === 'sync-order') && sourceAccountId) {
      return selectedAccounts.filter(account => account.id !== sourceAccountId)
    }
    return selectedAccounts
  }, [action, selectedAccounts, sourceAccountId])

  const batchPreview = useMemo<BatchPreview>(() => {
    const previewCtx: BulkPreviewContext = {
      targetAccounts: effectiveTargetAccounts,
      totalTargetAddons: effectiveTargetAccounts.reduce((total, account) => total + account.addons.length, 0),
      allAddonsRaw,
      installGroupAddons,
      selectedSavedAddons: selectedSavedAddonsForPreview,
      urlEntries,
      sourceAccount,
      overwriteClone,
      cloneMode,
      selectedAddonIds,
      selectedUpdateAddonIds,
      selectedBulkTag,
      libraryAddons: libraryArray,
      replaceFindText,
      replaceWithText,
      installMode,
      selectedInstallProfileId,
      selectedInstallTagName,
      profiles,
    }

    return actionDefinition.buildPreview
      ? actionDefinition.buildPreview(previewCtx)
      : buildDefaultBulkPreview(action, previewCtx)
  }, [
    action,
    actionDefinition,
    effectiveTargetAccounts,
    installGroupAddons,
    installMode,
    libraryArray,
    overwriteClone,
    cloneMode,
    profiles,
    selectedAddonIds,
    selectedBulkTag,
    selectedInstallProfileId,
    selectedInstallTagName,
    selectedSavedAddonsForPreview,
    selectedUpdateAddonIds,
    allAddonsRaw,
    sourceAccount,
    urlEntries,
    replaceFindText,
    replaceWithText,
  ])

  const toggleSavedAddon = (savedAddonId: string) => {
    setSelectedSavedAddonIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(savedAddonId)) {
        newSet.delete(savedAddonId)
      } else {
        newSet.add(savedAddonId)
      }
      return newSet
    })
  }

  const toggleAddon = (addonId: string) => {
    setSelectedAddonIds((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(addonId)) {
        newSet.delete(addonId)
      } else {
        newSet.add(addonId)
      }
      return newSet
    })
  }

  const handleCancelOperation = () => {
    cancelRequestedRef.current = true
    batchRef.current?.abort()
    setProgress(prev => prev && prev.status === 'running' ? { ...prev, status: 'cancelling' } : prev)
  }

  const handleExecute = async () => {
    if (isExecuting) return

    setError(null)
    setSuccess(false)
    setResult(null)
    cancelRequestedRef.current = false
    const batch = new AbortController()
    batch.signal.addEventListener('abort', () => { cancelRequestedRef.current = true })
    batchRef.current = batch

    const accountsData: BulkAccountTarget[] = selectedAccounts.map((a: Account) => ({
      id: a.id,
      authKey: getStremioAuthKey(a),
    }))

    const aggregate: BulkResult = {
      success: 0,
      failed: 0,
      errors: [],
      details: [],
    }

    try {
      const executeCtx: BulkExecuteContext = {
        accountsData,
        selectedAccounts,
        allAccounts,
        getStremioAuthKey,
        selectedSavedAddonIds,
        selectedAddonIds,
        selectedUpdateAddonIds,
        selectedBulkTag,
        urlList,
        replaceFindText,
        replaceWithText,
        sourceAccountId,
        overwriteClone,
        cloneMode,
        installMode,
        selectedInstallProfileId,
        selectedInstallTagName,
        library,
        bulkApplySavedAddons: (ids, targets, allow) => bulkApplySavedAddons(ids, targets, allow, { batch }),
        bulkRemoveAddons,
        bulkReinstallAddons,
        bulkInstallFromUrls,
        bulkReplaceUrl,
        bulkCloneAccount,
        bulkRemoveByTag,
        bulkSyncOrder,
        bulkProtectAddons,
        bulkSetHideConfigure,
      }

      const plan = actionDefinition.buildExecutionPlan?.(executeCtx)

      if (!plan) {
        throw new Error('Action failed or not implemented')
      }

      if ('error' in plan) {
        setError(plan.error)
        return
      }

      const { targets, runForAccount } = plan

      if (targets.length === 0) {
        setError('No accounts to update')
        return
      }

      setProgress({ status: 'running', current: 0, total: targets.length })

      let completedCount = 0
      const workerResults = await mapConcurrent(targets, 5, async (target) => {
        if (cancelRequestedRef.current) {
          return { cancelled: true }
        }

        const targetAccount = selectedAccounts.find(a => a.id === target.id) || allAccounts.find(a => a.id === target.id)
        const accountName = targetAccount ? maskedAccountLabel(targetAccount) : `${target.id.substring(0, 8)}...`

        setProgress({ status: 'running', current: completedCount, total: targets.length, accountName })

        try {
          const accountResult = await runForAccount(target)
          // Cancel on a deploy question stops the remaining accounts too.
          if ((accountResult as BulkResult | undefined)?.cancelled) cancelRequestedRef.current = true
          completedCount++
          setProgress({
            status: cancelRequestedRef.current ? 'cancelling' : 'running',
            current: completedCount,
            total: targets.length,
            accountName,
          })
          return { cancelled: false, result: accountResult, error: null, targetId: target.id }
        } catch (err) {
          completedCount++
          setProgress({
            status: cancelRequestedRef.current ? 'cancelling' : 'running',
            current: completedCount,
            total: targets.length,
            accountName,
          })
          return { cancelled: false, result: null, error: err instanceof Error ? err.message : 'Unknown error', targetId: target.id }
        }
      })

      for (const wr of workerResults) {
        if (wr.cancelled) continue
        if (wr.result) {
          appendBulkResult(aggregate, wr.result)
        } else if (wr.error) {
          aggregate.failed++
          aggregate.errors.push({
            accountId: wr.targetId,
            error: wr.error,
          })
        }
      }

      if (action === 'clone-account' && mirrorAutopilot && sourceAccountId) {
        const clonedTargetIds = workerResults
          .filter(wr => !wr.cancelled && wr.result && !wr.error)
          .map(wr => wr.targetId)
          .filter((id): id is string => !!id)
        if (clonedTargetIds.length > 0) {
          try {
            const { useFailoverStore } = await import('@/store/failoverStore')
            const { toast } = await import('@/hooks/use-toast')
            const { mirrored, skipped } = await useFailoverStore.getState().mirrorRulesToAccounts(sourceAccountId, clonedTargetIds)
            if (mirrored > 0) {
              toast({
                title: 'Autopilot rules mirrored',
                description: `${mirrored} rule${mirrored !== 1 ? 's' : ''} copied${skipped > 0 ? `, ${skipped} skipped` : ''}.`,
              })
            } else if (skipped > 0) {
              toast({
                title: 'No Autopilot rules mirrored',
                description: `${skipped} rule${skipped !== 1 ? 's' : ''} skipped (already present, or target has no Stremio login).`,
              })
            }
          } catch (e) {
            if (import.meta.env.DEV) console.error('[Batch] Autopilot mirror failed:', e)
          }
        }
      }

      const processed = aggregate.success + aggregate.failed
      const wasCancelled = cancelRequestedRef.current && processed < targets.length

      setResult(aggregate)
      setSuccess(processed > 0)
      setProgress({
        status: wasCancelled ? 'cancelled' : 'complete',
        current: processed,
        total: targets.length,
      })

      if (wasCancelled) {
        setError(`Cancelled after ${processed} of ${targets.length} account${targets.length !== 1 ? 's' : ''}.`)
        return
      }

      if (processed === 0) {
        setError('No accounts were processed')
        return
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
      setProgress(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 lg:px-6">
      {progress && progress.status !== 'complete' && (
        <div className="space-y-1">
          <OperationProgress
            status={progress.status}
            current={progress.current}
            total={progress.total}
            label={progress.status === 'cancelled'
              ? 'Operation cancelled'
              : progress.status === 'cancelling'
                ? 'Cancelling after current account...'
                : 'Bulk operation in progress'}
            detail={progress.accountName
              ? `Processing ${progress.accountName}`
              : `${progress.current} of ${progress.total} account${progress.total !== 1 ? 's' : ''} processed`}
            variant="card"
          />
          {progress.status !== 'cancelled' && (
            <p className="px-1 text-[11px] text-muted-foreground">
              Cancel stops before the next account; the account currently being processed will finish safely.
            </p>
          )}
        </div>
      )}

      {success && result && (
        <ResultReceipt result={result} accounts={[...selectedAccounts, ...allAccounts]} action={action} />
      )}

      {error && (
        <div data-theme-tone="status" data-theme-part="panel" className="rounded-2xl border border-destructive/30 bg-destructive/10 p-3 animate-in fade-in slide-in-from-top-2">
          <p className="text-sm text-destructive font-medium">{error}</p>
        </div>
      )}

      <div className="space-y-4">
        <Card className="border-border/45 bg-card/70 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <LayoutGrid className="h-4 w-4" />
              Operation Mode
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Choose one bulk operation for {selectedAccounts.length} account{selectedAccounts.length !== 1 ? 's' : ''}.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="action-select">I want to...</Label>
            <div className="relative">
              <button
                ref={actionTriggerRef}
                id="action-select"
                type="button"
                data-theme-part="select-trigger"
                onClick={() => setActionMenuOpen(open => !open)}
                onKeyDown={handleActionMenuKeyDown}
                aria-haspopup="listbox"
                aria-expanded={actionMenuOpen}
                aria-controls={actionMenuOpen ? actionMenuId : undefined}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border/40 bg-background/70 px-3 py-2 text-left transition-colors hover:border-primary/25 hover:bg-muted/30"
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border",
                    actionDefinition.severity === 'danger'
                      ? "border-destructive/15 bg-destructive/10 text-destructive"
                      : actionDefinition.severity === 'warning'
                        ? "border-warning/15 bg-warning/10 text-warning"
                        : "border-primary/15 bg-primary/10 text-primary",
                  )}
                >
                  <ActionIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{actionDefinition.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{actionDefinition.description}</span>
                </span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", actionMenuOpen && "rotate-180")} />
              </button>

              {actionMenuOpen && (
                <div
                  ref={actionMenuRef}
                  id={actionMenuId}
                  role="listbox"
                  tabIndex={-1}
                  aria-labelledby="action-select"
                  aria-activedescendant={getActionOptionId(activeAction)}
                  data-theme-part="menu"
                  onKeyDown={handleActionMenuKeyDown}
                  className="mt-2 max-h-[min(52vh,26rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border/40 bg-background p-1.5 shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {BULK_ACTION_GROUPS.map((group) => (
                    <div key={group.label} className="py-1">
                      <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</div>
                      {group.actions.map((item) => {
                        const itemDefinition = getBulkActionDefinition(item)
                        const ItemIcon = itemDefinition.icon
                        const selected = action === item
                        return (
                          <button
                            key={item}
                            id={getActionOptionId(item)}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-theme-part="menu-item"
                            tabIndex={-1}
                            onClick={() => {
                              selectAction(item)
                            }}
                            onMouseEnter={() => setActiveActionIndex(BULK_ACTION_OPTIONS.indexOf(item))}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                              selected
                                ? "bg-primary/12 text-primary"
                                : item === activeAction
                                  ? "bg-muted/45"
                                  : "hover:bg-muted/45",
                            )}
                          >
                          <span
                            className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border",
                              selected
                                ? "border-primary/20 bg-primary/15 text-primary"
                                :
                              itemDefinition.severity === 'danger'
                                ? "border-destructive/15 bg-destructive/10 text-destructive"
                                : itemDefinition.severity === 'warning'
                                  ? "border-warning/15 bg-warning/10 text-warning"
                                  : "border-primary/15 bg-primary/10 text-primary",
                            )}
                          >
                            <ItemIcon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold">{itemDefinition.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {itemDefinition.description}
                            </span>
                          </span>
                          {selected && <CheckCircle2 className="h-4 w-4 shrink-0" />}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card className="overflow-hidden border-border/45 bg-card/80 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            {action === 'add-saved-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <Label>Select Saved Addons</Label>
                  <div className="flex gap-3 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7 pr-7"
                        value={filterQuery}
                        onChange={e => handleFilterChange(e.target.value)}
                      />
                      {filterQuery && (
                        <button
                          data-theme-part="button"
                          onClick={() => handleFilterChange('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-accent rounded-full transition-colors"
                        >
                          <X className="h-2 w-2 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedSavedAddonIds(new Set(sortedSavedAddons.map(a => a.id)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedSavedAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <div data-theme-part="panel" className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {sortedSavedAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">
                      No saved add-ons in your library.
                    </p>
                  ) : (
                    <div className="divide-y">
                      {sortedSavedAddons.map((savedAddon) => (
                        <label
                          key={savedAddon.id}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            data-theme-part="checkbox"
                            className="rounded border-border/40 text-primary focus:ring-primary"
                            checked={selectedSavedAddonIds.has(savedAddon.id)}
                            onChange={() => toggleSavedAddon(savedAddon.id)}
                          />
                          <AddonIcon
                            name={savedAddon.name}
                            logo={savedAddon.metadata?.customLogo || savedAddon.manifest.logo}
                            alt={savedAddon.name}
                            className="h-8 w-8"
                            textClassName="text-xs"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-medium truncate">{savedAddon.name}</p>
                              {savedAddon.tags.slice(0, 2).map(tag => (
                                <AddonTag key={tag} tag={tag} isCompact className="shrink-0 hidden sm:inline-flex" />
                              ))}
                              {savedAddon.tags.length > 2 && (
                                <span className="text-xs text-muted-foreground/60 shrink-0 hidden sm:inline">
                                  +{savedAddon.tags.length - 2}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{savedAddon.manifest.name}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {action === 'install-from-library' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-1.5 px-1">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Installation Source</p>
                  <div data-theme-part="tabs-list" className="flex bg-muted/50 p-1 rounded-xl gap-1 border border-border/40">
                    <Button
                      variant={installMode === 'profile' ? 'secondary' : 'ghost'}
                      data-theme-part="tab"
                      data-state={installMode === 'profile' ? 'active' : 'inactive'}
                      className={`flex-1 h-9 text-xs transition-[transform,opacity,box-shadow] duration-200 rounded-lg gap-2 ${installMode === 'profile' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setInstallMode('profile')}
                      type="button"
                    >
                      <Library className={`h-3.5 w-3.5 ${installMode === 'profile' ? 'text-primary' : ''}`} />
                      Profiles
                    </Button>
                    <Button
                      variant={installMode === 'tag' ? 'secondary' : 'ghost'}
                      data-theme-part="tab"
                      data-state={installMode === 'tag' ? 'active' : 'inactive'}
                      className={`flex-1 h-9 text-xs transition-[transform,opacity,box-shadow] duration-200 rounded-lg gap-2 ${installMode === 'tag' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setInstallMode('tag')}
                      type="button"
                    >
                      <Tags className={`h-3.5 w-3.5 ${installMode === 'tag' ? 'text-primary' : ''}`} />
                      Tags
                    </Button>
                  </div>
                </div>

                {installMode === 'profile' ? (
                  <div className="space-y-3 animate-in fade-in duration-300">
                    <div className="space-y-1.5 px-1">
                      <Label className="text-xs font-medium uppercase text-muted-foreground">Select Library Profile</Label>
                      <Select value={selectedInstallProfileId} onValueChange={setSelectedInstallProfileId}>
                        <SelectTrigger className="bg-background/50 border-border/40 h-10">
                          <SelectValue placeholder="Choose a profile..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">
                            <div className="flex items-center gap-2">
                              <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground" />
                              <span>Unassigned Addons</span>
                            </div>
                          </SelectItem>
                          {profiles.map(p => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 animate-in fade-in duration-300">
                    <div className="space-y-1.5 px-1">
                      <Label className="text-xs font-medium uppercase text-muted-foreground">Select Library Tag</Label>
                      <Select value={selectedInstallTagName} onValueChange={setSelectedInstallTagName}>
                        <SelectTrigger className="bg-background/50 border-border/40 h-10">
                          <SelectValue placeholder="Choose a tag..." />
                        </SelectTrigger>
                        <SelectContent>
                          {allTags.map(tag => (
                            <SelectItem key={tag} value={tag}>
                              <div className="flex items-center gap-2">
                                <Tags className="h-3.5 w-3.5 text-primary/60" />
                                <span>{tag}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                {((installMode === 'profile' && selectedInstallProfileId) || (installMode === 'tag' && selectedInstallTagName)) && (
                  <div data-theme-part="panel" className="p-3 rounded-lg bg-primary/5 border border-primary/10 space-y-2">
                    <p className="text-xs font-semibold uppercase text-primary/70">
                      Addons to Install
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {(installMode === 'profile'
                        ? (selectedInstallProfileId === 'unassigned' ? Object.values(library).filter(a => !a.profileId) : Object.values(library).filter(a => a.profileId === selectedInstallProfileId))
                        : Object.values(library).filter(a => a.tags.includes(selectedInstallTagName))
                      ).map(addon => (
                        <div key={addon.id} data-theme-part="badge" className="text-xs px-2 py-0.5 bg-background border rounded flex items-center gap-1.5">
                          <AddonIcon
                            name={addon.name}
                            logo={addon.metadata?.customLogo || addon.manifest.logo}
                            className="h-3 w-3"
                            textClassName="text-[8px]"
                            imageClassName="p-0"
                          />
                          <span className="truncate max-w-[120px]">{addon.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {action === 'install-from-url' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Manifest URLs</Label>
                  <p className="text-xs text-muted-foreground">
                    Paste add-on links here, one per line. They will be checked and added to the selected accounts.
                  </p>
                  <textarea
                    data-theme-part="textarea"
                    className="flex min-h-[120px] w-full rounded-xl border border-border/40 bg-muted/30 px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="https://v3-cinemeta.strem.io/manifest.json&#10;https://opensubtitles.strem.io/manifest.json"
                    value={urlList}
                    onChange={(e) => setUrlList(e.target.value)}
                  />
                </div>
              </div>
            )}

            {action === 'replace-url' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="replace-find" className="text-xs font-medium uppercase text-muted-foreground">Find Fragment</Label>
                    <Input
                      id="replace-find"
                      placeholder="e.g. old-domain.com"
                      value={replaceFindText}
                      onChange={(e) => setReplaceFindText(e.target.value)}
                      className="h-10 font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="replace-with" className="text-xs font-medium uppercase text-muted-foreground">Replace With</Label>
                    <Input
                      id="replace-with"
                      placeholder="e.g. new-domain.com"
                      value={replaceWithText}
                      onChange={(e) => setReplaceWithText(e.target.value)}
                      className="h-10 font-mono text-sm"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Every add-on URL on the selected accounts that contains the find text is rewritten. This changes the accounts only; your Library is left untouched.
                </p>
              </div>
            )}

            {(action === 'clone-account' || action === 'sync-order') && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Source Account</Label>
                  <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select account to copy from..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allAccounts
                        .filter(acc => !selectedAccounts.some(s => s.id === acc.id))
                        .map((acc) => (
                          <SelectItem key={acc.id} value={acc.id}>
                            <div className="flex items-center gap-2">
                              <span className="h-5 w-5 shrink-0 rounded-full overflow-hidden flex items-center justify-center">
                                {acc.avatar ? (
                                    <img src={acc.avatar} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" loading="lazy" />
                                ) : acc.emoji ? (
                                    <span className="text-base">{acc.emoji}</span>
                                ) : (
                                    <span className="text-xs font-bold text-muted-foreground">{(acc.name || acc.email || '?')[0]?.toUpperCase()}</span>
                                )}
                              </span>
                              <span>{maskedAccountLabel(acc)}</span>
                            </div>
                          </SelectItem>
                        ))}
                      {allAccounts.filter(acc => !selectedAccounts.some(s => s.id === acc.id)).length === 0 && (
                        <SelectItem value="none" disabled>No other accounts available</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {action === 'clone-account'
                      ? "Add-ons from this account will be copied to the selected accounts."
                      : "Selected accounts will use this account's add-on order. No add-ons will be added or removed."}
                  </p>
                </div>

                {action === 'clone-account' && (
                  <>
                    <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                      <div className="space-y-1.5 px-1">
                        <p className="text-xs font-medium uppercase text-muted-foreground">Clone Mode</p>
                        <div data-theme-part="tabs-list" className="flex bg-muted/50 p-1 rounded-xl gap-1 border border-border/40">
                          <Button
                            variant={cloneMode === 'addons-only' ? 'secondary' : 'ghost'}
                            data-theme-part="tab"
                            data-state={cloneMode === 'addons-only' ? 'active' : 'inactive'}
                            className={`flex-1 h-9 text-xs transition-[transform,opacity,box-shadow] duration-200 rounded-lg gap-1.5 ${cloneMode === 'addons-only' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => setCloneMode('addons-only')}
                            type="button"
                          >
                            <PlusCircle className={`h-3.5 w-3.5 ${cloneMode === 'addons-only' ? 'text-primary' : ''}`} />
                            Addons Only
                          </Button>
                          <Button
                            variant={cloneMode === 'addons-settings' ? 'secondary' : 'ghost'}
                            data-theme-part="tab"
                            data-state={cloneMode === 'addons-settings' ? 'active' : 'inactive'}
                            className={`flex-1 h-9 text-xs transition-[transform,opacity,box-shadow] duration-200 rounded-lg gap-1.5 ${cloneMode === 'addons-settings' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => setCloneMode('addons-settings')}
                            type="button"
                          >
                            <ShieldCheck className={`h-3.5 w-3.5 ${cloneMode === 'addons-settings' ? 'text-primary' : ''}`} />
                            Addons + Settings
                          </Button>
                          <Button
                            variant={cloneMode === 'full-mirror' ? 'secondary' : 'ghost'}
                            data-theme-part="tab"
                            data-state={cloneMode === 'full-mirror' ? 'active' : 'inactive'}
                            className={`flex-1 h-9 text-xs transition-[transform,opacity,box-shadow] duration-200 rounded-lg gap-1.5 ${cloneMode === 'full-mirror' ? 'shadow-sm bg-background hover:bg-background' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => setCloneMode('full-mirror')}
                            type="button"
                          >
                            <Copy className={`h-3.5 w-3.5 ${cloneMode === 'full-mirror' ? 'text-primary' : ''}`} />
                            Full Mirror
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {cloneMode === 'addons-only' && 'Only add-on links are installed. No settings, protection, or custom branding are carried over.'}
                          {cloneMode === 'addons-settings' && 'Includes protection state and configure-button visibility. Custom names, logos, and overrides stay untouched.'}
                          {cloneMode === 'full-mirror' && 'Copies everything, including custom names, logos, catalog overrides, and notes.'}
                        </p>
                      </div>
                    </div>

                    {cloneMode === 'full-mirror' && (
                      <div data-theme-part="panel" className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-dashed mt-4 animate-in fade-in slide-in-from-top-2">
                        <div className="space-y-0.5">
                          <Label className="text-sm font-semibold flex items-center gap-2">
                            Destructive Mirror
                            {overwriteClone && <AlertTriangle className="h-3 w-3 text-warning" />}
                          </Label>
                          <p className="text-xs text-muted-foreground leading-relaxed pr-8">
                            Replaces selected accounts with this account's add-ons. Add-ons that only exist on selected accounts can be removed.
                          </p>
                        </div>
                        <Switch
                          checked={overwriteClone}
                          onCheckedChange={setOverwriteClone}
                          className="data-[state=checked]:bg-destructive"
                        />
                      </div>
                    )}

                    <div data-theme-part="panel" className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-dashed">
                      <div className="space-y-0.5">
                        <Label htmlFor="mirror-autopilot" className="text-sm font-semibold">Also mirror Autopilot rules</Label>
                        <p className="text-xs text-muted-foreground leading-relaxed pr-8">
                          Recreates the source account's Autopilot rules on each target, bound to its own login; active rules begin monitoring immediately. Connection-bound rules are skipped, and targets that already have a matching rule are left untouched.
                        </p>
                      </div>
                      <Switch
                        id="mirror-autopilot"
                        aria-label="Also mirror Autopilot rules"
                        checked={mirrorAutopilot}
                        onCheckedChange={setMirrorAutopilot}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {action === 'remove-by-tag' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Select Tag to Remove</Label>
                  <Select value={selectedBulkTag} onValueChange={setSelectedBulkTag}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a tag..." />
                    </SelectTrigger>
                    <SelectContent>
                      {allTags.map(tag => (
                        <SelectItem key={tag} value={tag}>
                          <div className="flex items-center gap-2">
                            <Tags className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>{tag}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Add-ons in your library with this tag will be removed from the selected accounts.
                  </p>
                </div>

                {selectedBulkTag && (
                  <div data-theme-tone="status" data-theme-part="panel" className="p-3 rounded-lg bg-destructive/5 border border-destructive/10 space-y-2 animate-in fade-in slide-in-from-top-2">
                    <p className="text-xs font-semibold uppercase text-destructive/70 flex items-center gap-2">
                      <Trash2 className="h-3 w-3" />
                      Addons to be Removed
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                      {Object.values(library)
                        .filter(a => a.tags.includes(selectedBulkTag))
                        .map(addon => (
                          <div key={addon.id} data-theme-part="badge" className="text-xs px-2 py-0.5 bg-background border rounded flex items-center gap-1.5 opacity-70">
                            <AddonIcon
                              name={addon.name}
                              logo={addon.metadata?.customLogo || addon.manifest.logo}
                              className="h-3 w-3"
                              textClassName="text-[8px]"
                              imageClassName="p-0"
                            />
                            <span className="truncate max-w-[120px]">{addon.name}</span>
                          </div>
                        ))}
                      {Object.values(library).filter(a => a.tags.includes(selectedBulkTag)).length === 0 && (
                        <span className="text-xs text-muted-foreground italic">No add-ons found with this tag.</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {action === 'remove-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-card p-1 gap-3">
                  <div className="space-y-0.5">
                    <Label>Select Addons to Remove</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="show-prot-remove"
                        checked={showProtected}
                        onCheckedChange={setShowProtected}
                      />
                      <span className="text-xs text-muted-foreground">Show Protected</span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7"
                        value={filterQuery}
                        onChange={e => handleFilterChange(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedAddonIds(new Set(allAddons.map(i => i.addon.transportUrl)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <div data-theme-part="panel" className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No add-ons found on selected accounts.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((item) => (
                        <label
                          key={item.addon.transportUrl}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            data-theme-part="checkbox"
                            className="rounded border-border/40 text-destructive focus:ring-destructive"
                            checked={selectedAddonIds.has(item.addon.transportUrl)}
                            onChange={() => toggleAddon(item.addon.transportUrl)}
                          />
                          <AddonIcon
                            name={item.addon.metadata?.customName || item.addon.manifest.name || 'Addon'}
                            logo={item.addon.metadata?.customLogo || item.addon.manifest.logo}
                            alt={item.addon.manifest.name}
                            className="h-8 w-8"
                            textClassName="text-xs"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">
                                {item.addon.manifest.name}
                                {allAddons.filter(a => a.addon.manifest.name === item.addon.manifest.name).length > 1 && (
                                  <span className="text-xs text-muted-foreground ml-1 font-normal opacity-70">
                                    ({item.addon.transportUrl.slice(-6)})
                                  </span>
                                )}
                              </p>
                              {(item.addon.flags?.protected || item.addon.flags?.official) && (
                                <span data-theme-part="badge" className={`text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap ${item.addon.flags?.protected
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-primary/12 text-primary'
                                  }`}>
                                  {item.addon.flags?.protected ? 'Protected' : 'Official'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground truncate font-mono">{item.addon.manifest.id}</p>
                              <span data-theme-part="badge" className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                {item.accounts.length === selectedAccounts.length ? 'All selected' : item.accounts.map(a => maskedAccountLabel(a)).join(', ')}
                              </span>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}


            {action === 'update-addons' && (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-card p-1 gap-3">
                  <div className="space-y-0.5">
                    <Label>Select Addons to Update</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="show-prot-update"
                        checked={showProtected}
                        onCheckedChange={setShowProtected}
                      />
                      <span className="text-xs text-muted-foreground">Show Protected</span>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center w-full sm:w-auto">
                    <div className="relative flex-1 sm:w-32">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        placeholder="Filter..."
                        className="h-7 text-xs pl-7"
                        value={filterQuery}
                        onChange={e => handleFilterChange(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-primary px-2"
                        onClick={() => setSelectedUpdateAddonIds(new Set(allAddons.map(i => i.addon.transportUrl)))}
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-muted-foreground px-2"
                        onClick={() => setSelectedUpdateAddonIds(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-2">
                  Checks selected add-ons again and uses the newest copy available.
                </p>
                <div data-theme-part="panel" className="border rounded-md max-h-60 overflow-y-auto bg-background">
                  {allAddons.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-8 text-center italic">No add-ons available.</p>
                  ) : (
                    <div className="divide-y">
                      {allAddons.map((item) => (
                        <label
                          key={item.addon.transportUrl}
                          className="flex items-center gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        >
                          <input
                            type="checkbox"
                            data-theme-part="checkbox"
                            className="rounded border-border/40 text-primary focus:ring-primary"
                            checked={selectedUpdateAddonIds.has(item.addon.transportUrl)}
                            onChange={() => {
                              setSelectedUpdateAddonIds((prev) => {
                                const newSet = new Set(prev)
                                if (newSet.has(item.addon.transportUrl)) {
                                  newSet.delete(item.addon.transportUrl)
                                } else {
                                  newSet.add(item.addon.transportUrl)
                                }
                                return newSet
                              })
                            }}
                          />
                          <AddonIcon
                            name={item.addon.metadata?.customName || item.addon.manifest.name || 'Addon'}
                            logo={item.addon.metadata?.customLogo || item.addon.manifest.logo}
                            alt={item.addon.manifest.name}
                            className="h-8 w-8"
                            textClassName="text-xs"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate">
                                {item.addon.manifest.name}
                                {allAddons.filter(a => a.addon.manifest.name === item.addon.manifest.name).length > 1 && (
                                  <span className="text-xs text-muted-foreground ml-1 font-normal opacity-70">
                                    ({item.addon.transportUrl.slice(-6)})
                                  </span>
                                )}
                              </p>
                              {(item.addon.flags?.protected || item.addon.flags?.official) && (
                                <span data-theme-part="badge" className={`text-xs px-1.5 py-0.5 rounded-full whitespace-nowrap ${item.addon.flags?.protected
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-primary/12 text-primary'
                                  }`}>
                                  {item.addon.flags?.protected ? 'Protected' : 'Official'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground truncate">v{item.addon.manifest.version}</p>
                              <span data-theme-part="badge" className="text-xs text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                {item.accounts.length === selectedAccounts.length ? 'All selected' : item.accounts.map(a => maskedAccountLabel(a)).join(', ')}
                              </span>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {(action === 'protect-all' || action === 'unprotect-all' || action === 'reinstall-all' || action === 'hide-configure-all' || action === 'show-configure-all') && (
              <div className="space-y-4">
                <div data-theme-part="panel" className="p-4 rounded-lg bg-muted/30 border border-dashed text-center">
                  <p className="text-sm font-medium">
                    {action === 'reinstall-all'
                      ? `This will check every add-on on the ${selectedAccounts.length} selected accounts.`
                      : action === 'hide-configure-all' || action === 'show-configure-all'
                        ? `This will ${action === 'hide-configure-all' ? 'hide' : 'show'} the configure button on every add-on across the ${selectedAccounts.length} selected accounts.`
                        : `This will ${action === 'protect-all' ? 'lock' : 'unlock'} every add-on on the ${selectedAccounts.length} selected accounts.`
                    }
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {action === 'reinstall-all'
                      ? 'Useful for refreshing add-ons or picking up updates.'
                      : action === 'hide-configure-all' || action === 'show-configure-all'
                        ? 'Stremio only. Applied instantly on supported add-ons.'
                        : 'Locked add-ons are left alone by tag-based remove tools.'
                    }
                  </p>
                </div>
              </div>
            )}
          </CardContent>
          </Card>
        {!success && <BatchImpactPreview preview={batchPreview} accounts={selectedAccounts} />}
        </div>
      </div>
      </div>

      <div className="grid grid-cols-2 gap-3 px-4 pb-4 pt-2 lg:px-6">
        <Button
          type="button"
          variant="subtle"
          onClick={isExecuting ? handleCancelOperation : onClose}
          disabled={progress?.status === 'cancelling'}
          className="h-11 w-full rounded-full font-semibold"
        >
          {isExecuting ? 'Cancel After Current' : success || progress?.status === 'cancelled' ? 'Close' : 'Cancel'}
        </Button>
        <Button
          onClick={handleExecute}
          disabled={loading || isExecuting || success || isInvalidTag || isInvalidReplace}
          className="h-11 w-full gap-2 rounded-full font-semibold"
          type="button"
        >
          {(loading || isExecuting) && <Loader2 className="h-4 w-4 animate-spin" />}
          {isExecuting ? 'Running...' : success ? 'Done' : 'Run'}
        </Button>
      </div>
    </div>
  )
}
