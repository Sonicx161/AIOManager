import { memo, useCallback, useEffect, useState } from 'react'
import { MonitorSmartphone, RefreshCw, Laptop, Fingerprint, AlertCircle, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { toast } from '@/hooks/use-toast'
import {
    endLocalRememberedSession,
    getActiveDeviceId,
    hasRememberedDeviceRecord,
    listRememberedDevices,
    renameRememberedDevice,
    revokeRememberedDevice,
    revokeRememberedDevicesEverywhere,
    type RememberedDeviceRow,
} from '@/lib/device-session'

function formatDate(iso: string | null): string {
    if (!iso) return 'Not used yet'
    const time = Date.parse(iso)
    if (!Number.isFinite(time)) return 'Unknown'
    return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

interface DeviceRowProps {
    row: RememberedDeviceRow
    isThisDevice: boolean
    busy: boolean
    onRevoke: (row: RememberedDeviceRow) => void
    onRename: (row: RememberedDeviceRow) => void
}

const DeviceRow = memo(function DeviceRow({ row, isThisDevice, busy, onRevoke, onRename }: DeviceRowProps) {
    return (
        <div data-theme-part="panel" className="rounded-2xl border border-border/35 bg-background/35 p-2.5 sm:p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/30 bg-muted/20">
                    {row.tier === 'prf'
                        ? <Fingerprint className="h-3.5 w-3.5 text-muted-foreground" />
                        : <Laptop className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-bold">{row.label || 'Remembered device'}</span>
                <span data-theme-part="badge" className="rounded-full bg-muted/50 px-1.5 py-0.5 text-xs font-bold text-muted-foreground">
                    {row.tier === 'prf' ? 'Passkey' : 'Device key'}
                </span>
                {isThisDevice && (
                    <span data-theme-part="badge" className="rounded-full bg-primary/12 px-1.5 py-0.5 text-xs font-bold text-primary">
                        This device
                    </span>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    aria-label="Rename device"
                    onClick={() => onRename(row)}
                >
                    <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 gap-1.5 text-xs font-semibold text-destructive hover:text-destructive"
                    disabled={busy}
                    onClick={() => onRevoke(row)}
                >
                    Revoke
                </Button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground/80">
                <span>Signed in {formatDate(row.createdAt)}</span>
                <span>Last used {formatDate(row.lastUsedAt)}</span>
                <span>Expires {formatDate(row.expiresAt)}</span>
            </div>
        </div>
    )
})

export function RememberedDevicesSection() {
    const [rows, setRows] = useState<RememberedDeviceRow[] | null>(null)
    const [loadFailed, setLoadFailed] = useState(false)
    const [busy, setBusy] = useState(false)
    const [revokeTarget, setRevokeTarget] = useState<RememberedDeviceRow | null>(null)
    const [confirmEverywhere, setConfirmEverywhere] = useState(false)
    const [renameTarget, setRenameTarget] = useState<RememberedDeviceRow | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [renameBusy, setRenameBusy] = useState(false)

    const refresh = useCallback(async () => {
        const listed = await listRememberedDevices()
        if (listed === null) {
            setRows(null)
            setLoadFailed(true)
            return
        }
        setLoadFailed(false)
        setRows(listed.filter(row => !row.revoked))
    }, [])

    useEffect(() => {
        refresh().catch(() => setLoadFailed(true))
    }, [refresh])

    const handleRevoke = async () => {
        if (!revokeTarget) return
        setBusy(true)
        try {
            const ok = await revokeRememberedDevice(revokeTarget.deviceId)
            if (!ok) {
                toast({ variant: 'destructive', title: 'Revoke failed', description: 'The server did not revoke this device. Try again.' })
                return
            }
            if (revokeTarget.deviceId === getActiveDeviceId()) {
                await endLocalRememberedSession()
                return
            }
            toast({ title: 'Device revoked', description: 'Its saved sign-in no longer works.' })
            await refresh()
        } catch {
            toast({ variant: 'destructive', title: 'Revoke failed', description: 'Something went wrong reaching the server.' })
        } finally {
            setBusy(false)
            setRevokeTarget(null)
        }
    }

    const handleRename = async () => {
        if (!renameTarget) return
        const label = renameValue.trim()
        if (!label) return
        setRenameBusy(true)
        try {
            const ok = await renameRememberedDevice(renameTarget.deviceId, label)
            if (!ok) {
                toast({ variant: 'destructive', title: 'Rename failed', description: 'The server did not rename this device. Try again.' })
                return
            }
            toast({ title: 'Device renamed' })
            setRenameTarget(null)
            await refresh()
        } catch {
            toast({ variant: 'destructive', title: 'Rename failed', description: 'Something went wrong reaching the server.' })
        } finally {
            setRenameBusy(false)
        }
    }

    const handleRevokeEverywhere = async () => {
        setBusy(true)
        try {
            const ok = await revokeRememberedDevicesEverywhere()
            if (!ok) {
                toast({ variant: 'destructive', title: 'Sign out everywhere failed', description: 'The server could not revoke your devices. Try again.' })
                return
            }
            if (getActiveDeviceId() || (await hasRememberedDeviceRecord())) {
                await endLocalRememberedSession()
                return
            }
            toast({ title: 'Signed out everywhere', description: 'Every remembered device needs to sign in again.' })
            await refresh()
        } catch {
            toast({ variant: 'destructive', title: 'Sign out everywhere failed', description: 'Something went wrong reaching the server.' })
        } finally {
            setBusy(false)
            setConfirmEverywhere(false)
        }
    }

    const activeDeviceId = getActiveDeviceId()

    return (
        <section className="space-y-4">
            <div data-theme-part="panel" className="space-y-4 sm:space-y-5 rounded-[1.5rem] sm:rounded-[1.75rem] border border-border/45 bg-card/80 p-3 sm:p-4 md:p-5 lg:p-6 shadow-sm">
                <div className="flex items-start gap-3">
                    <div className="relative mt-0.5 flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                        <SquircleOverlay />
                        <MonitorSmartphone className="relative z-10 h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h3 className="text-sm sm:text-base font-semibold">Remembered devices</h3>
                        <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
                            Devices with a saved sign-in to this app. Revoking ends that saved sign-in.
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label="Refresh remembered devices"
                        disabled={busy}
                        onClick={() => refresh().catch(() => setLoadFailed(true))}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                    </Button>
                </div>

                <div className="space-y-3">
                    {rows === null && !loadFailed && (
                        <p data-theme-part="panel" className="rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground">
                            Loading remembered devices...
                        </p>
                    )}
                    {loadFailed && (
                        <div data-theme-part="panel" className="flex items-start gap-2 rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            <span>Could not load remembered devices.</span>
                            <button
                                type="button"
                                data-theme-part="button"
                                className="ml-auto shrink-0 text-primary hover:underline"
                                onClick={() => refresh().catch(() => setLoadFailed(true))}
                            >
                                Retry
                            </button>
                        </div>
                    )}
                    {rows !== null && rows.length === 0 && (
                        <div data-theme-part="panel" className="flex items-start gap-2 rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            <span>No remembered devices. Tick Remember this device at sign-in to skip the password next time.</span>
                        </div>
                    )}
                    {rows !== null && rows.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                            {rows.map(row => (
                                <DeviceRow
                                    key={row.deviceId}
                                    row={row}
                                    isThisDevice={row.deviceId === activeDeviceId}
                                    busy={busy}
                                    onRevoke={setRevokeTarget}
                                    onRename={(r) => { setRenameTarget(r); setRenameValue(r.label || '') }}
                                />
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-2 border-t border-border/35 pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground/70">
                        Sign out everywhere ends every saved sign-in, including devices you cannot reach.
                    </p>
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full shrink-0 gap-1.5 text-xs font-semibold text-destructive hover:text-destructive sm:w-auto"
                        disabled={busy || rows === null}
                        onClick={() => setConfirmEverywhere(true)}
                    >
                        Sign out everywhere
                    </Button>
                </div>
            </div>

            <ConfirmationDialog
                open={!!revokeTarget}
                onOpenChange={(open) => { if (!open) setRevokeTarget(null) }}
                title="Revoke this device?"
                description={revokeTarget
                    ? `${revokeTarget.label || 'This device'} will lose its saved sign-in and needs your UUID and password next time.`
                    : ''}
                confirmText="Revoke"
                isDestructive
                onConfirm={handleRevoke}
            />

            <ConfirmationDialog
                open={confirmEverywhere}
                onOpenChange={setConfirmEverywhere}
                title="Sign out everywhere?"
                description="Every remembered device loses its saved sign-in and must sign in again with UUID and password."
                confirmText="Sign out everywhere"
                isDestructive
                onConfirm={handleRevokeEverywhere}
            />

            <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open && !renameBusy) setRenameTarget(null) }}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Rename device</DialogTitle>
                        <DialogDescription>
                            This name shows here and on the sign-in screen of that device.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={100}
                        placeholder="Chrome on Windows"
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter' && renameValue.trim() && !renameBusy) { e.preventDefault(); void handleRename() } }}
                    />
                    <DialogFooter>
                        <Button variant="subtle" size="sm" onClick={() => setRenameTarget(null)} disabled={renameBusy}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={() => void handleRename()} disabled={renameBusy || !renameValue.trim()}>
                            {renameBusy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
                            Rename
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    )
}
