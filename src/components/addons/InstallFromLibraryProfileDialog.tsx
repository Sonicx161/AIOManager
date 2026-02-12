import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { useAddonStore } from '@/store/addonStore'
import { useAccountStore } from '@/store/accountStore'
import { useProfileStore } from '@/store/profileStore'
import { useState, useMemo } from 'react'
import { Check, AlertCircle, Library, Tags } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface InstallFromLibraryProfileDialogProps {
    accountId: string
    accountAuthKey: string
    open: boolean
    onOpenChange: (open: boolean) => void
    onSuccess?: () => void
}

export function InstallFromLibraryProfileDialog({
    accountId,
    accountAuthKey,
    open,
    onOpenChange,
    onSuccess,
}: InstallFromLibraryProfileDialogProps) {
    const { library, bulkApplySavedAddons, loading } = useAddonStore()
    const { profiles } = useProfileStore()
    const syncAccount = useAccountStore((state) => state.syncAccount)

    const [selectedProfileId, setSelectedProfileId] = useState<string>('')
    const [selectedTagName, setSelectedTagName] = useState<string>('')
    const [mode, setMode] = useState<'profile' | 'tag'>('profile')
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    // Get all unique tags from the library
    const allTags = useMemo(() => {
        const tags = new Set<string>()
        Object.values(library).forEach(addon => addon.tags.forEach(tag => tags.add(tag)))
        return Array.from(tags).sort()
    }, [library])

    // Get addons in the selected group
    const addonsToInstall = useMemo(() => {
        const libraryArray = Object.values(library)
        if (mode === 'profile' && selectedProfileId) {
            if (selectedProfileId === 'unassigned') {
                return libraryArray.filter(a => !a.profileId)
            }
            return libraryArray.filter(a => a.profileId === selectedProfileId)
        }
        if (mode === 'tag' && selectedTagName) {
            return libraryArray.filter(a => a.tags.includes(selectedTagName))
        }
        return []
    }, [library, mode, selectedProfileId, selectedTagName])

    const handleInstall = async () => {
        if (addonsToInstall.length === 0) {
            setError('No addons found in the selected group')
            return
        }

        setError(null)
        setSuccess(false)

        try {
            const accountsToApply = [{ id: accountId, authKey: accountAuthKey }]
            const addonIds = addonsToInstall.map(a => a.id)

            const bulkResult = await bulkApplySavedAddons(
                addonIds,
                accountsToApply,
                true // UNRESTRICTED: Always allow protected override from library
            )

            if (bulkResult.failed === 0) {
                setSuccess(true)
                await syncAccount(accountId)
                if (onSuccess) onSuccess()
                setTimeout(() => onOpenChange(false), 2000)
            } else {
                setError(`Completed with ${bulkResult.failed} error(s)`)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to install addons')
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Install from Library Profile</DialogTitle>
                    <DialogDescription>
                        Bulk install all addons from a specific group in your library.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-4">
                    <div className="flex bg-muted p-1 rounded-lg">
                        <Button
                            variant={mode === 'profile' ? 'secondary' : 'ghost'}
                            className="flex-1 h-8 text-xs"
                            onClick={() => {
                                setMode('profile')
                                setError(null)
                            }}
                        >
                            <Library className="h-3.5 w-3.5 mr-2" />
                            Profiles
                        </Button>
                        <Button
                            variant={mode === 'tag' ? 'secondary' : 'ghost'}
                            className="flex-1 h-8 text-xs"
                            onClick={() => {
                                setMode('tag')
                                setError(null)
                            }}
                        >
                            <Tags className="h-3.5 w-3.5 mr-2" />
                            Tags
                        </Button>
                    </div>

                    {mode === 'profile' ? (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Profile</label>
                            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Choose a profile..." />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="unassigned">Unassigned</SelectItem>
                                    {profiles.map(p => (
                                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Select Tag</label>
                            <Select value={selectedTagName} onValueChange={setSelectedTagName}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Choose a tag..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {allTags.map(tag => (
                                        <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    {addonsToInstall.length > 0 && (
                        <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                            <p className="text-sm font-medium text-primary">
                                Found {addonsToInstall.length} addon{addonsToInstall.length !== 1 ? 's' : ''}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                                {addonsToInstall.map(addon => (
                                    <Badge key={addon.id} variant="secondary" className="text-[10px] font-normal">
                                        {addon.name}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                            <AlertCircle className="h-4 w-4" />
                            {error}
                        </div>
                    )}

                    {success && (
                        <div className="p-3 rounded-lg bg-green-500/10 text-green-600 text-sm flex items-center gap-2">
                            <Check className="h-4 w-4" />
                            Installation successful!
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleInstall}
                        disabled={addonsToInstall.length === 0 || loading || success}
                    >
                        {loading ? 'Installing...' : 'Install All'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
