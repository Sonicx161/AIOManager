import { Button } from '@/components/ui/button'
import { ImageUploadButton } from '@/components/ui/image-upload-button'
import { Tooltip } from '@/components/ui/tooltip'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Upload, RotateCcw } from 'lucide-react'
import { AddonDescriptor } from '@/types/addon'
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { isAddonConnection } from '@/types/connection'
import { getPlatformEntry } from '@/lib/platform-registry'
import { normalizeDestinations, nextPolicyRevision } from '@/lib/addon-destinations'
import { maskEmailLevel, maskNameLevel, maskProfileLevel } from '@/lib/utils'
import { PlatformLogo } from '@/components/providers/ConnectionPrimitives'
import { SourceUrlBox } from './SourceUrlBox'
import { maskSecretUrl } from '@/lib/mask-secret-url'
import { ManifestJSONEditor } from './ManifestJSONEditor'
import { AddonCardPreview } from './AddonCardPreview'

interface AddonMetadataDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    addon: AddonDescriptor
    accountId: string
    onSave: (metadata: { customName?: string; customLogo?: string; customDescription?: string }, destinations?: AddonDescriptor['destinations'] | null) => Promise<void>
    onReplaceUrl?: (newUrl: string, descriptor?: AddonDescriptor) => Promise<{ failedAccounts?: string[] } | void>
}

export function AddonMetadataDialog({
    open,
    onOpenChange,
    addon,
    accountId,
    onSave,
    onReplaceUrl,
}: AddonMetadataDialogProps) {
    const [customName, setCustomName] = useState('')
    const [customLogo, setCustomLogo] = useState('')
    const [customDescription, setCustomDescription] = useState('')
    const [draftExcludedPlatforms, setDraftExcludedPlatforms] = useState<Set<string>>(new Set())
    const [draftExcludedConnections, setDraftExcludedConnections] = useState<Set<string>>(new Set())
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const isPrivacyModeEnabled = useUIStore((state) => state.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(state => state.privacyLevelNames)
    const privacyLevelEmail = useUIStore(state => state.privacyLevelEmail)
    const privacyLevelProfiles = useUIStore(state => state.privacyLevelProfiles)

    const account = useAccountStore((state) => state.accounts.find(a => a.id === accountId))
    // Addon destinations: every addon-capable connection of the owning account
    // (Stremio logins included - they are fan-out targets even though their pushes
    // bypass the connection reconcile batch).
    const destinationConnections = useMemo(
        () => (account?.connections || []).filter(isAddonConnection),
        [account],
    )
    const platforms = useMemo(() => {
        const seen: string[] = []
        for (const conn of destinationConnections) {
            if (!seen.includes(conn.platform)) seen.push(conn.platform)
        }
        return seen
    }, [destinationConnections])

    const savedExcludedPlatforms = useMemo(
        () => [...(addon.destinations?.excludedPlatforms || [])].sort().join(','),
        [addon],
    )
    const savedExcludedConnections = useMemo(
        () => [...(addon.destinations?.excludedConnections || [])].sort().join(','),
        [addon],
    )
    const destinationsDirty =
        [...draftExcludedPlatforms].sort().join(',') !== savedExcludedPlatforms ||
        [...draftExcludedConnections].sort().join(',') !== savedExcludedConnections

    const hasChanges =
        customName !== (addon.metadata?.customName || '') ||
        customLogo !== (addon.metadata?.customLogo || '') ||
        customDescription !== (addon.metadata?.customDescription || '') ||
        destinationsDirty


    useEffect(() => {
        if (open) {
            setCustomName(addon.metadata?.customName || '')
            setCustomLogo(addon.metadata?.customLogo || '')
            setCustomDescription(addon.metadata?.customDescription || '')
            // Drafts seed from the FULL saved policy, including ids whose login no
            // longer exists: the picker below renders live connections only, so those
            // ids are invisible yet ride through a Save verbatim as retained intent -
            // a deliberate exclusion must outlive the login's removal, so a restore
            // resurrecting the same id lands excluded. A metadata-only Save (no
            // destinations key) never touches the policy at all; only an explicit
            // toggle of a LIVE row adds or drops an id.
            setDraftExcludedPlatforms(new Set(addon.destinations?.excludedPlatforms || []))
            setDraftExcludedConnections(new Set(addon.destinations?.excludedConnections || []))
            setError(null)
        }
    }, [open, addon])

    const togglePlatform = (platform: string, kept: boolean) => {
        setDraftExcludedPlatforms(prev => {
            const next = new Set(prev)
            if (kept) next.delete(platform)
            else next.add(platform)
            return next
        })
        // The switch covers every login on the platform, so it replaces per-login entries.
        setDraftExcludedConnections(prev => {
            const next = new Set(prev)
            for (const conn of destinationConnections) {
                if (conn.platform === platform) next.delete(conn.id)
            }
            return next
        })
    }

    const platformState = (platform: string) => {
        const conns = destinationConnections.filter(c => c.platform === platform)
        const live = conns.filter(c => !draftExcludedConnections.has(c.id))
        if (draftExcludedPlatforms.has(platform) || live.length === 0) return 'removed'
        if (!live.some(c => c.enabled)) return 'paused'
        return live.length < conns.length ? 'partial' : 'sync'
    }
    const platformStates = platforms.map(platformState)
    const syncingPlatforms = platformStates.filter(st => st === 'sync' || st === 'partial').length
    const pausedPlatforms = platformStates.filter(st => st === 'paused').length
    const removedPlatforms = platformStates.filter(st => st === 'removed').length
    const STATE_LABEL = { removed: 'Will be removed on save', paused: 'Sync paused', partial: 'Some logins excluded', sync: 'Will sync' } as const

    const connectionIdentity = (conn: typeof destinationConnections[number]) => {
        const personalName = conn.displayName || conn.credentials?.email
        if (personalName) return personalName.includes('@')
            ? maskEmailLevel(personalName, isPrivacyModeEnabled ? privacyLevelEmail : 0)
            : maskNameLevel(personalName, isPrivacyModeEnabled ? privacyLevelNames : 0)
        return conn.credentials?.userId
            ? maskProfileLevel(conn.credentials.userId, isPrivacyModeEnabled ? privacyLevelProfiles : 0)
            : ''
    }

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
            const nextDestinations = destinationsDirty ? normalizeDestinations({
                excludedPlatforms: [...draftExcludedPlatforms],
                excludedConnections: [...draftExcludedConnections],
                // Every deliberate policy write bumps the LWW clock (never below the
                // current value + 1), so this edit - including a full CLEAR, which
                // survives as the { revision } tombstone - outranks any stale cloud
                // copy of the policy.
                revision: nextPolicyRevision(addon.destinations?.revision),
            }) ?? null : undefined
            await onSave({
                customName: customName.trim() || undefined,
                customLogo: customLogo.trim() || undefined,
                customDescription: customDescription.trim() || undefined,
            }, nextDestinations)
            onOpenChange(false)
        } catch (err) {
            if (import.meta.env.DEV) console.error(err)
            setError(err instanceof Error && err.message ? err.message : 'Failed to save changes.')
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        setSaving(true)
        setError(null)
        try {
            // Clear all custom overrides by sending undefined
            await onSave({
                customName: undefined,
                customLogo: undefined,
                customDescription: undefined,
            })
            setCustomName('')
            setCustomLogo('')
            setCustomDescription('')
            onOpenChange(false) // Close dialog so parent re-renders with fresh addon data
        } catch (err) {
            if (import.meta.env.DEV) console.error(err)
            setError(err instanceof Error && err.message ? err.message : 'Failed to reset defaults.')
        } finally {
            setSaving(false)
        }
    }

    const handleReplaceUrl = async (descriptor: AddonDescriptor, requestedUrl: string) => {
        if (!onReplaceUrl) return
        setError(null)
        try {
            const result = await onReplaceUrl(descriptor.transportUrl || requestedUrl, descriptor)
            if (!result?.failedAccounts?.length) onOpenChange(false)
            return result
        } catch (err) {
            const message = (err instanceof Error && err.message) || 'Failed to replace URL.'
            setError(message)
            throw new Error(message)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* flex column keeps the footer below a scrolling body; the sticky
                footer needs a containing block taller than itself, which grid
                rows (sized to the footer alone) would not give it. */}
            <DialogContent className="flex max-h-[90dvh] flex-col overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Edit Addon Details</DialogTitle>
                    <DialogDescription>
                        Customize this addon and choose where it syncs.
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="customize" className="min-w-0 w-full">
                    <TabsList className="mb-2 w-full flex-nowrap sm:w-fit">
                        <TabsTrigger value="customize" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
                            Customize
                        </TabsTrigger>
                        <TabsTrigger value="destinations" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
                            Destinations
                        </TabsTrigger>
                        <TabsTrigger value="advanced" className="flex-1 px-2 text-xs sm:flex-none sm:px-3.5 sm:text-sm">
                            Advanced
                        </TabsTrigger>
                    </TabsList>

                    {/* forceMount keeps in-progress drafts (URL edit, destination
                        toggles, manifest JSON) alive across tab switches. Radix
                        never applies the hidden attribute to force-mounted
                        panels, so inactive ones are hidden via the data-state
                        class instead of unmounting. */}
                    <TabsContent value="customize" forceMount className="min-w-0 data-[state=inactive]:hidden">
                        <div className="flex flex-col-reverse gap-6 pb-4 pt-2 md:grid md:grid-cols-2">
                            <div className="min-w-0 space-y-4">

                                <div className="space-y-2">
                                    <Label htmlFor="name">Display Name</Label>
                                    <div className="relative">
                                        <Input
                                            id="name"
                                            className="min-w-0 pr-10"
                                            value={customName}
                                            onChange={(e) => setCustomName(e.target.value)}
                                            placeholder={addon.manifest.name}
                                        />
                                        {customName && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setCustomName('')}
                                                aria-label="Reset Display Name"
                                                className="absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
                                            >
                                                <RotateCcw className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="logo">Logo URL</Label>
                                    <div className="relative">
                                        <Input
                                            id="logo"
                                            className="min-w-0 pr-10"
                                            value={customLogo.startsWith('data:') ? '\u2713 Uploaded image' : customLogo}
                                            onChange={(e) => setCustomLogo(e.target.value)}
                                            placeholder="https://..."
                                            readOnly={customLogo.startsWith('data:')}
                                        />
                                        {customLogo && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setCustomLogo('')}
                                                aria-label="Reset Logo URL"
                                                className="absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
                                            >
                                                <RotateCcw className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                    <ImageUploadButton
                                        onUploaded={setCustomLogo}
                                        options={{ maxDimension: 512, square: false, quality: 0.85 }}
                                        className="flex h-8 w-fit items-center gap-1.5 rounded-full border border-border/40 px-3 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                                    >
                                        <Upload className="h-3 w-3" /> Upload Image
                                    </ImageUploadButton>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="description">Description</Label>
                                    <div className="relative">
                                        <Textarea
                                            id="description"
                                            className="min-w-0 pr-10"
                                            value={customDescription}
                                            onChange={(e) => setCustomDescription(e.target.value)}
                                            placeholder={addon.manifest.description}
                                        />
                                        {customDescription && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => setCustomDescription('')}
                                                aria-label="Reset Description"
                                                className="absolute bottom-2 right-2 h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
                                            >
                                                <RotateCcw className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Addon URL</Label>
                                    {onReplaceUrl ? (
                                        <SourceUrlBox
                                            addon={addon}
                                            accountId={accountId}
                                            privacyMode={isPrivacyModeEnabled}
                                            variant="compact"
                                            onReplace={handleReplaceUrl}
                                            successDescription="Addon URL updated successfully."
                                            className="bg-background/45"
                                        />
                                    ) : (
                                        <Tooltip content={isPrivacyModeEnabled ? 'Private addon URL' : maskSecretUrl(addon.transportUrl)}>
                                            <p className="break-all line-clamp-2 text-xs text-muted-foreground">
                                                URL: {isPrivacyModeEnabled ? '********' : maskSecretUrl(addon.transportUrl)}
                                            </p>
                                        </Tooltip>
                                    )}
                                </div>
                            </div>

                            <div className="w-full min-w-0 space-y-2 md:sticky md:top-0 md:self-start">
                                <span className="text-xs font-medium uppercase text-muted-foreground">Dashboard Preview</span>
                                <AddonCardPreview
                                    addon={addon}
                                    accountId={accountId}
                                    name={customName}
                                    logo={customLogo}
                                    description={customDescription}
                                />
                            </div>
                        </div>
                    </TabsContent>

                    <TabsContent value="destinations" forceMount className="data-[state=inactive]:hidden">
                        {platforms.length > 0 ? (
                            <div className="min-w-0">
                                <div data-theme-part="panel" data-testid="destinations-picker" className="rounded-2xl border border-border/40 bg-muted/20 px-4 py-1.5">
                                    {platforms.map((platform, index) => {
                                        const platformConns = destinationConnections.filter(c => c.platform === platform)
                                        const state = platformStates[index]
                                        const stateId = `dest-state-${platform}`
                                        const platformName = getPlatformEntry(platform)?.name || platform
                                        return (
                                            <div key={platform} className="flex items-center gap-3 border-b border-border/30 py-2.5 last:border-b-0">
                                                <PlatformLogo platform={platform} className="h-8 w-8 shrink-0" />
                                                <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                                                    <div className="min-w-0 sm:flex-1">
                                                        <p className="truncate text-sm font-semibold">{platformName}</p>
                                                        {platformConns.map(conn => {
                                                            const who = connectionIdentity(conn)
                                                            return who ? (
                                                                <p key={conn.id} className="break-all text-xs leading-snug text-muted-foreground">{who}</p>
                                                            ) : null
                                                        })}
                                                    </div>
                                                    <span id={stateId} className={`mt-0.5 block text-xs font-medium leading-snug sm:mt-0 sm:shrink-0 sm:text-right sm:text-sm ${state === 'removed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                                                        {STATE_LABEL[state]}
                                                    </span>
                                                </div>
                                                <Switch
                                                    checked={state !== 'removed'}
                                                    aria-describedby={stateId}
                                                    onCheckedChange={(v) => togglePlatform(platform, v)}
                                                    aria-label={`Sync to ${platformName}`}
                                                />
                                            </div>
                                        )
                                    })}
                                </div>
                                <p className="mt-3 text-xs text-muted-foreground">
                                    The switch covers every login on the platform, present and future.
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    A destination you switch off loses its copy on that platform when you save. The addon stays in your AIOManager library.
                                </p>
                                <p data-testid="destinations-summary" className="mt-3 text-sm font-medium">
                                    {syncingPlatforms} of {platforms.length} platform{platforms.length === 1 ? '' : 's'} will sync
                                    {pausedPlatforms > 0 && (
                                        <span className="text-muted-foreground">, {pausedPlatforms} paused</span>
                                    )}
                                    {removedPlatforms > 0 && (
                                        <span className="text-destructive">, {removedPlatforms} will be removed on save</span>
                                    )}
                                </p>
                            </div>
                        ) : (
                            <p className="py-6 text-sm text-muted-foreground">
                                This account has no addon-capable connections yet.
                            </p>
                        )}
                    </TabsContent>

                    <TabsContent value="advanced" forceMount className="data-[state=inactive]:hidden">
                        <div className="space-y-4 py-4 text-xs text-muted-foreground">
                            <div data-theme-part="panel" className="rounded-md border border-border/40 bg-muted/10 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <span className="font-semibold block mb-1">Developer Info</span>
                                    <p className="break-all line-clamp-2">ID: {addon.manifest.id}</p>
                                    <p className="break-words line-clamp-2">Name: {addon.manifest.name}</p>
                                </div>
                                <div>
                                    <span className="font-semibold block mb-1">Technical Details</span>
                                    <p>Status: {addon.flags?.protected ? 'Protected' : 'Standard'}</p>
                                </div>
                            </div>

                            <ManifestJSONEditor
                                embedded
                                manifest={addon.manifest}
                                onSave={async (newManifest) => {
                                    await useAccountStore.getState().updateAddonSettings(
                                        accountId,
                                        addon.transportUrl,
                                        { manifest: newManifest }
                                    )
                                    onOpenChange(false)
                                }}
                            />
                        </div>
                    </TabsContent>
                </Tabs>

                {error && <p role="alert" className="text-sm text-destructive font-medium">{error}</p>}

                {/* Pinned footer: stays visible while the dialog body scrolls. */}
                <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 flex flex-col gap-2 border-t border-border/40 bg-card px-4 pb-4 pt-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:pb-6 [&_button]:rounded-full [&_button]:px-5">
                    <Button type="button" variant="subtle" className="order-last h-9 w-full sm:order-none sm:h-11 sm:w-auto" onClick={handleReset} disabled={saving}>
                        Reset to Defaults
                    </Button>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-3 [&_button]:h-11">
                        <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={saving}>
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={saving || !hasChanges}>
                            {saving ? 'Syncing...' : 'Save & Sync'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
