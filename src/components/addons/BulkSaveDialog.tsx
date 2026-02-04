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
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useProfileStore } from '@/store/profileStore'
import { AddonDescriptor } from '@/types/addon'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

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
    const [saveTags, setSaveTags] = useState('')
    const [skipDuplicates] = useState(true) // Retain state but remove setter if unused, or just default to true properly

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
                // Default to creating a new profile for "Save All" usually implies setting up a new user
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
        setSaveTags('')
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

            // 2. Prepare Tags
            const tags = saveTags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)

            let successCount = 0
            let skippedCount = 0
            let failCount = 0

            // 3. Iterate and Save
            for (const addon of addons) {
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
                        addon.manifest
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
                        Save {addons.length} installed addons to your library.
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
                        <Label>Merge Strategy</Label>
                        <div className="text-sm text-muted-foreground mb-2">
                            Addons will be added to your library. If an addon with the same ID already exists, it will be updated.
                        </div>        </div>
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
