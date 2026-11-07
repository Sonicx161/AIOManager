import { Button } from '@/components/ui/button'
import { ImageUploadButton } from '@/components/ui/image-upload-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RotateCcw, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { normalizeTagName } from '@/lib/addon-validator'
import { useAddonStore } from '@/store/addonStore'
import { useProfileStore } from '@/store/profileStore'
import { useUIStore } from '@/store/uiStore'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SavedAddon } from '@/types/saved-addon'
import type { Account } from '@/types/account'
import { useState, useEffect, useMemo } from 'react'
import { useToast } from '@/hooks/use-toast'
import { SourceUrlBox } from '@/components/addons/SourceUrlBox'
import { ManifestJSONEditor } from '@/components/addons/ManifestJSONEditor'
import { SavedAddonCardPreview } from './SavedAddonCardPreview'
import { getTagColor } from '@/lib/tag-utils'
import type { AddonDescriptor } from '@/types/addon'

export function SavedAddonDetails({ savedAddon, deployedAccounts = [], onClose }: { savedAddon: SavedAddon; deployedAccounts?: Account[]; onClose: () => void }) {
  const updateSavedAddon = useAddonStore(s => s.updateSavedAddon)
  const updateSavedAddonMetadata = useAddonStore(s => s.updateSavedAddonMetadata)
  const replaceTransportUrlUniversally = useAddonStore(s => s.replaceTransportUrlUniversally)
  const library = useAddonStore(s => s.library)
  const loading = useAddonStore(s => s.loading)
  const error = useAddonStore(s => s.error)
  const profiles = useProfileStore(s => s.profiles)
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { toast } = useToast()

  const currentProfileId = savedAddon.profileId ?? 'unassigned'

  const [formData, setFormData] = useState({
    name: savedAddon.metadata?.customName || '',
    tags: savedAddon.tags,
    customLogo: savedAddon.metadata?.customLogo || '',
    customDescription: savedAddon.metadata?.customDescription || '',
    syncWithInstalled: savedAddon.syncWithInstalled ?? false,
    profileId: currentProfileId,
  })
  const [tagInput, setTagInput] = useState('')

  const [syncAccountIds, setSyncAccountIds] = useState<string[] | null>(
    Array.isArray(savedAddon.syncAccountIds) ? savedAddon.syncAccountIds : null
  )

  useEffect(() => {
    setFormData({
      name: savedAddon.metadata?.customName || '',
      tags: savedAddon.tags,
      customLogo: savedAddon.metadata?.customLogo || '',
      customDescription: savedAddon.metadata?.customDescription || '',
      syncWithInstalled: savedAddon.syncWithInstalled ?? false,
      profileId: savedAddon.profileId ?? 'unassigned',
    })
    setSyncAccountIds(Array.isArray(savedAddon.syncAccountIds) ? savedAddon.syncAccountIds : null)
  }, [savedAddon])

  const [formError, setFormError] = useState<string | null>(null)

  const hasChanges =
    formData.name !== (savedAddon.metadata?.customName || '') ||
    formData.tags.join(', ') !== savedAddon.tags.join(', ') ||
    formData.customLogo !== (savedAddon.metadata?.customLogo || '') ||
    formData.customDescription !== (savedAddon.metadata?.customDescription || '') ||
    formData.syncWithInstalled !== (savedAddon.syncWithInstalled ?? false) ||
    formData.profileId !== currentProfileId ||
    JSON.stringify(syncAccountIds ?? null) !== JSON.stringify(Array.isArray(savedAddon.syncAccountIds) ? savedAddon.syncAccountIds : null)

  const addTag = (raw: string) => {
    const incoming = raw.split(/[,\s]+/).map(t => normalizeTagName(t)).filter(Boolean)
    if (incoming.length === 0) return
    setFormData(prev => {
      const next = [...prev.tags]
      for (const tag of incoming) if (!next.includes(tag)) next.push(tag)
      return next.length === prev.tags.length ? prev : { ...prev, tags: next }
    })
  }

  const removeTag = (tag: string) => {
    setFormData(prev => ({ ...prev, tags: prev.tags.filter(t => t !== tag) }))
  }

  // Existing library tags not on the draft yet, offered as one-tap suggestions.
  const tagSuggestions = useMemo(() => {
    const known = new Set<string>()
    for (const item of Object.values(library)) {
      for (const tag of item.tags) {
        const normalized = normalizeTagName(tag)
        if (normalized) known.add(normalized)
      }
    }
    const draft = new Set(formData.tags.map(normalizeTagName))
    return [...known]
      .filter(tag => !draft.has(tag))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 6)
  }, [library, formData.tags])

  const profileName = profiles.find(profile => profile.id === formData.profileId)?.name

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)

    try {
      const tags = Array.from(new Set(formData.tags
        .map((t) => normalizeTagName(t))
        .filter(Boolean)))

      const name = formData.name.trim()

      await updateSavedAddon(savedAddon.id, {
        name: name || savedAddon.manifest.name,
        tags,
        syncWithInstalled: formData.syncWithInstalled,
        syncAccountIds,
        profileId: formData.profileId === 'unassigned' ? null : formData.profileId,
        metadata: {
          customName: name || undefined,
          customLogo: formData.customLogo.trim() || undefined,
          customDescription: formData.customDescription.trim() || undefined
        }
      })

      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update saved addon')
    }
  }

  const handleReplaceUrl = async (descriptor: AddonDescriptor, requestedUrl: string) => {
    setFormError(null)
    return replaceTransportUrlUniversally(savedAddon.id, savedAddon.installUrl, descriptor.transportUrl || requestedUrl, undefined, descriptor)
  }

  const handleResetDefaults = async () => {
    try {
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
        name: '',
        customLogo: '',
        customDescription: ''
      }))

      toast({
        title: 'Reset Complete',
        description: `Restored original manifest values for "${originalManifest.name}".`,
      })
    } catch (err) {
      if (import.meta.env.DEV) console.error('Reset failed:', err)
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
        name: '',
        customLogo: '',
        customDescription: ''
      }))
      toast({
        title: 'Reset Complete',
        description: 'Reset to stored defaults (could not reach addon server).',
      })
    }
  }

  const resetInputClass = 'absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground'

  return (
    <form onSubmit={handleSubmit} className="min-w-0">
      {(formError || error) && (
        <div data-theme-tone="status" data-theme-part="panel" className="mb-4 rounded-md border border-destructive/20 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{formError || error}</p>
        </div>
      )}

      <Tabs defaultValue="customize" className="min-w-0 w-full">
        <TabsList className="mb-2 w-full flex-nowrap sm:w-fit">
          <TabsTrigger value="customize" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
            Customize
          </TabsTrigger>
          <TabsTrigger value="library" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
            Library
          </TabsTrigger>
          <TabsTrigger value="advanced" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
            Advanced
          </TabsTrigger>
        </TabsList>

        {/* forceMount keeps in-progress drafts (tag edits, manifest JSON) alive
            across tab switches. Radix never applies the hidden attribute to
            force-mounted panels, so inactive ones are hidden via the
            data-state class instead of unmounting. */}
        <TabsContent value="customize" forceMount className="min-w-0 data-[state=inactive]:hidden">
          <div className="flex flex-col-reverse gap-6 py-2 md:grid md:grid-cols-2">
            <div className="min-w-0 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Display Name</Label>
                <div className="relative">
                  <Input
                    id="edit-name"
                    type="text"
                    className="pr-10"
                    value={formData.name}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder={savedAddon.manifest.name}
                    maxLength={100}
                  />
                  {formData.name && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setFormData((prev) => ({ ...prev, name: '' }))}
                      aria-label="Reset Display Name"
                      className={resetInputClass}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-logo">Logo URL</Label>
                <div className="relative">
                  <Input
                    id="edit-logo"
                    type="text"
                    className="pr-10"
                    value={formData.customLogo.startsWith('data:') ? '\u2713 Uploaded image' : formData.customLogo}
                    onChange={(e) => setFormData((prev) => ({ ...prev, customLogo: e.target.value }))}
                    placeholder="https://..."
                    readOnly={formData.customLogo.startsWith('data:')}
                  />
                  {formData.customLogo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setFormData((prev) => ({ ...prev, customLogo: '' }))}
                      aria-label="Reset Logo URL"
                      className={resetInputClass}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <ImageUploadButton
                  onUploaded={(dataUrl) => setFormData((prev) => ({ ...prev, customLogo: dataUrl }))}
                  options={{ maxDimension: 512, square: false, quality: 0.85 }}
                  className="flex h-8 w-fit items-center gap-1.5 rounded-full border border-border/40 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                >
                  <Upload className="h-3 w-3" /> Upload Image
                </ImageUploadButton>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <div className="relative">
                  <textarea
                    id="edit-description"
                    data-theme-part="textarea"
                    className="flex min-h-[120px] w-full rounded-xl border border-border/40 bg-muted/30 px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={formData.customDescription}
                    onChange={(e) => setFormData((prev) => ({ ...prev, customDescription: e.target.value }))}
                    placeholder={savedAddon.manifest.description}
                  />
                  {formData.customDescription && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setFormData((prev) => ({ ...prev, customDescription: '' }))}
                      aria-label="Reset Description"
                      className="absolute bottom-2 right-2 h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="w-full min-w-0 space-y-2 md:sticky md:top-0 md:self-start">
              <span className="text-xs font-medium uppercase text-muted-foreground">Dashboard Preview</span>
              <SavedAddonCardPreview
                savedAddon={savedAddon}
                deployedAccounts={deployedAccounts}
                name={formData.name}
                logo={formData.customLogo}
                description={formData.customDescription}
                tags={formData.tags}
                profileName={profileName}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="library" forceMount className="min-w-0 data-[state=inactive]:hidden">
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-profile">Profile</Label>
              <Select
                value={formData.profileId}
                onValueChange={(value) => setFormData((prev) => ({ ...prev, profileId: value }))}
              >
                <SelectTrigger id="edit-profile">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input
                id="edit-tags"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onBlur={() => {
                  if (!tagInput.trim()) return
                  addTag(tagInput)
                  setTagInput('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addTag(tagInput)
                    setTagInput('')
                  }
                }}
                placeholder="Add tag"
              />
              {formData.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {formData.tags.map((tag) => {
                    const color = getTagColor(tag)
                    return (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-xs font-medium"
                        style={{ background: color.bg, color: color.text, border: `1px solid ${color.border}` }}
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeTag(tag)}
                          aria-label={`Remove tag ${tag}`}
                          className="flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-foreground/10"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
              {tagSuggestions.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tagSuggestions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => addTag(tag)}
                      aria-label={`Add tag ${tag}`}
                      className="rounded-full border border-border/40 bg-muted/30 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <Label htmlFor="sync-with-installed" className="block truncate text-sm font-semibold">Keep in sync with installed versions</Label>
                <p className="text-xs text-muted-foreground">
                  {deployedAccounts.length > 0
                    ? `Auto-push changes to ${syncAccountIds ? `${syncAccountIds.length} selected account${syncAccountIds.length !== 1 ? 's' : ''}` : `${deployedAccounts.length} account${deployedAccounts.length !== 1 ? 's' : ''}`} where this is installed.`
                    : 'Auto-push URL and metadata changes to accounts where this addon is installed.'}
                </p>
              </div>
              <div className="flex-shrink-0">
                <Switch
                  id="sync-with-installed"
                  checked={formData.syncWithInstalled}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, syncWithInstalled: checked }))}
                />
              </div>
            </div>

            {formData.syncWithInstalled && deployedAccounts.length > 0 && (
              <div data-theme-part="panel" className="space-y-1.5 rounded-xl border border-border/40 bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {syncAccountIds === null ? 'Syncing to all accounts (default)' : `Syncing to ${syncAccountIds.length} of ${deployedAccounts.length} accounts`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-theme-part="button"
                    data-state={syncAccountIds === null ? 'active' : 'inactive'}
                    onClick={() => setSyncAccountIds(null)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      syncAccountIds === null
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-border/40 bg-background/60 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    All accounts
                  </button>
                  {deployedAccounts.map(acc => {
                    const checked = syncAccountIds?.includes(acc.id) ?? false
                    return (
                      <button
                        key={acc.id}
                        type="button"
                        data-theme-part="button"
                        data-state={checked ? 'active' : 'inactive'}
                        aria-pressed={checked}
                        onClick={() => {
                          setSyncAccountIds(prev => {
                            const current = prev ?? deployedAccounts.map(a => a.id)
                            return current.includes(acc.id)
                              ? current.filter(id => id !== acc.id)
                              : [...current, acc.id]
                          })
                        }}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                          checked
                            ? 'border-primary/40 bg-primary/15 text-primary'
                            : 'border-border/40 bg-background/60 text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {acc.name || acc.email || acc.id}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div data-theme-part="panel" className="-mx-6 mt-4 grid grid-cols-1 gap-4 border-t bg-muted/50 px-6 py-4 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <span className="mb-1 block font-semibold">Developer Info</span>
                <div className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5">
                  <span>ID</span>
                  <span className="break-all text-right">{isPrivacyModeEnabled ? '********' : savedAddon.manifest.id}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5">
                  <span>Source</span>
                  <span className="break-words text-right">{savedAddon.sourceType === 'manual' ? 'Manual' : 'Cloned from account'}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5">
                  <span>Updated</span>
                  <span>{new Date(savedAddon.updatedAt).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center justify-between gap-3 py-1.5">
                  <span>Version</span>
                  <span>{savedAddon.manifest.version}</span>
                </div>
              </div>
              <div>
                <span className="mb-1 block font-semibold">Source URL</span>
                <SourceUrlBox
                  url={savedAddon.installUrl}
                  manifest={savedAddon.manifest}
                  privacyMode={isPrivacyModeEnabled}
                  variant="compact"
                  onReplace={handleReplaceUrl}
                  successDescription="Library entry, installed copies, and Autopilot rules were updated."
                  className="mt-1 bg-background/45"
                />
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="advanced" forceMount className="min-w-0 data-[state=inactive]:hidden">
          <div className="py-2">
            <ManifestJSONEditor
              embedded
              manifest={savedAddon.manifest}
              onSave={async (newManifest) => {
                await updateSavedAddon(savedAddon.id, { manifest: newManifest, name: newManifest.name })
                await updateSavedAddonMetadata(savedAddon.id, {
                  customName: undefined,
                  customLogo: undefined,
                  customDescription: undefined
                })
                onClose()
              }}
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* Pinned footer: stays visible while the dialog body scrolls. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-col gap-2 border-t border-border/40 bg-card px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:pb-6 [&_button]:rounded-full [&_button]:px-5">
        <Button type="button" variant="subtle" className="order-last h-9 w-full sm:order-none sm:h-11 sm:w-auto" disabled={loading} onClick={handleResetDefaults}>
          Reset to Defaults
        </Button>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3 [&_button]:h-11">
          <Button type="button" variant="subtle" disabled={loading} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading || !hasChanges}>
            {loading ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </form>
  )
}
