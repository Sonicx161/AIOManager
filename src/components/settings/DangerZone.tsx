import { triggerSync } from '@/lib/sync-trigger'
import { apiFetch } from '@/lib/http-client'
import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { AlertTriangle, ChevronRight, ShieldAlert, type LucideIcon } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import localforage from 'localforage'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useSyncStore } from '@/store/syncStore'
import { useVaultStore } from '@/store/vaultStore'
import { useNotesStore } from '@/store/notesStore'
import { useTheme } from '@/contexts/ThemeContext'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type DangerAction = {
    title: string
    description: string
    confirmText: string
    action: () => Promise<void>
}

interface DangerRowProps {
    title: string
    description: string
    count?: number
    icon?: LucideIcon
    disabled: boolean
    onClick: () => void
}

function DangerRow({ title, description, count, icon: Icon, disabled, onClick }: DangerRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="flex min-h-[56px] w-full items-center gap-3 py-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 enabled:hover:bg-destructive/5"
        >
            {Icon && (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10">
                    <Icon className="h-4 w-4 text-destructive" />
                </span>
            )}
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-destructive">{title}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
            </span>
            {count !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{count}</span>}
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
        </button>
    )
}

export function DangerZone() {
    const accounts = useAccountStore(s => s.accounts)
    const wipeAccounts = useAccountStore(s => s.wipeAccounts)
    const library = useAddonStore(s => s.library)
    const resetAddons = useAddonStore(s => s.reset)
    const auth = useSyncStore(s => s.auth)
    const deleteRemoteAccount = useSyncStore(s => s.deleteRemoteAccount)
    const { setTheme } = useTheme()

    const savedAddonsCount = Object.keys(library).length
    const failoverRulesCount = useFailoverStore((s) => s.rules.length)
    const vaultKeysCount = useVaultStore((s) => s.keys.length)
    const clearVault = useVaultStore((s) => s.clearVault)
    const notesCount = useNotesStore((s) => s.notes.length)
    const trashCount = useNotesStore((s) => s.trash.length)
    const trashAllNotes = useNotesStore((s) => s.trashAllNotes)
    const emptyTrash = useNotesStore((s) => s.emptyTrash)

    const notesTotalCount = notesCount + trashCount

    const [unsafeMode, setUnsafeMode] = useState(false)
    const [pendingAction, setPendingAction] = useState<DangerAction | null>(null)
    const [isRunning, setIsRunning] = useState(false)
    const [resetRemoteFailed, setResetRemoteFailed] = useState(false)

    const executeDeleteAllAccounts = async () => {
        const { auth: syncAuth, serverUrl } = useSyncStore.getState()
        const failedServerCleanups: string[] = []
        if (syncAuth.isAuthenticated) {
            for (const account of accounts) {
                try {
                    const baseUrl = serverUrl || ''
                    const res = await apiFetch(`/accounts/${encodeURIComponent(account.id)}/server-state`, {
                        method: 'DELETE',
                        baseUrl: baseUrl.startsWith('http') ? baseUrl : undefined,
                    })
                    if (!res.ok) failedServerCleanups.push(account.id)
                } catch {
                    failedServerCleanups.push(account.id)
                }
            }
        }
        if (failedServerCleanups.length > 0) {
            const { queuePendingAccountServerCleanup } = await import('@/lib/account-server-cleanup')
            for (const id of failedServerCleanups) await queuePendingAccountServerCleanup(id)
        }
        const wipedAccountIds = new Set(accounts.map(a => a.id))
        useFailoverStore.setState(s => ({ rules: s.rules.filter(r => !wipedAccountIds.has(r.accountId)) }))
        await wipeAccounts()
        if (failedServerCleanups.length > 0) {
            toast({
                variant: 'destructive',
                title: 'Accounts deleted, server cleanup pending',
                description: `${failedServerCleanups.length} wiped account${failedServerCleanups.length !== 1 ? 's' : ''} still ha${failedServerCleanups.length === 1 ? 's' : 've'} Autopilot rules or sign-ins on the server. They are removed on the next sync.`,
            })
        } else {
            toast({ title: 'Accounts Deleted', description: 'All accounts have been removed.' })
        }
    }

    const executeDeleteAllAddons = async () => {
        await resetAddons()
        toast({ title: 'Saved Addons Deleted', description: 'All saved addons have been removed.' })
    }

    const executeWipeVault = async () => {
        await clearVault()
        toast({ title: 'Vault Wiped', description: 'All vault entries have been removed.' })
    }

    const executeWipeNotes = async () => {
        await trashAllNotes()
        await emptyTrash()
        toast({ title: 'Notes Wiped', description: 'All notes have been removed.' })
    }

    const executePurgeAutopilot = async () => {
        try {
            const failoverState = useFailoverStore.getState()
            const accountIds = [...new Set(failoverState.rules.map(r => r.accountId))]
            for (const accountId of accountIds) {
                try {
                    const { useSyncStore } = await import('@/store/syncStore')
                    const { auth: syncAuth, serverUrl } = useSyncStore.getState()
                    if (syncAuth.isAuthenticated) {
                        const baseUrl = serverUrl || ''
                        await apiFetch(`/autopilot/account/${accountId}`, {
                            method: 'DELETE',
                            baseUrl: baseUrl.startsWith('http') ? baseUrl : undefined,
                        })
                    }
                } catch (e) {
                    if (import.meta.env.DEV) console.warn(`[Settings] Failed to purge server rules for ${accountId}:`, e)
                }
            }
            useFailoverStore.setState({ rules: [] })
            const localforageModule = await import('localforage')
            await localforageModule.default.setItem('aioman:failover-rules', [])
            triggerSync()
            toast({ title: 'Autopilot Purged', description: 'All rules have been deleted from local and server.' })
        } catch (e) {
            if (import.meta.env.DEV) console.error('Purge failed:', e)
            toast({ variant: 'destructive', title: 'Purge Failed', description: 'Could not purge all autopilot rules.' })
        }
    }

    const wipeLocalData = async () => {
        await localforage.clear()
        localStorage.clear()
        setTheme('dark')
        toast({ title: 'Reset Complete', description: 'Application has been reset.' })
        setTimeout(() => { window.location.href = '/' }, 500)
    }

    const executeResetAll = async () => {
        try {
            if (auth.isAuthenticated) {
                try {
                    await deleteRemoteAccount()
                    toast({ title: 'Cloud Data Deleted', description: 'Sync account removed from server.' })
                } catch (e) {
                    if (import.meta.env.DEV) console.error('Remote delete failed', e)
                    setResetRemoteFailed(true)
                    return
                }
            }
            await wipeLocalData()
        } catch (e) {
            if (import.meta.env.DEV) console.error('Reset failed', e)
            toast({ variant: "destructive", title: "Reset Failed", description: "Could not clear database." })
        }
    }

    const handleRetryResetAll = () => {
        setResetRemoteFailed(false)
        void executeResetAll()
    }

    const handleWipeLocalOnly = () => {
        setResetRemoteFailed(false)
        void wipeLocalData()
    }

    const requestDangerAction = (action: DangerAction) => {
        if (!unsafeMode) {
            toast({ variant: 'destructive', title: 'Enable Unsafe Mode', description: 'You must enable Unsafe Mode first.' })
            return
        }
        setPendingAction(action)
    }

    const confirmDangerAction = async () => {
        if (!pendingAction) return
        setIsRunning(true)
        try {
            await pendingAction.action()
            setPendingAction(null)
            setUnsafeMode(false)
        } finally {
            setIsRunning(false)
        }
    }

    return (
        <>
            <div className="space-y-3 sm:space-y-4">
                <div data-theme-part="panel" data-theme-tone="status" className="rounded-[1.75rem] border border-destructive/30 bg-destructive/10 p-1">
                    <div className="flex items-center gap-3 rounded-[1.55rem] bg-card/90 px-4 py-3.5">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-destructive">Unlock actions</p>
                            <p className="text-xs text-muted-foreground">Wipe buttons stay disabled until this is on</p>
                        </div>
                        <Switch
                            id="unsafe-mode"
                            checked={unsafeMode}
                            onCheckedChange={setUnsafeMode}
                            className="shrink-0 data-[state=checked]:bg-destructive"
                        />
                    </div>
                </div>

                <div data-theme-part="panel" data-theme-tone="status" className="rounded-[1.75rem] border border-destructive/30 bg-destructive/10 p-1">
                    <div className="divide-y divide-border/25 rounded-[1.55rem] bg-card/90 px-4">
                        <DangerRow
                            title="Wipe accounts"
                            description={`Removes ${accounts.length} local account${accounts.length !== 1 ? 's' : ''}, their installed addon state and autopilot rules`}
                            count={accounts.length}
                            disabled={accounts.length === 0 || !unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Wipe all accounts?',
                                description: `This permanently removes ${accounts.length} local account${accounts.length !== 1 ? 's' : ''}, their installed addon state and their Autopilot rules from AIOManager. It does not delete the connected accounts themselves.`,
                                confirmText: 'Wipe Accounts',
                                action: executeDeleteAllAccounts,
                            })}
                        />
                        <DangerRow
                            title="Wipe library"
                            description="Removes every saved addon, tag and profile on this device"
                            count={savedAddonsCount}
                            disabled={savedAddonsCount === 0 || !unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Wipe saved addon library?',
                                description: `This permanently removes ${savedAddonsCount} saved addon${savedAddonsCount !== 1 ? 's' : ''}, tags, and reusable library entries from this device.`,
                                confirmText: 'Wipe Library',
                                action: executeDeleteAllAddons,
                            })}
                        />
                        <DangerRow
                            title="Purge autopilot"
                            description="Deletes all failover rules locally and on the server"
                            count={failoverRulesCount}
                            disabled={failoverRulesCount === 0 || !unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Purge all Autopilot rules?',
                                description: `This deletes ${failoverRulesCount} local/server Autopilot rule${failoverRulesCount !== 1 ? 's' : ''} and disables failover automation until rules are recreated.`,
                                confirmText: 'Purge Autopilot',
                                action: executePurgeAutopilot,
                            })}
                        />
                        <DangerRow
                            title="Wipe vault"
                            description="Removes debrid credentials and syncs the erasure across devices"
                            count={vaultKeysCount}
                            disabled={vaultKeysCount === 0 || !unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Wipe all vault entries?',
                                description: `This permanently removes all ${vaultKeysCount} vault entr${vaultKeysCount === 1 ? 'y' : 'ies'} from this device and syncs the erasure across devices.`,
                                confirmText: 'Wipe Vault',
                                action: executeWipeVault,
                            })}
                        />
                        <DangerRow
                            title="Wipe notes"
                            description="Removes all notes, including anything in deleted"
                            count={notesTotalCount}
                            disabled={notesTotalCount === 0 || !unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Wipe all notes?',
                                description: `This permanently removes all ${notesTotalCount} note${notesTotalCount !== 1 ? 's' : ''}, including anything in Deleted.`,
                                confirmText: 'Wipe Notes',
                                action: executeWipeNotes,
                            })}
                        />
                    </div>
                </div>

                <div data-theme-part="panel" data-theme-tone="status" className="rounded-[1.75rem] border border-destructive/30 bg-destructive/10 p-1">
                    <div className="rounded-[1.55rem] bg-card/90 px-4">
                        <DangerRow
                            icon={ShieldAlert}
                            title="Delete all AIOManager data"
                            description="Clears this device and removes the sync account from the server, then reloads the app"
                            disabled={!unsafeMode || isRunning}
                            onClick={() => requestDangerAction({
                                title: 'Delete all AIOManager data?',
                                description: 'This clears local storage, IndexedDB, accounts, saved addons, vault keys, settings, and attempts to remove the sync account from the server before reloading the app.',
                                confirmText: 'Delete All Data',
                                action: executeResetAll,
                            })}
                        />
                    </div>
                </div>

                <p className="px-1 text-xs leading-relaxed text-muted-foreground">
                    Two steps, always: turn on unlock actions, then confirm in a dialog that names exactly what is deleted. Wiping here never deletes the connected accounts themselves.
                </p>
            </div>
            <ConfirmationDialog
                open={!!pendingAction}
                onOpenChange={(open) => {
                    if (!open && !isRunning) setPendingAction(null)
                }}
                title={pendingAction?.title || 'Confirm destructive action'}
                description={pendingAction?.description || ''}
                confirmText={pendingAction?.confirmText || 'Confirm'}
                cancelText="Keep Data"
                isDestructive
                isLoading={isRunning}
                onConfirm={confirmDangerAction}
            />
            <Dialog open={resetRemoteFailed} onOpenChange={(open) => { if (!open) setResetRemoteFailed(false) }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-warning" />
                            Cloud delete failed
                        </DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-foreground/70 leading-relaxed">
                        The sync account could not be deleted from the server. Your cloud data and Autopilot rules stay on the server.
                    </p>
                    <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2 [&_button]:rounded-full [&_button]:px-4">
                        <Button variant="ghost" onClick={() => setResetRemoteFailed(false)}>Not now</Button>
                        <Button variant="outline" onClick={handleWipeLocalOnly}>Wipe this device only</Button>
                        <Button onClick={handleRetryResetAll}>Retry</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
