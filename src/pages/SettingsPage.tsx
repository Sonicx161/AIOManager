import { useState, useRef } from 'react'
import { useTheme, THEME_OPTIONS, ThemeOption, Theme } from '@/contexts/ThemeContext'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useActivityStore } from '@/store/activityStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useUIStore } from '@/store/uiStore'
import { useFailoverStore } from '@/store/failoverStore'
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
import { Trash2, Download, Upload, EyeOff, Check, ShieldAlert, Copy, RefreshCw, User, Bell, Clock, Database, Palette, Shield, Link2, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'
import { getTimeAgo } from '@/lib/utils'
import localforage from 'localforage'
import { useSyncStore } from '@/store/syncStore'
import { VaultSettings } from '@/components/settings/VaultSettings'
import { SyncDiagnostics } from '@/components/settings/SyncDiagnostics'
import { ExpiryDashboard } from '@/components/dashboard/ExpiryDashboard'

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
            <div className="p-4 rounded-xl border bg-card/50 space-y-6">
                {/* Display Name */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">Display Name</Label>
                    <div className="relative">
                        <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Your Name"
                            className="pl-10 h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                            value={auth.name}
                            onChange={(e) => setDisplayName(e.target.value)}
                        />
                    </div>
                </div>

                {/* ID Display */}
                <div className="space-y-2">
                    <Label className="text-sm font-semibold">Your UUID</Label>
                    <div className="flex gap-2">
                        <Input value={auth.id} readOnly className="font-mono bg-muted/50 text-xs h-9" />
                        <Button variant="outline" size="icon" className="h-9 w-9" onClick={copyId} title="Copy UUID">
                            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                        </Button>
                    </div>
                </div>

                {/* Sync Status */}
                <div className="flex items-center justify-between text-sm bg-blue-500/5 p-3 rounded-lg border border-blue-500/10">
                    <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-green-500" />
                        <span className="font-medium">Authenticated</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Last Sync
                        </span>
                        <span className="font-bold text-xs">
                            {lastSyncedAt ? getTimeAgo(new Date(lastSyncedAt)) : 'Never'}
                        </span>
                    </div>
                </div>

                {/* Actions */}
                <div className="space-y-3 pt-2">
                    <div className="p-3 rounded-lg border bg-blue-500/10 border-blue-500/20">
                        <p className="text-[11px] text-blue-600 dark:text-blue-400 font-medium leading-relaxed">
                            Cloud Sync is active. Every change you make is instantly saved to the server.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <Button variant="default" className="shadow-lg shadow-primary/20" onClick={() => syncToRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                            Push to Cloud
                        </Button>
                        <Button variant="outline" onClick={() => syncFromRemote()} disabled={isSyncing}>
                            {isSyncing ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                            Pull from Cloud
                        </Button>
                    </div>
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

function SyncSummarySection() {
    const { library, accountStates } = useAddonStore()
    const [isExpanded, setIsExpanded] = useState(false)

    // Find all addons in the library that have syncWithInstalled enabled
    const syncedAddons = Object.values(library).filter(a => a.syncWithInstalled)

    if (syncedAddons.length === 0) return null

    const displayCount = isExpanded ? syncedAddons.length : 3
    const hasMore = syncedAddons.length > 3

    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                            <Link2 className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex items-center gap-2">
                            <Label className="text-sm font-semibold">Active Sync Connections</Label>
                            <span className="bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tighter">
                                {syncedAddons.length}
                            </span>
                        </div>
                    </div>
                    <a
                        href="/saved-addons"
                        className="text-[10px] font-bold text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 uppercase tracking-widest"
                        onClick={(e) => {
                            e.preventDefault()
                            window.history.pushState({}, '', '/saved-addons')
                            window.dispatchEvent(new PopStateEvent('popstate'))
                        }}
                    >
                        Manage
                        <ChevronRight className="h-3 w-3" />
                    </a>
                </div>

                <div className="space-y-2">
                    {syncedAddons.slice(0, displayCount).map((addon, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-background/30 border border-white/5">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <div className="w-6 h-6 rounded bg-muted/50 flex-shrink-0 overflow-hidden border border-white/5">
                                    {(addon.metadata?.customLogo || addon.manifest.logo) && (
                                        <img
                                            src={addon.metadata?.customLogo || addon.manifest.logo}
                                            alt=""
                                            className="w-full h-full object-contain"
                                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                                        />
                                    )}
                                </div>
                                <span className="text-xs font-bold truncate">{addon.name}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0 text-right">
                                <span className="text-[10px] text-muted-foreground italic">
                                    {(() => {
                                        let count = 0
                                        for (const accState of Object.values(accountStates)) {
                                            if (accState.installedAddons.some(ia => ia.installUrl === addon.installUrl)) count++
                                        }
                                        return count > 0 ? `${count} account${count !== 1 ? 's' : ''}` : 'Not installed'
                                    })()}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>

                {hasMore && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="w-full h-8 text-[11px] font-bold text-muted-foreground hover:text-primary"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        {isExpanded ? (
                            <>
                                <ChevronUp className="mr-2 h-3 w-3" />
                                SHOW LESS
                            </>
                        ) : (
                            <>
                                <ChevronDown className="mr-2 h-3 w-3" />
                                SHOW ALL ({syncedAddons.length})
                            </>
                        )}
                    </Button>
                )}
            </div>
        </section>
    )
}

function NotificationsSection() {
    const { webhook, setWebhook } = useFailoverStore()
    const [webhookUrl, setWebhookUrl] = useState(webhook.url)

    const handleSave = () => {
        setWebhook(webhookUrl, !!webhookUrl)
        toast({ title: webhookUrl ? 'Notifications Enabled' : 'Notifications Disabled' })
    }

    return (
        <section className="space-y-4">
            <div className="p-4 rounded-xl border bg-card/50 space-y-4">
                <div className="space-y-2">
                    <Label className="text-sm font-semibold flex items-center gap-2">
                        <Bell className="h-4 w-4 text-primary" />
                        Discord Webhook URL
                    </Label>
                    <div className="flex gap-2">
                        <Input
                            placeholder="https://discord.com/api/webhooks/..."
                            value={webhookUrl}
                            onChange={(e) => setWebhookUrl(e.target.value)}
                            className="h-10 bg-background/50 border-muted focus:bg-background transition-colors"
                        />
                        <Button onClick={handleSave} className="shrink-0">Save</Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Used for system-wide health alerts and failover notifications.
                    </p>
                </div>
            </div>
        </section>
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
    const failoverRulesCount = useFailoverStore((s) => s.rules.length)

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

    const { clear: clearLibraryCache } = useLibraryCache()

    // Danger zone actions
    const handleClearActivity = () => {
        setConfirmDialog({
            open: true,
            title: 'Clear Activity History',
            description: 'This will delete all cached watch history. You can refresh to reload it from your accounts.',
            destructive: false,
            action: async () => {
                await clearHistory()
                await clearLibraryCache()
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
        <div className="space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
                <p className="text-muted-foreground mt-1">
                    Customize your experience and manage your data.
                </p>
            </div>

            {/* 1. Account & Security Group */}
            <div className="grid gap-8">
                <div className="space-y-4">
                    <h2 className="text-xl font-bold flex items-center gap-2 px-1">
                        <Shield className="h-5 w-5 text-primary" />
                        Account & Security
                    </h2>
                    <div className="grid gap-4">
                        <AccountSection />

                        <div className="p-4 rounded-xl border bg-card/50 flex items-center justify-between transition-all hover:bg-card/60">
                            <div className="flex items-center gap-3">
                                <div className="p-2 rounded-lg bg-primary/10">
                                    <EyeOff className="h-4 w-4 text-primary" />
                                </div>
                                <div>
                                    <Label htmlFor="privacy-mode" className="text-base font-medium cursor-pointer">Privacy Mode</Label>
                                    <p className="text-sm text-muted-foreground">Mask secrets and sensitive data</p>
                                </div>
                            </div>
                            <Switch
                                id="privacy-mode"
                                checked={isPrivacyModeEnabled}
                                onCheckedChange={togglePrivacyMode}
                            />
                        </div>

                        <VaultSettings />
                    </div>
                </div>

                {/* 2. Monitoring & Alerts Group */}
                <div className="space-y-4">
                    <h2 className="text-xl font-bold flex items-center gap-2 px-1">
                        <Bell className="h-5 w-5 text-primary" />
                        Monitoring & Alerts
                    </h2>
                    <div className="grid gap-4">
                        <NotificationsSection />
                        <ExpiryDashboard />
                    </div>
                </div>

                {/* 3. Appearance Group */}
                <div className="space-y-4">
                    <h2 className="text-xl font-bold flex items-center gap-2 px-1">
                        <Palette className="h-5 w-5 text-primary" />
                        Appearance
                    </h2>
                    <div className="p-6 rounded-xl border bg-card/50 space-y-6">
                        <div className="space-y-4">
                            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Standard Themes</h3>
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
                            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Community Themes</h3>
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
                    </div>
                </div>

                {/* 4. Management & Maintenance */}
                <div className="space-y-4">
                    <h2 className="text-xl font-bold flex items-center gap-2 px-1">
                        <Database className="h-5 w-5 text-primary" />
                        Management & Maintenance
                    </h2>
                    <div className="grid gap-4">
                        {/* Backup & Restore */}
                        <div className="p-6 rounded-xl border bg-card/50 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all">
                            <div className="space-y-1">
                                <Label className="text-lg font-bold">Cloud Backup & Restore</Label>
                                <p className="text-sm text-muted-foreground max-w-md">
                                    Export your entire configuration (Accounts, Profiles, Addons, and Rules) to a portable JSON file.
                                </p>
                            </div>

                            <div className="flex gap-2 shrink-0">
                                <Button variant="outline" className="border-primary/20 hover:bg-primary/5" onClick={handleExport} disabled={exporting || accounts.length === 0}>
                                    <Download className="mr-2 h-4 w-4" />
                                    {exporting ? 'Exporting...' : 'Export'}
                                </Button>
                                <Button variant="outline" className="border-primary/20 hover:bg-primary/5" onClick={handleImportClick} disabled={importing}>
                                    <Upload className="mr-2 h-4 w-4" />
                                    {importing ? 'Importing...' : 'Import'}
                                </Button>
                            </div>
                        </div>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".json,application/json"
                            onChange={handleFileChange}
                            className="hidden"
                        />

                        {/* Active Sync Summary */}
                        <SyncSummarySection />

                        {/* Sync Diagnostics */}
                        <SyncDiagnostics />

                        {/* Danger Zone */}
                        <div className="p-1 rounded-xl bg-destructive/5 border border-destructive/20 overflow-hidden">
                            <div className="p-5 bg-background/40 space-y-6">
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

                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 border-destructive/30 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                                        onClick={handleClearActivity}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Clear History Cache
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 border-destructive/30 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                                        onClick={handleDeleteAllAccounts}
                                        disabled={accounts.length === 0 || !unsafeMode}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Wipe Accounts ({accounts.length})
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 border-destructive/30 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
                                        onClick={handleDeleteAllAddons}
                                        disabled={savedAddonsCount === 0 || !unsafeMode}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Wipe Library ({savedAddonsCount})
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 border-destructive/30 text-destructive hover:bg-destructive hover:text-white transition-all disabled:opacity-40"
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
                        </div>
                    </div>
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
