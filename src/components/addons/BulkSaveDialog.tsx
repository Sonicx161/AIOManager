import { Button } from '@/components/ui/button'
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
import { Checkbox } from '@/components/ui/checkbox'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { isInternalAddon } from '@/lib/cinemeta-utils'
import { TagInput } from '@/components/ui/tag-input'
import { CheckCircle2, Library, Loader2, Plus, ShieldCheck, Tags } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEffect, useState, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

// Internal addon IDs are now handled by isInternalAddon in cinemeta-utils.ts

const SAVE_MODE_OPTIONS: Array<{
    value: 'skip' | 'update' | 'copy'
    label: string
    description: string
}> = [
        {
            value: 'skip',
            label: 'Skip Existing',
            description: 'Only save addons that are not already in the library.',
        },
        {
            value: 'update',
            label: 'Update Matches',
            description: 'Merge tags and refresh details for existing entries.',
        },
        {
            value: 'copy',
            label: 'Create Copies',
            description: 'Save new entries even when a match already exists.',
        },
    ]

interface BulkSaveDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    addons: AddonDescriptor[]
    accountId: string
    title?: string
}

export function BulkSaveDialog({
    open,
    onOpenChange,
    addons,
    accountId,
    title,
}: BulkSaveDialogProps) {
    const library = useAddonStore(s => s.library)
    const createSavedAddon = useAddonStore(s => s.createSavedAddon)
    const profiles = useProfileStore(s => s.profiles)
    const createProfile = useProfileStore(s => s.createProfile)
    const accounts = useAccountStore((state) => state.accounts)
    const { toast } = useToast()

    const [saving, setSaving] = useState(false)
    const [saveProfileId, setSaveProfileId] = useState<string>('unassigned')
    const [isCreatingProfile, setIsCreatingProfile] = useState(false)
    const [newProfileName, setNewProfileName] = useState('')
    const [saveTags, setSaveTags] = useState<string[]>([])
    const [saveMode, setSaveMode] = useState<'skip' | 'update' | 'copy'>('skip')
    const [excludeInternal, setExcludeInternal] = useState(true)
    const saveModeRefs = useRef<Array<HTMLButtonElement | null>>([])

    const filteredAddons = excludeInternal
        ? addons.filter(a => !isInternalAddon(a))
        : addons
    const internalAddonsCount = addons.length - filteredAddons.length

    const allKnownTags = useMemo(() => {
        const tagsSet = new Set<string>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => tagsSet.add(tag))
        })
        return Array.from(tagsSet).sort()
    }, [library])

    const handleSaveModeKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            nextIndex = (index + 1) % SAVE_MODE_OPTIONS.length
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            nextIndex = (index - 1 + SAVE_MODE_OPTIONS.length) % SAVE_MODE_OPTIONS.length
        } else if (e.key === 'Home') {
            nextIndex = 0
        } else if (e.key === 'End') {
            nextIndex = SAVE_MODE_OPTIONS.length - 1
        }

        if (nextIndex === null) return

        e.preventDefault()
        setSaveMode(SAVE_MODE_OPTIONS[nextIndex].value)
        requestAnimationFrame(() => saveModeRefs.current[nextIndex]?.focus())
    }

    useEffect(() => {
        if (open) {
            const currentAccount = accounts.find((a) => a.id === accountId)
            const customName = currentAccount?.name?.trim()
            const emailName = currentAccount?.email?.split('@')[0]?.trim()

            let matchingProfile = undefined
            if (customName) {
                matchingProfile = profiles.find(
                    (p) => p.name.trim().toLowerCase() === customName.trim().toLowerCase()
                )
            }
            if (!matchingProfile && emailName) {
                matchingProfile = profiles.find(
                    (p) => p.name.trim().toLowerCase() === emailName.trim().toLowerCase()
                )
            }

            if (matchingProfile) {
                setSaveProfileId(matchingProfile.id)
                setIsCreatingProfile(false)
            } else {
                setSaveProfileId('unassigned')
                setNewProfileName(customName || emailName || 'My Profile')
                setIsCreatingProfile(true)
            }
        }
    }, [open, accountId, accounts, profiles])

    const handleClose = () => {
        onOpenChange(false)
        setIsCreatingProfile(false)
        setNewProfileName('')
        setSaveTags([])
        setSaving(false)
    }

    const handleBulkSave = async () => {
        setSaving(true)
        try {
            let finalProfileId = saveProfileId === 'unassigned' ? undefined : saveProfileId

            if (isCreatingProfile && newProfileName.trim()) {
                try {
                    const newProfile = await createProfile(newProfileName.trim())
                    finalProfileId = newProfile.id
                } catch (err) {
                    if (import.meta.env.DEV) console.error('Failed to create profile:', err)
                    toast({
                        title: 'Error',
                        description: 'Failed to create profile. Aborting.',
                        variant: 'destructive',
                    })
                    setSaving(false)
                    return
                }
            }

            const tags = saveTags

            let successCount = 0
            let skippedCount = 0
            let failCount = 0

            const { updateSavedAddon, updateSavedAddonMetadata } = useAddonStore.getState()

            for (const addon of filteredAddons) {
                const existingAddons = Object.values(library).filter(
                    (saved) =>
                        saved.manifest.id === addon.manifest.id &&
                        saved.installUrl === addon.transportUrl
                )

                // Interpret "Existing" as "Same ID & URL"
                const existing = existingAddons.find(s => s.profileId === finalProfileId) || existingAddons[0]

                if (existing) {
                    if (saveMode === 'skip') {
                        skippedCount++
                        continue
                    }

                    if (saveMode === 'update') {
                        try {
                            const mergedTags = Array.from(new Set([...existing.tags, ...tags]))

                            await updateSavedAddon(existing.id, {
                                name: addon.manifest.name,
                                tags: mergedTags,
                                profileId: finalProfileId || existing.profileId,
                            })

                            if (addon.metadata) {
                                await updateSavedAddonMetadata(existing.id, {
                                    customName: addon.metadata.customName,
                                    customLogo: addon.metadata.customLogo
                                })
                            }
                            successCount++
                            continue
                        } catch (err) {
                            if (import.meta.env.DEV) console.error(`Failed to update ${addon.manifest.id}:`, err)
                            failCount++
                            continue
                        }
                    }
                    // If 'copy', we just fall through to createSavedAddon
                }

                try {
                    await createSavedAddon(
                        addon.manifest.name,
                        addon.transportUrl,
                        tags,
                        finalProfileId,
                        addon.manifest,
                        addon.metadata
                    )
                    successCount++
                } catch (err) {
                    if (import.meta.env.DEV) console.error(`Failed to save ${addon.manifest.id}:`, err)
                    failCount++
                }
            }

            toast({
                title: 'Bulk Save Complete',
                description: `Saved/Updated: ${successCount}. Skipped: ${skippedCount}. Failed: ${failCount}.`,
            })

            handleClose()
        } catch (err) {
            if (import.meta.env.DEV) console.error('Bulk save failed:', err)
            toast({
                title: 'Error',
                description: 'An unexpected error occurred during bulk save.',
                variant: 'destructive',
            })
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={(_val) => !saving && handleClose()}>
            <DialogContent className="max-h-[92vh] sm:max-w-3xl gap-0 overflow-hidden p-0 flex flex-col">
                <DialogHeader className="p-5 pb-2 pr-14 sm:pr-5 shrink-0">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                            <DialogTitle className="text-2xl tracking-tight">{title || 'Save Addons to Library'}</DialogTitle>
                            <DialogDescription>
                                Capture installed addons as reusable library entries.
                            </DialogDescription>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span data-theme-part="badge" className="rounded-full border border-border/40 bg-background/70 px-2.5 py-1 font-semibold tabular-nums">
                                {filteredAddons.length} saving
                            </span>
                            {internalAddonsCount > 0 && (
                                <span data-theme-part="badge" className="rounded-full border border-border/40 bg-background/70 px-2.5 py-1 font-semibold tabular-nums">
                                    {internalAddonsCount} internal
                                </span>
                            )}
                        </div>
                    </div>
                </DialogHeader>

                <div className="grid min-h-0 gap-4 overflow-y-auto p-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
                    <div className="space-y-4">
                        <section data-theme-part="panel" className="rounded-[1.35rem] border border-border/40 bg-card/70 p-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-primary/20 bg-primary/12 text-primary">
                                        <Library className="h-4 w-4" />
                                    </span>
                                    <div>
                                        <Label>Target Profile</Label>
                                        <p className="text-xs text-muted-foreground">Group these saved addons for reuse.</p>
                                    </div>
                                </div>
                                {!isCreatingProfile ? (
                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        className="h-8 gap-1.5 text-xs"
                                        onClick={() => setIsCreatingProfile(true)}
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        New
                                    </Button>
                                ) : (
                                    <Button
                                        variant="subtle"
                                        size="sm"
                                        className="h-8 text-xs"
                                        onClick={() => setIsCreatingProfile(false)}
                                    >
                                        Existing
                                    </Button>
                                )}
                            </div>

                            {isCreatingProfile ? (
                                <Input
                                    value={newProfileName}
                                    onChange={(e) => setNewProfileName(e.target.value)}
                                    placeholder="New profile name"
                                    autoFocus
                                    className="bg-background/70"
                                />
                            ) : (
                                <Select value={saveProfileId} onValueChange={setSaveProfileId}>
                                    <SelectTrigger className="bg-background/70">
                                        <SelectValue placeholder="Select a profile" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="unassigned">Unassigned</SelectItem>
                                        {profiles.map((p) => (
                                            <SelectItem key={p.id} value={p.id}>
                                                {p.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </section>

                        <section data-theme-part="panel" className="rounded-[1.35rem] border border-border/40 bg-card/70 p-4">
                            <div className="mb-3 flex items-center gap-2">
                                <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border/40 bg-muted/35 text-muted-foreground">
                                    <Tags className="h-4 w-4" />
                                </span>
                                <div>
                                    <Label>Tags</Label>
                                    <p className="text-xs text-muted-foreground">Optional labels for filtering later.</p>
                                </div>
                            </div>
                            <TagInput
                                value={saveTags}
                                onChange={setSaveTags}
                                placeholder="Type and press Enter to add..."
                                suggestions={allKnownTags}
                            />
                        </section>

                        <section data-theme-part="panel" className="rounded-[1.35rem] border border-border/40 bg-card/70 p-4">
                            <div className="mb-3">
                                <Label>Conflict Resolution</Label>
                                <p className="text-xs text-muted-foreground">Choose what happens when a matching addon already exists.</p>
                            </div>
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Conflict resolution">
                                {SAVE_MODE_OPTIONS.map((option, index) => (
                                    <button
                                        key={option.value}
                                        ref={(node) => { saveModeRefs.current[index] = node }}
                                        type="button"
                                        role="radio"
                                        aria-checked={saveMode === option.value}
                                        data-theme-part="button"
                                        data-state={saveMode === option.value ? 'active' : 'inactive'}
                                        tabIndex={saveMode === option.value ? 0 : -1}
                                        onClick={() => setSaveMode(option.value)}
                                        onKeyDown={(e) => handleSaveModeKeyDown(e, index)}
                                        className={cn(
                                            "rounded-2xl border p-3 text-left transition-[background,border-color,box-shadow]",
                                            saveMode === option.value
                                                ? "border-primary/30 bg-primary/12 shadow-sm"
                                                : "border-border/35 bg-background/55 hover:border-primary/25 hover:bg-muted/30",
                                        )}
                                    >
                                        <span className="flex items-center gap-2 text-sm font-semibold">
                                            {saveMode === option.value && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
                                            {option.label}
                                        </span>
                                        <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                                            {option.description}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    </div>

                    <aside className="space-y-3">
                        <div data-theme-part="panel" className="rounded-[1.35rem] border border-border/40 bg-background/55 p-4">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save Summary</p>
                            <div className="mt-3 space-y-2 text-sm">
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Installed addons</span>
                                    <span className="font-semibold tabular-nums">{addons.length}</span>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Will save</span>
                                    <span className="font-semibold tabular-nums">{filteredAddons.length}</span>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <span className="text-muted-foreground">Tags</span>
                                    <span className="font-semibold tabular-nums">{saveTags.length}</span>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-[1.35rem] border border-dashed border-border/45 bg-muted/20 p-4">
                            <div className="flex items-start gap-3">
                                <Checkbox
                                    id="exclude-internal"
                                    checked={excludeInternal}
                                    onCheckedChange={(checked) => setExcludeInternal(!!checked)}
                                    className="mt-0.5"
                                />
                                <div className="grid gap-1.5 leading-none">
                                    <Label
                                        htmlFor="exclude-internal"
                                        className="flex cursor-pointer items-center gap-1.5 text-sm font-medium leading-none"
                                    >
                                        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                                        Exclude internal addons
                                    </Label>
                                    <p className="text-xs leading-relaxed text-muted-foreground">
                                        Skip Cinemeta, Local, and other built-in Stremio components.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </aside>
                </div>

                <DialogFooter className="grid grid-cols-2 gap-3 px-5 pb-5 pt-2 shrink-0">
                    <Button variant="subtle" onClick={handleClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleBulkSave} disabled={saving || filteredAddons.length === 0} className="gap-2">
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        {isCreatingProfile
                            ? (title?.includes('Selected') ? 'Create & Save Selected' : 'Create & Save All')
                            : (title || 'Save Addons')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
