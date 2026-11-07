import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Activity, ArrowRightLeft, ArrowUpCircle, CheckCircle2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AddonIcon } from '@/components/ui/addon-icon'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useRelativeTime } from '@/hooks/use-relative-time'
import { cn, getLatestAddonVersion, isNewerVersion } from '@/lib/utils'
import type { Account } from '@/types/account'
import {
  changeCountLabel,
  changeEntryView,
  recentChangeCountsFor,
  recentChangesFor,
  ruleChipLabel,
  ruleStatusViews,
} from './account-stat-chips'

const chipClass = 'inline-flex h-4 items-center gap-1 leading-none'
const countClass = 'text-[11px] font-medium leading-none tabular-nums'
const triggerClass = 'cursor-pointer rounded-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/40'

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

const actionBadge: Record<string, string> = {
  installed: 'bg-success text-white',
  removed: 'bg-destructive text-white',
  replaced: 'bg-warning text-white',
  updated: 'bg-primary text-primary-foreground',
}

function ChangesPopoverBody({ account }: { account: Account }) {
  const formatRelative = useRelativeTime()
  const changelog = useAccountStore(state => state.changelog)
  const entries = useMemo(
    () => recentChangesFor(changelog, account.id, Date.now()).map(entry => ({ ...changeEntryView(entry, account.addons), timestamp: entry.timestamp })),
    [changelog, account.id, account.addons]
  )
  return (
    <>
      <p className="text-xs font-semibold text-foreground">{changeCountLabel(entries.length)}</p>
      {entries.length > 0 && (
        <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
          {entries.map(entry => (
            <li key={entry.id} className="flex items-start gap-2">
              <span className="relative mt-0.5 shrink-0">
                <AddonIcon name={entry.name} logo={entry.logo} className="h-6 w-6" textClassName="text-[10px]" imageClassName="p-0.5" />
                <span className={cn('absolute -bottom-1 -right-1 rounded-full p-px ring-2 ring-card', actionBadge[entry.action])}>
                  {entry.action === 'installed' ? <Plus className="h-2 w-2" /> : entry.action === 'removed' ? <Trash2 className="h-2 w-2" /> : <RefreshCw className="h-2 w-2" />}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{entry.name}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{entry.label}</span>
                {entry.maskedUrl && (
                  <span className="block truncate font-mono text-[10px] text-muted-foreground/70">{entry.maskedUrl}</span>
                )}
              </span>
              <time className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(new Date(entry.timestamp))}</time>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex justify-end border-t border-border/40 pt-1.5">
        <button
          type="button"
          onClick={() => { void useAccountStore.getState().clearChangelog(account.id) }}
          className="rounded-sm px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Clear
        </button>
      </div>
    </>
  )
}

const RecentChangesChip = memo(function RecentChangesChip({ account }: { account: Account }) {
  useRelativeTime()
  const recentChanges = useAccountStore(
    state => recentChangeCountsFor(state.changelog, Date.now()).get(account.id) ?? 0
  )
  if (recentChanges <= 0) return null
  const label = changeCountLabel(recentChanges)
  return (
    <Popover>
      <Tooltip content={label} side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-theme-part="badge"
            onClick={stop}
            onKeyDown={stop}
            aria-label={`${label}. Show changes`}
            className={cn(chipClass, triggerClass, 'text-primary')}
          >
            <Activity className="h-3 w-3" />
            <span className={countClass}>{recentChanges}</span>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="bottom" align="start" className="w-72 max-w-[calc(100vw-1.5rem)] p-3 text-left" onClick={stop} onKeyDown={stop}>
        <ChangesPopoverBody account={account} />
      </PopoverContent>
    </Popover>
  )
})

const RulesChip = memo(function RulesChip({ account }: { account: Account }) {
  const rules = useFailoverStore(useShallow(state => state.rules.filter(r => r.accountId === account.id)))
  const views = useMemo(() => ruleStatusViews(rules, account.addons), [rules, account.addons])
  if (views.length === 0) return null
  const failedOverCount = views.filter(v => v.failedOver).length
  const label = ruleChipLabel(views.length, failedOverCount)
  return (
    <Popover>
      <Tooltip content={label} side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            data-theme-part="badge"
            onClick={stop}
            onKeyDown={stop}
            aria-label={`${label}. Show rules`}
            className={cn(chipClass, triggerClass, failedOverCount > 0 ? 'text-warning' : 'text-success')}
          >
            {failedOverCount > 0 ? <ArrowRightLeft className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
            <span className={countClass}>{failedOverCount || views.length}</span>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent side="bottom" align="start" className="w-64 max-w-[calc(100vw-1.5rem)] p-3 text-left" onClick={stop} onKeyDown={stop}>
        <p className="text-xs font-semibold text-foreground">Autopilot rules</p>
        <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
          {views.map(view => (
            <li key={view.id} className="flex items-start gap-2">
              {view.failedOver
                ? <ArrowRightLeft className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{view.name}</span>
                <span className={cn('block text-[11px] leading-snug', view.failedOver ? 'text-warning' : 'text-muted-foreground')}>{view.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
})

export const AccountStatChips = memo(function AccountStatChips({ account }: { account: Account }) {
  const latestVersions = useAddonStore(state => state.latestVersions)
  const updateCount = useMemo(
    () => account.addons.filter(addon => {
      const latest = getLatestAddonVersion(latestVersions, addon)
      return latest && isNewerVersion(addon.manifest.version, latest)
    }).length,
    [account.addons, latestVersions]
  )
  const updateLabel = `${updateCount} update${updateCount !== 1 ? 's' : ''} available`
  return (
    <>
      {updateCount > 0 ? (
        <Tooltip content={updateLabel} side="top">
          <span aria-label={updateLabel} data-theme-part="badge" className={cn(chipClass, 'text-primary')}>
            <ArrowUpCircle className="h-3 w-3" />
            <span className={countClass}>{updateCount}</span>
          </span>
        </Tooltip>
      ) : (
        <RecentChangesChip account={account} />
      )}
      <RulesChip account={account} />
    </>
  )
})
