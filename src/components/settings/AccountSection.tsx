import { useRef } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Check, User, Clock, RefreshCw, Upload, Download } from 'lucide-react'
import { ImageUploadButton } from '@/components/ui/image-upload-button'
import { useSyncStore } from '@/store/syncStore'
import { useUIStore } from '@/store/uiStore'
import { getTimeAgo, maskedInitial } from '@/lib/utils'
import { CopyButton } from '@/components/ui/copy-button'
import { useNow } from '@/hooks/use-relative-time'
import { maskSyncId } from './settings-model'

export function AccountSection() {
    const auth = useSyncStore(s => s.auth)
    const privacyLevel = useUIStore(s => (s.isPrivacyModeEnabled ? s.privacyLevelNames : 0))
    const syncToRemote = useSyncStore(s => s.syncToRemote)
    const syncFromRemote = useSyncStore(s => s.syncFromRemote)
    const isSyncing = useSyncStore(s => s.isSyncing)
    const lastSyncedAt = useSyncStore(s => s.lastSyncedAt)
    const lastSyncCheckedAt = useSyncStore(s => s.lastSyncCheckedAt)
    useNow()
    // Same clock as the header chip: the newest of a confirmed check and a real push or pull.
    const latestSyncAt = [lastSyncCheckedAt, lastSyncedAt].filter(Boolean).map(t => new Date(t as string).getTime()).reduce((a, b) => Math.max(a, b), 0)
    const setDisplayName = useSyncStore(s => s.setDisplayName)
    const setAvatar = useSyncStore(s => s.setAvatar)
    const urlRef = useRef<HTMLInputElement>(null)

    if (!auth.isAuthenticated) {
        return (
            <section>
                <div data-theme-part="panel" className="rounded-[1.75rem] border border-dashed border-border/50 bg-card/60 p-8 text-center text-sm text-muted-foreground shadow-sm">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl border border-border/40 bg-muted/30">
                        <User className="h-4 w-4" />
                    </div>
                    Cloud Sync is not connected. Log in to manage your account.
                </div>
            </section>
        )
    }

    return (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div data-theme-part="panel" className="rounded-[1.75rem] border border-border/45 bg-card/80 p-5 lg:p-6 shadow-sm">
                <div className="mb-5 flex items-start justify-between gap-4">
                    <div>
                        <p className="text-xs font-semibold text-muted-foreground">Cloud account</p>
                        <h3 className="mt-1 text-xl font-semibold tracking-tight">Sync identity</h3>
                    </div>
                    <span data-theme-part="badge" className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">
                        <Check className="h-3.5 w-3.5" />
                        Authenticated
                    </span>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                        <Label className="text-xs font-semibold text-muted-foreground">Display name</Label>
                        <div className="flex items-center gap-3">
                            <div data-theme-part="avatar" className="h-16 w-16 shrink-0 overflow-hidden rounded-full border border-primary/25 bg-primary/10 flex items-center justify-center">
                                {auth.avatar ? (
                                    <img src={auth.avatar} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <span className="text-xl font-bold text-primary">{maskedInitial(auth.name || auth.id, privacyLevel)}</span>
                                )}
                            </div>
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <Input
                                    placeholder="Your Name"
                                    className="h-10 border-border/45 bg-background/60 focus:bg-background"
                                    value={auth.name}
                                    onChange={(e) => setDisplayName(e.target.value)}
                                />
                                <div className="flex gap-2">
                                    <Input
                                        ref={urlRef}
                                        value={auth.avatar?.startsWith('data:') ? '\u2713 Uploaded image' : (auth.avatar || '')}
                                        onChange={(e) => setAvatar(e.target.value || null)}
                                        placeholder="Avatar image URL (optional)..."
                                        className="h-8 text-xs"
                                        readOnly={auth.avatar?.startsWith('data:')}
                                    />
                                    <ImageUploadButton
                                        onUploaded={(dataUrl) => setAvatar(dataUrl)}
                                        options={{ maxDimension: 128, square: true, quality: 0.85 }}
                                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                                        label="Upload avatar"
                                    />
                                    {auth.avatar && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 shrink-0 text-xs text-muted-foreground hover:text-destructive"
                                            onClick={() => setAvatar(null)}
                                        >
                                            Remove
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-xs font-semibold text-muted-foreground">Sync ID</Label>
                        <div className="flex gap-2">
                            <div data-theme-part="field" className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-border/50 bg-background/60 px-3">
                                <span className="truncate font-mono text-xs text-muted-foreground select-none">{maskSyncId(auth.id)}</span>
                            </div>
                            <CopyButton value={auth.id} variant="outline" className="h-10 w-10" iconSize={16} aria-label="Copy sync ID" />
                        </div>
                    </div>
                </div>

                <p className="mt-3 text-xs leading-relaxed text-muted-foreground/70">
                    Avoid using AIOManager on two devices simultaneously with the same sync ID; both devices can compete to push state.
                </p>
            </div>

            <div data-theme-part="panel" className="rounded-[1.75rem] border border-primary/20 bg-primary/10 p-5 lg:p-6 shadow-sm">
                <div className="flex h-full flex-col justify-between gap-5">
                    <div>
                        <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-primary/25 bg-background/70 text-primary">
                            <Clock className="h-4 w-4" />
                        </div>
                        <p className="text-xs font-semibold text-muted-foreground">Last sync</p>
                        <p className="mt-1 text-2xl font-semibold tracking-tight">
                            {latestSyncAt ? getTimeAgo(new Date(latestSyncAt)) : 'Never'}
                        </p>
                        {lastSyncedAt && new Date(lastSyncedAt).getTime() < latestSyncAt && (
                            <p className="mt-1 text-xs text-muted-foreground">Last change {getTimeAgo(new Date(lastSyncedAt))}</p>
                        )}
                    </div>

                    <div className="grid gap-2">
                        <Button variant="default" className="gap-2" onClick={() => syncToRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                            Push to Cloud
                        </Button>
                        <Button variant="outline" className="gap-2" onClick={() => syncFromRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            Pull from Cloud
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    )
}
