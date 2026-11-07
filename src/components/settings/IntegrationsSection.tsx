import { useEffect, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Key,
    Trash2,
    Eye,
    EyeOff,
    Plus,
    Download,
    CheckCircle2,
    AlertCircle,
    Loader2,
    ChevronDown,
    ChevronUp,
    Zap,
    ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { Tooltip } from '@/components/ui/tooltip'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { getTimeAgo } from '@/lib/utils'
import {
    ConfiguredProvider,
    detectKeyFormat,
    listMetadataKeys,
    saveMetadataKey,
    deleteMetadataKey,
    getMetadataKeyValue,
    importFromAIOMetadata,
    testMetadataKey,
} from '@/lib/metadata-keys'
import { useAIOMetadataInstances } from '@/hooks/useAIOMetadataInstances'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'
import { useAccountStore } from '@/store/accountStore'

type ProviderOption = {
    id: string
    label: string
    available: boolean
    description: string
    keyUrl?: string
    color: string
    abbr: string
    logo?: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
    { id: 'tmdb', label: 'TMDB', available: true, description: 'Recommendations, trailers, cast, posters', keyUrl: 'https://www.themoviedb.org/settings/api', color: '#01b4e3', abbr: 'M', logo: '/tmdb-logo.svg' },
    { id: 'pmdb', label: 'PMDB', available: true, description: 'Community ratings, ID mappings, skip timestamps', keyUrl: 'https://publicmetadb.com/api-docs', color: '#7c3aed', abbr: 'P' },
    { id: 'mdblist', label: 'MDBList', available: true, description: 'Curated lists, cross-platform metadata', keyUrl: 'https://mdblist.com/preferences/', color: '#3D7ABD', abbr: 'M', logo: '/mdblist-logo.png' },
    { id: 'tvdb', label: 'TVDB', available: true, description: 'Series metadata, episode data, artwork', keyUrl: 'https://thetvdb.com/api-information/signup', color: '#1a6ede', abbr: 'TV', logo: '/tvdb-logo.svg' },
]

const CUSTOM_INSTANCE_ID = '__custom__'

interface ImportFormState {
    url: string
    uuid: string
    password: string
    addonPassword: string
}

const EMPTY_IMPORT_FORM: ImportFormState = { url: '', uuid: '', password: '', addonPassword: '' }



export function IntegrationsSection() {
    const [loading, setLoading] = useState(true)
    const [providers, setProviders] = useState<ConfiguredProvider[]>([])
    const [selectedProvider, setSelectedProvider] = useState<string>('tmdb')
    const [pastedKey, setPastedKey] = useState('')
    const [showKey, setShowKey] = useState(false)
    const [savingKey, setSavingKey] = useState(false)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
    const [deletingProvider, setDeletingProvider] = useState<string | null>(null)
    const [deleteInProgress, setDeleteInProgress] = useState(false)

    const [showImportDialog, setShowImportDialog] = useState(false)
    const [importForm, setImportForm] = useState<ImportFormState>(EMPTY_IMPORT_FORM)
    const [selectedInstance, setSelectedInstance] = useState<string>(CUSTOM_INSTANCE_ID)
    const [showAddonPassword, setShowAddonPassword] = useState(false)
    const [importing, setImporting] = useState(false)
    const [importError, setImportError] = useState<string | null>(null)

    const [providerTestResults, setProviderTestResults] = useState<Record<string, { success: boolean; message: string } | null>>({})
    const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({})
    const [revealingKey, setRevealingKey] = useState<string | null>(null)
    const [inlineEditProvider, setInlineEditProvider] = useState<string | null>(null)
    const [inlineEditValue, setInlineEditValue] = useState('')

    const { instances: detectedInstances } = useAIOMetadataInstances()
    const accounts = useAccountStore(s => s.accounts)
    const maskedLabel = useMaskedAccountLabel()

    const refreshProviders = useCallback(async () => {
        setLoading(true)
        try {
            const list = await listMetadataKeys()
            setProviders(list)
        } catch (error) {
            if (import.meta.env.DEV) console.warn('[IntegrationsSection] Failed to load providers:', error)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        refreshProviders()
    }, [refreshProviders])

    const detectedFormat = detectKeyFormat(pastedKey)
    const isTmdb = selectedProvider === 'tmdb'
    const canSave = pastedKey.trim().length > 0 && !savingKey && (!isTmdb || detectedFormat !== 'unknown')
    const selectedProviderOption = PROVIDER_OPTIONS.find(p => p.id === selectedProvider)

    const handleSaveKey = async () => {
        if (!canSave) return
        const provider = selectedProvider
        const key = pastedKey.trim()
        setSavingKey(true)
        try {
            const result = await saveMetadataKey(provider, key)
            const providerLabel = PROVIDER_OPTIONS.find(p => p.id === result.provider)?.label || result.provider.toUpperCase()
            toast({
                title: `${providerLabel} key saved`,
                description: result.keyFormat === 'v4' ? 'Read token stored on the server.' : 'API key stored on the server.',
            })
            setPastedKey('')
            setShowKey(false)
            setTestResult(null)
            setInlineEditProvider(null)
            setInlineEditValue('')
            await refreshProviders()
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not save key.'
            toast({ variant: 'destructive', title: 'Save failed', description: message })
        } finally {
            setSavingKey(false)
        }
    }

    const handleTestKey = async () => {
        setTesting(true)
        setTestResult(null)
        try {
            const result = await testMetadataKey(selectedProvider, pastedKey.trim() || undefined)
            setTestResult({ success: result.success, message: result.message })
            const lbl = selectedProviderOption?.label || 'Provider'
            if (result.success) {
                toast({ title: `${lbl} key works`, description: result.message })
            } else {
                toast({ variant: 'destructive', title: `${lbl} key test failed`, description: result.message })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Test request failed.'
            setTestResult({ success: false, message })
            toast({ variant: 'destructive', title: 'Test failed', description: message })
        } finally {
            setTesting(false)
        }
    }

    const handleConfirmDelete = async () => {
        if (!deletingProvider) return
        const provider = deletingProvider
        setDeleteInProgress(true)
        try {
            await deleteMetadataKey(provider)
            const providerLabel = PROVIDER_OPTIONS.find(p => p.id === provider)?.label || provider.toUpperCase()
            toast({ title: `${providerLabel} key removed` })
            await refreshProviders()
            setDeletingProvider(null)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not delete key.'
            toast({ variant: 'destructive', title: 'Delete failed', description: message })
        } finally {
            setDeleteInProgress(false)
        }
    }

    const openImportDialog = () => {
        setImportForm(EMPTY_IMPORT_FORM)
        setImportError(null)
        setShowAddonPassword(false)
        const first = detectedInstances[0]
        if (first) {
            setSelectedInstance(`${first.baseUrl}|${first.uuid}`)
            setImportForm({
                url: first.baseUrl,
                uuid: first.uuid,
                password: first.password || '',
                addonPassword: '',
            })
        } else {
            setSelectedInstance(CUSTOM_INSTANCE_ID)
        }
        setShowImportDialog(true)
    }

    const handleImport = async () => {
        if (!importForm.url.trim() || !importForm.uuid.trim() || !importForm.password) {
            setImportError('URL, UUID, and password are all required.')
            return
        }
        setImporting(true)
        setImportError(null)
        try {
            const result = await importFromAIOMetadata({
                aiometadataUrl: importForm.url.trim(),
                uuid: importForm.uuid.trim(),
                password: importForm.password,
                addonPassword: importForm.addonPassword.trim() || undefined,
            })
            const labels = result.imported
                .map(p => PROVIDER_OPTIONS.find(opt => opt.id === p.provider)?.label || p.provider.toUpperCase())
                .join(', ')
            toast({
                title: `Imported ${result.imported.length} key${result.imported.length !== 1 ? 's' : ''}`,
                description: labels || 'No new keys were found.',
            })
            setShowImportDialog(false)
            await refreshProviders()
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error)
            const lower = raw.toLowerCase()
            let friendly = raw
            if (lower.includes('auth') || lower.includes('password') || lower.includes('invalid uuid')) {
                friendly = 'AIOMetadata authentication failed. Check your UUID and password.'
            } else if (lower.includes('fetch') || lower.includes('network') || lower.includes('reach') || lower.includes('econnrefused') || lower.includes('timeout')) {
                friendly = 'Could not reach AIOMetadata instance. Verify the URL.'
            }
            setImportError(friendly)
        } finally {
            setImporting(false)
        }
    }

    return (
        <section className="space-y-4">
            <div data-theme-part="panel" className="space-y-4 sm:space-y-5 rounded-[1.5rem] sm:rounded-[1.75rem] border border-border/45 bg-card/80 p-3 sm:p-4 md:p-5 lg:p-6 shadow-sm">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                        <div className="relative mt-0.5 flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                            <SquircleOverlay />
                            <Key className="relative z-10 h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm sm:text-base font-semibold">Metadata Integrations</h3>
                                <div data-theme-part="badge" className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-background/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                    <span className="text-muted-foreground/60">Powered by</span>
                                    {[
                                        ...providers.flatMap(p => {
                                            const opt = PROVIDER_OPTIONS.find(o => o.id === p.provider)
                                            return opt?.logo ? [{ key: p.provider, logo: opt.logo, label: opt.label }] : []
                                        }),
                                    ].map(item => (
                                        <img key={item.key} src={item.logo} alt={item.label} className="h-3 w-auto max-w-[40px] object-contain" />
                                    ))}
                                </div>
                            </div>
                            <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
                                Store encrypted metadata provider keys for trailer fallback, artwork, and recommendations.
                            </p>
                        </div>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={openImportDialog}
                        className="h-8 shrink-0 gap-1.5 text-xs font-semibold self-start sm:self-auto"
                    >
                        <Download className="h-3.5 w-3.5" />
                        Import from AIOMetadata
                    </Button>
                </div>

                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-muted-foreground">Configured keys</p>
                        {providers.length > 0 && (
                            <span data-theme-part="badge" className="rounded-full bg-primary/12 px-1.5 py-0.5 text-xs font-bold text-primary">
                                {providers.length}
                            </span>
                        )}
                    </div>

                    {loading ? (
                        <div data-theme-part="panel" className="flex items-center gap-2 rounded-2xl border border-border/30 bg-background/35 p-3 text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading configured keys...
                        </div>
                    ) : providers.length === 0 ? (
                        <div data-theme-part="panel" className="flex items-start gap-2 rounded-2xl border border-dashed border-border/40 bg-background/30 p-3 text-xs text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            <span>No API keys configured. Add your TMDB key below to enable trailer fallback and recommendations.</span>
                        </div>
                    ) : (
                        <div className="grid gap-2">
                            {providers.map((provider) => {
                                const option = PROVIDER_OPTIONS.find(o => o.id === provider.provider)
                                const label = option?.label || provider.provider.toUpperCase()
                                const testResult = providerTestResults[provider.provider]
                                const keyRevealed = revealedKeys[provider.provider]
                                const isInlineEditing = inlineEditProvider === provider.provider
                                return (
                                    <div
                                        key={provider.provider}
                                        data-theme-part="panel"
                                        className="rounded-2xl border border-border/35 bg-background/35 p-2.5 sm:p-3 space-y-2"
                                    >
                                        <div className="flex items-center gap-2">
                                        <div
                                            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/35 bg-muted/25 overflow-hidden"
                                        >
                                            <SquircleOverlay />
                                            {option?.logo ? (
                                                <img src={option.logo} alt={label} className="relative z-10 h-full w-full object-cover" />
                                            ) : (
                                                <span className="relative z-10 font-black text-xs text-muted-foreground">{option?.abbr || label.slice(0, 2)}</span>
                                            )}
                                        </div>
                                            <div className="min-w-0 flex flex-col gap-0.5 flex-1">
                                                <span className="truncate text-xs font-bold">{label}</span>
                                                <p className="text-xs text-muted-foreground">
                                                    {provider.updatedAt ? `Saved ${getTimeAgo(new Date(provider.updatedAt))}` : 'Saved'}
                                                </p>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                                onClick={() => setDeletingProvider(provider.provider)}
                                                aria-label={`Delete ${label} key`}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            {isInlineEditing ? (
                                                <>
                                                    <Input
                                                        autoFocus
                                                        value={inlineEditValue}
                                                        onChange={(e) => setInlineEditValue(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Escape') { setInlineEditProvider(null); setInlineEditValue('') }
                                                            if (e.key === 'Enter' && inlineEditValue.trim()) {
                                                                saveMetadataKey(provider.provider, inlineEditValue.trim())
                                                                    .then(() => {
                                                                        toast({ title: `${label} key updated` })
                                                                        setInlineEditProvider(null)
                                                                        setInlineEditValue('')
                                                                        setRevealedKeys(prev => { const n = { ...prev }; delete n[provider.provider]; return n })
                                                                        refreshProviders()
                                                                    })
                                                                    .catch(() => toast({ variant: 'destructive', title: 'Update failed' }))
                                                            }
                                                        }}
                                                        className="h-8 min-w-0 flex-1 font-mono text-xs"
                                                        placeholder="Paste new key..."
                                                        type={keyRevealed ? 'text' : 'password'}
                                                    />
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 shrink-0"
                                                        onClick={() => { setInlineEditProvider(null); setInlineEditValue('') }}
                                                        aria-label="Cancel"
                                                    >
                                                        <ChevronDown className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 shrink-0 text-primary hover:text-primary"
                                                        disabled={!inlineEditValue.trim()}
                                                        onClick={() => {
                                                            saveMetadataKey(provider.provider, inlineEditValue.trim())
                                                                .then(() => {
                                                                    toast({ title: `${label} key updated` })
                                                                    setInlineEditProvider(null)
                                                                    setInlineEditValue('')
                                                                    setRevealedKeys(prev => { const n = { ...prev }; delete n[provider.provider]; return n })
                                                                    refreshProviders()
                                                                })
                                                                .catch(() => toast({ variant: 'destructive', title: 'Update failed' }))
                                                        }}
                                                        aria-label="Save key"
                                                    >
                                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                                    </Button>
                                                </>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        data-theme-part="input"
                                                        className="flex h-8 min-w-0 flex-1 cursor-text items-center truncate rounded-lg border border-border/30 bg-muted/20 px-2 font-mono text-xs text-muted-foreground transition-colors hover:border-border/50 hover:text-foreground"
                                                        onClick={() => {
                                                            setInlineEditProvider(provider.provider)
                                                            setInlineEditValue(keyRevealed || '')
                                                        }}
                                                    >
                                                        {keyRevealed || '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                                                    </button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                                                        disabled={revealingKey === provider.provider}
                                                        onClick={async () => {
                                                            if (keyRevealed) {
                                                                setRevealedKeys(prev => { const n = { ...prev }; delete n[provider.provider]; return n })
                                                            } else {
                                                                setRevealingKey(provider.provider)
                                                                try {
                                                                    const val = await getMetadataKeyValue(provider.provider)
                                                                    setRevealedKeys(prev => ({ ...prev, [provider.provider]: val }))
                                                                } catch {
                                                                    toast({ variant: 'destructive', title: 'Could not fetch key' })
                                                                }
                                                                setRevealingKey(null)
                                                            }
                                                        }}
                                                        aria-label={keyRevealed ? 'Hide key' : 'Reveal key'}
                                                    >
                                                        {revealingKey === provider.provider ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        ) : keyRevealed ? (
                                                            <EyeOff className="h-3.5 w-3.5" />
                                                        ) : (
                                                            <Eye className="h-3.5 w-3.5" />
                                                        )}
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-8 shrink-0 text-xs font-semibold"
                                                        onClick={async () => {
                                                            setProviderTestResults(prev => ({ ...prev, [provider.provider]: null }))
                                                            try {
                                                                const result = await testMetadataKey(provider.provider)
                                                                setProviderTestResults(prev => ({ ...prev, [provider.provider]: { success: result.success, message: result.message } }))
                                                                toast({ title: result.success ? 'Key working' : 'Key test failed', description: result.message })
                                                            } catch {
                                                                setProviderTestResults(prev => ({ ...prev, [provider.provider]: { success: false, message: 'Test failed' } }))
                                                                toast({ variant: 'destructive', title: 'Test failed' })
                                                            }
                                                        }}
                                                    >
                                                        <Zap className="h-3 w-3" />
                                                        Test
                                                    </Button>
                                                </>
                                            )}
                                        </div>
                                        {testResult && (
                                            <p className={`text-xs font-medium ${testResult.success ? 'text-success' : 'text-destructive'}`}>
                                                {testResult.message}
                                            </p>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>

                <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/30 bg-background/30 p-2.5 sm:p-3 md:p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="space-y-1.5">
                            <Label className="text-xs font-semibold text-muted-foreground">Provider</Label>
                            <div className="flex flex-wrap gap-1.5">
                                {PROVIDER_OPTIONS.map((opt) => {
                                    const isSelected = selectedProvider === opt.id
                                    const button = (
                                        <button
                                            key={opt.id}
                                            type="button"
                                            data-theme-part="tab"
                                            data-state={isSelected ? 'active' : 'inactive'}
                                            disabled={!opt.available}
                                            onClick={() => opt.available && setSelectedProvider(opt.id)}
                                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 sm:px-2.5 sm:py-1.5 text-xs font-semibold transition-colors ${
                                                isSelected
                                                    ? 'border-primary/40 bg-primary/10 text-primary'
                                                    : opt.available
                                                        ? 'border-border/40 bg-muted/25 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                                                        : 'border-border/30 bg-muted/10 text-muted-foreground/50 cursor-not-allowed'
                                            }`}
                                        >
                                            <span
                                                className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded border border-border/35 bg-muted/25"
                                            >
                                                {opt.logo ? (
                                                    <img src={opt.logo} alt="" className="h-full w-full object-contain p-0.5" />
                                                ) : (
                                                    <span className="text-[7px] font-bold text-muted-foreground">{opt.abbr}</span>
                                                )}
                                            </span>
                                            {!opt.available && <span className="text-xs opacity-60">soon</span>}
                                            {opt.label}
                                        </button>
                                    )
                                    return opt.available ? (
                                        button
                                    ) : (
                                        <Tooltip key={opt.id} content={`${opt.description} (coming soon)`}>
                                            {button}
                                        </Tooltip>
                                    )
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="tmdb-key-input" className="text-xs font-semibold text-muted-foreground">
                                {selectedProviderOption?.label || 'Provider'} key
                            </Label>
                            {selectedProviderOption?.keyUrl && (
                                <a
                                    href={selectedProviderOption.keyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                                >
                                    Get key
                                    <ExternalLink className="h-3 w-3" />
                                </a>
                            )}
                        </div>
                        <div className="relative">
                            <Input
                                id="tmdb-key-input"
                                type={showKey ? 'text' : 'password'}
                                autoComplete="off"
                                spellCheck={false}
                                inputMode="text"
                                placeholder={`Paste your ${selectedProviderOption?.label || 'provider'} API key or read token`}
                                value={pastedKey}
                                onChange={(e) => setPastedKey(e.target.value)}
                                className="h-9 sm:h-10 font-mono text-xs pr-10"
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                type="button"
                                aria-label={showKey ? 'Hide key' : 'Show key'}
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                                onClick={() => setShowKey(s => !s)}
                                disabled={!pastedKey}
                            >
                                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                            <p className="text-xs text-muted-foreground/70 hidden sm:block">
                                Keys are encrypted at rest on the server.
                            </p>
                            {testResult && (
                                <span className={`inline-flex items-center gap-1 text-xs font-medium ${testResult.success ? 'text-green-500' : 'text-destructive'}`}>
                                    {testResult.success ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                                    <span className="truncate">{testResult.message}</span>
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleTestKey}
                                disabled={testing}
                                className="h-9 gap-1.5"
                            >
                                {testing ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Zap className="h-3.5 w-3.5" />
                                )}
                                Test
                            </Button>
                            <Button
                                variant="default"
                                size="sm"
                                onClick={handleSaveKey}
                                disabled={!canSave}
                                className="h-9 shrink-0 gap-1.5 sm:w-auto"
                            >
                                {savingKey ? (
                                    <>
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Plus className="h-3.5 w-3.5" />
                                        Save Key
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            <Dialog open={showImportDialog} onOpenChange={(open) => { if (!importing) setShowImportDialog(open) }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Download className="h-4 w-4 text-primary" />
                            Import keys from AIOMetadata
                        </DialogTitle>
                        <DialogDescription>
                            Pull your existing TMDB, TVDB, and PMDB keys from an AIOMetadata instance. This is a one-time import; your password is used to fetch the keys and is then discarded.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4 px-6 pb-3">
                        <div className="space-y-2">
                            <Label className="text-xs font-semibold text-muted-foreground">
                                AIOMetadata Instance
                            </Label>
                            <div className="grid gap-2">
                                {detectedInstances.length === 0 && (
                                    <p data-theme-part="panel" className="rounded-xl border border-dashed border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground/60">
                                        No AIOMetadata instances detected from your accounts. Add one manually below.
                                    </p>
                                )}
                                {detectedInstances.map(inst => {
                                    const instKey = `${inst.baseUrl}|${inst.uuid}`
                                    return (
                                        <button
                                            key={instKey}
                                            type="button"
                                            data-theme-part="button"
                                            onClick={() => {
                                                setSelectedInstance(instKey)
                                                setImportForm({
                                                    url: inst.baseUrl,
                                                    uuid: inst.uuid,
                                                    password: inst.password || '',
                                                    addonPassword: '',
                                                })
                                            }}
                                            className={`flex items-start gap-2.5 rounded-xl border p-2 sm:p-2.5 text-left transition-[border,background] ${
                                                selectedInstance === instKey
                                                    ? 'border-primary/50 bg-primary/8'
                                                    : 'border-border/40 bg-muted/15 hover:border-border/60 hover:bg-muted/25'
                                            }`}
                                        >
                                            <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                                selectedInstance === instKey ? 'border-primary bg-primary' : 'border-muted-foreground/30'
                                            }`}>
                                                {selectedInstance === instKey && (
                                                    <svg className="h-2.5 w-2.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                    </svg>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-xs font-semibold text-foreground">{inst.addonName}</span>
                                                    {inst.hasPassword && (
                                                        <span data-theme-part="badge" className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-xs font-semibold text-success">
                                                            <CheckCircle2 className="h-2.5 w-2.5" /> Key saved
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground/50">{inst.baseUrl}</p>
                                                <p className="mt-0.5 truncate text-xs text-muted-foreground/40">
                                                    {inst.accounts.map(a => maskedLabel(accounts.find(acc => acc.id === a.accountId))).join(', ')}
                                                </p>
                                            </div>
                                        </button>
                                    )
                                })}
                                <button
                                    type="button"
                                    data-theme-part="button"
                                    onClick={() => {
                                        setSelectedInstance(CUSTOM_INSTANCE_ID)
                                        setImportForm(EMPTY_IMPORT_FORM)
                                    }}
                                    className={`flex items-start gap-2.5 rounded-xl border p-2 sm:p-2.5 text-left transition-[border,background] ${
                                        selectedInstance === CUSTOM_INSTANCE_ID
                                            ? 'border-primary/50 bg-primary/8'
                                            : 'border-border/40 bg-muted/15 hover:border-border/60 hover:bg-muted/25'
                                    }`}
                                >
                                    <div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                        selectedInstance === CUSTOM_INSTANCE_ID ? 'border-primary bg-primary' : 'border-muted-foreground/30'
                                    }`}>
                                        {selectedInstance === CUSTOM_INSTANCE_ID && (
                                            <svg className="h-2.5 w-2.5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                            </svg>
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <span className="text-xs font-semibold text-foreground">Custom Instance</span>
                                        <p className="mt-0.5 text-xs leading-tight text-muted-foreground/70">Enter URL and credentials manually.</p>
                                    </div>
                                </button>
                            </div>
                            {selectedInstance === CUSTOM_INSTANCE_ID && (
                                <Input
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="https://your-aiometadata-instance.com"
                                    value={importForm.url}
                                    onChange={(e) => setImportForm(prev => ({ ...prev, url: e.target.value }))}
                                    className="h-9 sm:h-10"
                                    data-autofocus
                                />
                            )}
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="aiometadata-uuid" className="text-xs font-semibold text-muted-foreground">
                                    UUID
                                </Label>
                                <Input
                                    id="aiometadata-uuid"
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder="e.g. abc123def456"
                                    value={importForm.uuid}
                                    onChange={(e) => setImportForm(prev => ({ ...prev, uuid: e.target.value }))}
                                    className="h-9 sm:h-10 font-mono text-xs"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="aiometadata-password" className="text-xs font-semibold text-muted-foreground">
                                    Password
                                </Label>
                                <Input
                                    id="aiometadata-password"
                                    type="password"
                                    autoComplete="off"
                                    placeholder="AIOMetadata password"
                                    value={importForm.password}
                                    onChange={(e) => setImportForm(prev => ({ ...prev, password: e.target.value }))}
                                    className="h-9 sm:h-10"
                                />
                            </div>
                        </div>

                        <div data-theme-part="panel" className="rounded-xl border border-border/30 bg-muted/15 p-1">
                            <button
                                type="button"
                                data-theme-part="button"
                                onClick={() => setShowAddonPassword(s => !s)}
                                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                            >
                                <span>Advanced: addon password</span>
                                {showAddonPassword ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>
                            <AnimatePresence initial={false}>
                                {showAddonPassword && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                        className="overflow-hidden"
                                    >
                                        <div className="p-2.5 pt-2">
                                            <Input
                                                type="password"
                                                autoComplete="off"
                                                placeholder="Addon password (optional)"
                                                value={importForm.addonPassword}
                                                onChange={(e) => setImportForm(prev => ({ ...prev, addonPassword: e.target.value }))}
                                                className="h-9"
                                            />
                                            <p className="mt-1.5 text-xs text-muted-foreground/70">
                                                Only needed if your AIOMetadata instance is protected with an addon-level password.
                                            </p>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        <div data-theme-tone="status" data-theme-part="panel" className="flex items-start gap-2 rounded-xl border border-info/25 bg-info/8 p-2 sm:p-2.5 text-xs text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                            <span>Your AIOMetadata password is used once to fetch your keys, then discarded. It is never stored on the AIOManager server.</span>
                        </div>

                        <AnimatePresence initial={false}>
                            {importError && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-2 sm:p-2.5 text-xs text-destructive"
                                    data-theme-part="panel"
                                >
                                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                    <span>{importError}</span>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <DialogFooter>
                        <Button
                            variant="subtle"
                            onClick={() => { if (!importing) setShowImportDialog(false) }}
                            disabled={importing}
                            ripple={false}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="default"
                            onClick={handleImport}
                            disabled={importing || !importForm.url.trim() || !importForm.uuid.trim() || !importForm.password}
                            ripple={false}
                        >
                            {importing ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Importing...
                                </>
                            ) : (
                                <>
                                    <Download className="h-3.5 w-3.5" />
                                    Import keys
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmationDialog
                open={!!deletingProvider}
                onOpenChange={(open) => { if (!open && !deleteInProgress) setDeletingProvider(null) }}
                title="Remove this key?"
                description={
                    deletingProvider
                        ? `The ${PROVIDER_OPTIONS.find(o => o.id === deletingProvider)?.label || deletingProvider.toUpperCase()} key will be deleted from the server. Features depending on it will stop working until you add it again.`
                        : ''
                }
                confirmText="Remove key"
                isDestructive
                isLoading={deleteInProgress}
                onConfirm={handleConfirmDelete}
            />
        </section>
    )
}
