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
import { AddonDescriptor } from '@/types/addon'
import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

interface AddonMetadataDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    addon: AddonDescriptor
    onSave: (metadata: { customName?: string; customLogo?: string; customDescription?: string }) => Promise<void>
}

export function AddonMetadataDialog({
    open,
    onOpenChange,
    addon,
    onSave,
}: AddonMetadataDialogProps) {
    const [customName, setCustomName] = useState('')
    const [customLogo, setCustomLogo] = useState('')
    const [customDescription, setCustomDescription] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Initialize form with existing metadata
    useEffect(() => {
        if (open) {
            setCustomName(addon.metadata?.customName || '')
            setCustomLogo(addon.metadata?.customLogo || '')
            setCustomDescription(addon.metadata?.customDescription || '')
            setError(null)
        }
    }, [open, addon])

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
            await onSave({
                customName: customName.trim() || undefined,
                customLogo: customLogo.trim() || undefined,
                customDescription: customDescription.trim() || undefined,
            })
            onOpenChange(false)
        } catch (err) {
            console.error(err)
            setError('Failed to save changes.')
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        setSaving(true)
        setError(null)
        try {
            // Send undefined to clearing overrides
            await onSave({
                customName: undefined,
                customLogo: undefined,
                customDescription: undefined,
            })
            setCustomName('')
            setCustomLogo('')
            setCustomDescription('')
            // Keep open as requested
        } catch (err) {
            console.error(err)
            setError('Failed to reset defaults.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit Addon Details</DialogTitle>
                    <DialogDescription>
                        Customize how this addon appears in your Stremio dashboard.
                    </DialogDescription>
                </DialogHeader>

                <div className="md:grid md:grid-cols-2 gap-6 py-4">
                    <div className="space-y-4">
                        {/* Display Name */}
                        <div className="space-y-2">
                            <Label htmlFor="name">Display Name</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="name"
                                    value={customName}
                                    onChange={(e) => setCustomName(e.target.value)}
                                    placeholder={addon.manifest.name}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    title="Reset Name"
                                    onClick={() => setCustomName('')}
                                    disabled={!customName}
                                >
                                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                </Button>
                            </div>
                        </div>

                        {/* Custom Logo */}
                        <div className="space-y-2">
                            <Label htmlFor="logo">Logo URL</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="logo"
                                    value={customLogo}
                                    onChange={(e) => setCustomLogo(e.target.value)}
                                    placeholder="https://..."
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    title="Reset Logo"
                                    onClick={() => setCustomLogo('')}
                                    disabled={!customLogo}
                                >
                                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                </Button>
                            </div>
                        </div>

                        {/* Custom Description */}
                        <div className="space-y-2">
                            <Label htmlFor="description">Description</Label>
                            <div className="flex gap-2">
                                <textarea
                                    id="description"
                                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    value={customDescription}
                                    onChange={(e) => setCustomDescription(e.target.value)}
                                    placeholder={addon.manifest.description}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    title="Reset Description"
                                    onClick={() => setCustomDescription('')}
                                    disabled={!customDescription}
                                    className="mt-1"
                                >
                                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                </Button>
                            </div>
                        </div>

                        {/* Error Message */}
                        {error && <p className="text-sm text-destructive font-medium">{error}</p>}
                    </div>

                    <div className="space-y-4">
                        {/* Preview Section */}
                        <div className="border rounded-md p-4 bg-muted/20 flex flex-col items-center justify-start gap-4 h-full min-h-[300px]">
                            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Dashboard Preview</span>

                            <div className="flex flex-col items-center gap-3 w-full">
                                <div className="bg-background p-2 rounded-xl shadow-sm border">
                                    <img
                                        key={customLogo || addon.manifest.logo}
                                        src={customLogo || addon.manifest.logo || "https://placehold.co/80x80?text=?"}
                                        className="w-20 h-20 object-contain rounded-lg"
                                        alt="Logo Preview"
                                        onError={(e) => e.currentTarget.style.display = 'none'}
                                    />
                                </div>
                                <span className="font-bold text-lg text-center truncate w-full px-2">
                                    {customName || addon.manifest.name}
                                </span>
                                <div className="w-full text-center px-4">
                                    <p className="text-xs text-muted-foreground line-clamp-4 leading-relaxed italic">
                                        {customDescription || addon.manifest.description}
                                    </p>
                                </div>
                                <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded-full mt-2">
                                    v{addon.manifest.version}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Info Footer */}
                <div className="bg-muted/50 -mx-6 -mb-6 px-6 py-4 mt-2 border-t text-xs text-muted-foreground grid grid-cols-2 gap-4">
                    <div>
                        <span className="font-semibold block mb-1">Developer Info</span>
                        <p className="truncate">ID: {addon.manifest.id}</p>
                        <p className="truncate">Name: {addon.manifest.name}</p>
                    </div>
                    <div>
                        <span className="font-semibold block mb-1">Technical Details</span>
                        <p className="truncate" title={addon.transportUrl}>URL: {addon.transportUrl}</p>
                        <p>Status: {addon.flags?.protected ? 'Protected' : 'Standard'}</p>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-0 mt-6 pt-2">
                    <Button type="button" variant="secondary" onClick={handleReset} className="mr-auto" disabled={saving}>
                        Reset to Default
                    </Button>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? 'Syncing...' : 'Save & Sync'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
