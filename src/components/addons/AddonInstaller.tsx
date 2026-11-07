import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { ClipboardPaste, Zap, Loader2 } from 'lucide-react'
import { useTheme } from '@/contexts/ThemeContext'
import { AddonIcon } from '@/components/ui/addon-icon'
import { useAddonManifest } from '@/hooks/useAddonManifest'
import { AddonManifest } from '@/types/addon'

export function AddonInstaller() {
  const isOpen = useUIStore((state) => state.isAddAddonDialogOpen)
  const closeDialog = useUIStore((state) => state.closeAddAddonDialog)
  const selectedAccountId = useUIStore((state) => state.selectedAccountId)
  const installAddon = useAccountStore((state) => state.installAddonToAccount)

  const [addonUrl, setAddonUrl] = useState('')
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [isClipboardScanActive, setIsClipboardScanActive] = useState(false)
  const addonUrlRef = useRef(addonUrl)
  addonUrlRef.current = addonUrl
  const [debouncedUrl, setDebouncedUrl] = useState('')
  const { isLight } = useTheme()

  useEffect(() => {
    const trimmed = addonUrl.trim()
    if (!isOpen || !trimmed || !trimmed.startsWith('http')) {
      setDebouncedUrl('')
      return
    }
    const timer = setTimeout(() => {
      setDebouncedUrl(trimmed.replace(/^stremio:\/\//, 'https://'))
    }, 500)
    return () => clearTimeout(timer)
  }, [addonUrl, isOpen])

  const { data: previewDescriptor, isFetching: previewFetching } = useAddonManifest(isOpen ? debouncedUrl : null)
  const previewManifest: AddonManifest | null = debouncedUrl ? previewDescriptor?.manifest ?? null : null
  const previewLoading = debouncedUrl ? previewFetching : false

  useEffect(() => {
    if (!isOpen) {
      setIsClipboardScanActive(false)
      return
    }

    const checkClipboard = async () => {
      try {
        if (!navigator.clipboard) return
        const text = await navigator.clipboard.readText()
        if (addonUrlRef.current !== '') return
        if (text && (text.startsWith('stremio://') || (text.includes('/manifest.json') && text.startsWith('http')))) {
          setAddonUrl(text)
          setIsClipboardScanActive(true)
          setTimeout(() => setIsClipboardScanActive(false), 3000)
        }
      } catch (err) {
        // Silently swallow NotAllowedError/privacy blocks
      }
    }

    // Prefill once per open and only into an empty field; the Paste button covers the rest.
    checkClipboard()
  }, [isOpen])

  const handleClose = () => {
    setAddonUrl('')
    setError('')
    closeDialog()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!selectedAccountId) {
      setError('No account selected')
      return
    }

    if (!addonUrl.trim()) {
      setError('Addon URL is required')
      return
    }

    const normalizedUrl = addonUrl.trim().replace(/^stremio:\/\//, 'https://')

    setInstalling(true)
    try {
      new URL(normalizedUrl)

      await installAddon(selectedAccountId, normalizedUrl)
      handleClose()
    } catch (err) {
      if (err instanceof TypeError) {
        setError('Invalid URL format')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to install addon')
      }
    } finally {
      setInstalling(false)
    }
  }

  const handlePaste = async () => {
    try {
      if (!navigator.clipboard) return
      const text = await navigator.clipboard.readText()
      if (text) {
        setAddonUrl(text)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to read clipboard:', err)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install Addon</DialogTitle>
          <DialogDescription>
            Enter the addon URL to install it to the selected account
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="addonUrl">Addon URL</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-xs"
                onClick={handlePaste}
              >
                <ClipboardPaste className="h-3 w-3" />
                Paste
              </Button>
            </div>
            <Input
              id="addonUrl"
              type="text"
              value={addonUrl}
              onChange={(e) => setAddonUrl(e.target.value)}
              placeholder="https://example.com/addon/manifest.json"
              required
              autoFocus
              className={isClipboardScanActive ? `ring-2 ${isLight ? 'ring-primary/50' : 'ring-primary/25'}` : ""}
            />
            {isClipboardScanActive && (
              <div className="flex items-center gap-1.5 text-xs text-primary font-semibold animate-in fade-in slide-in-from-top-1">
                <Zap className="h-3 w-3" />
                Pasted from clipboard
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The URL should point to the addon's base URL (e.g., https://addon.example.com)
            </p>
          </div>

          {previewLoading && (
            <div data-theme-part="panel" className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking addon...
            </div>
          )}

          {!previewLoading && previewManifest && (
            <div data-theme-part="panel" className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
              <AddonIcon
                name={previewManifest.name || 'Addon'}
                logo={previewManifest.logo}
                alt={previewManifest.name || 'Addon'}
                className="h-9 w-9 shrink-0"
                textClassName="text-xs"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-sm font-semibold">{previewManifest.name || 'Unknown addon'}</span>
                  {previewManifest.version && (
                    <span className="shrink-0 text-xs text-muted-foreground">v{previewManifest.version}</span>
                  )}
                </div>
                {previewManifest.description && (
                  <p className="break-words text-xs text-muted-foreground">{previewManifest.description}</p>
                )}
              </div>
            </div>
          )}

          {error && (
            <div data-theme-tone="status" data-theme-part="panel" className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="subtle" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={installing} className="gap-2">
              {installing && <Loader2 className="h-4 w-4 animate-spin" />}
              {installing ? 'Installing...' : 'Install Addon'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
