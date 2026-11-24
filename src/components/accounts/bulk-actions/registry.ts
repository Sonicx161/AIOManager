import type { LucideIcon } from 'lucide-react'
import {
  Copy,
  Eye,
  EyeOff,
  FileDown,
  Globe,
  GripVertical,
  Library,
  PlusCircle,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserMinus,
  Wand2,
  Zap,
} from 'lucide-react'
import type { CloneMode } from '@/lib/clone-mode'
import { getCanonicalAddonUrl, normalizeAddonUrl } from '@/lib/utils'
import { formatReplacePreviewUrl } from './replace-preview-url'
import type { Account } from '@/types/account'
import type { AddonDescriptor } from '@/types/addon'
import type { Profile } from '@/types/profile'
import type { BulkResult, MergeResult, SavedAddon } from '@/types/saved-addon'

/**
 * Declarative registry of the bulk actions offered by BatchOperationsDialog.
 *
 * Two consumers drive off this registry: the preview builder (`buildPreview`)
 * and the executor (`buildExecutionPlan`). The dialog keeps the shell
 * (tabs, selection UI, progress, receipts) and iterates registry entries.
 *
 * Phase 1b forward-compat: `id` values are kebab-case and stable enough to
 * become server command names for the planned command queue.
 */
export type BulkAction =
  | 'install-from-library'
  | 'add-saved-addons'
  | 'install-from-url'
  | 'clone-account'
  | 'update-addons'
  | 'reinstall-all'
  | 'protect-all'
  | 'unprotect-all'
  | 'hide-configure-all'
  | 'show-configure-all'
  | 'remove-addons'
  | 'remove-by-tag'
  | 'replace-url'
  | 'sync-order'

export type BulkAccountTarget = {
  id: string
  authKey: string
}

export type BulkActionGroup = 'Install' | 'Sync' | 'Manage' | 'Protection' | 'Configure'

export type BulkActionSeverity = 'default' | 'warning' | 'danger'

/**
 * Extra input an action needs from the dialog before it can run.
 * Metadata only for now; intended to map onto command payloads later.
 */
export type BulkActionRequirement =
  | 'libraryGroup'
  | 'savedAddonSelection'
  | 'urlList'
  | 'sourceAccount'
  | 'addonSelection'
  | 'findReplace'
  | 'tagSelection'

export type PreviewTone = 'muted' | 'success' | 'warning' | 'destructive'

export type PreviewStat = {
  label: string
  value: string | number
  detail?: string
  tone?: PreviewTone
}

export type PreviewAccountRow = {
  id: string
  name: string
  detail: string
  tone?: PreviewTone
}

export type PreviewAddon = {
  id: string
  name: string
  logo?: string
  detail: string
  tone?: PreviewTone
}

export type BatchPreview = {
  title: string
  description: string
  targetCount: number
  stats: PreviewStat[]
  addons: PreviewAddon[]
  rows: PreviewAccountRow[]
  notes: string[]
  tone: PreviewTone
}

/** Everything a `buildPreview` implementation may read from the dialog. */
export type BulkPreviewContext = {
  /** Effective targets (source account already excluded for clone/sync). */
  targetAccounts: Account[]
  totalTargetAddons: number
  /** Installed add-ons across the selected accounts, grouped + sorted. */
  allAddonsRaw: Array<{ addon: AddonDescriptor; accounts: Account[] }>
  /** Library entries for install-from-library's current profile/tag selection. */
  installGroupAddons: SavedAddon[]
  selectedSavedAddons: SavedAddon[]
  urlEntries: string[]
  sourceAccount: Account | undefined
  overwriteClone: boolean
  cloneMode: CloneMode
  selectedAddonIds: Set<string>
  selectedUpdateAddonIds: Set<string>
  selectedBulkTag: string
  libraryAddons: SavedAddon[]
  replaceFindText: string
  replaceWithText: string
  urlPrivacyLevel: number
  installMode: 'profile' | 'tag'
  selectedInstallProfileId: string
  selectedInstallTagName: string
  profiles: Profile[]
}

/** Everything a `buildExecutionPlan` implementation may read from the dialog. */
export type BulkExecuteContext = {
  accountsData: BulkAccountTarget[]
  selectedAccounts: Account[]
  allAccounts: Account[]
  getStremioAuthKey: (account: Account) => string
  selectedSavedAddonIds: Set<string>
  selectedAddonIds: Set<string>
  selectedUpdateAddonIds: Set<string>
  selectedBulkTag: string
  urlList: string
  replaceFindText: string
  replaceWithText: string
  sourceAccountId: string
  overwriteClone: boolean
  cloneMode: CloneMode
  installMode: 'profile' | 'tag'
  selectedInstallProfileId: string
  selectedInstallTagName: string
  library: Record<string, SavedAddon>
  bulkApplySavedAddons: (
    savedAddonIds: string[],
    accountIds: BulkAccountTarget[],
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkRemoveAddons: (
    addonIds: string[],
    accountIds: BulkAccountTarget[],
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkRemoveByTag: (
    tag: string,
    accountIds: BulkAccountTarget[],
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkReinstallAddons: (
    addonIds: string[],
    accountIds: BulkAccountTarget[],
    allowProtected?: boolean,
    onProgress?: (current: number, total: number) => void
  ) => Promise<BulkResult>
  bulkInstallFromUrls: (
    urls: string[],
    accountIds: BulkAccountTarget[],
    allowProtected?: boolean
  ) => Promise<BulkResult>
  bulkReplaceUrl: (
    find: string,
    replace: string,
    accountIds: BulkAccountTarget[]
  ) => Promise<BulkResult>
  bulkCloneAccount: (
    sourceAccount: BulkAccountTarget,
    targetAccountIds: BulkAccountTarget[],
    overwrite?: boolean,
    cloneMode?: CloneMode
  ) => Promise<BulkResult>
  bulkSyncOrder: (
    sourceAccountId: string,
    targetAccountIds: BulkAccountTarget[]
  ) => Promise<BulkResult>
  bulkProtectAddons: (accountId: string, isProtected: boolean) => Promise<number>
  bulkSetHideConfigure: (accountId: string, hideConfigure: boolean) => Promise<number>
}

/**
 * A resolvable unit of work: which accounts to run against, and how to run
 * one account. The dialog owns progress/cancel/aggregation.
 */
export type BulkExecutionPlan = {
  targets: BulkAccountTarget[]
  runForAccount: (target: BulkAccountTarget) => Promise<BulkResult>
}

/** A plan, or a validation failure message to surface via `setError`. */
export type BulkExecutionPlanResult = BulkExecutionPlan | { error: string }

export type BulkReceiptLabels = {
  added: string
  updated: string
  removed: string
  skipped: string
  protected: string
  protectedIsWarning: boolean
}

export type BulkActionDefinition = {
  id: BulkAction
  group: BulkActionGroup
  title: string
  description: string
  severity: BulkActionSeverity
  icon: LucideIcon
  requires?: readonly BulkActionRequirement[]
  buildPreview?: (ctx: BulkPreviewContext) => BatchPreview
  buildExecutionPlan?: (ctx: BulkExecuteContext) => BulkExecutionPlanResult
  receiptLabels?: Partial<BulkReceiptLabels>
}

function escapeReplaceRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceUrlFragment(url: string, find: string, replace: string) {
  return url.replace(new RegExp(escapeReplaceRegExp(find), 'gi'), replace)
}

export function getAccountName(account?: Account) {
  return account?.name || account?.email || (account?.id ? `${account.id.substring(0, 8)}...` : 'Unknown account')
}

function getAddonDisplayName(addon: AddonDescriptor) {
  return addon.metadata?.customName || addon.manifest?.name || 'Add-on'
}

function savedAddonToPreview(addon: SavedAddon, detail: string, tone: PreviewTone = 'success'): PreviewAddon {
  return {
    id: addon.id,
    name: addon.name || addon.manifest.name || 'Saved add-on',
    logo: addon.metadata?.customLogo || addon.manifest.logo,
    detail,
    tone,
  }
}

function descriptorToPreview(addon: AddonDescriptor, detail: string, tone: PreviewTone = 'success'): PreviewAddon {
  return {
    id: normalizeAddonUrl(addon.transportUrl) || addon.manifest?.id || getAddonDisplayName(addon),
    name: getAddonDisplayName(addon),
    logo: addon.metadata?.customLogo || addon.manifest?.logo,
    detail,
    tone,
  }
}

function linkToPreview(url: string): PreviewAddon {
  let name = 'Pasted link'
  try {
    const normalized = normalizeAddonUrl(url)
    const parsed = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`)
    name = parsed.hostname.replace(/^www\./, '')
  } catch {
    name = url.replace(/^https?:\/\//, '').slice(0, 32) || 'Pasted link'
  }

  return {
    id: url,
    name,
    detail: 'Will check',
    tone: 'success',
  }
}

function uniquePreviewAddons(addons: PreviewAddon[]) {
  const seen = new Set<string>()
  const unique: PreviewAddon[] = []

  for (const addon of addons) {
    const key = addon.id || addon.name
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(addon)
  }

  return unique
}

function countByUrl(account: Account, urls: string[]) {
  if (urls.length === 0) return 0
  const targetUrls = new Set(urls.map(url => normalizeAddonUrl(url)).filter(Boolean))
  return account.addons.reduce((count, addon) => (
    targetUrls.has(normalizeAddonUrl(addon.transportUrl)) ? count + 1 : count
  ), 0)
}

function countByCanonicalUrl(account: Account, urls: string[]) {
  if (urls.length === 0) return 0
  const targetUrls = new Set(urls.map(url => getCanonicalAddonUrl(url)).filter(Boolean))
  return account.addons.reduce((count, addon) => (
    targetUrls.has(getCanonicalAddonUrl(addon.transportUrl)) ? count + 1 : count
  ), 0)
}

function countProtectedMatches(account: Account, urls: string[]) {
  if (urls.length === 0) return 0
  const targetUrls = new Set(urls.map(url => normalizeAddonUrl(url)).filter(Boolean))
  return account.addons.reduce((count, addon) => {
    const matches = targetUrls.has(normalizeAddonUrl(addon.transportUrl))
    return matches && addon.flags?.protected ? count + 1 : count
  }, 0)
}

function countProtectedCanonicalMatches(account: Account, urls: string[]) {
  if (urls.length === 0) return 0
  const targetUrls = new Set(urls.map(url => getCanonicalAddonUrl(url)).filter(Boolean))
  return account.addons.reduce((count, addon) => {
    const matches = targetUrls.has(getCanonicalAddonUrl(addon.transportUrl))
    return matches && addon.flags?.protected ? count + 1 : count
  }, 0)
}

function createPickFirstPreview(title: string, description: string, targetCount: number, tone: PreviewTone = 'muted'): BatchPreview {
  return {
    title,
    description,
    targetCount,
    tone,
    stats: [],
    addons: [],
    rows: [],
    notes: [],
  }
}

function createPreviewNotes(): string[] {
  return ['This is an estimate. AIOManager checks the account again before making changes.']
}

function createProtectionMergeResult(account: Account | undefined, isProtected: boolean): MergeResult {
  const addons = account?.addons ?? []
  const changed = addons.filter(addon => Boolean(addon.flags?.protected) !== isProtected)
  const unchanged = addons.filter(addon => Boolean(addon.flags?.protected) === isProtected)

  return {
    added: [],
    updated: changed.map((addon) => ({
      addonId: addon.manifest.id,
      oldUrl: '',
      newUrl: addon.transportUrl,
    })),
    removed: [],
    skipped: [],
    protected: unchanged.map((addon) => ({
      addonId: addon.manifest.id,
      name: getAddonDisplayName(addon),
    })),
  }
}

function createHideConfigureMergeResult(account: Account | undefined, hideConfigure: boolean): MergeResult {
  const addons = account?.addons ?? []
  const changed = addons.filter(addon => Boolean(addon.metadata?.hideConfigure) !== hideConfigure)
  const unchanged = addons.filter(addon => Boolean(addon.metadata?.hideConfigure) === hideConfigure)

  return {
    added: [],
    updated: changed.map((addon) => ({
      addonId: addon.manifest.id,
      oldUrl: '',
      newUrl: addon.transportUrl,
    })),
    removed: [],
    skipped: [],
    protected: unchanged.map((addon) => ({
      addonId: addon.manifest.id,
      name: getAddonDisplayName(addon),
    })),
  }
}

function getInstalledPreviewAddons(ctx: BulkPreviewContext, urls: string[], detail: string, tone: PreviewTone, mode: 'url' | 'canonical' = 'url'): PreviewAddon[] {
  if (urls.length === 0) return []
  const targets = new Set(urls.map(url => mode === 'canonical'
    ? getCanonicalAddonUrl(url)
    : normalizeAddonUrl(url)
  ).filter(Boolean))

  return uniquePreviewAddons(
    ctx.allAddonsRaw
      .filter(item => targets.has(mode === 'canonical'
        ? getCanonicalAddonUrl(item.addon.transportUrl)
        : normalizeAddonUrl(item.addon.transportUrl)
      ))
      .map(item => descriptorToPreview(item.addon, detail, tone))
  )
}

function buildInstallPreview(ctx: BulkPreviewContext, addons: SavedAddon[], title: string, emptyText: string): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (addons.length === 0) {
    return createPickFirstPreview(title, emptyText, targetCount)
  }

  const notes = createPreviewNotes()
  const installUrls = addons.map(addon => addon.installUrl)
  let updates = 0
  let installs = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const existing = countByUrl(account, installUrls)
    const missing = Math.max(0, installUrls.length - existing)
    updates += existing
    installs += missing
    return {
      id: account.id,
      name: getAccountName(account),
      detail: `${missing} to add, ${existing} to update`,
      tone: missing > 0 ? 'success' : 'muted',
    }
  })

  return {
    title,
    description: `${addons.length} add-on${addons.length !== 1 ? 's' : ''} will be added where missing and updated where already installed.`,
    targetCount,
    tone: 'success',
    stats: [
      { label: 'Picked', value: addons.length },
      { label: 'Will add', value: installs, tone: installs > 0 ? 'success' : 'muted' },
      { label: 'Will update', value: updates, tone: updates > 0 ? 'success' : 'muted' },
      { label: 'Accounts', value: targetCount },
    ],
    addons: addons.map(addon => savedAddonToPreview(addon, 'Will add/update')),
    rows,
    notes,
  }
}

function buildInstallFromLibraryPreview(ctx: BulkPreviewContext): BatchPreview {
  const profileName = ctx.selectedInstallProfileId === 'unassigned'
    ? 'Unassigned'
    : ctx.profiles.find(profile => profile.id === ctx.selectedInstallProfileId)?.name
  const groupName = ctx.installMode === 'profile'
    ? (profileName || 'Select a profile')
    : (ctx.selectedInstallTagName || 'Select a tag')
  return buildInstallPreview(
    ctx,
    ctx.installGroupAddons,
    ctx.installGroupAddons.length > 0 ? `Add add-ons from ${groupName}` : 'Pick a group first',
    ctx.installMode === 'profile' ? 'Pick a library profile first.' : 'Pick a tag first.'
  )
}

function buildAddSavedAddonsPreview(ctx: BulkPreviewContext): BatchPreview {
  return buildInstallPreview(
    ctx,
    ctx.selectedSavedAddons,
    ctx.selectedSavedAddons.length > 0 ? 'Add selected saved add-ons' : 'Pick saved add-ons first',
    'Choose one or more saved add-ons. Nothing will change until you run it.'
  )
}

function buildInstallFromUrlPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (ctx.urlEntries.length === 0) {
    return createPickFirstPreview('Paste add-on links first', 'Paste one add-on link per line. Nothing will change until you run it.', targetCount)
  }

  const notes = createPreviewNotes()
  let updates = 0
  let installs = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const existing = countByUrl(account, ctx.urlEntries)
    const missing = Math.max(0, ctx.urlEntries.length - existing)
    updates += existing
    installs += missing
    return {
      id: account.id,
      name: getAccountName(account),
      detail: `${missing} to add, ${existing} to update`,
      tone: missing > 0 ? 'success' : 'muted',
    }
  })

  return {
    title: 'Add pasted links',
    description: `${ctx.urlEntries.length} link${ctx.urlEntries.length !== 1 ? 's' : ''} will be checked, then added where missing and updated where already installed.`,
    targetCount,
    tone: 'success',
    stats: [
      { label: 'Links', value: ctx.urlEntries.length },
      { label: 'Will add', value: installs, tone: installs > 0 ? 'success' : 'muted' },
      { label: 'Will update', value: updates, tone: updates > 0 ? 'success' : 'muted' },
      { label: 'Accounts', value: targetCount },
    ],
    addons: ctx.urlEntries.map(url => ({ ...linkToPreview(url), detail: 'Will add/update' })),
    rows,
    notes: [...notes, 'If a link is broken, it will be skipped and shown in the result.'],
  }
}

function buildCloneAccountPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (!ctx.sourceAccount) {
    return createPickFirstPreview('Pick an account to copy from', 'Choose the account you want to use as the source. Nothing will change until you run it.', targetCount)
  }

  const notes = createPreviewNotes()
  const sourceAddons = ctx.sourceAccount?.addons ?? []
  const sourceUrls = sourceAddons.map(addon => addon.transportUrl)
  const sourceUrlSet = new Set(sourceUrls.map(url => normalizeAddonUrl(url)))
  const effectiveOverwrite = ctx.overwriteClone && ctx.cloneMode === 'full-mirror'
  const modeNoun = ctx.cloneMode === 'addons-only'
    ? 'add-ons only'
    : ctx.cloneMode === 'addons-settings'
      ? 'add-ons with settings'
      : 'a full mirror'
  const modeDetail = ctx.cloneMode === 'addons-only'
    ? 'Only add-on links are installed. No settings, protection, or custom branding are carried over.'
    : ctx.cloneMode === 'addons-settings'
      ? 'Protection state and configure-button visibility are copied. Custom names, logos, and overrides stay untouched.'
      : 'Custom names, logos, catalog overrides, and notes are all copied.'
  const modeStatLabel = ctx.cloneMode === 'addons-only'
    ? 'Addons'
    : ctx.cloneMode === 'addons-settings'
      ? 'Addons + Set'
      : 'Mirror'
  let missingInstalls = 0
  let removed = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const existing = countByUrl(account, sourceUrls)
    const missing = Math.max(0, sourceAddons.length - existing)
    const targetOnly = effectiveOverwrite
      ? account.addons.filter(addon => !sourceUrlSet.has(normalizeAddonUrl(addon.transportUrl))).length
      : 0
    missingInstalls += missing
    removed += targetOnly
    return {
      id: account.id,
      name: getAccountName(account),
      detail: effectiveOverwrite
        ? `${sourceAddons.length} after copy, ${targetOnly} may be removed`
        : `${missing} to add, current add-ons stay`,
      tone: effectiveOverwrite && targetOnly > 0 ? 'warning' : 'success',
    }
  })

  return {
    title: effectiveOverwrite
      ? `Make accounts match ${getAccountName(ctx.sourceAccount)}`
      : `Copy ${modeNoun} from ${getAccountName(ctx.sourceAccount)}`,
    description: effectiveOverwrite
      ? 'Accounts will be changed to match the source account.'
      : modeDetail,
    targetCount,
    tone: effectiveOverwrite ? 'warning' : 'success',
    stats: [
      { label: 'Source add-ons', value: sourceAddons.length },
      { label: effectiveOverwrite ? 'May remove' : 'Will add', value: effectiveOverwrite ? removed : missingInstalls, tone: effectiveOverwrite && removed > 0 ? 'warning' : 'success' },
      { label: 'Mode', value: modeStatLabel },
      { label: 'Accounts', value: targetCount },
    ],
    addons: sourceAddons.map(addon => descriptorToPreview(addon, effectiveOverwrite ? 'Will copy' : 'Will add')),
    rows,
    notes: effectiveOverwrite
      ? [...notes, 'Matching can remove add-ons that only exist on the selected accounts.']
      : notes,
  }
}

function buildSyncOrderPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (!ctx.sourceAccount) {
    return createPickFirstPreview('Pick an account to match', 'Choose the account whose add-on order should be copied. Nothing will change until you run it.', targetCount)
  }

  const notes = createPreviewNotes()
  const sourceAddons = ctx.sourceAccount?.addons ?? []
  const sourceNormUrls = new Set(sourceAddons.map(addon => normalizeAddonUrl(addon.transportUrl)))
  const sourceIds = new Set(sourceAddons.map(addon => addon.manifest.id).filter(Boolean))
  const sourceNames = new Set(sourceAddons.map(addon => addon.manifest.name).filter(Boolean))
  let matched = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const accountMatches = account.addons.filter(addon => (
      sourceNormUrls.has(normalizeAddonUrl(addon.transportUrl)) ||
      sourceIds.has(addon.manifest.id) ||
      sourceNames.has(addon.manifest.name)
    )).length
    matched += accountMatches
    return {
      id: account.id,
      name: getAccountName(account),
      detail: `${accountMatches} of ${account.addons.length} can be moved`,
      tone: accountMatches > 0 ? 'success' : 'muted',
    }
  })

  return {
    title: `Match the order from ${getAccountName(ctx.sourceAccount)}`,
    description: 'Only the order changes. Extra add-ons stay at the bottom.',
    targetCount,
    tone: 'muted',
    stats: [
      { label: 'Source list', value: sourceAddons.length },
      { label: 'Can move', value: matched, tone: matched > 0 ? 'success' : 'muted' },
      { label: 'Accounts', value: targetCount },
    ],
    addons: sourceAddons.map(addon => descriptorToPreview(addon, 'Order source', 'muted')),
    rows,
    notes,
  }
}

function buildUpdateAddonsPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  const selectedUrls = Array.from(ctx.selectedUpdateAddonIds)
  if (selectedUrls.length === 0) {
    return createPickFirstPreview('Pick add-ons to update', 'Choose one or more installed add-ons. Nothing will change until you run it.', targetCount)
  }

  const notes = createPreviewNotes()
  let refreshes = 0
  let lockedIncluded = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const matched = countByCanonicalUrl(account, selectedUrls)
    const protectedMatches = countProtectedCanonicalMatches(account, selectedUrls)
    refreshes += matched
    lockedIncluded += protectedMatches
    return {
      id: account.id,
      name: getAccountName(account),
      detail: protectedMatches > 0 ? `${matched} to check, ${protectedMatches} locked` : `${matched} to check`,
      tone: matched > 0 ? 'success' : 'muted',
    }
  })

  const stats: PreviewStat[] = [
    { label: 'Picked', value: selectedUrls.length },
    { label: 'Will check', value: refreshes, tone: refreshes > 0 ? 'success' : 'muted' },
  ]
  if (lockedIncluded > 0) {
    stats.push({ label: 'Locked included', value: lockedIncluded, detail: 'selected by you', tone: 'warning' })
  }
  stats.push({ label: 'Accounts', value: targetCount })

  return {
    title: 'Update selected add-ons',
    description: 'AIOManager will check these add-ons again and use the newest copy it finds.',
    targetCount,
    tone: 'success',
    stats,
    addons: getInstalledPreviewAddons(ctx, selectedUrls, 'Will check', 'success', 'canonical'),
    rows,
    notes,
  }
}

function buildReplaceUrlPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (!ctx.replaceFindText.trim()) {
    return createPickFirstPreview('Enter text to find', 'Type the part of the URL you want to replace (like an old domain). Nothing changes until you run it.', targetCount)
  }

  const notes = createPreviewNotes()
  const find = ctx.replaceFindText
  const previewAddons: PreviewAddon[] = []
  let totalChanges = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    let changes = 0
    for (const addon of account.addons) {
      if (!addon.transportUrl.toLowerCase().includes(find.toLowerCase())) continue
      const newUrl = replaceUrlFragment(addon.transportUrl, find, ctx.replaceWithText)
      if (normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(newUrl)) continue
      changes++
      previewAddons.push(descriptorToPreview(addon, `New: ${formatReplacePreviewUrl(addon.transportUrl, newUrl, ctx.urlPrivacyLevel)}`, 'success'))
    }
    totalChanges += changes
    return {
      id: account.id,
      name: getAccountName(account),
      detail: changes > 0 ? `${changes} to change` : 'No matches',
      tone: changes > 0 ? 'success' : 'muted',
    }
  })

  return {
    title: `Replace "${find}" in add-on URLs`,
    description: 'Matching add-on URLs are rewritten on the selected accounts only. Your Library is not changed.',
    targetCount,
    tone: 'warning',
    stats: [
      { label: 'Find', value: find.length > 14 ? `${find.slice(0, 14)}...` : find },
      { label: 'Will change', value: totalChanges, tone: totalChanges > 0 ? 'success' : 'muted' },
      { label: 'Accounts', value: targetCount },
    ],
    addons: uniquePreviewAddons(previewAddons),
    rows,
    notes: [...notes, 'Each matching add-on is re-fetched at its new URL. If the new URL is unreachable, that add-on is skipped.'],
  }
}

function buildRemoveByTagPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  if (!ctx.selectedBulkTag) {
    return createPickFirstPreview('Pick a tag first', 'Choose a tag, then AIOManager will show what would be removed.', targetCount, 'destructive')
  }

  const notes = createPreviewNotes()
  const taggedAddons = ctx.selectedBulkTag ? ctx.libraryAddons.filter(addon => addon.tags.includes(ctx.selectedBulkTag)) : []
  const taggedUrls = taggedAddons.map(addon => addon.installUrl)
  let removals = 0
  let protectedSkipped = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const matches = countByUrl(account, taggedUrls)
    const protectedMatches = countProtectedMatches(account, taggedUrls)
    const removable = Math.max(0, matches - protectedMatches)
    removals += removable
    protectedSkipped += protectedMatches
    return {
      id: account.id,
      name: getAccountName(account),
      detail: `${removable} to remove, ${protectedMatches} locked`,
      tone: removable > 0 ? 'destructive' : protectedMatches > 0 ? 'warning' : 'muted',
    }
  })

  return {
    title: `Remove add-ons tagged ${ctx.selectedBulkTag}`,
    description: taggedAddons.length > 0 ? `${taggedAddons.length} saved add-on${taggedAddons.length !== 1 ? 's' : ''} use this tag. Locked add-ons are left alone.` : 'No saved add-ons use this tag.',
    targetCount,
    tone: 'destructive',
    stats: [
      { label: 'With tag', value: taggedAddons.length },
      { label: 'Will remove', value: removals, tone: removals > 0 ? 'destructive' : 'muted' },
      { label: 'Left alone', value: protectedSkipped, tone: protectedSkipped > 0 ? 'warning' : 'muted' },
      { label: 'Accounts', value: targetCount },
    ],
    addons: taggedAddons.map(addon => savedAddonToPreview(addon, 'Will remove', 'destructive')),
    rows,
    notes,
  }
}

function buildRemoveAddonsPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  const selectedUrls = Array.from(ctx.selectedAddonIds)
  if (selectedUrls.length === 0) {
    return createPickFirstPreview('Pick add-ons to remove', 'Choose one or more installed add-ons. Nothing will change until you run it.', targetCount, 'destructive')
  }

  const notes = createPreviewNotes()
  let removals = 0
  let lockedIncluded = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const matches = countByUrl(account, selectedUrls)
    const protectedMatches = countProtectedMatches(account, selectedUrls)
    removals += matches
    lockedIncluded += protectedMatches
    return {
      id: account.id,
      name: getAccountName(account),
      detail: protectedMatches > 0 ? `${matches} to remove, ${protectedMatches} locked` : `${matches} to remove`,
      tone: matches > 0 ? 'destructive' : 'muted',
    }
  })

  const stats: PreviewStat[] = [
    { label: 'Picked', value: selectedUrls.length },
    { label: 'Will remove', value: removals, tone: removals > 0 ? 'destructive' : 'muted' },
  ]
  if (lockedIncluded > 0) {
    stats.push({ label: 'Locked included', value: lockedIncluded, detail: 'selected by you', tone: 'warning' })
  }
  stats.push({ label: 'Accounts', value: targetCount })

  return {
    title: 'Remove selected add-ons',
    description: 'These add-ons will be removed from any selected account where they are found, including locked ones you selected.',
    targetCount,
    tone: 'destructive',
    stats,
    addons: getInstalledPreviewAddons(ctx, selectedUrls, 'Will remove', 'destructive'),
    rows,
    notes,
  }
}

function buildReinstallAllPreview(ctx: BulkPreviewContext): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  const notes = createPreviewNotes()
  let refreshes = 0
  let lockedIncluded = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const protectedCount = account.addons.filter(addon => addon.flags?.protected).length
    const refreshCount = account.addons.length
    refreshes += refreshCount
    lockedIncluded += protectedCount
    return {
      id: account.id,
      name: getAccountName(account),
      detail: protectedCount > 0 ? `${refreshCount} to check, ${protectedCount} locked` : `${refreshCount} to check`,
      tone: refreshCount > 0 ? 'success' : 'muted',
    }
  })

  const stats: PreviewStat[] = [
    { label: 'On accounts', value: ctx.totalTargetAddons },
    { label: 'Will check', value: refreshes, tone: refreshes > 0 ? 'success' : 'muted' },
  ]
  if (lockedIncluded > 0) {
    stats.push({ label: 'Locked included', value: lockedIncluded, detail: 'still checked', tone: 'warning' })
  }
  stats.push({ label: 'Accounts', value: targetCount })

  return {
    title: 'Update every add-on',
    description: 'AIOManager will check every add-on on these accounts and use the newest copy it finds.',
    targetCount,
    tone: 'warning',
    stats,
    addons: uniquePreviewAddons(
      ctx.targetAccounts.flatMap(account => (
        account.addons
          .map(addon => descriptorToPreview(addon, 'Will check', 'success'))
      ))
    ),
    rows,
    notes,
  }
}

function buildProtectionPreview(ctx: BulkPreviewContext, enableProtection: boolean): BatchPreview {
  const targetCount = ctx.targetAccounts.length
  const notes = createPreviewNotes()
  let changes = 0
  let already = 0
  const rows: PreviewAccountRow[] = ctx.targetAccounts.map((account) => {
    const protectedCount = account.addons.filter(addon => addon.flags?.protected).length
    const changeCount = enableProtection ? account.addons.length - protectedCount : protectedCount
    const alreadyCount = account.addons.length - changeCount
    changes += changeCount
    already += alreadyCount
    return {
      id: account.id,
      name: getAccountName(account),
      detail: `${changeCount} change${changeCount !== 1 ? 's' : ''}, ${alreadyCount} unchanged`,
      tone: changeCount > 0 ? 'success' : 'muted',
    }
  })

  return {
    title: enableProtection ? 'Lock all add-ons' : 'Unlock all add-ons',
    description: enableProtection ? 'Locked add-ons are left alone by tag-based cleanup.' : 'Unlocked add-ons can be removed by tag-based cleanup again.',
    targetCount,
    tone: enableProtection ? 'success' : 'warning',
    stats: [
      { label: 'On accounts', value: ctx.totalTargetAddons },
      { label: 'Will change', value: changes, tone: changes > 0 ? 'success' : 'muted' },
      { label: 'Already okay', value: already },
      { label: 'Accounts', value: targetCount },
    ],
    addons: uniquePreviewAddons(
      ctx.targetAccounts.flatMap(account => (
        account.addons
          .filter(addon => enableProtection ? !addon.flags?.protected : addon.flags?.protected)
          .map(addon => descriptorToPreview(addon, enableProtection ? 'Will lock' : 'Will unlock', enableProtection ? 'success' : 'warning'))
      ))
    ),
    rows,
    notes,
  }
}

/** Fallback preview for actions without a dedicated `buildPreview`. */
export function buildDefaultBulkPreview(action: BulkAction, ctx: BulkPreviewContext): BatchPreview {
  const definition = getBulkActionDefinition(action)
  const targetCount = ctx.targetAccounts.length
  return {
    title: definition.title,
    description: definition.description,
    targetCount,
    tone: 'muted',
    stats: [
      { label: 'Accounts', value: targetCount },
      { label: 'Add-ons', value: ctx.totalTargetAddons },
      { label: 'Will update', value: targetCount },
      { label: 'Mode', value: 'Bulk' },
    ],
    addons: [],
    rows: [],
    notes: createPreviewNotes(),
  }
}

function buildRemoveByTagPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (!ctx.selectedBulkTag) {
    return { error: 'Select a tag' }
  }
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkRemoveByTag(ctx.selectedBulkTag, [target]),
  }
}

function buildAddSavedAddonsPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (ctx.selectedSavedAddonIds.size === 0) {
    return { error: 'Choose at least one saved add-on' }
  }
  const addonIds = Array.from(ctx.selectedSavedAddonIds)
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkApplySavedAddons(addonIds, [target], true),
  }
}

function buildRemoveAddonsPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (ctx.selectedAddonIds.size === 0) {
    return { error: 'Choose at least one add-on to remove' }
  }
  const addonIds = Array.from(ctx.selectedAddonIds)
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkRemoveAddons(addonIds, [target], true),
  }
}

function buildUpdateAddonsPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (ctx.selectedUpdateAddonIds.size === 0) {
    return { error: 'Choose at least one add-on to update' }
  }
  const addonIds = Array.from(ctx.selectedUpdateAddonIds)
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkReinstallAddons(addonIds, [target], true),
  }
}

function buildInstallFromUrlPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  const urls = ctx.urlList.split('\n').map(u => u.trim()).filter(u => u.length > 0)
  if (urls.length === 0) {
    return { error: 'Enter at least one URL' }
  }
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkInstallFromUrls(urls, [target], true),
  }
}

function buildReplaceUrlPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (!ctx.replaceFindText.trim()) {
    return { error: 'Enter the text to find' }
  }
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkReplaceUrl(ctx.replaceFindText, ctx.replaceWithText, [target]),
  }
}

function buildCloneAccountPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (!ctx.sourceAccountId) {
    return { error: 'Select a source account' }
  }
  const sourceAccount = ctx.allAccounts.find(a => a.id === ctx.sourceAccountId)
  if (!sourceAccount) {
    return { error: 'Source account not found' }
  }
  return {
    targets: ctx.accountsData.filter(target => target.id !== sourceAccount.id),
    runForAccount: (target) => ctx.bulkCloneAccount(
      { id: sourceAccount.id, authKey: ctx.getStremioAuthKey(sourceAccount) },
      [target],
      ctx.overwriteClone && ctx.cloneMode === 'full-mirror',
      ctx.cloneMode
    ),
  }
}

function buildSyncOrderPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  if (!ctx.sourceAccountId) {
    return { error: 'Select a source account' }
  }
  if (!ctx.allAccounts.find(a => a.id === ctx.sourceAccountId)) {
    return { error: 'Source account not found' }
  }
  return {
    targets: ctx.accountsData.filter(target => target.id !== ctx.sourceAccountId),
    runForAccount: (target) => ctx.bulkSyncOrder(ctx.sourceAccountId, [target]),
  }
}

function buildProtectionPlan(ctx: BulkExecuteContext, isProtected: boolean): BulkExecutionPlanResult {
  return {
    targets: ctx.accountsData,
    runForAccount: async (target) => {
      const targetAccount = ctx.selectedAccounts.find(account => account.id === target.id) || ctx.allAccounts.find(account => account.id === target.id)
      if (!targetAccount) throw new Error('Account not found')
      await ctx.bulkProtectAddons(target.id, isProtected)
      return {
        success: 1,
        failed: 0,
        errors: [],
        details: [{ accountId: target.id, result: createProtectionMergeResult(targetAccount, isProtected) }],
      }
    },
  }
}

function buildHideConfigurePlan(ctx: BulkExecuteContext, hideConfigure: boolean): BulkExecutionPlanResult {
  return {
    targets: ctx.accountsData,
    runForAccount: async (target) => {
      const targetAccount = ctx.selectedAccounts.find(account => account.id === target.id) || ctx.allAccounts.find(account => account.id === target.id)
      await ctx.bulkSetHideConfigure(target.id, hideConfigure)
      return {
        success: 1,
        failed: 0,
        errors: [],
        details: [{ accountId: target.id, result: createHideConfigureMergeResult(targetAccount, hideConfigure) }],
      }
    },
  }
}

function buildReinstallAllPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkReinstallAddons(['*'], [target], true),
  }
}

function buildInstallFromLibraryPlan(ctx: BulkExecuteContext): BulkExecutionPlanResult {
  const libraryArray = Object.values(ctx.library)
  let addonsToInstall: typeof libraryArray = []
  if (ctx.installMode === 'profile' && ctx.selectedInstallProfileId) {
    addonsToInstall = ctx.selectedInstallProfileId === 'unassigned'
      ? libraryArray.filter(a => !a.profileId)
      : libraryArray.filter(a => a.profileId === ctx.selectedInstallProfileId)
  } else if (ctx.installMode === 'tag' && ctx.selectedInstallTagName) {
    addonsToInstall = libraryArray.filter(a => a.tags.includes(ctx.selectedInstallTagName))
  }

  if (addonsToInstall.length === 0) {
    return { error: 'No add-ons found in the selected group' }
  }

  const addonIds = addonsToInstall.map(a => a.id)
  return {
    targets: ctx.accountsData,
    runForAccount: (target) => ctx.bulkApplySavedAddons(addonIds, [target], true),
  }
}

const DEFAULT_RECEIPT_LABELS: BulkReceiptLabels = {
  added: 'added',
  updated: 'updated',
  removed: 'removed',
  skipped: 'skipped',
  protected: 'left alone',
  protectedIsWarning: true,
}

export function getReceiptLabels(action?: BulkAction): BulkReceiptLabels {
  const overrides = action ? getBulkActionDefinition(action).receiptLabels : undefined
  return { ...DEFAULT_RECEIPT_LABELS, ...overrides }
}

/**
 * All bulk actions in menu order (group order: Install, Sync, Manage,
 * Protection, Configure — matching the original ACTION_GROUPS layout).
 */
export const BULK_ACTIONS: BulkActionDefinition[] = [
  {
    id: 'install-from-library',
    group: 'Install',
    title: 'Install from Library',
    description: 'Add saved add-ons from a profile or tag.',
    severity: 'default',
    icon: Library,
    requires: ['libraryGroup'],
    buildPreview: buildInstallFromLibraryPreview,
    buildExecutionPlan: buildInstallFromLibraryPlan,
  },
  {
    id: 'add-saved-addons',
    group: 'Install',
    title: 'Install Saved Add-ons',
    description: 'Choose saved add-ons and add them to the selected accounts.',
    severity: 'default',
    icon: PlusCircle,
    requires: ['savedAddonSelection'],
    buildPreview: buildAddSavedAddonsPreview,
    buildExecutionPlan: buildAddSavedAddonsPlan,
  },
  {
    id: 'install-from-url',
    group: 'Install',
    title: 'Install from URLs',
    description: 'Paste add-on links and add them to the selected accounts.',
    severity: 'default',
    icon: Globe,
    requires: ['urlList'],
    buildPreview: buildInstallFromUrlPreview,
    buildExecutionPlan: buildInstallFromUrlPlan,
  },
  {
    id: 'clone-account',
    group: 'Sync',
    title: 'Mirror from Account',
    description: 'Copy add-ons from one account to the selected accounts.',
    severity: 'warning',
    icon: Copy,
    requires: ['sourceAccount'],
    buildPreview: buildCloneAccountPreview,
    buildExecutionPlan: buildCloneAccountPlan,
    receiptLabels: {
      added: 'copied',
      updated: 'matched',
    },
  },
  {
    id: 'sync-order',
    group: 'Sync',
    title: 'Sync Addon Order',
    description: 'Make selected accounts use the same add-on order.',
    severity: 'default',
    icon: GripVertical,
    requires: ['sourceAccount'],
    buildPreview: buildSyncOrderPreview,
    buildExecutionPlan: buildSyncOrderPlan,
    receiptLabels: {
      updated: 'moved',
      protected: 'already in place',
      protectedIsWarning: false,
    },
  },
  {
    id: 'update-addons',
    group: 'Manage',
    title: 'Update Add-ons',
    description: 'Check selected add-ons and use the newest copy available.',
    severity: 'default',
    icon: FileDown,
    requires: ['addonSelection'],
    buildPreview: buildUpdateAddonsPreview,
    buildExecutionPlan: buildUpdateAddonsPlan,
  },
  {
    id: 'replace-url',
    group: 'Manage',
    title: 'Find & Replace URL',
    description: 'Swap a URL fragment (like a domain) across the selected accounts.',
    severity: 'warning',
    icon: Wand2,
    requires: ['findReplace'],
    buildPreview: buildReplaceUrlPreview,
    buildExecutionPlan: buildReplaceUrlPlan,
  },
  {
    id: 'remove-by-tag',
    group: 'Manage',
    title: 'Remove by Tags',
    description: 'Remove add-ons that use a saved-library tag.',
    severity: 'danger',
    icon: UserMinus,
    requires: ['tagSelection'],
    buildPreview: buildRemoveByTagPreview,
    buildExecutionPlan: buildRemoveByTagPlan,
  },
  {
    id: 'reinstall-all',
    group: 'Manage',
    title: 'Reinstall All',
    description: 'Force reinstall every add-on from its source URL, even when nothing seems to have changed. Picks up config changes and pushes them everywhere sync is enabled.',
    severity: 'warning',
    icon: Zap,
    buildPreview: buildReinstallAllPreview,
    buildExecutionPlan: buildReinstallAllPlan,
  },
  {
    id: 'remove-addons',
    group: 'Manage',
    title: 'Remove Add-ons',
    description: 'Choose installed add-ons to remove from selected accounts.',
    severity: 'danger',
    icon: Trash2,
    requires: ['addonSelection'],
    buildPreview: buildRemoveAddonsPreview,
    buildExecutionPlan: buildRemoveAddonsPlan,
  },
  {
    id: 'protect-all',
    group: 'Protection',
    title: 'Protect All',
    description: 'Lock every add-on so tag cleanup leaves them alone.',
    severity: 'default',
    icon: ShieldCheck,
    buildPreview: (ctx) => buildProtectionPreview(ctx, true),
    buildExecutionPlan: (ctx) => buildProtectionPlan(ctx, true),
    receiptLabels: {
      updated: 'locked',
      protected: 'already locked',
      protectedIsWarning: false,
    },
  },
  {
    id: 'unprotect-all',
    group: 'Protection',
    title: 'Unprotect All',
    description: 'Unlock every add-on so tag cleanup can remove them again.',
    severity: 'warning',
    icon: ShieldAlert,
    buildPreview: (ctx) => buildProtectionPreview(ctx, false),
    buildExecutionPlan: (ctx) => buildProtectionPlan(ctx, false),
    receiptLabels: {
      updated: 'unlocked',
      protected: 'already unlocked',
      protectedIsWarning: false,
    },
  },
  {
    id: 'hide-configure-all',
    group: 'Configure',
    title: 'Hide Configure All',
    description: 'Hide the configure button on every add-on across selected accounts.',
    severity: 'default',
    icon: EyeOff,
    buildExecutionPlan: (ctx) => buildHideConfigurePlan(ctx, true),
    receiptLabels: {
      updated: 'hidden',
      protected: 'already hidden',
      protectedIsWarning: false,
    },
  },
  {
    id: 'show-configure-all',
    group: 'Configure',
    title: 'Show Configure All',
    description: 'Show the configure button on every add-on across selected accounts.',
    severity: 'default',
    icon: Eye,
    buildExecutionPlan: (ctx) => buildHideConfigurePlan(ctx, false),
    receiptLabels: {
      updated: 'shown',
      protected: 'already visible',
      protectedIsWarning: false,
    },
  },
]

const BULK_ACTION_GROUP_ORDER: BulkActionGroup[] = ['Install', 'Sync', 'Manage', 'Protection', 'Configure']

export const BULK_ACTION_REGISTRY: Record<BulkAction, BulkActionDefinition> = Object.fromEntries(
  BULK_ACTIONS.map(definition => [definition.id, definition])
) as Record<BulkAction, BulkActionDefinition>

/** Compile-time check that every BulkAction id has a registry entry. */
const ALL_BULK_ACTIONS_REGISTERED: { [K in BulkAction]: true } = Object.fromEntries(
  BULK_ACTIONS.map(definition => [definition.id, true])
) as { [K in BulkAction]: true }
void ALL_BULK_ACTIONS_REGISTERED

/** Flat action-id list in menu/keyboard-nav order. */
export const BULK_ACTION_OPTIONS: BulkAction[] = BULK_ACTIONS.map(definition => definition.id)

/** Grouped action ids in menu order. */
export const BULK_ACTION_GROUPS: Array<{ label: BulkActionGroup; actions: BulkAction[] }> = BULK_ACTION_GROUP_ORDER.map(label => ({
  label,
  actions: BULK_ACTIONS.filter(definition => definition.group === label).map(definition => definition.id),
}))

export function getBulkActionDefinition(action: BulkAction): BulkActionDefinition {
  return BULK_ACTION_REGISTRY[action]
}
