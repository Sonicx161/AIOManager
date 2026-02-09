import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useProfileStore } from '@/store/profileStore'
import { Profile } from '@/types/profile'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from '@/hooks/use-toast'

interface ProfileDialogProps {
    profile?: Profile // If provided, we are editing
    trigger?: React.ReactNode
}

export function ProfileDialog({ profile, trigger }: ProfileDialogProps) {
    const [open, setOpen] = useState(false)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const { createProfile, updateProfile } = useProfileStore()
    const { toast } = useToast()

    // Reset form when dialog opens/closes or profile changes
    useEffect(() => {
        if (open) {
            setName(profile?.name || '')
            setDescription(profile?.description || '')
        }
    }, [open, profile])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()

        if (!name.trim()) return

        try {
            if (profile) {
                await updateProfile(profile.id, { name, description })
                toast({ title: 'Profile updated', description: `Updated profile "${name}"` })
            } else {
                await createProfile(name, description)
                toast({ title: 'Profile created', description: `Created profile "${name}"` })
            }
            setOpen(false)
        } catch (error) {
            toast({
                variant: 'destructive',
                title: 'Error',
                description: 'Failed to save profile'
            })
        }
    }

    return (
        <>
            <div onClick={() => setOpen(true)} className="inline-block cursor-pointer">
                {trigger || (
                    <Button>
                        <Plus className="mr-2 h-4 w-4" />
                        Create Profile
                    </Button>
                )}
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>{profile ? 'Edit Profile' : 'Create Profile'}</DialogTitle>
                        <DialogDescription>
                            {profile ? 'Update profile details.' : 'Create a new profile to organize your addons.'}
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleSubmit} className="space-y-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="name">Name</Label>
                            <Input
                                id="name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="e.g. Kids, Guests"
                                required
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="description">Description (Optional)</Label>
                            <Input
                                id="description"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Brief description of this profile"
                            />
                        </div>
                        <DialogFooter>
                            <Button type="submit">{profile ? 'Save Changes' : 'Create Profile'}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    )
}
