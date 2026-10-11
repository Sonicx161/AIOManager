import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { fetchAddonManifest } from '@/api/addons'
import { cn, getStremioLink, maskUrlLevel } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { AddonDescriptor, AddonManifest } from '@/types/addon'
import { Check, ExternalLink, TriangleAlert, X } from 'lucide-react'

interface SourceUrlBoxProps {
  addon?: AddonDescriptor
  accountId?: string
  url?: string
  manifest?: AddonManifest
  onReplace?: (descriptor: AddonDescriptor, requestedUrl: string) => Promise<{ failedAccounts?: string[] } | void>
  privacyMode?: boolean
  variant?: 'compact' | 'full'
  disabled?: boolean
  successDescription?: string
  className?: string
}

export function SourceUrlBox({
  addon,
  accountId,
  url,
  manifest,
  onReplace,
  privacyMode = false,
  variant = 'compact',
  disabled = false,
  successDescription = 'Order, enabled state, notes, protection, and custom metadata were preserved.',
  className,
}: SourceUrlBoxProps) {
  const { toast } = useToast()
  const replaceTransportUrl = useAccountStore((state) => state.replaceTransportUrl)
  const privacyLevelUrls = useUIStore((state) => state.privacyLevelUrls)
  const sourceUrl = addon?.transportUrl || url || ''
  const sourceManifest = addon?.manifest || manifest
  const [isEditing, setIsEditing] = useState(false)
  const [newUrl, setNewUrl] = useState(sourceUrl)
  const [saving, setSaving] = useState(false)
  const [pendingDescriptor, setPendingDescriptor] = useState<AddonDescriptor | null>(null)
  const [needsConfirm, setNeedsConfirm] = useState(false)

  const displayUrl = maskUrlLevel(sourceUrl, privacyMode ? privacyLevelUrls : 0)
  const currentId = sourceManifest?.id || 'unknown'
  const pendingId = pendingDescriptor?.manifest?.id || 'unknown'

  const resetEdit = () => {
    setIsEditing(false)
    setNewUrl(sourceUrl)
    setPendingDescriptor(null)
    setNeedsConfirm(false)
    setSaving(false)
  }

  const beginEdit = () => {
    setNewUrl(sourceUrl)
    setPendingDescriptor(null)
    setNeedsConfirm(false)
    setIsEditing(true)
  }

  const handleReplace = async (allowDifferentAddon = false) => {
    const trimmed = newUrl.trim()
    if (!trimmed) {
      toast({ title: 'Paste a URL first', variant: 'destructive' })
      return
    }
    if (trimmed === sourceUrl.trim()) {
      resetEdit()
      return
    }

    setSaving(true)
    try {
      const descriptor = pendingDescriptor || await fetchAddonManifest(trimmed, accountId || 'System-Check', true)
      const nextId = descriptor.manifest?.id || 'unknown'
      const isDifferentAddon = nextId !== currentId

      setPendingDescriptor(descriptor)
      if (isDifferentAddon && !allowDifferentAddon) {
        setNeedsConfirm(true)
        return
      }

      if (onReplace) {
        const result = await onReplace(descriptor, trimmed)
        if (result?.failedAccounts?.length) {
          toast({
            title: 'URL replaced with sync warnings',
            description: `Could not update ${result.failedAccounts.length} account(s): ${result.failedAccounts.join(', ')}`,
            variant: 'destructive',
          })
          resetEdit()
          return
        }
      } else {
        const result = await replaceTransportUrl(sourceUrl, descriptor.transportUrl || trimmed, accountId, descriptor.manifest)
        try {
          const { useFailoverStore } = await import('@/store/failoverStore')
          await useFailoverStore.getState().replaceUrlInRules(sourceUrl, descriptor.transportUrl || trimmed, accountId)
        } catch {
          // URL replacement should still succeed even if optional failover cleanup is unavailable.
        }
        if (result.failedAccounts.length) {
          toast({
            title: 'URL replaced with sync warnings',
            description: `Could not update ${result.failedAccounts.length} account(s): ${result.failedAccounts.join(', ')}`,
            variant: 'destructive',
          })
          resetEdit()
          return
        }
      }
      toast({ title: 'URL replaced', description: successDescription })
      resetEdit()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to replace source URL'
      toast({ title: 'Replace failed', description: message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={(event) => event.stopPropagation()}
      className={cn(
        'group/url min-w-0 overflow-hidden rounded-lg border border-border/35 bg-muted/20 px-2 py-1.5 transition-colors hover:border-border/60 hover:bg-muted/30',
        variant === 'full' ? 'space-y-2' : 'space-y-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {isEditing ? (
          <>
            <Input
              value={newUrl}
              onChange={(event) => {
                setNewUrl(event.target.value)
                setPendingDescriptor(null)
                setNeedsConfirm(false)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') resetEdit()
                if (event.key === 'Enter') handleReplace(false)
              }}
              className="h-8 min-w-0 flex-1 border-border/30 bg-transparent px-2 py-1 font-mono text-xs"
              autoFocus
            />
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip content="Cancel">
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 flex items-center justify-center" onClick={resetEdit} disabled={saving} aria-label="Cancel URL edit">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
              <Tooltip content={needsConfirm ? 'Replace anyway' : 'Check and replace'}>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 flex items-center justify-center text-primary hover:text-primary" onClick={() => handleReplace(needsConfirm)} disabled={saving} aria-label="Save URL">
                  <Check className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-text truncate text-left font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            onClick={beginEdit}
            disabled={disabled}
            aria-label="Replace URL"
          >
            {displayUrl}
          </button>
        )}

        {!isEditing && (
          <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/url:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
            <CopyButton value={sourceUrl} variant="inline" iconSize={12} className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-background/70 hover:text-foreground" />
            <Tooltip content="Open in Stremio">
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:bg-background/70 hover:text-foreground" onClick={() => { window.location.href = getStremioLink(sourceUrl) }} aria-label="Open in Stremio">
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {needsConfirm && pendingDescriptor && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">This looks like a different addon.</p>
            <p className="mt-0.5 truncate text-warning/80">{currentId} {'->'} {pendingId}. Press the check again to replace anyway.</p>
          </div>
        </div>
      )}
    </div>
  )
}
