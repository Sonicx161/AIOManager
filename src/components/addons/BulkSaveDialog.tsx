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
import { Loader2 } from 'lucide-react'
import { useEffect, useState, useMemo } from 'react'

// Internal addon IDs are now handled by isInternalAddon in cinemeta-utils.ts

interface BulkSaveDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    addons: AddonDescriptor[]
    accountId: string
}

export function BulkSaveDialog({
    open,
    onOpenChange,
    addons,
    accountId,
}: BulkSaveDialogProps) {
    const { library, createSavedAddon } = useAddonStore()
    const { profiles, createProfile } = useProfileStore()
    const accounts = useAccountStore((state) => state.accounts)
    const { toast } = useToast()

    const [saving, setSaving] = useState(false)
    const [saveProfileId, setSaveProfileId] = useState<string>('unassigned')
    const [isCreatingProfile, setIsCreatingProfile] = useState(false)
    const [newProfileName, setNewProfileName] = useState('')
    const [saveTags, setSaveTags] = useState<string[]>([])
    const [skipDuplicates] = useState(true)
    const [excludeInternal, setExcludeInternal] = useState(true)

    const filteredAddons = excludeInternal
        ? addons.filter(a => !isInternalAddon(a))
        : addons

    const allKnownTags = useMemo(() => {
        const tagsSet = new Set<string>()
        Object.values(library).forEach((savedAddon) => {
            savedAddon.tags.forEach((tag) => tagsSet.add(tag))
        })
        return Array.from(tagsSet).sort()
    }, [library])

    // Smart Defaulting when dialog opens
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

            // 1. Create Profile if needed
            if (isCreatingProfile && newProfileName.trim()) {
                try {
                    const newProfile = await createProfile(newProfileName.trim())
                    finalProfileId = newProfile.id
                } catch (err) {
                    console.error('Failed to create profile:', err)
                    toast({
                        title: 'Error',
                        description: 'Failed to create profile. Aborting.',
                        variant: 'destructive',
                    })
                    setSaving(false)
                    return
                }
            }

            // 2. Tags are already in array format
            const tags = saveTags

            let successCount = 0
            let skippedCount = 0
            let failCount = 0

            // 3. Iterate and Save
            for (const addon of filteredAddons) {
                // Check duplicate
                if (skipDuplicates) {
                    const isDuplicate = Object.values(library).some(
                        (saved) =>
                            saved.manifest.id === addon.manifest.id &&
                            saved.installUrl === addon.transportUrl &&
                            saved.profileId === finalProfileId
                    )
                    if (isDuplicate) {
                        skippedCount++
                        continue
                    }
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
                    console.error(`Failed to save ${addon.manifest.id}:`, err)
                    failCount++
                }
            }

            toast({
                title: 'Bulk Save Complete',
                description: `Saved: ${successCount}. Skipped: ${skippedCount}. Failed: ${failCount}.`,
            })

            handleClose()
        } catch (err) {
            console.error('Bulk save failed:', err)
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Save All Addons</DialogTitle>
                    <DialogDescription>
                        Save {filteredAddons.length} installed addons to your library.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>Target Profile</Label>
                            {!isCreatingProfile ? (
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="h-auto p-0 text-xs"
                                    onClick={() => setIsCreatingProfile(true)}
                                >
                                    + Create New Profile
                                </Button>
                            ) : (
                                <Button
                                    variant="link"
                                    size="sm"
                                    className="h-auto p-0 text-xs"
                                    onClick={() => setIsCreatingProfile(false)}
                                >
                                    Select Existing
                                </Button>
                            )}
                        </div>

                        {isCreatingProfile ? (
                            <Input
                                value={newProfileName}
                                onChange={(e) => setNewProfileName(e.target.value)}
                                placeholder="New Profile Name"
                                autoFocus
                            />
                        ) : (
                            <Select value={saveProfileId} onValueChange={setSaveProfileId}>
                                <SelectTrigger>
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
                        <Label className="text-xs font-medium">Tags (optional)</Label>
                        <TagInput
                            value={saveTags}
                            onChange={setSaveTags}
                            placeholder="Type and press Enter to add..."
                            suggestions={allKnownTags}
                        />
                        <Label>Merge Strategy</Label>
                        <div className="text-sm text-muted-foreground mb-4">
                            Addons will be added to your library. If an addon with the same ID already exists, it will be updated.
                        </div>

                        <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg border border-dashed">
                            <Checkbox
                                id="exclude-internal"
                                checked={excludeInternal}
                                onCheckedChange={(checked) => setExcludeInternal(!!checked)}
                            />
                            <div className="grid gap-1.5 leading-none">
                                <Label
                                    htmlFor="exclude-internal"
                                    className="text-sm font-medium leading-none cursor-pointer"
                                >
                                    Exclude internal Stremio addons
                                </Label>
                                <p className="text-[10px] text-muted-foreground">
                                    Skip Cinemeta, Local, and other built-in addons.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={handleClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleBulkSave} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {isCreatingProfile ? 'Create & Save All' : 'Save All'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
