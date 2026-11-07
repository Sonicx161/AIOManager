import { useEffect, useState } from 'react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProfileStore } from '@/store/profileStore'
import type { DiscoverAddon } from '@/api/discover'

export interface DiscoverSavePayload {
  name: string
  tags: string[]
  profileId?: string
  newProfileName?: string
}

interface DiscoverSaveDialogProps {
  addon: DiscoverAddon | null
  open: boolean
  onOpenChange: (open: boolean) => void
  saving: boolean
  onSave: (payload: DiscoverSavePayload) => void
}

export function DiscoverSaveDialog({ addon, open, onOpenChange, saving, onSave }: DiscoverSaveDialogProps) {
  const profiles = useProfileStore((s) => s.profiles)
  const initProfiles = useProfileStore((s) => s.initialize)

  const [name, setName] = useState('')
  const [tags, setTags] = useState('')
  const [profileId, setProfileId] = useState<string>('unassigned')
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')

  useEffect(() => { initProfiles() }, [initProfiles])

  useEffect(() => {
    if (open && addon) {
      setName(addon.manifest?.name?.trim() || addon.slug || '')
      setTags('')
      setProfileId('unassigned')
      setCreatingProfile(false)
      setNewProfileName('')
    }
  }, [open, addon])

  const handleSave = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      profileId: profileId === 'unassigned' ? undefined : profileId,
      newProfileName: creatingProfile ? newProfileName.trim() : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save to Library</DialogTitle>
          <DialogDescription>Save this addon and choose where it lives in your library.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 py-4">
          <div className="space-y-2">
            <Label htmlFor="discover-save-name">Name</Label>
            <Input id="discover-save-name" data-autofocus="true" value={name} onChange={(e) => setName(e.target.value)} placeholder="Addon name" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{creatingProfile ? 'New Profile Name' : 'Profile'}</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-primary hover:text-primary/80"
                onClick={() => setCreatingProfile((v) => !v)}
              >
                {creatingProfile ? 'Choose Existing' : '+ Create New'}
              </Button>
            </div>
            {creatingProfile ? (
              <Input value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="e.g. My Movies" autoFocus />
            ) : (
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="discover-save-tags">Tags (optional)</Label>
            <Input id="discover-save-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="movies, series, anime..." />
          </div>
        </div>
        <DialogFooter>
          <Button variant="subtle" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>{saving ? 'Saving...' : 'Save Addon'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
