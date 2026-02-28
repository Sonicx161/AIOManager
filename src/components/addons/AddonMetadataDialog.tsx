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
    accountId: string
    onSave: (metadata: { customName?: string; customLogo?: string; customDescription?: string }) => Promise<void>
    onReplaceUrl?: (newUrl: string) => Promise<void>
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
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const [newUrl, setNewUrl] = useState('')
    const [replacingUrl, setReplacingUrl] = useState(false)


    // Initialize form with existing metadata
    useEffect(() => {
        if (open) {
            setCustomName(addon.metadata?.customName || '')
            setCustomLogo(addon.metadata?.customLogo || '')
            setCustomDescription(addon.metadata?.customDescription || '')
            setNewUrl(addon.transportUrl)



            setShowAdvanced(false)
            setError(null)
        }
    }, [open, addon, accountId])

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
            console.error(err)
            setError('Failed to reset defaults.')
        } finally {
            setSaving(false)
        }
    }

    const handleReplaceUrl = async () => {
        if (!onReplaceUrl || !newUrl.trim() || newUrl === addon.transportUrl) return
        setReplacingUrl(true)
        setError(null)
        try {
            await onReplaceUrl(newUrl.trim())
            // Success toast is handled by parent, we just clear error
            setError(null)
        } catch (err: any) {
            setError(err.message || 'Failed to replace URL.')
        } finally {
            setReplacingUrl(false)
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
                                    className="mt-1 shrink-0"
                                >
                                    <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                </Button>
                            </div>
                        </div>



                        {/* Error Message */}
                        {error && <p className="text-sm text-destructive font-medium">{error}</p>}
                    </div>

                    <div className="space-y-4 pt-4 md:pt-0">
                        {/* Preview Section */}
                        <div className="border rounded-md p-4 bg-muted/20 flex flex-col items-center justify-start gap-4 h-full min-h-[250px] overflow-hidden">
                            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Dashboard Preview</span>

                            <div className="flex flex-col items-center gap-3 w-full">
                                <div className="bg-background p-2 rounded-xl shadow-sm border shrink-0">
                                    <img
                                        key={customLogo || addon.manifest.logo}
                                        src={customLogo || addon.manifest.logo || "https://placehold.co/80x80?text=?"}
                                        className="w-16 h-16 sm:w-20 sm:h-20 object-contain rounded-lg"
                                        alt="Logo Preview"
                                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                                    />
                                </div>
                                <span className="font-bold text-base sm:text-lg text-center break-words w-full px-2 line-clamp-2">
                                    {customName || addon.manifest.name}
                                </span>
                                <div className="w-full text-center px-2 sm:px-4">
                                    <p className="text-xs text-muted-foreground line-clamp-4 sm:line-clamp-6 leading-relaxed italic break-words">
                                        {customDescription || addon.manifest.description}
                                    </p>
                                </div>
                                <span className="text-[10px] sm:text-xs text-muted-foreground px-2 py-1 bg-muted rounded-full mt-2 shrink-0">
                                    v{addon.manifest.version}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Info Footer */}
                <div className="bg-muted/50 -mx-6 px-6 py-4 mt-2 border-t text-xs text-muted-foreground grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <span className="font-semibold block mb-1">Developer Info</span>
                        <p className="break-all line-clamp-2">ID: {addon.manifest.id}</p>
                        <p className="break-words line-clamp-2">Name: {addon.manifest.name}</p>
                    </div>
                    <div>
                        <span className="font-semibold block mb-1">Technical Details</span>
                        <p className="break-all line-clamp-2" title={addon.transportUrl}>URL: {addon.transportUrl}</p>
                        <p>Status: {addon.flags?.protected ? 'Protected' : 'Standard'}</p>
                    </div>
                </div>

                {onReplaceUrl && (
                    <div className="bg-muted/30 -mx-6 px-6 py-4 bg-destructive/5 border-t border-b">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-[10px] uppercase font-bold tracking-widest opacity-50 hover:opacity-100 p-0 h-auto"
                            onClick={() => setShowAdvanced(!showAdvanced)}
                        >
                            {showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
                        </Button>

                        {showAdvanced && (
                            <div className="mt-4 p-4 border rounded-md bg-destructive/5 border-destructive/20 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                                <div className="space-y-1">
                                    <h4 className="text-sm font-semibold text-destructive uppercase tracking-tight">Replace Transport URL</h4>
                                    <p className="text-xs text-muted-foreground">
                                        Swap the underlying manifest URL. This will also update any Autopilot rules using this addon.
                                    </p>
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2">
                                    <Input
                                        value={newUrl}
                                        onChange={(e) => setNewUrl(e.target.value)}
                                        placeholder="https://..."
                                        className="text-xs bg-background flex-1 min-w-0"
                                    />
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        onClick={handleReplaceUrl}
                                        disabled={replacingUrl || !newUrl.trim() || newUrl === addon.transportUrl}
                                        className="shrink-0"
                                    >
                                        {replacingUrl ? 'Updating...' : 'Replace'}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <DialogFooter className="gap-2 sm:gap-0 mt-4 pb-4 flex-col-reverse sm:flex-row">
                    <Button type="button" variant="secondary" onClick={handleReset} className="w-full sm:w-auto sm:mr-auto" disabled={saving}>
                        Reset Details
                    </Button>
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="w-full sm:w-auto">
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
                            {saving ? 'Syncing...' : 'Save & Sync'}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
