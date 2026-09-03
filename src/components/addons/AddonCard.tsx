import { Button } from '@/components/ui/button'
import type { SavedAddonManifestChangeSummary } from '@/types/saved-addon'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AddonIcon } from '@/components/ui/addon-icon'
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
import { isAIOStreamsAddon, parseAIOStreamsUrl } from '@/lib/aiostreams-utils'
import { isAIOMetadataAddon, parseAIOMetadataUrl } from '@/lib/aiometadata-utils'
import { useNavigate } from 'react-router-dom'
import { CinemetaManifest } from '@/types/cinemeta'
import { cn, isNewerVersion } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { getHostnameIdentifier } from '@/lib/addon-identifier'
import { useProfileStore } from '@/store/profileStore'
import { useUIStore } from '@/store/uiStore'
import { AddonDescriptor } from '@/types/addon'
import { Copy, List, Pencil, Trash2, MoreVertical, Download, Shield, EyeOff, Loader2, Star, ArrowRightLeft, BadgeCheck, Bandage, ArrowUpCircle } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import React, { useMemo, useState, useEffect, useCallback } from 'react'
import { AddonMetadataDialog } from './AddonMetadataDialog'
import { CinemetaConfigurationDialog } from './CinemetaConfigurationDialog'

import { CatalogEditorDialog } from './CatalogEditorDialog'
import { SourceUrlBox } from './SourceUrlBox'
import { AccountPickerDialog } from '../accounts/AccountPickerDialog'
import { Switch } from '@/components/ui/switch'
import { usePendingRemoval } from '@/hooks/useSyncManager'
import { AnimatedUpdateIcon, AnimatedRefreshIcon, AnimatedSettingsIcon, AnimatedHeartIcon } from '../ui/AnimatedIcons'
import { AddonNoteEditor } from '@/components/ui/addon-note-popover'
import { useLongPress } from '@/hooks/useLongPress'
import { Tooltip } from '@/components/ui/tooltip'
import { useTheme } from '@/contexts/ThemeContext'
import { getEffectiveManifest } from '@/lib/addon-utils'

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
  manifestChange?: SavedAddonManifestChangeSummary | null
  isOnline?: boolean
  healthError?: string
  loading?: boolean
  loader?: boolean
  isSelectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (addonId: string) => void
  onLongPress?: (addonId: string) => void
  selectionId?: string
  index?: number // Optional for index-based targeting (handling duplicates)
  failoverPrimaryName?: string
  failoverPaused?: boolean
  isPrimary?: boolean
  isPrimaryPaused?: boolean
  isInstalled?: boolean
  compact?: boolean
}

export const AddonCard = React.memo(function AddonCard({
  addon,
  accountId,
  accountAuthKey,
  onRemove,
  onUpdate,
  latestVersion,
  manifestChange,
  isOnline,
  healthError,
  loading,
  isSelectionMode,
  isSelected,
  onToggleSelect,
  onLongPress,
  selectionId,
  index,
  failoverPrimaryName,
  failoverPaused,
  isPrimary,
  isPrimaryPaused,
  isInstalled = false,
  compact = false,
}: AddonCardProps) {
  const navigate = useNavigate()
  const createSavedAddon = useAddonStore((state) => state.createSavedAddon)
  const profiles = useProfileStore((state) => state.profiles)
  const initProfiles = useProfileStore((state) => state.initialize)
  const createProfile = useProfileStore((state) => state.createProfile)
  const currentAccount = useAccountStore(state => state.accounts.find(a => a.id === accountId))
  const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
  const { toast } = useToast()
  const { isLight } = useTheme()

  const [saving, setSaving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [showRemoveDialog, setShowRemoveDialog] = useState(false)
  const [showCatalogEditor, setShowCatalogEditor] = useState(false)
  const [showMetadataDialog, setShowMetadataDialog] = useState(false)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [pickerMode, setPickerMode] = useState<'clone' | 'move'>('clone')
  const [isActionLoading, setIsActionLoading] = useState(false)

  const [saveName, setSaveName] = useState('')
  const [saveTags, setSaveTags] = useState('')
  const [saveProfileId, setSaveProfileId] = useState<string>('unassigned')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [showUnprotectConfirmation, setShowUnprotectConfirmation] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  const isPendingRemoval = usePendingRemoval(accountId, addon.transportUrl)

  useEffect(() => {
    initProfiles()
  }, [initProfiles])

  const handleSaveMetadata = async (metadata: { customName?: string; customLogo?: string; customDescription?: string }) => {
    const account = useAccountStore.getState().accounts.find(a => a.id === accountId)
    const enabledConnections = account?.connections?.filter(c => c.enabled !== false) || []
    const platformLabel = enabledConnections.length === 0
      ? 'saved locally'
      : enabledConnections.length === 1
        ? `synced to ${enabledConnections[0].platform}`
        : 'synced to your connected platforms'

    try {
      await useAccountStore.getState().updateAddonSettings(accountId, addon.transportUrl, { metadata }, index)
      toast({
        title: 'Appearance Updated',
        description: `Addon metadata has been customized and ${platformLabel}.`
      })
    } catch (err) {
      if (import.meta.env.DEV) console.error('Metadata sync failed', err)
      toast({
        variant: 'destructive',
        title: 'Sync Failed',
        description: `Failed to push customization to your platform${enabledConnections.length !== 1 ? 's' : ''}.`
      })
    }
  }

  const handleRemove = useCallback(() => {
    setShowRemoveDialog(true)
  }, [])

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
      if (import.meta.env.DEV) console.error('Failed to remove addon:', error)
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

  const handleBulkAction = async (targetAccountIds: string[]) => {
    if (targetAccountIds.length === 0) return

    setIsActionLoading(true)
    let successCount = 0
    let failCount = 0

    const accountStore = useAccountStore.getState()

    for (const targetId of targetAccountIds) {
      try {
        await accountStore.installAddonToAccount(targetId, addon.transportUrl, addon.metadata)
        successCount++
      } catch (err) {
        if (import.meta.env.DEV) console.error(`Failed to deploy to ${targetId}:`, err)
        failCount++
      }
    }

    if (pickerMode === 'move') {
      try {
        await onRemove(accountId, addon.transportUrl)
      } catch (err) {
        if (import.meta.env.DEV) console.error('Failed to remove from origin account:', err)
      }
    }

    toast({
      title: pickerMode === 'move' ? 'Move Complete' : 'Clone Complete',
      description: `Successfully processed ${successCount} account${successCount !== 1 ? 's' : ''}. ${failCount > 0 ? `Failed: ${failCount}` : ''}`,
    })
    setIsActionLoading(false)
    setShowAccountPicker(false)
  }

  const handleDeployToAll = async () => {
    const targetAccountIds = useAccountStore.getState().accounts
      .filter(acc => acc.id !== accountId)
      .map(acc => acc.id)

    if (targetAccountIds.length === 0) {
      toast({
        title: 'No other accounts',
        description: 'You need at least one other account to deploy to.'
      })
      return
    }

    setIsActionLoading(true)
    try {
      await handleBulkAction(targetAccountIds)
    } finally {
      setIsActionLoading(false)
    }
  }

  const isCinemeta = useMemo(() => isCinemetaAddon(addon), [addon])
  const isAIOStreams = useMemo(() => isAIOStreamsAddon(addon), [addon])
  const isAIOMetadata = useMemo(() => isAIOMetadataAddon(addon), [addon])
  const managedCatalogs = isAIOMetadata

  const isPatched = useMemo(() => {
    if (!isCinemeta) return false
    const status = detectAllPatches(addon.manifest as CinemetaManifest)
    return Object.values(status).some(val => val === true)
  }, [isCinemeta, addon.manifest])

  const cinemetaNeedsStremio = isCinemeta && !accountAuthKey
  const configureDisabled = configuring || removing || cinemetaNeedsStremio
  const configureTooltip = cinemetaNeedsStremio
    ? 'Configuring Cinemeta updates your Stremio addon collection, which requires a Stremio account. This account has no Stremio login.'
    : 'Open addon configuration page'

  const isExternal = useMemo(() => {
    return !addon.flags?.protected && !addon.flags?.official
  }, [addon.flags?.protected, addon.flags?.official])

  const canSaveToLibrary = useMemo(() => {
    return isExternal && !isInstalled
  }, [isExternal, isInstalled])

  const library = useAddonStore(s => s.library)
  const savedInLibrary = useMemo(() => {
    const strip = (url: string) => url.split('?')[0].replace(/\/+$/, '')
    return Object.values(library).some(
      (s) => s.manifest.id === addon.manifest.id && strip(s.installUrl) === strip(addon.transportUrl)
    )
  }, [library, addon.manifest.id, addon.transportUrl])

  const hasVersionUpdate = latestVersion ? isNewerVersion(addon.manifest.version, latestVersion) : false
  const hasManifestShapeChange = !!manifestChange?.hasManifestShapeChange
  const hasUpdate = hasVersionUpdate || hasManifestShapeChange
  const canUpdate = !!onUpdate

  const openSaveModal = () => {
    setSaveName(addon.manifest.name || '')
    setSaveTags('')

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
      setSaveError('Enter a name for this addon.')
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
          if (import.meta.env.DEV) console.error('Failed to auto-create profile:', createErr)
          setSaveError('Failed to create profile. Try again.')
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
      if (import.meta.env.DEV) console.error('Failed to save addon to library:', error)
      setSaveError('Failed to save addon to library. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = useCallback(async () => {
    if (!onUpdate) return
    setUpdating(true)
    try {
      await onUpdate(accountId, addon.transportUrl)
      toast({
        title: hasUpdate ? 'Addon Updated' : 'Addon Reinstalled',
        description: `Successfully ${hasUpdate ? 'updated' : 'reinstalled'} ${addon.manifest.name}`,
      })
    } catch (error) {
      toast({
        title: hasUpdate ? 'Update Failed' : 'Reinstall Failed',
        description: error instanceof Error ? error.message : `Failed to ${hasUpdate ? 'update' : 'reinstall'} addon`,
        variant: 'destructive',
      })
    } finally {
      setUpdating(false)
    }
  }, [onUpdate, accountId, addon.transportUrl, addon.manifest.name, hasUpdate, toast])

  const handleReplaceUrl = async (targetNewUrl: string, descriptor?: AddonDescriptor) => {
    try {
      const lib = useAddonStore.getState().library
      const savedAddon = Object.values(lib).find(
        (s) => s.manifest.id === addon.manifest.id && s.installUrl === addon.transportUrl
      )

      return await useAddonStore.getState().replaceTransportUrlUniversally(
        savedAddon ? savedAddon.id : null,
        addon.transportUrl,
        targetNewUrl,
        accountId,
        descriptor
      )
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to replace URL', err)
      const message = err instanceof Error ? err.message : 'Failed to replace URL'
      throw new Error(message)
    }
  }

  const candidateUrls = useMemo(() => buildCandidateUrls(addon), [addon])

  const handleConfigure = useCallback(async () => {
    if (isCinemeta) {
      if (cinemetaNeedsStremio) {
        toast({
          title: 'Stremio session required',
          description: 'Configuring Cinemeta updates your Stremio addon collection, which requires a Stremio account. This account has no Stremio login.',
          variant: 'destructive',
        })
        return
      }
      setShowConfigDialog(true)
      return
    }
    if (isAIOStreams) {
      const parsed = parseAIOStreamsUrl(addon.transportUrl)
      if (parsed?.uuid) {
        navigate(`/account/${accountId}/aiostreams/${parsed.uuid}`)
      }
      return
    }
    if (isAIOMetadata) {
      const parsed = parseAIOMetadataUrl(addon.transportUrl)
      if (parsed?.uuid) {
        navigate(`/account/${accountId}/aiometadata/${parsed.uuid}`)
        return
      }
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
      window.open(url, '_blank', 'noopener,noreferrer')
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
  }, [isCinemeta, cinemetaNeedsStremio, isAIOStreams, isAIOMetadata, candidateUrls, addon.transportUrl, toast, navigate, accountId])

  const handleToggleProtection = useCallback(async () => {
    if (addon.flags?.protected && isCinemeta) {
      setShowUnprotectConfirmation(true)
      return
    }
    try {
      await useAccountStore.getState().toggleAddonProtection(accountId, addon.transportUrl, !addon.flags?.protected, index)
    } catch {
      toast({ variant: 'destructive', title: 'Protection Update Failed', description: 'Could not update addon protection. Please try again.' })
    }
  }, [addon.flags?.protected, isCinemeta, accountId, addon.transportUrl, index, toast])

  const confirmUnprotectCinemeta = useCallback(async () => {
    try {
      await useAccountStore.getState().toggleAddonProtection(accountId, addon.transportUrl, false, index)
    } catch {
      toast({ variant: 'destructive', title: 'Protection Update Failed', description: 'Could not unprotect addon. Please try again.' })
    }
    setShowUnprotectConfirmation(false)
  }, [accountId, addon.transportUrl, index, toast])

  const handleToggleHideConfigure = useCallback(async () => {
    try {
      await useAccountStore.getState().updateAddonSettings(accountId, addon.transportUrl, {
        metadata: { hideConfigure: addon.metadata?.hideConfigure ? undefined : true },
      }, index)
    } catch (error) {
      toast({ variant: 'destructive', title: 'Failed to update Configure button visibility', description: error instanceof Error ? error.message : undefined })
    }
  }, [accountId, addon.transportUrl, addon.metadata?.hideConfigure, index, toast])

  const effectiveCatalogCount = useMemo(() => getEffectiveManifest(addon).catalogs?.length || 0, [addon])
  const hasCatalogs = effectiveCatalogCount > 0

  const handleSaveCatalogs = async (updatedAddon: AddonDescriptor) => {
    await useAccountStore.getState().updateAddonSettings(
      accountId,
      addon.transportUrl,
      { catalogOverrides: updatedAddon.catalogOverrides },
      index
    )
  }

  const { isLongPressTriggered, ...longPressProps } = useLongPress(() => {
    if (!isSelectionMode && onLongPress) {
      onLongPress(selectionId || addon.transportUrl)
    }
  })

  const handleCardActivate = () => {
    if (isLongPressTriggered) return
    if (isSelectionMode && onToggleSelect) {
      onToggleSelect(selectionId || addon.transportUrl)
    }
  }

  const addonDisplayName = addon.metadata?.customName ||
    (addon.manifest.name && addon.manifest.name !== 'Unknown Addon' ? addon.manifest.name : getHostnameIdentifier(addon.transportUrl))

  return (
    <>
      {compact ? (
        <div
          {...longPressProps}
          role={isSelectionMode ? "button" : undefined}
          tabIndex={isSelectionMode ? 0 : undefined}
          className={cn(
            'group relative rounded-[1.35rem] border border-border/45 bg-card/80 p-3 shadow-sm transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            addon.flags?.enabled === false || isPendingRemoval ? 'opacity-60 grayscale-[0.8]' : '',
            isSelectionMode && isSelected
              ? 'border-primary/35 bg-primary/10 ring-2 ring-primary/20'
              : isSelectionMode
                ? 'cursor-pointer hover:border-primary/45'
                : '',
            isMenuOpen && 'z-40'
          )}
          onClick={isSelectionMode ? (e) => { e.preventDefault(); if (onToggleSelect) onToggleSelect(selectionId || addon.transportUrl) } : undefined}
          onKeyDown={isSelectionMode ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardActivate() } } : undefined}
        >
          {isSelected && (
            <div className="absolute -right-2 -top-2 z-30 flex h-5 w-5 items-center justify-center rounded-full border-2 border-background shadow-lg" style={{ background: 'hsl(var(--primary))' }}>
              <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
            </div>
          )}

          <div className={cn('space-y-3', isSelectionMode && 'pointer-events-none')}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="relative h-10 w-10 shrink-0">
                  <AddonIcon
                    name={addonDisplayName}
                    logo={addon.metadata?.customLogo || addon.manifest.logo}
                    alt={addonDisplayName}
                    className="h-full w-full"
                    textClassName="text-xs"
                  />
                  {isOnline !== undefined && (
                    <Tooltip content={isOnline ? 'Online' : (healthError ? `Offline: ${healthError}` : 'Offline')} side="top">
                      <span className={`absolute -bottom-0.5 -right-0.5 z-20 h-2.5 w-2.5 rounded-full ring-2 ring-card ${isOnline ? 'bg-success' : 'bg-destructive'}`} />
                    </Tooltip>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold leading-tight">{addonDisplayName}</span>
                    <span className="text-xs text-muted-foreground/60">v{addon.manifest.version}</span>
                    {isCinemeta && (
                      <Tooltip content="Official Addon">
                        <span aria-label="Official Addon" className="inline-flex items-center justify-center rounded-full border p-1 border-primary/20 bg-primary/10 text-primary">
                          <BadgeCheck className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                    {isPatched && (
                      <Tooltip content="Cinemeta patches applied">
                        <span aria-label="Cinemeta patches applied" className="inline-flex items-center justify-center rounded-full border p-1 border-warning/20 bg-warning/10 text-warning">
                          <Bandage className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                    {hasUpdate && latestVersion && (
                      <Tooltip content={`Update available: ${latestVersion}`}>
                        <span aria-label={`Update available: ${latestVersion}`} className="inline-flex items-center justify-center rounded-full border p-1 border-primary/20 bg-primary/10 text-primary">
                          <ArrowUpCircle className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                    {addon.flags?.protected && (
                      <Tooltip content="Protected">
                        <span aria-label="Protected" className="inline-flex items-center justify-center rounded-full border p-1 border-success/20 bg-success/10 text-success">
                          <Shield className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                    {(addon.metadata?.hideConfigure || (isCinemeta && addon.manifest?.behaviorHints?.configurable !== true)) && (
                      <Tooltip content="Configure button hidden in Stremio">
                        <span aria-label="Configure button hidden in Stremio" className="inline-flex items-center justify-center rounded-full border p-1 border-muted-foreground/20 bg-muted/30 text-muted-foreground">
                          <EyeOff className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                    {isPendingRemoval && (
                      <Tooltip content="Deleting...">
                        <span aria-label="Deleting..." className="inline-flex items-center justify-center rounded-full border p-1 border-destructive/20 bg-destructive/10 text-destructive">
                          <Loader2 className="h-3 w-3 animate-spin" />
                        </span>
                      </Tooltip>
                    )}
                    {isPrimary && (
                      <Tooltip content={isPrimaryPaused ? 'Primary failover (paused)' : 'Primary failover'}>
                        <span aria-label={isPrimaryPaused ? 'Primary failover (paused)' : 'Primary failover'} className={`inline-flex items-center justify-center rounded-full border p-1 ${isPrimaryPaused ? 'border-border/40 bg-muted/40 text-muted-foreground/60' : 'border-primary/25 bg-primary/12 text-primary/80'}`}>
                          <Star className={`h-3 w-3 ${isPrimaryPaused ? '' : 'fill-current'}`} />
                        </span>
                      </Tooltip>
                    )}
                    {failoverPrimaryName && (
                      <Tooltip content={failoverPaused ? `Autopilot backup for ${failoverPrimaryName} (paused)` : `Autopilot backup for ${failoverPrimaryName}`}>
                        <span aria-label={failoverPaused ? `Autopilot backup for ${failoverPrimaryName} (paused)` : `Autopilot backup for ${failoverPrimaryName}`} className={`inline-flex items-center justify-center rounded-full border p-1 ${failoverPaused ? 'border-border/40 bg-muted/40 text-muted-foreground/60' : 'border-primary/25 bg-primary/12 text-primary/80'}`}>
                          <ArrowRightLeft className="h-3 w-3" />
                        </span>
                      </Tooltip>
                    )}
                  </div>

                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {addon.metadata?.customDescription || addon.manifest.description || `Addon from ${getHostnameIdentifier(addon.transportUrl)}`}
                  </p>

                  <SourceUrlBox
                    addon={addon}
                    accountId={accountId}
                    privacyMode={isPrivacyModeEnabled}
                    variant="compact"
                    disabled={removing || loading}
                    onReplace={(descriptor, requestedUrl) => handleReplaceUrl(descriptor.transportUrl || requestedUrl, descriptor)}
                    successDescription="Addon URL updated successfully."
                  />
                </div>
              </div>

              {!isSelectionMode && (
                <div className="flex shrink-0 items-center justify-end gap-2">
                  {canUpdate && hasUpdate && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleUpdate}
                      disabled={loading || updating || removing}
                      className="h-8 gap-1.5 border-primary/25 bg-primary/12 px-3 text-xs font-semibold text-primary shadow-none hover:bg-primary/20 hover:text-primary"
                    >
                      <AnimatedUpdateIcon className="h-3.5 w-3.5" isAnimating={updating} />
                      {updating ? 'Updating...' : 'Update'}
                    </Button>
                  )}

                  <Switch
                    checked={addon.flags?.enabled !== false}
                    onCheckedChange={async (checked) => {
                      useAccountStore.getState().toggleAddonEnabled(accountId, addon.transportUrl, checked, false, index)

                      const { useFailoverStore } = await import('@/store/failoverStore')
                      const failoverStore = useFailoverStore.getState()
                      const rule = failoverStore.rules.find((r) => r.accountId === accountId && r.isActive && r.priorityChain.some((url: string) => url === addon.transportUrl))

                      if (rule) {
                        await failoverStore.updateRule(rule.id, { isActive: false, isAutomatic: false })
                        toast({
                          title: "Autopilot Disabled",
                          description: "Manual override detected. Autopilot has been set to standby for this chain.",
                          variant: "default"
                        })
                      }
                    }}
                    className="shrink-0 data-[state=checked]:bg-success"
                    aria-label="Toggle Addon"
                  />

                  <DropdownMenu onOpenChange={setIsMenuOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 p-0" onClick={(e) => e.stopPropagation()}>
                        <span className="sr-only">Open menu</span>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
                      <div className="px-2 py-1.5 text-xs font-medium uppercase text-muted-foreground">Manage Addon</div>
                      {hasCatalogs && !managedCatalogs ? (
                        <DropdownMenuItem className="gap-2 sm:hidden" onClick={(e) => { e.stopPropagation(); setShowCatalogEditor(true); }} disabled={removing}>
                          <List className="h-4 w-4" />
                          Catalogs
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem className="gap-2 sm:hidden" disabled>
                          <List className="h-4 w-4" />
                          {managedCatalogs ? 'Catalogs managed in addon' : 'No catalogs available'}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem className="gap-2 sm:hidden" onClick={(e) => { e.stopPropagation(); setShowMetadataDialog(true); }} disabled={removing}>
                        <Pencil className="h-4 w-4" />
                        Customize
                      </DropdownMenuItem>
                      {canSaveToLibrary && (
                        <DropdownMenuItem className="gap-2 sm:hidden" onClick={(e) => { e.stopPropagation(); openSaveModal(); }} disabled={saving || removing}>
                          <AnimatedHeartIcon className="h-4 w-4" isAnimating={saving} />
                          Save to Library
                        </DropdownMenuItem>
                      )}
                      {savedInLibrary && (
                        <DropdownMenuItem className="gap-2 sm:hidden" onClick={(e) => { e.stopPropagation(); handleUpdate(); }} disabled={loading || updating || removing}>
                          <AnimatedRefreshIcon className="h-4 w-4" isAnimating={updating} />
                          Reinstall
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleToggleProtection(); }}>
                        <Shield className={`h-4 w-4 ${addon.flags?.protected ? 'text-primary fill-primary/20' : 'text-muted-foreground'}`} />
                        {addon.flags?.protected ? 'Unprotect Addon' : 'Protect Addon'}
                      </DropdownMenuItem>
                      {!isCinemeta && (
                      <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleToggleHideConfigure(); }}>
                        <EyeOff className={`h-4 w-4 ${addon.metadata?.hideConfigure ? 'text-primary' : 'text-muted-foreground'}`} />
                        {addon.metadata?.hideConfigure ? 'Show Configure Button' : 'Hide Configure Button'}
                      </DropdownMenuItem>
                      )}
                      <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); setPickerMode('clone'); setShowAccountPicker(true); }} disabled={isActionLoading}>
                        <Copy className="h-4 w-4" />
                        Clone
                      </DropdownMenuItem>
                      <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleDeployToAll(); }} disabled={isActionLoading}>
                        <Download className="h-4 w-4" />
                        Deploy to All
                      </DropdownMenuItem>
                      {!addon.flags?.protected && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleRemove(); }} className="gap-2 text-destructive focus:text-destructive">
                            <Trash2 className="h-4 w-4" />
                            Remove
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>

            {!isSelectionMode && (
              <>
              <div className="grid grid-cols-2 gap-1.5 sm:hidden">
                <Tooltip content={configureTooltip}>
                  <Button size="sm" onClick={handleConfigure} disabled={configureDisabled} className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 shadow-none hover:bg-muted/70">
                    <AnimatedSettingsIcon className="h-3.5 w-3.5" isAnimating={configuring} />
                    Configure
                  </Button>
                </Tooltip>

                <AddonNoteEditor
                  accountId={accountId}
                  addonTransportUrl={addon.transportUrl}
                  addonName={addon.metadata?.customName || addon.manifest.name || 'Addon'}
                  addonLogo={addon.metadata?.customLogo || addon.manifest.logo}
                  note={addon.note}
                  index={index}
                  asButton
                  className="h-8 w-full rounded-lg"
                />
              </div>

              <div className="hidden grid-cols-3 gap-1.5 sm:grid xl:grid-cols-6">
                <Tooltip content={configureTooltip}>
                  <Button size="sm" onClick={handleConfigure} disabled={configureDisabled} className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 shadow-none hover:bg-muted/70">
                    <AnimatedSettingsIcon className="h-3.5 w-3.5" isAnimating={configuring} />
                    Configure
                  </Button>
                </Tooltip>

                {hasCatalogs && !managedCatalogs ? (
                  <Tooltip content={`Edit Catalogs (${effectiveCatalogCount})`}>
                    <Button size="sm" onClick={() => setShowCatalogEditor(true)} disabled={removing} className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 shadow-none hover:bg-muted/70">
                      <List className="h-3.5 w-3.5" />
                      Catalogs
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip content={managedCatalogs ? 'Manage catalogs via addon UI' : 'No catalogs available'}>
                    <Button size="sm" disabled className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 opacity-50 shadow-none hover:bg-muted/70">
                      <List className="h-3.5 w-3.5" />
                      Catalogs
                    </Button>
                  </Tooltip>
                )}

                <Tooltip content="Edit name, logo & description" side="top">
                  <Button size="sm" onClick={() => setShowMetadataDialog(true)} disabled={removing} className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 shadow-none hover:bg-muted/70">
                    <Pencil className="h-3.5 w-3.5" />
                    Customize
                  </Button>
                </Tooltip>

                {canSaveToLibrary && (
                  <Button size="sm" onClick={openSaveModal} disabled={saving || removing} className="h-8 gap-1.5 border border-primary/25 bg-primary/12 text-xs font-semibold text-primary shadow-none hover:bg-primary/20">
                    <AnimatedHeartIcon className="h-3.5 w-3.5" isAnimating={saving} />
                    Save
                  </Button>
                )}
                {savedInLibrary && (
                  <Tooltip content="Reinstalls this addon - also useful after making config changes to refresh settings without losing anything">
                    <Button size="sm" onClick={handleUpdate} disabled={loading || updating || removing} className="h-8 gap-1.5 bg-muted/40 text-xs font-semibold text-foreground/70 shadow-none hover:bg-muted/70">
                      <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={updating} />
                      Reinstall
                    </Button>
                  </Tooltip>
                )}

                <AddonNoteEditor
                  accountId={accountId}
                  addonTransportUrl={addon.transportUrl}
                  addonName={addon.metadata?.customName || addon.manifest.name || 'Addon'}
                  addonLogo={addon.metadata?.customLogo || addon.manifest.logo}
                  note={addon.note}
                  index={index}
                  asButton
                  className="h-8 rounded-lg"
                />

                {!addon.flags?.protected && (
                  <Button variant="destructive" size="sm" onClick={handleRemove} disabled={removing} className="h-8 gap-1.5 border border-destructive/20 bg-destructive/10 text-xs font-bold text-destructive transition-[transform,opacity,box-shadow] duration-200 hover:bg-destructive hover:text-white">
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                )}
              </div>
              </>
            )}
          </div>
        </div>
      ) : (
      <Card
        {...longPressProps}
        role={isSelectionMode ? "button" : undefined}
        tabIndex={isSelectionMode ? 0 : undefined}
        className={`flex flex-col h-full rounded-2xl border-border/40 transition-[transform,opacity,box-shadow] duration-300 relative focus:outline-none ${addon.flags?.enabled === false || isPendingRemoval ? 'opacity-60 grayscale-[0.8] border-dashed' : ''
          } ${isSelectionMode && isSelected
            ? `ring-2 ${isLight ? 'ring-primary/25' : 'ring-primary/12'} border-primary/25 bg-primary/12`
            : isSelectionMode
              ? 'cursor-pointer hover:border-primary/50'
              : ''
          } ${isMenuOpen ? 'z-40' : ''}`}
        onClick={(e) => {
          if (isLongPressTriggered) return
          if (isSelectionMode && onToggleSelect) {
            e.preventDefault()
            onToggleSelect(selectionId || addon.transportUrl)
          }
        }}
        onKeyDown={isSelectionMode ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardActivate() } } : undefined}
      >
        {isSelected && (
          <div className="absolute -top-2 -right-2 z-30 w-6 h-6 rounded-full border-2 border-background shadow-lg flex items-center justify-center transition-[transform,opacity,box-shadow] animate-in zoom-in-50 duration-200" style={{ background: 'hsl(var(--primary))' }}>
            <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
        <div className={isSelectionMode ? 'pointer-events-none' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <div className="flex items-center gap-3 min-w-0">
              <AddonIcon
                name={addonDisplayName}
                logo={addon.metadata?.customLogo || addon.manifest.logo}
                alt={addonDisplayName}
                className="h-11 w-11"
                textClassName="text-sm"
              />
              <div className="flex flex-col min-w-0">
                <CardTitle className="text-base font-semibold truncate leading-tight">
                  {addon.metadata?.customName ||
                    (addon.manifest.name && addon.manifest.name !== 'Unknown Addon' ? addon.manifest.name : getHostnameIdentifier(addon.transportUrl))}
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-1.5 mt-1 overflow-hidden">
                  <span className="text-xs truncate">v{addon.manifest.version}</span>
                  {isOnline !== undefined && (
                    <Tooltip content={isOnline ? 'Online' : (healthError ? `Offline: ${healthError}` : 'Offline')} side="top">
                      <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-success' : 'bg-destructive'}`} />
                    </Tooltip>
                  )}
                  {isCinemeta && (
                    <Tooltip content="Official Addon">
                      <span aria-label="Official Addon" className="inline-flex items-center justify-center rounded-full border p-1 border-primary/20 bg-primary/10 text-primary">
                        <BadgeCheck className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {isPatched && (
                    <Tooltip content="Cinemeta patches applied">
                      <span aria-label="Cinemeta patches applied" className="inline-flex items-center justify-center rounded-full border p-1 border-warning/20 bg-warning/10 text-warning">
                        <Bandage className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {hasUpdate && latestVersion && (
                    <Tooltip content={`Update available: ${latestVersion}`}>
                      <span aria-label={`Update available: ${latestVersion}`} className="inline-flex items-center justify-center rounded-full border p-1 border-primary/20 bg-primary/10 text-primary">
                        <ArrowUpCircle className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {addon.flags?.protected && (
                    <Tooltip content="Protected">
                      <span aria-label="Protected" className="inline-flex items-center justify-center rounded-full border p-1 border-success/20 bg-success/10 text-success">
                        <Shield className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {(addon.metadata?.hideConfigure || (isCinemeta && addon.manifest?.behaviorHints?.configurable !== true)) && (
                    <Tooltip content="Configure button hidden in Stremio">
                      <span aria-label="Configure button hidden in Stremio" className="inline-flex items-center justify-center rounded-full border p-1 border-muted-foreground/20 bg-muted/30 text-muted-foreground">
                        <EyeOff className="h-3 w-3" />
                      </span>
                    </Tooltip>
                  )}
                  {isPendingRemoval && (
                    <Tooltip content="Deleting...">
                      <span aria-label="Deleting..." className="inline-flex items-center justify-center rounded-full border p-1 border-destructive/20 bg-destructive/10 text-destructive">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  )}
                  {isPrimary && (
                    <Tooltip content={isPrimaryPaused ? 'Primary failover (paused)' : 'Primary failover'}>
                      <span aria-label={isPrimaryPaused ? 'Primary failover (paused)' : 'Primary failover'} className={`inline-flex items-center justify-center rounded-full border p-1 shrink-0 ${isPrimaryPaused ? 'border-border/40 bg-muted/40 text-muted-foreground/60' : 'border-primary/25 bg-primary/12 text-primary/80'}`}>
                        <Star className={`h-3 w-3 ${isPrimaryPaused ? '' : 'fill-current'}`} />
                      </span>
                    </Tooltip>
                  )}
                  {failoverPrimaryName && (
                    <Tooltip content={failoverPaused ? `Autopilot backup for ${failoverPrimaryName} (paused)` : `Autopilot backup for ${failoverPrimaryName}`}>
                      <span aria-label={failoverPaused ? `Autopilot backup for ${failoverPrimaryName} (paused)` : `Autopilot backup for ${failoverPrimaryName}`} className={`inline-flex items-center justify-center rounded-full border p-1 shrink-0 ${failoverPaused ? 'border-border/40 bg-muted/40 text-muted-foreground/60' : 'border-primary/25 bg-primary/12 text-primary/80'}`}>
                        <ArrowRightLeft className="h-3 w-3" />
                      </span>
                    </Tooltip>
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
                    const rule = failoverStore.rules.find((r) => r.accountId === accountId && r.isActive && r.priorityChain.some((url: string) => url === addon.transportUrl))

                    if (rule) {
                      await failoverStore.updateRule(rule.id, { isActive: false, isAutomatic: false })
                      toast({
                        title: "Autopilot Disabled",
                        description: "Manual override detected. Autopilot has been set to standby for this chain.",
                        variant: "default"
                      })
                    }
                  }}
                  className="data-[state=checked]:bg-success"
                  aria-label="Toggle Addon"
                />
              </div>

              {!isSelectionMode && (
                <DropdownMenu onOpenChange={setIsMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10 p-0" onClick={(e) => e.stopPropagation()}>
                      <span className="sr-only">Open menu</span>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-2rem)]">
                    <div className="px-2 py-1.5 text-xs font-medium uppercase text-muted-foreground">MANAGE ADDON</div>
                    <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleToggleProtection(); }}>
                      <Shield className={`h-4 w-4 ${addon.flags?.protected ? 'text-primary fill-primary/20' : 'text-muted-foreground'}`} />
                      {addon.flags?.protected ? 'Unprotect Addon' : 'Protect Addon'}
                    </DropdownMenuItem>
                    {!isCinemeta && (
                    <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleToggleHideConfigure(); }}>
                      <EyeOff className={`h-4 w-4 ${addon.metadata?.hideConfigure ? 'text-primary' : 'text-muted-foreground'}`} />
                      {addon.metadata?.hideConfigure ? 'Show Configure Button' : 'Hide Configure Button'}
                    </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); setPickerMode('clone'); setShowAccountPicker(true); }} disabled={isActionLoading}>
                      <Copy className="h-4 w-4" />
                      Clone
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onClick={(e) => { e.stopPropagation(); handleDeployToAll(); }} disabled={isActionLoading}>
                      <Download className="h-4 w-4" />
                      Deploy to All
                    </DropdownMenuItem>
                    {!addon.flags?.protected && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); handleRemove(); }}
                          className="gap-2 text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </CardHeader>

          <CardContent className="flex-grow py-2 min-w-0">
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3 h-10 w-full">
              {addon.metadata?.customDescription ||
                addon.manifest.description ||
                (!addon.manifest.description ? `Addon from ${getHostnameIdentifier(addon.transportUrl)}` : '')}
            </p>

            <SourceUrlBox
              addon={addon}
              accountId={accountId}
              privacyMode={isPrivacyModeEnabled}
              variant="full"
              disabled={removing || loading}
              onReplace={(descriptor, requestedUrl) => handleReplaceUrl(descriptor.transportUrl || requestedUrl, descriptor)}
              successDescription="Addon URL updated successfully."
            />
          </CardContent>

          <CardFooter className="flex flex-col gap-2 pt-2 mt-auto">
            {canUpdate && hasUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUpdate}
                disabled={loading || updating || removing}
                className="w-full gap-1.5 border-primary/25 bg-primary/12 text-xs font-semibold text-primary shadow-none hover:bg-primary/20 hover:text-primary"
              >
                <AnimatedUpdateIcon className="h-3.5 w-3.5" isAnimating={updating} />
                {updating ? 'Updating...' : 'Update'}
              </Button>
            )}

            <div className="grid grid-cols-2 gap-1.5 w-full">
              <Tooltip content={configureTooltip}>
                <Button
                  size="sm"
                  onClick={handleConfigure}
                  disabled={configureDisabled}
                  className="font-semibold text-xs gap-1.5 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                >
                  <AnimatedSettingsIcon className="h-3.5 w-3.5" isAnimating={configuring} />
                  Configure
                </Button>
              </Tooltip>

              {hasCatalogs && !managedCatalogs ? (
                <Tooltip content={`Edit Catalogs (${effectiveCatalogCount})`}>
                  <Button
                    size="sm"
                    onClick={() => setShowCatalogEditor(true)}
                    disabled={removing}
                    className="font-semibold text-xs gap-1.5 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                  >
                    <List className="h-3.5 w-3.5" />
                    Catalogs
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip content={managedCatalogs ? 'Manage catalogs via addon UI' : 'No catalogs available'}>
                  <Button
                    size="sm"
                    disabled
                    className="font-semibold text-xs opacity-50 gap-1.5 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                  >
                    <List className="h-3.5 w-3.5" />
                    Catalogs
                  </Button>
                </Tooltip>
              )}

              <Tooltip content="Edit name, logo & description" side="top">
                <Button
                  size="sm"
                  onClick={() => setShowMetadataDialog(true)}
                  disabled={removing}
                  className="font-semibold text-xs gap-1.5 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Customize
                </Button>
              </Tooltip>

              {canSaveToLibrary && (
                <Button
                  size="sm"
                  onClick={openSaveModal}
                  disabled={saving || removing}
                  className="font-semibold text-xs gap-1.5 bg-primary/12 text-primary border border-primary/25 hover:bg-primary/20 shadow-none"
                >
                  <AnimatedHeartIcon className="h-3.5 w-3.5" isAnimating={saving} />
                  Save to Library
                </Button>
              )}
              {savedInLibrary && (
                <Tooltip content="Reinstalls this addon - also useful after making config changes to refresh settings without losing anything">
                  <Button
                    size="sm"
                    onClick={handleUpdate}
                    disabled={loading || updating || removing}
                    className={cn('font-semibold text-xs gap-1.5 bg-muted/40 text-foreground/70 border border-border/40 hover:bg-muted/70 shadow-none', canSaveToLibrary && 'col-span-2')}
                  >
                    <AnimatedRefreshIcon className="h-3.5 w-3.5" isAnimating={updating} />
                    Reinstall
                  </Button>
                </Tooltip>
              )}
            </div>

            <div className="flex gap-1.5 w-full">
              <AddonNoteEditor
                accountId={accountId}
                addonTransportUrl={addon.transportUrl}
                addonName={addon.metadata?.customName || addon.manifest.name || 'Addon'}
                addonLogo={addon.metadata?.customLogo || addon.manifest.logo}
                note={addon.note}
                index={index}
                asButton
              />

              {!addon.flags?.protected && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleRemove}
                  disabled={removing}
                  className="font-bold gap-2 flex-1 bg-destructive/10 hover:bg-destructive text-destructive hover:text-white border border-destructive/20 transition-[transform,opacity,box-shadow] duration-200"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove Addon
                </Button>
              )}
            </div>
          </CardFooter>
        </div >
      </Card >
      )}

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
                  <p className="text-xs text-muted-foreground px-1">
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
          <DialogFooter>
            <Button variant="subtle" onClick={closeSaveModal} disabled={saving}>
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
        description={`Remove "${addon.metadata?.customName || addon.manifest.name || getHostnameIdentifier(addon.transportUrl)}"?`}
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
            <strong>We strongly recommend keeping this protected unless you have a reliable backup.</strong>
            <br /><br />
            Are you sure?
          </>
        }
        confirmText="Confirm Unprotect"
        isDestructive={true}
        onConfirm={confirmUnprotectCinemeta}
      />

      <AccountPickerDialog
        open={showAccountPicker}
        onOpenChange={setShowAccountPicker}
        title={pickerMode === 'move' ? "Move Addon" : "Clone Addon"}
        description={pickerMode === 'move' ? "Select accounts to move this addon to. It will be removed from the current account." : "Select accounts to clone this addon to."}
        onConfirm={handleBulkAction}
        confirmLabel={pickerMode === 'move' ? 'Move' : 'Clone'}
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



      {!managedCatalogs && (
        <CatalogEditorDialog
          open={showCatalogEditor}
          onOpenChange={setShowCatalogEditor}
          addon={addon}
          onSave={handleSaveCatalogs}
        />
      )}

      <AddonMetadataDialog
        open={showMetadataDialog}
        onOpenChange={setShowMetadataDialog}
        addon={addon}
        accountId={accountId}
        onSave={handleSaveMetadata}
        onReplaceUrl={handleReplaceUrl}
      />

    </>
  )
})
