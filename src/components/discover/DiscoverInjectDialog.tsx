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
import { AddonLogo } from '@/components/discover/AddonLogo'
import { useToast } from '@/hooks/use-toast'
import { getStoredAIOStreamsPassword } from '@/lib/aiostreams-utils'
import { useUIStore } from '@/store/uiStore'
import { maskNameLevel } from '@/lib/utils'
import type { AIOStreamsInstance, AIOStreamsInstanceAccount } from '@/hooks/useAIOStreamsInstances'
import { Lock, Loader2, ServerCog } from 'lucide-react'

export type DiscoverInjectInstance = AIOStreamsInstance

export interface DiscoverInjectSelection {
  baseUrl: string
  uuid: string
  password: string
  accounts: AIOStreamsInstanceAccount[]
  transportUrl: string
}

interface DiscoverInjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  addonName: string
  instances: DiscoverInjectInstance[]
  onConfirm: (selectedInstances: DiscoverInjectSelection[]) => Promise<void>
}

function hostOf(baseUrl: string): string {
  try {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
}

function instanceKey(inst: DiscoverInjectInstance): string {
  return `${inst.baseUrl}|${inst.uuid}`
}

export function DiscoverInjectDialog({
  open,
  onOpenChange,
  addonName,
  instances,
  onConfirm,
}: DiscoverInjectDialogProps) {
  const { toast } = useToast()
  const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
  const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
  const namePrivacy = isPrivacyModeEnabled ? privacyLevelNames : 0
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const handleOpenChange = (next: boolean) => {
      if (!next && loading) return
      onOpenChange(next)
  }

  const resetState = useCallback(() => {
    setSelected(new Set())
    setLoading(false)
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

  const handleConfirm = async () => {
    if (selected.size === 0) return
    setLoading(true)
    try {
      const payload: DiscoverInjectSelection[] = []
      for (const inst of instances) {
        if (!selected.has(instanceKey(inst))) continue
        const password = getStoredAIOStreamsPassword(inst.baseUrl, inst.uuid)
        if (!password) continue
        payload.push({ baseUrl: inst.baseUrl, uuid: inst.uuid, password, accounts: inst.accounts, transportUrl: inst.transportUrl })
      }
      if (payload.length === 0) {
        toast({
          title: 'No instances available',
            description: "No stored credentials. Open each instance's addon page in AIOManager and enter its AIOS password to enable.",
          variant: 'destructive',
        })
        return
      }
      await onConfirm(payload)
      toast({
        title: 'Added to AIOStreams',
        description: `Added ${addonName.trim() || 'the addon'} to ${payload.length} instance${payload.length !== 1 ? 's' : ''}.`,
      })
      onOpenChange(false)
    } catch (error) {
      toast({
        title: 'Could not add the addon',
                description: error instanceof Error ? error.message : 'Something went wrong.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  const allSelected =
    selectableInstances.length > 0 && selected.size === selectableInstances.length
  const lockedCount = instances.length - selectableInstances.length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to AIOStreams</DialogTitle>
          <DialogDescription>
            {addonName.trim()
              ? `Add ${addonName.trim()} as a custom addon to your AIOStreams instance(s).`
              : 'Add this addon as a custom addon to your AIOStreams instance(s).'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4 py-4">
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

              <ScrollArea data-theme-part="panel" className="h-64 rounded-md border p-2">
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

        <DialogFooter>
          <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            className="gap-2"
            onClick={handleConfirm}
            disabled={loading || selected.size === 0}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? 'Adding...' : 'Add to AIOStreams'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
