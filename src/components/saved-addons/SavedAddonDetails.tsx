import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { normalizeTagName } from '@/lib/addon-validator'
import { useAddonStore } from '@/store/addonStore'
import { useUIStore } from '@/store/uiStore'
import { Switch } from '@/components/ui/switch'
import { SavedAddon } from '@/types/saved-addon'
import { useState } from 'react'
import { useToast } from '@/hooks/use-toast'

export function SavedAddonDetails({ savedAddon, onClose }: { savedAddon: SavedAddon, onClose: () => void }) {
  const { updateSavedAddon, updateSavedAddonMetadata, replaceTransportUrlUniversally, loading, error } = useAddonStore()
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { toast } = useToast()

  const [formData, setFormData] = useState({
    name: savedAddon.name,
    tags: savedAddon.tags.join(', '),
    installUrl: savedAddon.installUrl,
    customLogo: savedAddon.metadata?.customLogo || '',
    customDescription: savedAddon.metadata?.customDescription || '',
    syncWithInstalled: savedAddon.syncWithInstalled ?? false,
  })

  const [formError, setFormError] = useState<string | null>(null)
  const [newUrl, setNewUrl] = useState(savedAddon.installUrl)
  const [replacingUrl, setReplacingUrl] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const hasChanges =
    formData.name !== savedAddon.name ||
    formData.tags !== savedAddon.tags.join(', ') ||
    formData.customLogo !== (savedAddon.metadata?.customLogo || '') ||
    formData.customDescription !== (savedAddon.metadata?.customDescription || '') ||
    formData.syncWithInstalled !== (savedAddon.syncWithInstalled ?? false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)

    try {
      // Parse tags
      const tags = formData.tags
        .split(/[,\s]+/)
        .map((t) => normalizeTagName(t))
        .filter(Boolean)

      const name = formData.name.trim()

      await updateSavedAddon(savedAddon.id, {
        name,
        tags,
        installUrl: formData.installUrl.trim(),
        syncWithInstalled: formData.syncWithInstalled,
        metadata: {
          customName: name,
          customLogo: formData.customLogo.trim() || undefined,
          customDescription: formData.customDescription.trim() || undefined
        }
      })

      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update saved addon')
    }
  }

  const handleReplaceUrl = async () => {
    if (!newUrl.trim() || newUrl === savedAddon.installUrl) return

    setReplacingUrl(true)
    setFormError(null)
    try {
      await replaceTransportUrlUniversally(savedAddon.id, savedAddon.installUrl, newUrl.trim())
      // Keep advanced open but updated
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to replace URL')
    } finally {
      setReplacingUrl(false)
    }
  }

  return (
    <div className="space-y-6">
      {(formError || error) && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{formError || error}</p>
        </div>
      )}


      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Saved Addon Name */}
        <div className="space-y-2">
          <Label htmlFor="edit-name">Saved Addon Name</Label>
          <Input
            id="edit-name"
            type="text"
            value={formData.name}
            onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
            maxLength={100}
            required
          />
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label htmlFor="edit-tags">Tags</Label>
          <Input
            id="edit-tags"
            type="text"
            value={formData.tags}
            onChange={(e) => setFormData((prev) => ({ ...prev, tags: e.target.value }))}
            placeholder="e.g., essential, torrent, debrid"
          />
        </div>


        {/* Custom Logo */}
        <div className="space-y-2">
          <Label htmlFor="edit-logo">Custom Logo URL</Label>
          <Input
            id="edit-logo"
            type="text"
            value={formData.customLogo}
            onChange={(e) => setFormData((prev) => ({ ...prev, customLogo: e.target.value }))}
            placeholder="https://... (Leave empty for default)"
          />
        </div>

        {/* Custom Description */}
        <div className="space-y-2">
          <Label htmlFor="edit-description">Custom Description</Label>
          <textarea
            id="edit-description"
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            value={formData.customDescription}
            onChange={(e) => setFormData((prev) => ({ ...prev, customDescription: e.target.value }))}
            placeholder={savedAddon.manifest.description}
          />
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
          <div className="space-y-0.5">
            <Label htmlFor="sync-with-installed" className="text-sm font-semibold">Keep in sync with installed versions</Label>
            <p className="text-[10px] text-muted-foreground uppercase tracking-tight">
              When enabled, changing this addon's URL or metadata in the library will automatically update it across all accounts where it is installed.
            </p>
          </div>
          <Switch
            id="sync-with-installed"
            checked={formData.syncWithInstalled}
            onCheckedChange={(checked) => setFormData(prev => ({ ...prev, syncWithInstalled: checked }))}
          />
        </div>

        {/* Manifest Info */}
        <div className="space-y-2">
          <Label>Addon Info</Label>
          <div className="flex items-start gap-3">
            {formData.customLogo || savedAddon.manifest.logo ? (
              <img
                src={formData.customLogo || savedAddon.manifest.logo}
                alt={savedAddon.manifest.name}
                className="w-12 h-12 rounded object-contain flex-shrink-0 bg-transparent"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : (
              <div className="w-12 h-12 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                <span className="text-lg text-gray-500 dark:text-gray-400">📦</span>
              </div>
            )}
            <div className="text-sm space-y-1">
              <p>
                <span className="font-medium">Name:</span> {savedAddon.manifest.name}
              </p>
              <p>
                <span className="font-medium">ID:</span>{' '}
                {isPrivacyModeEnabled ? '********' : savedAddon.manifest.id}
              </p>
              <p>
                <span className="font-medium">Version:</span> {savedAddon.manifest.version}
              </p>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-2">
          <Label>Metadata</Label>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Created: {new Date(savedAddon.createdAt).toLocaleString()}</p>
            <p>Updated: {new Date(savedAddon.updatedAt).toLocaleString()}</p>
            {savedAddon.lastUsed && (
              <p>Last used: {new Date(savedAddon.lastUsed).toLocaleString()}</p>
            )}
            <p>Source: {savedAddon.sourceType === 'manual' ? 'Manual' : 'Cloned from account'}</p>
          </div>
        </div>

        {/* Advanced Section */}
        <div className="mt-4 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[10px] uppercase font-bold tracking-widest opacity-50 hover:opacity-100 p-0 h-auto"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
          </Button>

          {showAdvanced && (
            <div className="mt-4 p-4 border rounded-md bg-destructive/5 border-destructive/20 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-destructive uppercase tracking-tight">Replace Transport URL</h4>
                <p className="text-xs text-muted-foreground">
                  Swap the underlying manifest URL. This will also update any Autopilot rules using this addon.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  id="edit-url"
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="Enter new manifest URL"
                  className="flex-1 text-xs bg-background"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleReplaceUrl}
                  disabled={replacingUrl || !newUrl.trim() || newUrl === savedAddon.installUrl}
                >
                  {replacingUrl ? 'Updating...' : 'Replace'}
                </Button>
              </div>
              {!isPrivacyModeEnabled && (
                <p className="text-[10px] text-muted-foreground truncate uppercase opacity-50">
                  Current: {savedAddon.installUrl}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4">
          <Button
            type="button"
            variant="outline"
            className="mr-auto"
            disabled={loading || replacingUrl}
            onClick={async () => {
              try {
                // Fetch the original manifest from the addon URL
                const { fetchAddonManifest } = await import('@/api/addons')
                const fetched = await fetchAddonManifest(savedAddon.installUrl)
                const originalManifest = fetched.manifest

                await updateSavedAddonMetadata(savedAddon.id, {
                  customName: undefined,
                  customLogo: undefined,
                  customDescription: undefined
                })
                await updateSavedAddon(savedAddon.id, {
                  name: originalManifest.name || savedAddon.manifest.name
                })

                setFormData(prev => ({
                  ...prev,
                  name: originalManifest.name || savedAddon.manifest.name,
                  customLogo: '',
                  customDescription: ''
                }))

                toast({
                  title: 'Reset Complete',
                  description: `Restored original manifest values for "${originalManifest.name}".`,
                })
              } catch (err) {
                console.error('Reset failed:', err)
                // Fallback: reset using stored manifest values
                await updateSavedAddonMetadata(savedAddon.id, {
                  customName: undefined,
                  customLogo: undefined,
                  customDescription: undefined
                })
                await updateSavedAddon(savedAddon.id, {
                  name: savedAddon.manifest.name
                })
                setFormData(prev => ({
                  ...prev,
                  name: savedAddon.manifest.name,
                  customLogo: '',
                  customDescription: ''
                }))
                toast({
                  title: 'Reset Complete',
                  description: 'Reset to stored defaults (could not reach addon server).',
                })
              }
            }}
          >
            Reset to Defaults
          </Button>
          <Button type="submit" disabled={loading || !hasChanges}>
            {loading ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </div>
  )
}
