import { useMemo, type ReactNode } from 'react'
import { useAccountStore } from '@/store/accountStore'
import { cn, normalizeAddonUrl } from '@/lib/utils'
import type { SavedAddon } from '@/types/saved-addon'
import type { Account } from '@/types/account'
import { Info, Plus, RefreshCw, ShieldAlert, Trash2, Users, Tag, Layers } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { SavedAddonIcon } from './SavedAddonIcon'
import { extractAddonParams } from '@/lib/addon-params'
import { summarizeDeployTargets } from '@/lib/deploy-targets'

interface DeploymentPreviewProps {
  selectedAddonIds: Set<string>
  library: Record<string, SavedAddon>
  accountIds: string[]
    operation?: 'deploy' | 'remove'
  allowProtected?: boolean
}

function AddonPreviewIcon({ name, logo }: { name: string; logo?: string }) {
  return (
    <SavedAddonIcon
      name={name}
      logo={logo}
      className="h-8 w-8"
      textClassName="text-[11px]"
    />
  )
}

type PreviewStat = {
  label: string
  value: number
  detail?: string
  tone?: 'muted' | 'success' | 'warning' | 'destructive'
  icon: ReactNode
}

function PreviewStatCard({ stat }: { stat: PreviewStat }) {
  return (
    <div data-theme-tone="status" data-theme-part="panel" className={cn(
      "rounded-xl border border-border/35 bg-background/45 p-2.5",
      stat.tone === 'success' && "border-success/25 bg-success/5",
      stat.tone === 'warning' && "border-warning/25 bg-warning/5",
      stat.tone === 'destructive' && "border-destructive/25 bg-destructive/5"
    )}>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {stat.icon}
        <span className="text-[11px] font-semibold uppercase">{stat.label}</span>
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums">{stat.value}</div>
      {stat.detail && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{stat.detail}</div>}
    </div>
  )
}

export function DeploymentPreview({
  selectedAddonIds,
  library,
  accountIds,
  operation = 'deploy',
  allowProtected = true,
}: DeploymentPreviewProps) {
  const accounts = useAccountStore(state => state.accounts)

  const selectedAddons = useMemo(() => (
    Array.from(selectedAddonIds)
      .map(id => library[id])
      .filter(Boolean) as SavedAddon[]
  ), [library, selectedAddonIds])

  const preview = useMemo(() => {
    const accountById = new Map(accounts.map(account => [account.id, account]))
    const targetAccounts = accountIds
      .map(id => accountById.get(id))
      .filter((account): account is Account => Boolean(account))

    const totals = {
      rows: [] as Array<{
        accountId: string
        accountName: string
        accountEmoji?: string
        installs: number
        refreshes: number
        asks: number
        removals: number
        missing: number
        protectedSkips: number
      }>,
      installs: 0,
      refreshes: 0,
      asks: 0,
      removals: 0,
      missing: 0,
      protectedSkips: 0,
    }

    targetAccounts.forEach(account => {
      const installedByUrl = new Map(
        account.addons.map(addon => [
          normalizeAddonUrl(addon.transportUrl),
          addon,
        ])
      )

      let installs = 0
      let refreshes = 0
      let asks = 0
      let removals = 0
      let missing = 0
      let protectedSkips = 0

      if (operation === 'remove') {
        selectedAddons.forEach(savedAddon => {
          const existing = installedByUrl.get(normalizeAddonUrl(savedAddon.installUrl))
          if (!existing) missing += 1
          else if (existing.flags?.protected && !allowProtected) protectedSkips += 1
          else removals += 1
        })
      } else {
        // Deploy counts come from the merge's own planner, so the estimate matches the result.
        const counts = summarizeDeployTargets(account.addons, selectedAddons, Object.values(library), allowProtected)
        installs = counts.installs
        refreshes = counts.refreshes
        asks = counts.asks
        protectedSkips = counts.protectedSkips
      }

      const row = {
        accountId: account.id,
        accountName: account.name,
        accountEmoji: account.emoji,
        installs,
        refreshes,
        asks,
        removals,
        missing,
        protectedSkips,
      }

      totals.rows.push(row)
      totals.installs += row.installs
      totals.refreshes += row.refreshes
      totals.asks += row.asks
      totals.removals += row.removals
      totals.missing += row.missing
      totals.protectedSkips += row.protectedSkips
    })

    return totals
  }, [accountIds, accounts, allowProtected, library, operation, selectedAddons])

  if (selectedAddons.length === 0 || preview.rows.length === 0) return null

  const stats: PreviewStat[] = operation === 'remove'
    ? [
      {
        label: 'Will remove',
        value: preview.removals,
        tone: preview.removals > 0 ? 'destructive' : 'muted',
        icon: <Trash2 className="h-3.5 w-3.5" />,
      },
      {
        label: 'Not found',
        value: preview.missing,
        detail: 'already absent',
        tone: 'muted',
        icon: <Info className="h-3.5 w-3.5" />,
      },
      ...(preview.protectedSkips > 0 ? [{
        label: 'Locked kept',
        value: preview.protectedSkips,
        detail: 'left alone',
        tone: 'warning' as const,
        icon: <ShieldAlert className="h-3.5 w-3.5" />,
      }] : []),
      {
        label: 'Accounts',
        value: preview.rows.length,
        tone: 'muted' as const,
        icon: <Users className="h-3.5 w-3.5" />,
      },
    ]
    : [
      {
        label: 'Will add',
        value: preview.installs,
        tone: preview.installs > 0 ? 'success' : 'muted',
        icon: <Plus className="h-3.5 w-3.5" />,
      },
      {
        label: 'Will update',
        value: preview.refreshes,
        detail: 'already installed',
        tone: preview.refreshes > 0 ? 'success' : 'muted',
        icon: <RefreshCw className="h-3.5 w-3.5" />,
      },
      ...(preview.asks > 0 ? [{
        label: 'May ask',
        value: preview.asks,
        detail: 'older copy, you choose',
        tone: 'warning' as const,
        icon: <Info className="h-3.5 w-3.5" />,
      }] : []),
      ...(preview.protectedSkips > 0 ? [{
        label: 'Locked kept',
        value: preview.protectedSkips,
        detail: 'left alone',
        tone: 'warning' as const,
        icon: <ShieldAlert className="h-3.5 w-3.5" />,
      }] : []),
      {
        label: 'Accounts',
        value: preview.rows.length,
        tone: 'muted' as const,
        icon: <Users className="h-3.5 w-3.5" />,
      },
    ]

  return (
    <div data-theme-part="panel" className="rounded-xl border border-border/40 bg-muted/20 p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-foreground">
            {operation === 'remove' ? 'Before you remove' : 'Before you deploy'}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {operation === 'remove'
              ? 'Selected add-ons are removed where found. Locked add-ons stay.'
              : 'Selected add-ons are added where missing and updated where already installed.'}
          </div>
        </div>
        <div data-theme-part="badge" className="shrink-0 rounded-full border border-border/35 bg-background/60 px-2.5 py-1 font-semibold tabular-nums">
          {preview.rows.length} account{preview.rows.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {selectedAddons.slice(0, 8).map(addon => {
          const logo = addon.metadata?.customLogo || addon.manifest.logo
          return (
            <div key={addon.id} data-theme-part="addon-card" className="flex min-w-0 max-w-[190px] flex-1 basis-[150px] items-center gap-2 rounded-xl border border-border/25 bg-background/40 px-2.5 py-2">
              <AddonPreviewIcon name={addon.name} logo={logo} />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{addon.name}</div>
                <div className={cn(
                  "flex items-center gap-1 truncate text-[11px]",
                  operation === 'remove' ? "text-destructive" : "text-success"
                )}>
                  <span>{operation === 'remove' ? 'Will remove if found' : 'Will add/update'}</span>
                  {(() => { const p = extractAddonParams(addon.installUrl).params; if (!p.tag && !p.variant) return null; return (
                    <Tooltip content={`${p.tag ? 'Tag' : 'Variant'}: ${p.tag || p.variant}`} side="top">
                      <span data-theme-part="badge" className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1 text-primary">
                        {p.tag ? <Tag className="h-2.5 w-2.5" /> : <Layers className="h-2.5 w-2.5" />}
                        <span className="truncate max-w-[100px]">{p.tag || p.variant}</span>
                      </span>
                    </Tooltip>
                  ) })()}
                </div>
              </div>
            </div>
          )
        })}
        {selectedAddons.length > 8 && (
          <div data-theme-part="badge" className="flex min-w-20 items-center justify-center rounded-xl border border-border/25 bg-background/35 px-3 text-xs font-semibold text-muted-foreground">
            +{selectedAddons.length - 8} more
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {stats.map(stat => <PreviewStatCard key={stat.label} stat={stat} />)}
      </div>

      <div className="mt-3 max-h-28 space-y-1 overflow-y-auto pr-1">
        {preview.rows.map(row => (
          <div key={row.accountId} data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-xl border border-border/25 bg-background/35 px-2.5 py-2">
            <div className="min-w-0 truncate font-medium">
              {row.accountEmoji && <span className="mr-1.5">{row.accountEmoji}</span>}
              {row.accountName}
            </div>
            <div className="shrink-0 text-muted-foreground">
              {operation === 'remove'
                ? `${row.removals} to remove${row.protectedSkips > 0 ? `, ${row.protectedSkips} locked` : ''}`
                : `${row.installs} to add, ${row.refreshes} to update${row.asks > 0 ? `, ${row.asks} may ask` : ''}`}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Estimate only. AIOManager checks each account again before changing anything.
      </div>
    </div>
  )
}
