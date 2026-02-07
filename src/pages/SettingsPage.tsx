import { useState, useRef } from 'react'
import { useTheme, THEME_OPTIONS, ThemeOption, Theme } from '@/contexts/ThemeContext'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useActivityStore } from '@/store/activityStore'
import { useUIStore } from '@/store/uiStore'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { toast } from '@/hooks/use-toast'
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
import { Trash2, Download, Upload, EyeOff, Check, ShieldAlert, Copy, RefreshCw, Cloud, User } from 'lucide-react'
import localforage from 'localforage'
import { useSyncStore } from '@/store/syncStore'

function AccountSection() {
    const { auth, syncToRemote, syncFromRemote, isSyncing, lastSyncedAt, setDisplayName } = useSyncStore()

    const [copied, setCopied] = useState(false)

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(auth.id)
            setCopied(true)
            toast({ title: "Copied UUID", description: "Account UUID copied to clipboard." })
            setTimeout(() => setCopied(false), 2000)
        } catch (err) {
            console.error('Failed to copy ID:', err)
            toast({ variant: "destructive", title: "Copy Failed", description: "Could not copy ID to clipboard." })
        }
    }

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-xl font-semibold flex items-center gap-2">
                    <Cloud className="h-5 w-5 text-primary" />
                    Account & Sync
                </h2>
                <p className="text-sm text-muted-foreground">Manage your identity and cloud data.</p>
            </div>

            <div className="p-4 rounded-lg border bg-card space-y-6">
                {/* Display Name */}
                <div className="space-y-2">
                    <Label>Display Name</Label>
                    <div className="relative">
                        <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Your Name"
                            className="pl-9"
                            value={auth.name}
                            onChange={(e) => setDisplayName(e.target.value)}
                        />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Used to identify this account in the header.
                    </p>
                </div>

                {/* ID Display */}
                <div className="space-y-2">
                    <Label>Your UUID</Label>
                    <div className="flex gap-2">
                        <Input value={auth.id} readOnly className="font-mono bg-muted text-sm" />
                        <Button variant="outline" size="icon" onClick={copyId} title="Copy UUID">
                            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Use this UUID (and your password) to log in on other devices.
                    </p>
                </div>

                {/* Sync Status */}
                <div className="flex items-center justify-between text-sm bg-muted/30 p-3 rounded-lg border">
                    <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-green-500" />
                        <span className="font-medium">Authenticated</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-xs text-muted-foreground">Last Sync:</span>
                        <span className="font-mono text-xs">
                            {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : 'Never'}
                        </span>
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="space-y-3">
                <div className="p-3 rounded-lg border bg-blue-500/10 border-blue-500/20">
                    <p className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                        Cloud Sync is active. Every change you make is instantly saved to the server.
                    </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Button variant="default" onClick={() => syncToRemote()} disabled={isSyncing}>
                        {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                        Push to Cloud
                    </Button>
                    <Button variant="outline" onClick={() => syncFromRemote()} disabled={isSyncing}>
                        {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                        Pull from Cloud
                    </Button>
                </div>

            </div>
        </section>
    )
}

// Theme preview card component
function ThemeCard({ option, selected, onSelect }: { option: ThemeOption; selected: boolean; onSelect: (id: Theme) => void }) {
    const { preview } = option
    return (
        <button
            onClick={() => onSelect(option.id)}
            className={`relative w-full rounded-xl border-2 transition-all text-left shadow-sm focus:outline-none hover:scale-[1.02] ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
                }`}
            style={{
                borderColor: preview.textMuted + '40',
                background: preview.background,
                color: preview.text,
            }}
        >
            <div className="p-3">
                {/* Mini preview */}
                <div
                    className="w-full h-16 rounded-lg mb-3 overflow-hidden"
                    style={{ background: preview.surface, border: `1px solid ${preview.textMuted}30` }}
                >
                    <div className="p-2 space-y-1.5">
                        <div
                            className="h-2 rounded-full w-1/2"
                            style={{ background: preview.accent }}
                        />
                        <div className="flex gap-2">
                            <div
                                className="w-6 h-6 rounded-full flex-shrink-0"
                                style={{ background: preview.accent + '80' }}
                            />
                            <div className="flex-1 space-y-1">
                                <div
                                    className="h-1.5 rounded-full w-3/4"
                                    style={{ background: preview.text, opacity: 0.7 }}
                                />
                                <div
                                    className="h-1.5 rounded-full w-1/2"
                                    style={{ background: preview.textMuted, opacity: 0.5 }}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Label */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">{option.emoji}</span>
                        <span className="font-semibold text-sm" style={{ color: preview.text }}>
                            {option.label}
                        </span>
                    </div>
                    {selected && (
                        <div
                            className="w-5 h-5 rounded-full flex items-center justify-center"
                            style={{ background: preview.accent }}
                        >
                            <Check className="w-3 h-3 text-white" />
                        </div>
                    )}
                </div>
                <p className={`text-xs mt-1 ${option.id === 'sonic' ? 'italic' : ''}`} style={{ color: preview.textMuted }}>
                    {option.description}
                </p>
            </div>
        </button>
    )
}

export function SettingsPage() {
    const { theme, setTheme } = useTheme()
    const { accounts, reset: resetAccounts, exportAccounts, importAccounts } = useAccountStore()
    const { library, reset: resetAddons, initialize: initializeAddonStore } = useAddonStore()
    const { clearHistory } = useActivityStore()
    const { isPrivacyModeEnabled, togglePrivacyMode } = useUIStore()
    const { auth, deleteRemoteAccount } = useSyncStore()

    const [unsafeMode, setUnsafeMode] = useState(false)
    const [confirmDialog, setConfirmDialog] = useState<{
        open: boolean
        title: string
        description: string
        action: () => Promise<void>
        destructive?: boolean
    }>({ open: false, title: '', description: '', action: async () => { } })

    const [exporting, setExporting] = useState(false)
    const [importing, setImporting] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)

    const savedAddonsCount = Object.keys(library).length

    // Export all data (uses same logic as ExportDialog)
    const handleExport = async () => {
        setExporting(true)
        try {
            const json = await exportAccounts(true)

            const blob = new Blob([json], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const now = new Date()
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`

            const a = document.createElement('a')
            a.href = url
            a.download = `AIOManager-Backup-${timestamp}.json`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)

            toast({ title: 'Export Complete', description: 'Your data has been downloaded.' })
        } catch (error) {
            console.error('Export failed:', error)
            toast({ variant: 'destructive', title: 'Export Failed', description: 'Could not export data.' })
        } finally {
            setExporting(false)
        }
    }

    // Import data (uses same logic as ImportDialog)
    const handleImportClick = () => {
        fileInputRef.current?.click()
    }

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
            toast({ variant: 'destructive', title: 'Invalid File', description: 'Please select a valid JSON file.' })
            return
        }

        setImporting(true)
        try {
            const text = await file.text()
            await importAccounts(text)
            // Refresh the addon store to pick up any imported saved addons
            await initializeAddonStore()
            toast({ title: 'Import Complete', description: 'Accounts and settings have been imported.' })

            // Success message only, no reload needed as stores are reactive
            // window.location.reload() 
            toast({ title: "Import Successful", description: "All accounts, addons, and settings have been restored." })
        } catch (error) {
            console.error('Import failed:', error)
            toast({ variant: 'destructive', title: 'Import Failed', description: error instanceof Error ? error.message : 'Failed to import accounts' })
        } finally {
            setImporting(false)
            // Reset file input
            if (fileInputRef.current) {
                fileInputRef.current.value = ''
            }
        }
    }

    // Danger zone actions
    const handleClearActivity = () => {
        setConfirmDialog({
            open: true,
            title: 'Clear Activity History',
            description: 'This will delete all cached watch history. You can refresh to reload it from your accounts.',
            destructive: false,
            action: async () => {
                await clearHistory()
                toast({ title: 'Activity Cleared', description: 'Watch history cache has been cleared.' })
            },
        })
    }

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
        <div className="space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
                <p className="text-muted-foreground mt-1">
                    Customize your experience and manage your data.
                </p>
            </div>

            {/* Account Management (Top Priority) */}
            <AccountSection />

            {/* Privacy */}
            <section className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">Privacy</h2>
                    <p className="text-sm text-muted-foreground">Control how sensitive information is displayed.</p>
                </div>

                <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
                    <div className="flex items-center gap-3">
                        <EyeOff className="h-5 w-5 text-muted-foreground" />
                        <div>
                            <Label htmlFor="privacy-mode" className="text-base font-medium">Privacy Mode</Label>
                            <p className="text-sm text-muted-foreground">Mask auth keys and email addresses</p>
                        </div>
                    </div>
                    <Switch
                        id="privacy-mode"
                        checked={isPrivacyModeEnabled}
                        onCheckedChange={togglePrivacyMode}
                    />
                </div>
            </section>


            {/* Data Management */}
            <section className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold">Data Management</h2>
                    <p className="text-sm text-muted-foreground">Manage your accounts and configuration.</p>
                </div>

                <div className="flex flex-wrap gap-4 p-4 rounded-lg border bg-card items-center">
                    <div className="flex-1 space-y-1">
                        <Label className="text-base">Full Backup & Restore</Label>
                        <p className="text-sm text-muted-foreground">
                            Save everything (Accounts, Profiles, Saved Addons, and Failover Rules) to a single file.
                        </p>
                    </div>

                    <div className="flex gap-2">
                        <Button variant="outline" onClick={handleExport} disabled={exporting || accounts.length === 0}>
                            <Download className="mr-2 h-4 w-4" />
                            {exporting ? 'Backing up...' : 'Full Backup'}
                        </Button>
                        <Button variant="outline" onClick={handleImportClick} disabled={importing}>
                            <Upload className="mr-2 h-4 w-4" />
                            {importing ? 'Restoring...' : 'Restore from File'}
                        </Button>
                    </div>
                </div>

                <div className="flex justify-end">
                    <Button variant="ghost" size="sm" onClick={handleClearActivity} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="mr-2 h-4 w-4" />
                        Clear Activity Cache
                    </Button>
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFileChange}
                    className="hidden"
                />
            </section>


            {/* Appearance */}
            <section className="space-y-6">
                <div>
                    <h2 className="text-xl font-semibold">Appearance</h2>
                    <p className="text-sm text-muted-foreground">Customize your interface and show off your favorite community services.</p>
                </div>

                <div className="space-y-4">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Standard Themes</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {THEME_OPTIONS.filter(opt => opt.category === 'standard').map(option => (
                            <ThemeCard
                                key={option.id}
                                option={option}
                                selected={theme === option.id}
                                onSelect={setTheme}
                            />
                        ))}
                    </div>
                </div>

                <div className="space-y-4">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Community Themes</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                        {THEME_OPTIONS.filter(opt => opt.category === 'community').map(option => (
                            <ThemeCard
                                key={option.id}
                                option={option}
                                selected={theme === option.id}
                                onSelect={setTheme}
                            />
                        ))}
                    </div>
                </div>
            </section>

            {/* Danger Zone */}
            <section className="space-y-4">
                <div>
                    <h2 className="text-xl font-semibold text-destructive">Danger Zone</h2>
                    <p className="text-sm text-muted-foreground">Irreversible actions. Proceed with caution.</p>
                </div>

                <div className="p-4 rounded-lg border border-destructive bg-destructive/20 space-y-4">
                    {/* Unsafe Mode Toggle */}
                    <div className="flex items-center justify-between p-3 rounded-lg border border-destructive/30 bg-background">
                        <div className="flex items-center gap-3">
                            <ShieldAlert className="h-5 w-5 text-destructive" />
                            <div>
                                <Label htmlFor="unsafe-mode" className="text-base font-medium text-destructive">Unsafe Mode</Label>
                                <p className="text-sm text-muted-foreground">Enable to unlock destructive actions</p>
                            </div>
                        </div>
                        <Switch
                            id="unsafe-mode"
                            checked={unsafeMode}
                            onCheckedChange={setUnsafeMode}
                            className="data-[state=checked]:bg-destructive"
                        />
                    </div>

                    <div className="flex flex-wrap gap-3">
                        <Button
                            variant="outline"
                            className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                            onClick={handleDeleteAllAccounts}
                            disabled={accounts.length === 0 || !unsafeMode}
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete All Accounts ({accounts.length})
                        </Button>
                        <Button
                            variant="outline"
                            className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
                            onClick={handleDeleteAllAddons}
                            disabled={savedAddonsCount === 0 || !unsafeMode}
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete All Saved Addons ({savedAddonsCount})
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleResetAll}
                            disabled={!unsafeMode}
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Cloud & Local Data
                        </Button>
                    </div>

                    {!unsafeMode && (
                        <p className="text-xs text-muted-foreground italic">
                            Enable Unsafe Mode above to unlock these destructive actions.
                        </p>
                    )}
                </div>
            </section>

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
