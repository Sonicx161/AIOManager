import { useState, useRef, useEffect } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useActivityStore } from '@/store/activityStore'
import { useLibraryCache } from '@/store/libraryCache'
import { useUIStore } from '@/store/uiStore'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
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
import {
    Trash2,
    Database,
    Shield,
    Palette,
    Settings2,
    EyeOff,
    Download,
    Upload
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { VaultSettings } from '@/components/settings/VaultSettings'
import { SyncDiagnostics } from '@/components/settings/SyncDiagnostics'
import { ExpiryDashboard } from '@/components/dashboard/ExpiryDashboard'

// Extracted components
import { AccountSection } from '@/components/settings/AccountSection'
import { SyncSummarySection } from '@/components/settings/SyncSummarySection'
import { NotificationsSection } from '@/components/settings/NotificationsSection'
import { ThemeSection } from '@/components/settings/ThemeSection'
import { DangerZone } from '@/components/settings/DangerZone'

export function SettingsPage() {
    const { theme, setTheme } = useTheme()
    const { accounts, exportAccounts, importAccounts } = useAccountStore()
    const { initialize: initializeAddonStore } = useAddonStore()
    const { clearHistory } = useActivityStore()
    const { isPrivacyModeEnabled, togglePrivacyMode } = useUIStore()
    const { clear: clearLibraryCache } = useLibraryCache()

    const [activeTab, setActiveTab] = useState(() => {
        const hash = window.location.hash.replace('#', '')
        if (['general', 'appearance', 'data', 'advanced'].includes(hash)) {
            return hash
        }
        return 'general'
    })

    const handleTabChange = (val: string) => {
        setActiveTab(val)
        window.history.replaceState(null, '', `#${val}`)
    }

    useEffect(() => {
        return () => {
            window.history.replaceState(null, '', window.location.pathname)
        }
    }, [])

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

    // Export all data
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

    // Import data
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

            // Only keeping the Import Successful toast as requested
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

    const handleClearActivity = () => {
        setConfirmDialog({
            open: true,
            title: 'Clear History Cache',
            description: 'This will delete all cached watch history. You can refresh to reload it from your accounts. This only deletes local cache, not Stremio remote history.',
            destructive: false, // Changed down to false, visually safer
            action: async () => {
                await clearHistory()
                await clearLibraryCache()
                toast({ title: 'Activity Cleared', description: 'Watch history cache has been cleared locally.' })
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

            <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
                <TabsList className="flex h-auto bg-transparent p-0 gap-2 justify-start w-full whitespace-nowrap overflow-x-auto scrollbar-hide pb-2">
                    <TabsTrigger value="general" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all">
                        <Settings2 className="h-3.5 w-3.5 mr-2" />General
                    </TabsTrigger>
                    <TabsTrigger value="appearance" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all">
                        <Palette className="h-3.5 w-3.5 mr-2" />Appearance
                    </TabsTrigger>
                    <TabsTrigger value="data" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all">
                        <Database className="h-3.5 w-3.5 mr-2" />Data & Sync
                    </TabsTrigger>
                    <TabsTrigger value="advanced" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full px-4 border border-border/50 data-[state=active]:border-transparent bg-muted/30 shrink-0 shadow-sm transition-all">
                        <Shield className="h-3.5 w-3.5 mr-2" />Advanced
                    </TabsTrigger>
                </TabsList>

                <div className="mt-8">
                    {/* General Tab */}
                    <TabsContent value="general" className="mt-0">
                        <div className="grid gap-6">
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
                            <ExpiryDashboard />
                        </div>
                    </TabsContent>

                    {/* Appearance Tab */}
                    <TabsContent value="appearance" className="mt-0">
                        <ThemeSection theme={theme} setTheme={setTheme} />
                    </TabsContent>

                    {/* Data & Sync Tab */}
                    <TabsContent value="data" className="mt-0 space-y-6">
                        {/* Backup & Restore */}
                        <div className="p-6 rounded-xl border bg-card/50 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all">
                            <div className="space-y-1">
                                <h3 className="text-base font-semibold flex items-center gap-2">
                                    <Database className="h-5 w-5 text-primary" />
                                    Cloud Backup & Restore
                                </h3>
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

                        {/* Non-destructive Clear History Cache */}
                        <div className="p-6 rounded-xl border bg-card/50 flex flex-col md:flex-row md:items-center justify-between gap-6 transition-all">
                            <div className="space-y-1">
                                <h3 className="text-base font-semibold flex items-center gap-2">
                                    <Trash2 className="h-5 w-5 text-muted-foreground" />
                                    Clear History Cache
                                </h3>
                                <p className="text-sm text-muted-foreground max-w-[80%]">
                                    Wipes all locally cached activity view data. Useful if you want to force a clean re-pull from your attached Stremio accounts immediately.
                                </p>
                            </div>

                            <div className="flex gap-2 shrink-0">
                                <Button variant="outline" onClick={handleClearActivity}>
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Clear Cache
                                </Button>
                            </div>
                        </div>
                    </TabsContent>

                    {/* Advanced Tab */}
                    <TabsContent value="advanced" className="mt-0 space-y-6">
                        <NotificationsSection />
                        <SyncDiagnostics />
                        <DangerZone />
                    </TabsContent>
                </div>
            </Tabs>

            {/* Confirmation Dialog needed for SettingsPage specifically (Clear History Cache) */}
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
