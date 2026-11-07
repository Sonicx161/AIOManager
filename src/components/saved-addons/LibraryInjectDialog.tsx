import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip } from '@/components/ui/tooltip'
import { OperationProgress } from '@/components/ui/operation-progress'
import { AddonLogo } from '@/components/discover/AddonLogo'
import { useToast } from '@/hooks/use-toast'
import { getStoredAIOStreamsPassword } from '@/lib/aiostreams-utils'
import { performInjection } from '@/lib/aiostreams-inject'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { maskNameLevel } from '@/lib/utils'
import { mapConcurrent } from '@/lib/concurrency'
import type { AIOStreamsInstance } from '@/hooks/useAIOStreamsInstances'
import type { SavedAddon } from '@/types/saved-addon'
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  ServerCog,
} from 'lucide-react'

type Phase = 'select' | 'injecting' | 'results'

interface InstanceResult {
  key: string
  displayName: string
  accountNames: string
  host: string
  succeeded: number
  alreadyExists: number
  failed: number
  reinstallFailed: boolean
  errors: string[]
}

interface LibraryInjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  addons: SavedAddon[]
  instances: AIOStreamsInstance[]
}

function hostOf(baseUrl: string): string {
  try {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
}

function instanceKey(inst: AIOStreamsInstance): string {
  return `${inst.baseUrl}|${inst.uuid}`
}

export function LibraryInjectDialog({
  open,
  onOpenChange,
  addons,
  instances,
}: LibraryInjectDialogProps) {
  const { toast } = useToast()
  const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
  const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
  const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<Phase>('select')
  const [progressCurrent, setProgressCurrent] = useState(0)
  const [results, setResults] = useState<InstanceResult[]>([])

  const resetState = useCallback(() => {
    setSelected(new Set())
    setPhase('select')
    setProgressCurrent(0)
    setResults([])
  }, [])

  useEffect(() => {
    if (!open) resetState()
  }, [open, resetState])

  const selectableInstances = useMemo(
    () => instances.filter((i) => i.hasCredentials),
    [instances]
  )

  const toggleInstance = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSelectAll = () => {
    if (selectableInstances.length > 0 && selected.size === selectableInstances.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(selectableInstances.map(instanceKey)))
    }
  }

  const totalOps = addons.length * selected.size
  const allSelected =
    selectableInstances.length > 0 && selected.size === selectableInstances.length
  const lockedCount = instances.length - selectableInstances.length

  const handleConfirm = async () => {
    if (selected.size === 0 || addons.length === 0) return
    setPhase('injecting')
    setProgressCurrent(0)
    setResults([])
    const selectedInstances = instances.filter(inst => selected.has(instanceKey(inst)))
    
    const instanceResults = await mapConcurrent(selectedInstances, 3, async (inst) => {
      const password = getStoredAIOStreamsPassword(inst.baseUrl, inst.uuid)
      if (!password) return null

      const res: InstanceResult = {
        key: instanceKey(inst),
        displayName: inst.addonName || 'AIOStreams',
        accountNames: inst.accounts.map(a => maskNameLevel(a.accountName, namePrivacy)).join(', '),
        host: hostOf(inst.baseUrl),
        succeeded: 0,
        alreadyExists: 0,
        failed: 0,
        reinstallFailed: false,
        errors: [],
      }

      for (let i = 0; i < addons.length; i++) {
        const addon = addons[i]
        try {
          const result = await performInjection(
            inst.baseUrl,
            inst.uuid,
            password,
            addon.name,
            addon.installUrl
          )
          if (result.success && !result.alreadyExists) {
            res.succeeded++
          } else if (result.alreadyExists) {
            res.alreadyExists++
          } else {
            res.failed++
            if (result.error) res.errors.push(`${addon.name}: ${result.error}`)
          }
        } catch (err) {
          res.failed++
          res.errors.push(
            `${addon.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
          )
        }
        setProgressCurrent(prev => prev + 1)
      }

      if (res.succeeded > 0) {
        for (const { accountId } of inst.accounts) {
          try {
            await useAccountStore.getState().reinstallAddon(accountId, inst.transportUrl)
          } catch (e) {
            res.reinstallFailed = true
            if (import.meta.env.DEV) {
              console.warn('[Library Inject] Reinstall failed:', e)
            }
          }
        }
      }

      return res
    })

    const validResults = instanceResults.filter((r): r is InstanceResult => r !== null)

    setResults(validResults)
    setPhase('results')

    const totalSucceeded = validResults.reduce((n, r) => n + r.succeeded, 0)
    const totalExisted = validResults.reduce((n, r) => n + r.alreadyExists, 0)
    const totalFailed = validResults.reduce((n, r) => n + r.failed, 0)
    const reinstallFailures = validResults.filter((r) => r.reinstallFailed).length

    toast({
                    title: 'Added to AIOStreams',
                    description: `${totalSucceeded} added, ${totalExisted} already existed, ${totalFailed} failed across ${validResults.length} instance${validResults.length !== 1 ? 's' : ''}.${reinstallFailures > 0 ? ` ${reinstallFailures} reinstall${reinstallFailures !== 1 ? 's' : ''} failed.` : ''}`,
      variant: totalSucceeded === 0 && totalFailed > 0 ? 'destructive' : 'default',
    })
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && phase === 'injecting') return
    onOpenChange(next)
  }

  const handleInjectMore = () => {
    setPhase('select')
    setSelected(new Set())
    setResults([])
    setProgressCurrent(0)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
                <DialogTitle>Add to AIOStreams</DialogTitle>
          <DialogDescription>
            {phase === 'select'
              ? `Add ${addons.length} saved addon${addons.length !== 1 ? 's' : ''} as custom presets to your AIOStreams instance(s).`
              : phase === 'injecting'
                ? 'Adding...'
                : 'Finished. Review the results below.'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'select' && (
          <div className="min-w-0 space-y-4 py-4">
            {addons.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground">
                  {addons.length} addon{addons.length !== 1 ? 's' : ''} queued
                </Label>
                <ScrollArea className="h-28 rounded-md border p-2">
                  <div className="space-y-1">
                    {addons.map((addon) => (
                      <div key={addon.id} className="flex items-center gap-3 rounded-md p-1.5">
                        <AddonLogo
                          src={addon.manifest?.logo}
                          name={addon.name}
                          className="h-7 w-7"
                          letterClassName="text-[10px]"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{addon.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {addon.manifest?.version ? `v${addon.manifest.version}` : 'addon'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}

            {instances.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                <div className="rounded-full bg-muted/50 p-3 text-muted-foreground">
                  <ServerCog className="h-6 w-6" />
                </div>
                <p className="text-sm font-medium">No AIOStreams instances found</p>
                <p className="text-xs text-muted-foreground">
                  Install the AIOStreams addon on an account to use this feature.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {selected.size} of {selectableInstances.length} instance
                    {selectableInstances.length !== 1 ? 's' : ''} selected
                  </Label>
                  {selectableInstances.length > 0 && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={handleSelectAll}
                      className="h-auto p-0 text-xs"
                    >
                      {allSelected ? 'Deselect All' : 'Select All'}
                    </Button>
                  )}
                </div>

                <ScrollArea className="h-56 rounded-md border p-2">
                  <div className="space-y-1">
                    {instances.map((inst) => {
                      const key = instanceKey(inst)
                      const locked = !inst.hasCredentials
                      const checked = selected.has(key)
                      const host = hostOf(inst.baseUrl)
                      const isDefault = !inst.addonName || inst.addonName === 'AIOStreams'
                      const accountNames = inst.accounts.map(a => maskNameLevel(a.accountName, namePrivacy)).join(', ')
                      const primaryLabel = isDefault ? accountNames : inst.addonName
                      const secondaryLabel = isDefault ? host : `${accountNames} · ${host}`
                      return (
                        <Tooltip
                          key={key}
                          content={locked ? 'No stored credentials for this instance' : undefined}
                          disabled={!locked}
                        >
                          <label
                            data-theme-part="menu-item"
                            className={`flex items-center gap-3 rounded-md p-2 transition-colors ${
                              locked
                                ? 'cursor-not-allowed opacity-60'
                                : 'cursor-pointer hover:bg-muted/50'
                            }`}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={locked}
                              onCheckedChange={() => toggleInstance(key)}
                            />
                            <AddonLogo
                              src={inst.logo}
                              name={primaryLabel}
                              className="h-8 w-8"
                              letterClassName="text-xs"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-sm font-medium">{primaryLabel}</p>
                                {locked && (
                                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                                )}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {secondaryLabel}
                              </p>
                            </div>
                          </label>
                        </Tooltip>
                      )
                    })}
                  </div>
                </ScrollArea>

                {lockedCount > 0 && (
                  <p className="px-2 text-xs text-muted-foreground">
                    {lockedCount} instance{lockedCount !== 1 ? 's' : ''} without stored credentials. Open each instance's addon page in AIOManager and enter its AIOS password to enable.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {phase === 'injecting' && (
          <div className="py-6">
            <OperationProgress
              status="running"
              current={progressCurrent}
              total={totalOps}
              label="Adding..."
              variant="bare"
            />
          </div>
        )}

        {phase === 'results' && (
          <div className="min-w-0 space-y-3 py-4">
            {results.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                    Nothing was added. No instances with stored credentials were selected.
              </p>
            ) : (
              <ScrollArea className="max-h-80 rounded-md border p-2">
                <div className="space-y-2">
                  {results.map((r) => {
                    const hasFailure = r.failed > 0 || r.reinstallFailed
                    const onlyExisted =
                      r.succeeded === 0 && r.failed === 0 && r.alreadyExists > 0
                    const Icon = hasFailure
                      ? AlertCircle
                      : onlyExisted
                        ? Clock
                        : CheckCircle2
                    const iconClass = hasFailure
                      ? 'text-destructive'
                      : onlyExisted
                        ? 'text-muted-foreground'
                        : 'text-success'
                    return (
                      <div
                        key={r.key}
                        data-theme-part="panel"
                        className="rounded-md border border-border/50 p-2.5"
                      >
                        <div className="flex items-start gap-2.5">
                          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{r.accountNames}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {r.displayName === 'AIOStreams' ? r.host : `${r.displayName} · ${r.host}`}
                            </p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              <span className="text-success">
                                {r.succeeded} added
                              </span>
                              <span className="text-muted-foreground">
                                {r.alreadyExists} existed
                              </span>
                              {r.failed > 0 && (
                                <span className="text-destructive">
                                  {r.failed} failed
                                </span>
                              )}
                              {r.reinstallFailed && (
                                <span className="flex items-center gap-1 text-warning">
                                  <RefreshCw className="h-3 w-3" />
                                  reinstall failed
                                </span>
                              )}
                            </div>
                            {r.errors.length > 0 && (
                              <ul className="mt-1.5 space-y-0.5">
                                {r.errors.slice(0, 3).map((e, idx) => (
                                  <li
                                    key={idx}
                                    className="truncate text-xs text-destructive/80"
                                  >
                                    {e}
                                  </li>
                                ))}
                                {r.errors.length > 3 && (
                                  <li className="text-xs text-muted-foreground">
                                    +{r.errors.length - 3} more
                                  </li>
                                )}
                              </ul>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === 'select' && (
            <>
              <Button variant="subtle" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                className="gap-2"
                onClick={handleConfirm}
                disabled={
                  selected.size === 0 || addons.length === 0 || instances.length === 0
                }
              >
                <Layers className="h-4 w-4" />
                Add {addons.length} addon{addons.length !== 1 ? 's' : ''}
                {selected.size > 0 ? ` to ${selected.size}` : ''}
              </Button>
            </>
          )}
          {phase === 'injecting' && (
            <Button disabled>
              <Loader2 className="h-4 w-4 animate-spin" />
              Adding...
            </Button>
          )}
          {phase === 'results' && (
            <>
              <Button variant="subtle" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button className="gap-2" onClick={handleInjectMore}>
                Add More
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
