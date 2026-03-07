import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ShieldAlert, Trash2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import localforage from 'localforage'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useFailoverStore } from '@/store/failoverStore'
import { useSyncStore } from '@/store/syncStore'
import { useTheme } from '@/contexts/ThemeContext'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export function DangerZone() {
    const { accounts, reset: resetAccounts } = useAccountStore()
    const { library, reset: resetAddons } = useAddonStore()
    const { auth, deleteRemoteAccount } = useSyncStore()
    const { setTheme } = useTheme()

    const savedAddonsCount = Object.keys(library).length
    const failoverRulesCount = useFailoverStore((s) => s.rules.length)

    const [unsafeMode, setUnsafeMode] = useState(false)
    const [confirmDialog, setConfirmDialog] = useState<{
        open: boolean
        title: string
        description: string
        action: () => Promise<void>
        destructive?: boolean
    }>({ open: false, title: '', description: '', action: async () => { } })

    const handleDeleteAllAccounts = () => {
        if (!unsafeMode) {
            toast({ variant: 'destructive', title: 'Enable Unsafe Mode', description: 'You must enable Unsafe Mode to delete all accounts.' })
            return
        }
        setConfirmDialog({
            open: true,
            title: 'Delete All Accounts',
            description: `This will permanently delete all ${accounts.length} account(s). This cannot be undone.`,
            destructive: true,
            action: async () => {
                await resetAccounts()
                toast({ title: 'Accounts Deleted', description: 'All accounts have been removed.' })
            },
        })
    }

    const handleDeleteAllAddons = () => {
        if (!unsafeMode) {
            toast({ variant: 'destructive', title: 'Enable Unsafe Mode', description: 'You must enable Unsafe Mode to delete all saved addons.' })
            return
        }
        setConfirmDialog({
            open: true,
            title: 'Delete All Saved Addons',
            description: `This will permanently delete all ${savedAddonsCount} saved addon(s). This cannot be undone.`,
            destructive: true,
            action: async () => {
                await resetAddons()
                toast({ title: 'Saved Addons Deleted', description: 'All saved addons have been removed.' })
            },
        })
    }

    const handlePurgeAutopilot = () => {
        if (!unsafeMode) {
            toast({ variant: 'destructive', title: 'Enable Unsafe Mode', description: 'You must enable Unsafe Mode to purge autopilot rules.' })
            return
        }
        setConfirmDialog({
            open: true,
            title: 'Purge All Autopilot Rules',
            description: `This will delete all ${failoverRulesCount} autopilot rule(s) from both local storage and the server. The Autopilot worker will stop processing these rules immediately. This cannot be undone.`,
            destructive: true,
            action: async () => {
                try {
                    const failoverState = useFailoverStore.getState()

                    // Delete from server (bulk endpoint per account)
                    const accountIds = [...new Set(failoverState.rules.map(r => r.accountId))]
                    for (const accountId of accountIds) {
                        try {
                            const { useSyncStore } = await import('@/store/syncStore')
                            const { auth: syncAuth, serverUrl } = useSyncStore.getState()
                            if (syncAuth.isAuthenticated) {
                                const baseUrl = serverUrl || ''
                                const apiPath = baseUrl.startsWith('http') ? `${baseUrl.replace(/\/$/, '')}/api` : '/api'
                                const axios = (await import('axios')).default
                                await axios.delete(`${apiPath}/autopilot/account/${accountId}`)
                            }
                        } catch (e) {
                            console.warn(`[Settings] Failed to purge server rules for ${accountId}:`, e)
                        }
                    }

                    // Clear local state
                    useFailoverStore.setState({ rules: [] })
                    const localforageModule = await import('localforage')
                    await localforageModule.default.setItem('stremio-manager:failover-rules', [])

                    const { useSyncStore } = await import('@/store/syncStore')
                    useSyncStore.getState().syncToRemote(true).catch(console.error)

                    toast({ title: 'Autopilot Purged', description: 'All rules have been deleted from local and server.' })
                } catch (e) {
                    console.error('Purge failed:', e)
                    toast({ variant: 'destructive', title: 'Purge Failed', description: 'Could not purge all autopilot rules.' })
                }
            },
        })
    }

    const handleResetAll = () => {
        if (!unsafeMode) {
            toast({ variant: 'destructive', title: 'Enable Unsafe Mode', description: 'You must enable Unsafe Mode to reset everything.' })
            return
        }
        setConfirmDialog({
            open: true,
            title: 'Delete Account Data?',
            description: 'Are you sure? This will permanently DELETE your cloud sync account (if logged in) and all local data. This cannot be undone.',
            destructive: true,
            action: async () => {
                // Hard Reset: Nuke everything
                try {
                    // 1. Delete Remote Account first (if logged in)
                    if (auth.isAuthenticated) {
                        try {
                            await deleteRemoteAccount()
                            toast({ title: 'Cloud Data Deleted', description: 'Your sync account has been removed from the server.' })
                        } catch (e) {
                            console.error('Remote delete failed', e)
                            toast({ variant: 'destructive', title: 'Remote Delete Failed', description: 'Could not delete cloud account, but proceeding with local wipe.' })
                        }
                    }

                    // 2. Wipe Local Data
                    await localforage.clear()
                    localStorage.clear()

                    // Set default theme for next load
                    setTheme('midnight')

                    toast({ title: 'Reset Complete', description: 'Application has been reset.' })

                    // Force reload to clear all in-memory state
                    setTimeout(() => {
                        window.location.href = '/'
                    }, 500)
                } catch (e) {
                    console.error('Reset failed', e)
                    toast({ variant: "destructive", title: "Reset Failed", description: "Could not clear database." })
                }
            },
        })
    }

    return (
        <div className="p-1 rounded-xl bg-destructive/10 border border-destructive/30 overflow-hidden">
            <div className="p-5 bg-card rounded-lg space-y-6">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-destructive/10">
                            <ShieldAlert className="h-5 w-5 text-destructive" />
                        </div>
                        <div>
                            <h3 className="font-bold text-destructive uppercase tracking-widest text-xs">Irreversible Actions</h3>
                            <p className="text-sm text-muted-foreground">Actions below will permanently delete data.</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Label htmlFor="unsafe-mode" className="text-xs font-bold text-destructive/70 uppercase">Unlock Actions</Label>
                        <Switch
                            id="unsafe-mode"
                            checked={unsafeMode}
                            onCheckedChange={setUnsafeMode}
                            className="data-[state=checked]:bg-destructive"
                        />
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 border-destructive/50 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                        onClick={handleDeleteAllAccounts}
                        disabled={accounts.length === 0 || !unsafeMode}
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Wipe Accounts ({accounts.length})
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 border-destructive/50 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                        onClick={handleDeleteAllAddons}
                        disabled={savedAddonsCount === 0 || !unsafeMode}
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Wipe Library ({savedAddonsCount})
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10 border-destructive/50 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                        onClick={handlePurgeAutopilot}
                        disabled={failoverRulesCount === 0 || !unsafeMode}
                    >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Purge Autopilot ({failoverRulesCount})
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        className="h-10 font-bold shadow-lg shadow-destructive/20"
                        onClick={handleResetAll}
                        disabled={!unsafeMode}
                    >
                        <ShieldAlert className="mr-2 h-4 w-4" />
                        Factory Reset
                    </Button>
                </div>
            </div>

            {/* Confirmation Dialog */}
            <AlertDialog open={confirmDialog.open} onOpenChange={(open: boolean) => setConfirmDialog(prev => ({ ...prev, open }))}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
                        <AlertDialogDescription>{confirmDialog.description}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className={confirmDialog.destructive ? 'bg-destructive hover:bg-destructive/90' : ''}
                            onClick={async () => {
                                await confirmDialog.action()
                                setConfirmDialog(prev => ({ ...prev, open: false }))
                                setUnsafeMode(false) // Reset unsafe mode after action completes
                            }}
                        >
                            Confirm
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}
