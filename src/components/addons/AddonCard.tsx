import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { isCinemetaAddon, detectAllPatches } from '@/lib/cinemeta-utils'
import { CinemetaManifest } from '@/types/cinemeta'
import { getStremioLink, maskUrl, isNewerVersion } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { useProfileStore } from '@/store/profileStore'
import { useUIStore } from '@/store/uiStore'
import { AddonDescriptor } from '@/types/addon'

import { Copy, ExternalLink, List, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useState, useEffect } from 'react'
import { AddonMetadataDialog } from './AddonMetadataDialog'
import { CinemetaConfigurationDialog } from './CinemetaConfigurationDialog'
import { CatalogEditorDialog } from './CatalogEditorDialog'
import { Switch } from '@/components/ui/switch'
import { usePendingRemoval } from '@/hooks/useSyncManager'
import { AnimatedUpdateIcon, AnimatedRefreshIcon, AnimatedShieldIcon, AnimatedSettingsIcon, AnimatedHeartIcon } from '../ui/AnimatedIcons'

// --- URL Helpers ---
const MANIFEST_SUFFIX_REGEX = /\/manifest(\.[^/?#]+)?$/i

const normalizeBaseUrl = (raw?: string | null): string | null => {
  if (typeof raw !== 'string') return null
  let candidate = raw.trim()
  if (!candidate) return null
  candidate = candidate.replace(/\?.*$/, '').replace(/#.*$/, '')
  candidate = candidate.replace(/\/configure\/?$/i, '')
  candidate = candidate.replace(MANIFEST_SUFFIX_REGEX, '')
  try {
    const parsed = new URL(candidate)
    let pathname = parsed.pathname
    if (pathname.endsWith('/') && pathname !== '/') {
      pathname = pathname.slice(0, -1)
    }
    return pathname && pathname !== '/' ? `${parsed.origin}${pathname}` : parsed.origin
  } catch {
    return candidate || null
  }
}

const extractOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    const match = url.match(/^https?:\/\/[^/]+/i)
    return match ? match[0] : null
  }
}

const appendConfigure = (baseUrl: string | null): string | null => {
  if (!baseUrl) return null
  return baseUrl.endsWith('/') ? `${baseUrl}configure` : `${baseUrl}/configure`
}

const buildCandidateUrls = (addon: AddonDescriptor): string[] => {
  const manifest = addon.manifest as unknown as Record<string, unknown>
  const transportUrl = addon.transportUrl

  const baseCandidates = [
    manifest.configureUrl as string | undefined,
    manifest.configure as string | undefined,
    manifest.configUrl as string | undefined,
    manifest.manifestUrl as string | undefined,
    transportUrl
  ]

  const seen = new Set<string>()
  const result: string[] = []

  const push = (value: string | null | undefined) => {
    if (!value) return
    const trimmed = value.trim()
    if (!trimmed || !trimmed.startsWith('http')) return
    const normalized = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
    if (seen.has(normalized)) return
    seen.add(normalized)
    result.push(normalized)
  }

  for (const candidate of baseCandidates) {
    const baseUrl = normalizeBaseUrl(candidate as string | undefined)
    if (!baseUrl) continue
    push(appendConfigure(baseUrl))
    push(baseUrl)
    push(extractOrigin(baseUrl))
  }

  return result
}

interface AddonCardProps {
  addon: AddonDescriptor
  accountId: string
  accountAuthKey: string
  onRemove: (accountId: string, transportUrl: string) => Promise<void>
  onUpdate?: (accountId: string, transportUrl: string) => Promise<void>
  latestVersion?: string
  isOnline?: boolean
  healthError?: string
  loading?: boolean
  loader?: boolean
  isSelectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (addonId: string) => void
  selectionId?: string
  index?: number // Optional for index-based targeting (handling duplicates)
}

export function AddonCard({
  addon,
  accountId,
  accountAuthKey,
  onRemove,
  onUpdate,
  latestVersion,
  isOnline,
  healthError,
  loading,
  isSelectionMode,
  isSelected,
  onToggleSelect,
  selectionId,
  index
}: AddonCardProps) {
  const { library, createSavedAddon } = useAddonStore()
  const { profiles, initialize: initProfiles, createProfile } = useProfileStore()
  const accounts = useAccountStore(state => state.accounts)
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { toast } = useToast()

  const [saving, setSaving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [showRemoveDialog, setShowRemoveDialog] = useState(false)

  const [saveName, setSaveName] = useState('')
  const [saveTags, setSaveTags] = useState('')
  const [saveProfileId, setSaveProfileId] = useState<string>('unassigned')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [showCatalogEditor, setShowCatalogEditor] = useState(false)
  const [showUnprotectConfirmation, setShowUnprotectConfirmation] = useState(false)
  const [showMetadataDialog, setShowMetadataDialog] = useState(false)
  const [showReinstallConfirm, setShowReinstallConfirm] = useState(false)
  const isPendingRemoval = usePendingRemoval(accountId, addon.transportUrl)

  useEffect(() => {
    initProfiles()
  }, [initProfiles])

  const handleSaveMetadata = async (metadata: { customName?: string; customLogo?: string; customDescription?: string }) => {
    try {
      await useAccountStore.getState().updateAddonSettings(accountId, addon.transportUrl, { metadata }, index)
      toast({
        title: 'Appearance Updated',
        description: 'Addon metadata has been customized and synced to Stremio.'
      })
    } catch (err) {
      console.error('Metadata sync failed', err)
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: 'Failed to push customization to Stremio.'
      })
    }
  }

  const handleRemove = () => {
    setShowRemoveDialog(true)
  }

  const handleConfirmRemove = async () => {
    setRemoving(true)
    try {
      await onRemove(accountId, addon.transportUrl)
      setShowRemoveDialog(false)
      toast({
        title: 'Addon Removed',
        description: `Successfully removed ${addon.manifest.name}`
      })
    } catch (error) {
      console.error('Failed to remove addon:', error)
      toast({
        variant: 'destructive',
        title: 'Removal Failed',
        description: error instanceof Error ? error.message : 'Failed to remove addon'
      })
      setShowRemoveDialog(false)
    } finally {
      setRemoving(false)
    }
  }

  const isCinemeta = useMemo(() => isCinemetaAddon(addon), [addon])

  const isPatched = useMemo(() => {
    if (!isCinemeta) return false
    const status = detectAllPatches(addon.manifest as CinemetaManifest)
    return Object.values(status).some(val => val === true)
  }, [isCinemeta, addon.manifest])

  const isInstalled = useMemo(() => {
    return Object.values(library).some(
      (savedAddon) =>
        savedAddon.manifest.id === addon.manifest.id && savedAddon.installUrl === addon.transportUrl
    )
  }, [library, addon.manifest.id, addon.transportUrl])

  const isExternal = useMemo(() => {
    return !addon.flags?.protected && !addon.flags?.official
  }, [addon.flags?.protected, addon.flags?.official])

  const canSaveToLibrary = useMemo(() => {
    return isExternal && !isInstalled
  }, [isExternal, isInstalled])

  const hasUpdate = latestVersion ? isNewerVersion(addon.manifest.version, latestVersion) : false
  const canUpdate = !!onUpdate

  const openSaveModal = () => {
    setSaveName(addon.manifest.name)
    setSaveTags('')

    const currentAccount = accounts.find(a => a.id === accountId)
    const customName = currentAccount?.name?.trim()
    const emailName = currentAccount?.email?.split('@')[0]?.trim()

    let matchingProfile = undefined
    if (customName) {
      matchingProfile = profiles.find(p => p.name.trim().toLowerCase() === customName.trim().toLowerCase())
    }
    if (!matchingProfile && emailName) {
      matchingProfile = profiles.find(p => p.name.trim().toLowerCase() === emailName.trim().toLowerCase())
    }

    if (matchingProfile) {
      setSaveProfileId(matchingProfile.id)
      setIsCreatingProfile(false)
    } else {
      setSaveProfileId('unassigned')
      setNewProfileName(customName || emailName || 'My Profile')
      setIsCreatingProfile(true)
    }

    setSaveError(null)
    setShowSaveModal(true)
  }

  const closeSaveModal = () => {
    setShowSaveModal(false)
    setSaveName('')
    setSaveTags('')
    setSaveError(null)
    setIsCreatingProfile(false)
  }

  const handleSaveToLibrary = async () => {
    if (!saveName.trim()) {
      setSaveError('Please enter a name for this addon.')
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      const tags = saveTags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)

      let finalProfileId = saveProfileId === 'unassigned' ? undefined : saveProfileId

      if (isCreatingProfile && newProfileName.trim()) {
        try {
          const newProfile = await createProfile(newProfileName.trim())
          finalProfileId = newProfile.id
        } catch (createErr) {
          console.error('Failed to auto-create profile:', createErr)
          setSaveError('Failed to create profile. Please try again.')
          setSaving(false)
          return
        }
      }

      await createSavedAddon(
        saveName.trim(),
        addon.transportUrl,
        tags,
        finalProfileId,
        addon.manifest,
        addon.metadata
      )

      closeSaveModal()
      toast({
        title: 'Addon Saved',
        description: `Saved "${saveName}" to ${finalProfileId ? 'profile' : 'unassigned'}.`
      })
    } catch (error) {
      console.error('Failed to save addon to library:', error)
      setSaveError('Failed to save addon to library. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(addon.transportUrl)
    toast({
      title: 'URL Copied',
      description: 'Addon URL copied to clipboard',
    })
  }

  const handleOpenInStremio = () => {
    window.location.href = getStremioLink(addon.transportUrl)
  }

  const handleUpdate = () => {
    // Skip confirmation for updates — no harm in updating
    // Only show confirmation for manual reinstalls (same version)
    if (hasUpdate) {
      handleConfirmUpdate()
    } else {
      setShowReinstallConfirm(true)
    }
  }

  const handleConfirmUpdate = async () => {
    if (!onUpdate) return
    setUpdating(true)
    setShowReinstallConfirm(false)
    try {
      await onUpdate(accountId, addon.transportUrl)
      toast({
        title: 'Addon Updated',
        description: `Successfully updated ${addon.manifest.name}`,
      })
    } catch (error) {
      toast({
        title: 'Update Failed',
        description: error instanceof Error ? error.message : 'Failed to update addon',
        variant: 'destructive',
      })
    } finally {
      setUpdating(false)
    }
  }

  const handleReplaceUrl = async (targetNewUrl: string) => {
    try {
      const savedAddon = Object.values(library).find(
        (s) => s.manifest.id === addon.manifest.id && s.installUrl === addon.transportUrl
      )

      await useAddonStore.getState().replaceTransportUrlUniversally(
        savedAddon ? savedAddon.id : null,
        addon.transportUrl,
        targetNewUrl,
        accountId
      )

      await useAccountStore.getState().syncAccount(accountId)

      toast({
        title: 'URL Replaced',
        description: 'Addon transport URL updated successfully.'
      })
    } catch (err) {
      console.error('Failed to replace URL', err)
      const message = err instanceof Error ? err.message : 'Failed to replace URL'
      toast({
        variant: 'destructive',
        title: 'Replacement Failed',
        description: message
      })
      throw new Error(message)
    }
  }

  const candidateUrls = useMemo(() => buildCandidateUrls(addon), [addon])

  const handleConfigure = async () => {
    if (isCinemeta) {
      setShowConfigDialog(true)
      return
    }

    if (candidateUrls.length === 0) {
      toast({
        title: 'No configuration URL',
        description: 'This addon does not appear to have a configuration page.',
        variant: 'destructive',
      })
      return
    }

    setConfiguring(true)
    const openUrl = (url: string) => {
      window.open(url, '_blank')
      return true
    }

    const bestCandidate = candidateUrls.find(u => u.endsWith('/configure')) || candidateUrls[0]
    if (bestCandidate) {
      openUrl(bestCandidate)
    } else {
      const url = addon.transportUrl.replace('/manifest.json', '')
      openUrl(url.endsWith('/') ? `${url}configure` : `${url}/configure`)
    }
    setConfiguring(false)
  }

  const handleToggleProtection = () => {
    if (addon.flags?.protected && isCinemeta) {
      setShowUnprotectConfirmation(true)
      return
    }
    useAccountStore.getState().toggleAddonProtection(accountId, addon.transportUrl, !addon.flags?.protected, index)
  }

  const confirmUnprotectCinemeta = () => {
    useAccountStore.getState().toggleAddonProtection(accountId, addon.transportUrl, false, index)
    setShowUnprotectConfirmation(false)
  }

  const hasCatalogs = addon.manifest.catalogs && addon.manifest.catalogs.length > 0

  const handleSaveCatalogs = async (updatedAddon: AddonDescriptor) => {
    await useAccountStore.getState().updateAddonSettings(
      accountId,
      addon.transportUrl,
      { catalogOverrides: updatedAddon.catalogOverrides },
      index
    )
  }

  return (
    <>
      <Card
        className={`flex flex-col h-full transition-all duration-300 relative ${addon.flags?.enabled === false || isPendingRemoval ? 'opacity-60 grayscale-[0.8] border-dashed' : ''
          } ${isSelectionMode && isSelected
            ? 'ring-2 ring-primary border-primary bg-primary/5'
            : isSelectionMode
              ? 'cursor-pointer hover:border-primary/50'
              : ''
          }`}
        onClick={(e) => {
          if (isSelectionMode && onToggleSelect) {
            e.preventDefault()
            onToggleSelect(selectionId || addon.transportUrl)
          }
        }}
      >
        {isSelected && (
          <div className="absolute -top-2 -right-2 z-30 w-6 h-6 rounded-full border-2 border-background shadow-lg flex items-center justify-center transition-all animate-in zoom-in-50 duration-200" style={{ background: 'hsl(var(--primary))' }}>
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
          <div className="flex items-center gap-3 min-w-0">
            {(addon.metadata?.customLogo || addon.manifest.logo) && (
              <div className="bg-muted p-1 rounded-md shrink-0">
                <img
                  src={addon.metadata?.customLogo || addon.manifest.logo}
                  alt={addon.metadata?.customName || addon.manifest.name}
                  className="w-10 h-10 rounded object-contain"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              </div>
            )}
            <div className="flex flex-col min-w-0">
              <CardTitle className="text-base font-semibold truncate leading-tight">
                {addon.metadata?.customName ||
                  (addon.manifest.name && addon.manifest.name !== 'Unknown Addon' ? addon.manifest.name : getHostnameIdentifier(addon.transportUrl))}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-1.5 mt-1 overflow-hidden">
                <span className="text-xs truncate">v{addon.manifest.version}</span>
                {isOnline !== undefined && (
                  <span
                    className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}
                    title={isOnline ? 'Online' : (healthError ? `Offline (${healthError})` : 'Offline')}
                  />
                )}
                {isCinemeta && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-500 border border-blue-500/20">
                    Official
                  </span>
                )}
                {isPatched && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                    Patched
                  </span>
                )}
                {hasUpdate && latestVersion && (
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                    → {latestVersion}
                  </span>
                )}
                {addon.flags?.protected && (
                  <span className="inline-flex items-center px-1 py-0.5 rounded text-[10px] bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                    Protected
                  </span>
                )}
                {isPendingRemoval && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-500 border border-red-500/20 animate-pulse">
                    Deleting...
                  </span>
                )}
              </CardDescription>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <div className="flex items-center gap-2 mr-2">
              <Switch
                checked={addon.flags?.enabled !== false}
                onCheckedChange={async (checked) => {
                  useAccountStore.getState().toggleAddonEnabled(accountId, addon.transportUrl, checked, false, index)

                  const { useFailoverStore } = await import('@/store/failoverStore')
                  const failoverStore = useFailoverStore.getState()
                  const rule = failoverStore.rules.find((r: any) => r.accountId === accountId && r.isActive && r.priorityChain.some((url: string) => url === addon.transportUrl))

                  if (rule) {
                    await failoverStore.updateRule(rule.id, { isActive: false, isAutomatic: false })
                    toast({
                      title: "Autopilot Disabled",
                      description: "Manual override detected. Autopilot has been set to standby for this chain.",
                      variant: "default"
                    })
                  }
                }}
                className="data-[state=checked]:bg-green-500"
                aria-label="Toggle Addon"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={`h-8 w-8 shrink-0 ${addon.flags?.protected ? 'text-green-600 hover:text-green-700' : 'text-muted-foreground opacity-30 hover:opacity-100'}`}
              onClick={handleToggleProtection}
              title={addon.flags?.protected ? "Unprotect Addon" : "Protect Addon"}
            >
              <AnimatedShieldIcon className="h-4 w-4" isAnimating={addon.flags?.protected} />
            </Button>

          </div>
        </CardHeader>

        <CardContent className="flex-grow py-2 min-w-0">
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3 h-10 w-full">
            {addon.metadata?.customDescription ||
              addon.manifest.description ||
              (!addon.manifest.description ? `Addon from ${getHostnameIdentifier(addon.transportUrl)}` : '')}
          </p>

          <div className="flex items-center gap-2 w-full min-w-0">
            <div className="flex-1 bg-muted/40 rounded px-2 py-1 flex items-center justify-between border min-w-0 w-full overflow-hidden">
              <span className="text-xs text-muted-foreground font-mono truncate mr-2 flex-grow min-w-0">
                {isPrivacyModeEnabled ? maskUrl(addon.transportUrl) : addon.transportUrl}
              </span>
              <button
                onClick={handleCopyUrl}
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title="Copy URL"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleOpenInStremio} title="Open in Stremio">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-2 pt-2 border-t bg-muted/5 mt-auto">
          {/* Update Available — full width when present */}
          {canUpdate && hasUpdate && (
            <Button
              variant="default"
              size="sm"
              onClick={handleUpdate}
              disabled={loading || updating || removing}
              className="w-full font-bold bg-amber-500 hover:bg-amber-400 text-black border-none shadow-sm"
            >
              <AnimatedUpdateIcon className="h-4 w-4 mr-2" isAnimating={updating} />
              {updating ? 'Updating...' : 'Update Available'}
            </Button>
          )}

          {/* 2×2 action grid */}
          <div className="grid grid-cols-2 gap-1.5 w-full">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleConfigure}
              disabled={configuring || removing}
              className="font-semibold text-xs"
              title="Open addon configuration page"
            >
              <AnimatedSettingsIcon className="h-3.5 w-3.5 mr-1.5" isAnimating={configuring} />
              Configure
            </Button>

            {hasCatalogs ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowCatalogEditor(true)}
                disabled={removing}
                className="font-semibold text-xs"
                title={`Edit Catalogs (${(addon.manifest.catalogs || []).filter(c => !(addon.catalogOverrides?.removed || []).includes(c.id)).length})`}
              >
                <List className="h-3.5 w-3.5 mr-1.5" />
                Catalogs
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled
                className="font-semibold text-xs opacity-50"
              >
                <List className="h-3.5 w-3.5 mr-1.5" />
                Catalogs
              </Button>
            )}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowMetadataDialog(true)}
              disabled={removing}
              className="font-semibold text-xs"
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Customize
            </Button>

            {canSaveToLibrary ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={openSaveModal}
                disabled={saving || removing}
                className="font-semibold text-xs text-primary hover:text-primary hover:bg-primary/10"
              >
                <AnimatedHeartIcon className="h-3.5 w-3.5 mr-1.5" isAnimating={saving} />
                Save to Library
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleUpdate}
                disabled={loading || updating || removing}
                className="font-semibold text-xs"
                title="Reinstalls this addon — also useful after making config changes to refresh settings without losing anything"
              >
                <AnimatedRefreshIcon className="h-3.5 w-3.5 mr-1.5" isAnimating={updating} />
                Reinstall
              </Button>
            )}
          </div>

          {!addon.flags?.protected && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleRemove}
              disabled={removing}
              className="w-full mt-1 font-bold h-9 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white border border-red-500/20 transition-all duration-200"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Remove Addon
            </Button>
          )}
        </CardFooter>
      </Card>

      <Dialog open={showSaveModal} onOpenChange={(open) => !open && closeSaveModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to Library</DialogTitle>
            <DialogDescription>
              Save this addon to your library.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-4">
            <div className="space-y-2">
              <Label htmlFor="addon-name">Name</Label>
              <Input
                id="addon-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Enter addon name"
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="addon-profile" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  {isCreatingProfile ? 'New Profile Name' : 'Profile'}
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-primary hover:text-primary/80"
                  onClick={() => setIsCreatingProfile(!isCreatingProfile)}
                >
                  {isCreatingProfile ? 'Choose Existing' : '+ Create New'}
                </Button>
              </div>

              {isCreatingProfile ? (
                <div className="space-y-1.5 animate-in fade-in zoom-in-95 duration-200">
                  <Input
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="e.g. My Movies"
                    className="w-full"
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground px-1">
                    Created automatically on save.
                  </p>
                </div>
              ) : (
                <Select value={saveProfileId} onValueChange={setSaveProfileId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a profile" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {profiles.map(profile => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="addon-tags">Tags (optional)</Label>
              <Input
                id="addon-tags"
                value={saveTags}
                onChange={(e) => setSaveTags(e.target.value)}
                placeholder="movies, series, anime..."
              />
            </div>
            {saveError && <p className="text-sm font-medium text-destructive animate-in fade-in slide-in-from-top-1">{saveError}</p>}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeSaveModal} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSaveToLibrary} disabled={saving}>
              {saving ? 'Saving...' : 'Save Addon'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={showRemoveDialog}
        onOpenChange={setShowRemoveDialog}
        title="Remove Addon?"
        description={`Remove "${addon.manifest.name}"?`}
        confirmText={removing ? "Removing..." : "Remove"}
        isDestructive={true}
        onConfirm={handleConfirmRemove}
        disabled={removing}
      />

      <ConfirmationDialog
        open={showUnprotectConfirmation}
        onOpenChange={setShowUnprotectConfirmation}
        title="Unprotect Cinemeta?"
        description={
          <>
            Cinemeta is the official addon for movie and series catalogs. Unprotecting it allows for <strong>removal</strong>, which may break your search and library experience.
            <br /><br />
            <strong>Unless you have a reliable backup such as AIOMetadata, we strongly recommend keeping this protected.</strong>
            <br /><br />
            Are you sure?
          </>
        }
        confirmText="Confirm Unprotect"
        isDestructive={true}
        onConfirm={confirmUnprotectCinemeta}
      />

      {isCinemeta && (
        <CinemetaConfigurationDialog
          open={showConfigDialog}
          onOpenChange={setShowConfigDialog}
          addon={addon}
          accountId={accountId}
          accountAuthKey={accountAuthKey}
        />
      )}

      <CatalogEditorDialog
        open={showCatalogEditor}
        onOpenChange={setShowCatalogEditor}
        addon={addon}
        onSave={handleSaveCatalogs}
      />

      <AddonMetadataDialog
        open={showMetadataDialog}
        onOpenChange={setShowMetadataDialog}
        addon={addon}
        accountId={accountId}
        onSave={handleSaveMetadata}
        onReplaceUrl={handleReplaceUrl}
      />
      <ConfirmationDialog
        open={showReinstallConfirm}
        onOpenChange={setShowReinstallConfirm}
        title={hasUpdate ? "Update Addon?" : "Reinstall Addon?"}
        description={
          <div className="space-y-3">
            <p>
              {hasUpdate
                ? `Update "${addon.manifest.name}" to version ${latestVersion}?`
                : `Reinstall "${addon.manifest.name}"?`
              }
            </p>
            <div className="p-3 bg-primary/5 rounded-lg border border-primary/10 text-xs text-muted-foreground leading-relaxed">
              Reinstalling will refresh the addon manifest and ensure you have the latest version.
              Your custom settings, catalog overrides, and tags will be <strong>preserved</strong>.
            </div>
          </div>
        }
        confirmText={updating ? "Updating..." : (hasUpdate ? "Update Now" : "Reinstall")}
        onConfirm={handleConfirmUpdate}
        isLoading={updating}
        disabled={updating}
      />
    </>
  )
}
