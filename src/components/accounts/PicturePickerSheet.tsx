import { useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Link2, Upload } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountAvatar } from './AccountAvatar'
import { processImageFile } from '@/lib/image-upload'
import { toast } from '@/hooks/use-toast'
import type { PictureRow, PictureSpec } from '@/lib/connection-pictures/types'
import { isValidAvatarHttpsUrl } from '@/lib/connection-pictures/avatar-value'
import { cn } from '@/lib/utils'

interface PicturePickerSheetProps {
    row: PictureRow
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The account default picture (https URL or data URL), empty when the account has none. */
    accountPicture: string
    /** True when the account picture cannot reach this row (link-only platform, uploaded picture). */
    accountDefaultDisabled: boolean
    onPicked: (spec: PictureSpec) => void
    /** "Use account picture": opt the row back into following the account default. */
    onUseAccountDefault: () => void
}

type PickerTab = 'upload' | 'link'

/**
 * Per-row picture picker (owner spec 2026-11-05): Upload and Picture link
 * tabs; link-only targets (the AIOStreams and AIOMetadata logins) get only the
 * link tab with the public-link note. Uploads are resized to 256 px.
 */
export function PicturePickerSheet({ row, open, onOpenChange, accountPicture, accountDefaultDisabled, onPicked, onUseAccountDefault }: PicturePickerSheetProps) {
    const [tab, setTab] = useState<PickerTab>(row.linkOnly ? 'link' : 'upload')
    const [linkUrl, setLinkUrl] = useState('')
    const [processing, setProcessing] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (open) {
            setTab(row.linkOnly ? 'link' : 'upload')
            setLinkUrl('')
            setProcessing(false)
        }
    }, [open, row.linkOnly, row.id])

    const tabs = useMemo(() => {
        const list: Array<{ id: PickerTab; label: string }> = []
        if (!row.linkOnly) list.push({ id: 'upload', label: 'Upload' })
        list.push({ id: 'link', label: 'Picture link' })
        return list
    }, [row.linkOnly])

    const handleFile = async (file: File) => {
        setProcessing(true)
        try {
            const result = await processImageFile(file, { maxDimension: 256, square: true, quality: 0.85 })
            onPicked({ kind: 'dataUrl', dataUrl: result.dataUrl })
            onOpenChange(false)
        } catch (err) {
            toast({ variant: 'destructive', title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error.' })
        } finally {
            setProcessing(false)
        }
    }

    const confirmLink = () => {
        const value = linkUrl.trim()
        if (!isValidAvatarHttpsUrl(value)) {
            toast({ variant: 'destructive', title: 'Enter a public image link', description: 'Must start with https:// and point directly at an image.' })
            return
        }
        onPicked({ kind: 'url', url: value })
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{row.label} picture</DialogTitle>
                    <DialogDescription>
                        {row.linkOnly
                            ? 'This platform shows the picture from a link saved in its own settings, so it has to be a public image link.'
                            : 'This picture is saved when you press Sync pictures.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex gap-1 rounded-xl border border-border/40 bg-muted/40 p-1">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            aria-selected={tab === t.id}
                            role="tab"
                            onClick={() => setTab(t.id)}
                            className={cn(
                                'flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-colors',
                                tab === t.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {t.id === 'upload' && <Upload className="h-3.5 w-3.5" aria-hidden />}
                            {t.id === 'link' && <Link2 className="h-3.5 w-3.5" aria-hidden />}
                            {t.label}
                        </button>
                    ))}
                </div>

                {tab === 'upload' && !processing && (
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex w-full flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center transition-colors hover:bg-muted/40"
                    >
                        <ImagePlus className="h-7 w-7 text-muted-foreground" aria-hidden />
                        <span className="text-sm font-medium">Choose an image</span>
                        <span className="text-xs text-muted-foreground">Resized to 256 px and sent as the platform's profile picture.</span>
                    </button>
                )}
                {tab === 'upload' && processing && (
                    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                        Processing image...
                    </div>
                )}

                {tab === 'link' && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Input
                                type="url"
                                value={linkUrl}
                                onChange={(e) => setLinkUrl(e.target.value)}
                                placeholder="https://example.com/picture.png"
                                aria-label="Picture URL"
                                className="h-11 rounded-xl"
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            Paste a direct https image link. The platform stores the URL as you typed it.
                        </p>
                    </div>
                )}

                {accountPicture && (
                    <button
                        type="button"
                        onClick={() => {
                            onUseAccountDefault()
                            onOpenChange(false)
                        }}
                        disabled={accountDefaultDisabled}
                        className="flex w-full items-center gap-3 rounded-xl border border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 disabled:pointer-events-none disabled:opacity-50"
                    >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/50 bg-muted/40">
                            <AccountAvatar account={{ name: 'Account', avatar: accountPicture || undefined, status: 'active' }} size="sm" showStatus={false} />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">Use account picture</span>
                            <span className="block text-xs text-muted-foreground">
                                {accountDefaultDisabled ? 'Uploaded pictures need a public link for this platform.' : 'Follow the account default again.'}
                            </span>
                        </span>
                    </button>
                )}

                <div className="flex gap-2">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
                    {tab === 'link' && (
                        <Button type="button" className="flex-1" disabled={!linkUrl.trim()} onClick={confirmLink}>Use link</Button>
                    )}
                    {tab === 'upload' && (
                        <Button type="button" variant="ghost" className="flex-1" onClick={() => fileInputRef.current?.click()} disabled={processing}>
                            {processing ? 'Processing...' : 'Choose file'}
                        </Button>
                    )}
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleFile(file)
                        e.target.value = ''
                    }}
                    aria-hidden
                />
            </DialogContent>
        </Dialog>
    )
}
