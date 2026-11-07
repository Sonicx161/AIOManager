import { useState, useCallback, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { CopyButton } from '@/components/ui/copy-button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { KNOWN_AIOMETADATA_INSTANCES, mergeInstanceOptions } from '@/lib/known-instances'
import { useToast } from '@/hooks/use-toast'
import { useAccountStore } from '@/store/accountStore'
import {
    createAIOMetadataUser,
    saveAIOMetadataPassword,
    fetchAIOMetadataStatus,
    isAIOMetadataAddon,
    parseAIOMetadataUrl,
    sanitizeAIOMetadataConfigForCreate,
} from '@/lib/aiometadata-utils'
import { cn } from '@/lib/utils'
import { mapConcurrent } from '@/lib/concurrency'
import { useNavigate } from 'react-router-dom'
import { Plus, Loader2, Check, AlertTriangle, UserPlus, Eye, EyeOff, Users, Info } from 'lucide-react'
import { maskSecretUrl } from '@/lib/mask-secret-url'

interface AIOMetadataActionsTabProps {
    sourceConfig: Record<string, unknown>
    baseUrl: string
    targetOptions: { baseUrl: string }[]
    requiresAddonPassword?: boolean
}

interface BatchResult {
    accountId: string
    accountName: string
    success: boolean
    uuid?: string
    installUrl?: string
    error?: string
}

const BATCH_CONCURRENCY = 4

export function AIOMetadataActionsTab({ sourceConfig, baseUrl, targetOptions, requiresAddonPassword = false }: AIOMetadataActionsTabProps) {
    const { toast } = useToast()
    const navigate = useNavigate()
    const accounts = useAccountStore(s => s.accounts)
    const installAddonToAccount = useAccountStore(s => s.installAddonToAccount)

    const accountById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])

    const instanceUrls = useMemo(() => {
        const urls = new Set<string>([baseUrl])
        targetOptions.forEach(t => urls.add(t.baseUrl))
        return Array.from(urls)
    }, [baseUrl, targetOptions])

    const selectOptions = useMemo(
        () => mergeInstanceOptions(instanceUrls, KNOWN_AIOMETADATA_INSTANCES),
        [instanceUrls]
    )

    const [createBaseUrl, setCreateBaseUrl] = useState(baseUrl)
    const [customUrl, setCustomUrl] = useState('')
    const [useCustomUrl, setUseCustomUrl] = useState(false)
    const [addonPassword, setAddonPassword] = useState('')
    const [prefillConfig, setPrefillConfig] = useState(true)

    const [createPassword, setCreatePassword] = useState('')
    const [showCreatePassword, setShowCreatePassword] = useState(false)
    const [creating, setCreating] = useState(false)
    const [createResult, setCreateResult] = useState<{ uuid: string; installUrl: string } | null>(null)
    const [createError, setCreateError] = useState('')
    const [addingToAccount, setAddingToAccount] = useState<string | null>(null)
    const [addedAccountIds, setAddedAccountIds] = useState<Set<string>>(new Set())

    const [batchMode, setBatchMode] = useState(false)
    const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
    const [batchPassword, setBatchPassword] = useState('')
    const [showBatchPassword, setShowBatchPassword] = useState(false)
    const [batchCreating, setBatchCreating] = useState(false)
    const [batchResults, setBatchResults] = useState<BatchResult[]>([])

    const sourceLocationRef = useRef(`${window.location.pathname}${window.location.search}`)
    const activeBaseUrl = useCustomUrl ? customUrl.trim() : createBaseUrl
    const addonPwd = addonPassword.trim() || undefined

    const handleCreate = useCallback(async () => {
        if (creating || !activeBaseUrl || !createPassword.trim()) return
        setCreating(true)
        setCreateError('')
        setCreateResult(null)
        setAddedAccountIds(new Set())
        try {
            const password = createPassword.trim()
            if (!(await fetchAIOMetadataStatus(activeBaseUrl))) throw new Error('Instance unreachable')
            const config = prefillConfig ? sanitizeAIOMetadataConfigForCreate(sourceConfig) : {}
            const result = await createAIOMetadataUser(activeBaseUrl, password, config, addonPwd)
            setCreateResult(result)
            try { await saveAIOMetadataPassword(activeBaseUrl, result.uuid, password) } catch {}
            toast({ title: 'User created', description: `UUID: ${result.uuid.slice(0, 8)}…` })
        } catch (e: unknown) {
            setCreateError(e instanceof Error ? e.message : 'Failed to create user')
        } finally {
            setCreating(false)
        }
    }, [creating, activeBaseUrl, createPassword, prefillConfig, sourceConfig, addonPwd, toast])

    const handleAddToAccount = useCallback(async (accountId: string) => {
        if (!createResult) return
        setAddingToAccount(accountId)
        const sourceLocation = sourceLocationRef.current
        try {
            await installAddonToAccount(accountId, createResult.installUrl)
            if (`${window.location.pathname}${window.location.search}` !== sourceLocation) navigate(sourceLocation, { replace: true })
            setAddedAccountIds(prev => new Set(prev).add(accountId))
            const acc = accountById.get(accountId)
            toast({ title: 'Addon installed', description: `Added to ${acc?.name || acc?.email || accountId}` })
        } catch (e: unknown) {
            toast({ title: 'Install failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' })
        } finally {
            setAddingToAccount(null)
        }
    }, [createResult, installAddonToAccount, accountById, navigate, toast])

    const toggleBatchAccount = (accountId: string) => setBatchSelected(prev => {
        const next = new Set(prev)
        if (next.has(accountId)) next.delete(accountId); else next.add(accountId)
        return next
    })

    const handleBatchCreate = useCallback(async () => {
        if (batchCreating || !activeBaseUrl || !batchPassword.trim() || batchSelected.size === 0) return
        setBatchCreating(true)
        setBatchResults([])
        if (!(await fetchAIOMetadataStatus(activeBaseUrl))) {
            setBatchCreating(false)
            toast({ title: 'Instance unreachable', description: `Could not connect to ${activeBaseUrl}`, variant: 'destructive' })
            return
        }

        const skipped: BatchResult[] = []
        const toCreate: string[] = []
        for (const accountId of batchSelected) {
            const acc = accountById.get(accountId)
            const accountName = acc?.name || acc?.email || accountId
            const alreadyHas = (acc?.addons || []).some(a => {
                if (!isAIOMetadataAddon(a)) return false
                return parseAIOMetadataUrl(a.transportUrl)?.baseUrl === activeBaseUrl
            })
            if (alreadyHas) skipped.push({ accountId, accountName, success: false, error: 'Already has addon from this instance' })
            else toCreate.push(accountId)
        }

        const password = batchPassword.trim()
        const sourceLocation = sourceLocationRef.current
        const config = prefillConfig ? sanitizeAIOMetadataConfigForCreate(sourceConfig) : {}

        const created = await mapConcurrent(toCreate, BATCH_CONCURRENCY, async (accountId): Promise<BatchResult> => {
            const acc = accountById.get(accountId)
            const accountName = acc?.name || acc?.email || accountId
            try {
                const result = await createAIOMetadataUser(activeBaseUrl, password, JSON.parse(JSON.stringify(config)), addonPwd)
                try { await saveAIOMetadataPassword(activeBaseUrl, result.uuid, password) } catch {}
                try {
                    await installAddonToAccount(accountId, result.installUrl)
                    if (`${window.location.pathname}${window.location.search}` !== sourceLocation) navigate(sourceLocation, { replace: true })
                } catch (e: unknown) {
                    return { accountId, accountName, success: false, uuid: result.uuid, installUrl: result.installUrl, error: `User created, install failed: ${e instanceof Error ? e.message : 'Unknown error'}` }
                }
                return { accountId, accountName, success: true, uuid: result.uuid }
            } catch (e: unknown) {
                return { accountId, accountName, success: false, error: e instanceof Error ? e.message : 'Unknown error' }
            }
        })

        const results = [...skipped, ...created]
        setBatchResults(results)
        setBatchCreating(false)
        const successCount = results.filter(r => r.success).length
        const failCount = results.filter(r => !r.success).length
        toast({
            title: failCount === 0 ? 'Batch create complete' : 'Batch create partially complete',
            description: `${successCount} created, ${failCount} skipped or failed`,
            variant: failCount > 0 ? 'destructive' : undefined,
        })
    }, [batchCreating, activeBaseUrl, batchPassword, batchSelected, prefillConfig, sourceConfig, accountById, addonPwd, installAddonToAccount, navigate, toast])

    const InstancePicker = (
        <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase">Instance</label>
            {useCustomUrl ? (
                <div className="space-y-1.5">
                    <Input placeholder="https://your-instance.com" value={customUrl} onChange={e => setCustomUrl(e.target.value)} className="h-11 font-mono text-sm" />
                    <button type="button" data-theme-part="button" onClick={() => setUseCustomUrl(false)} className="text-xs text-primary hover:underline">Known instance</button>
                </div>
            ) : (
                <div className="space-y-1.5">
                    <Select value={createBaseUrl} onValueChange={setCreateBaseUrl}>
                        <SelectTrigger className="h-11 font-mono text-sm"><SelectValue placeholder="Select instance" /></SelectTrigger>
                        <SelectContent>
                            {selectOptions.map(o => <SelectItem key={o.value} value={o.value}><span className="font-mono text-xs truncate max-w-[250px]">{o.label}</span></SelectItem>)}
                        </SelectContent>
                    </Select>
                    <button type="button" data-theme-part="button" onClick={() => setUseCustomUrl(true)} className="text-xs text-primary hover:underline">Custom URL…</button>
                </div>
            )}
        </div>
    )

    const AddonPasswordField = requiresAddonPassword || useCustomUrl ? (
        <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase">Addon password {requiresAddonPassword ? '' : '(if required)'}</label>
            <Input type="password" placeholder="Instance addon password" value={addonPassword} onChange={e => setAddonPassword(e.target.value)} className="h-11 text-sm" />
        </div>
    ) : null

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-2">
                <p className="text-xs font-medium text-muted-foreground uppercase">User creation tools</p>
                <button type="button" data-theme-part="button" onClick={() => setBatchMode(!batchMode)} className="text-xs text-primary hover:underline ml-auto">
                    {batchMode ? 'Single user' : 'Batch create'}
                </button>
            </div>

            {!batchMode ? (
                <div className="space-y-4">
                    {InstancePicker}
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground uppercase">Password</label>
                        <div className="relative">
                            <Input type={showCreatePassword ? 'text' : 'password'} placeholder="Password for the new user" value={createPassword}
                                onChange={e => { setCreatePassword(e.target.value); setCreateError('') }} className="h-11 font-mono text-sm pr-9" aria-label="New user password" />
                            <Button type="button" variant="ghost" size="icon" tabIndex={-1}
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => setShowCreatePassword(v => !v)} aria-label={showCreatePassword ? 'Hide password' : 'Show password'}>
                                {showCreatePassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    </div>
                    {AddonPasswordField}
                    <label className="flex items-center gap-2.5 cursor-pointer">
                        <Checkbox checked={prefillConfig} onCheckedChange={c => setPrefillConfig(c === true)} />
                        <span className="text-xs">Clone current config (without session fields)</span>
                    </label>

                    {createError && (
                        <div data-theme-tone="status" data-theme-part="panel" className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-3 py-2">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{createError}
                        </div>
                    )}

                    <Button onClick={handleCreate} disabled={creating || !activeBaseUrl || !createPassword.trim()} className="w-full gap-2 rounded-xl font-semibold text-xs">
                        {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        {creating ? 'Creating…' : 'Create User'}
                    </Button>

                    {createResult && (
                        <div data-theme-tone="status" data-theme-part="panel" className="bg-success/5 border border-success/20 rounded-2xl p-4 space-y-3">
                            <div className="flex items-center gap-2"><Check className="w-4 h-4 text-success" /><p className="text-xs font-bold text-success">User created</p></div>
                            <div className="space-y-2">
                                <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground uppercase">UUID</p>
                                    <div className="flex items-center gap-1.5"><p className="text-xs font-mono break-all">{createResult.uuid}</p><CopyButton value={createResult.uuid} iconSize={12} variant="ghost" /></div>
                                </div>
                                <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Install URL</p>
                                    <div className="flex items-start gap-1.5"><p className="text-xs font-mono break-all flex-1">{maskSecretUrl(createResult.installUrl)}</p><CopyButton value={createResult.installUrl} iconSize={12} variant="ghost" /></div>
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground flex items-center gap-1"><Check className="w-3 h-3 text-success" /> Password saved to vault.</p>
                            <div className="pt-3 border-t border-success/10 space-y-1.5">
                                <p className="text-xs font-medium text-muted-foreground uppercase">Add to Account</p>
                                {accounts.map(acc => {
                                    const isAdded = addedAccountIds.has(acc.id)
                                    const isAdding = addingToAccount === acc.id
                                    return (
                                        <button key={acc.id} type="button" data-theme-part="button" onClick={() => !isAdded && !isAdding && handleAddToAccount(acc.id)} disabled={isAdding || isAdded}
                                            className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-colors',
                                                isAdded ? 'bg-success/10 border-success/20 text-success' : 'border-border/30 hover:bg-muted/20')}>
                                            {isAdded ? <Check className="w-3.5 h-3.5" /> : isAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5 text-muted-foreground" />}
                                            <span className="font-semibold truncate">{acc.name || acc.email || acc.id}</span>
                                            {isAdded && <span className="text-xs ml-auto">Added</span>}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    {InstancePicker}
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground uppercase">Password for all users</label>
                        <div className="relative">
                            <Input type={showBatchPassword ? 'text' : 'password'} placeholder="Shared password" value={batchPassword}
                                onChange={e => setBatchPassword(e.target.value)} className="h-11 font-mono text-sm pr-9" aria-label="Batch user password" />
                            <Button type="button" variant="ghost" size="icon" tabIndex={-1}
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => setShowBatchPassword(v => !v)} aria-label={showBatchPassword ? 'Hide password' : 'Show password'}>
                                {showBatchPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    </div>
                    {AddonPasswordField}
                    <label className="flex items-center gap-2.5 cursor-pointer">
                        <Checkbox checked={prefillConfig} onCheckedChange={c => setPrefillConfig(c === true)} />
                        <span className="text-xs">Clone current config (without session fields)</span>
                    </label>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-muted-foreground uppercase">Accounts ({batchSelected.size} selected)</label>
                            <button type="button" data-theme-part="button" onClick={() => setBatchSelected(batchSelected.size === accounts.length ? new Set() : new Set(accounts.map(a => a.id)))} className="text-xs text-primary hover:underline">
                                {batchSelected.size === accounts.length ? 'Deselect all' : 'Select all'}
                            </button>
                        </div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                            {accounts.map(acc => {
                                const selected = batchSelected.has(acc.id)
                                return (
                                    <button key={acc.id} type="button" role="checkbox" aria-checked={selected} data-theme-part="button" data-state={selected ? 'active' : 'inactive'}
                                        aria-label={`${selected ? 'Deselect' : 'Select'} ${acc.name || acc.email || acc.id}`}
                                        onClick={() => toggleBatchAccount(acc.id)}
                                        className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-colors',
                                            selected ? 'border-primary/30 bg-primary/5' : 'border-border/30 hover:bg-muted/20')}>
                                        <div data-theme-part="checkbox" className={cn('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border/40')}>
                                            {selected && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3} />}
                                        </div>
                                        <span className="font-semibold truncate">{acc.name || acc.email || acc.id}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {batchResults.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-xs font-medium text-muted-foreground uppercase">Results</p>
                            {batchResults.map((r, i) => (
                                <div data-theme-tone="status" key={i} data-theme-part="panel" className={cn('flex items-center gap-2 px-3 py-2 rounded-lg border text-xs', r.success ? 'bg-success/5 border-success/20' : 'bg-destructive/5 border-destructive/20')}>
                                    <span className={r.success ? 'text-success' : 'text-destructive'}>{r.success ? '✓' : '✗'}</span>
                                    <span className="font-semibold truncate">{r.accountName}</span>
                                    {r.uuid && <span className="text-muted-foreground font-mono truncate">{r.uuid.slice(0, 8)}…</span>}
                                    {!r.success && r.error && <span className="text-destructive truncate ml-auto">{r.error}</span>}
                                    {r.installUrl && (
                                        <CopyButton value={r.installUrl} variant="ghost" aria-label={`Copy install URL for ${r.accountName}`}>
                                            <span className="ml-1 text-xs font-medium">Copy URL</span>
                                        </CopyButton>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    <Button onClick={handleBatchCreate} disabled={batchCreating || !activeBaseUrl || !batchPassword.trim() || batchSelected.size === 0} className="w-full gap-2 rounded-xl font-semibold text-xs">
                        {batchCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-3.5 h-3.5" />}
                        {batchCreating ? `Creating ${batchSelected.size} users…` : `Create and install for ${batchSelected.size} account${batchSelected.size !== 1 ? 's' : ''}`}
                    </Button>
                </div>
            )}

            <div className="border-t border-border/10 pt-6">
                <div data-theme-part="panel" className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/20 border border-border/30 rounded-xl px-3 py-2.5">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <p>AIOMetadata has no delete API. To remove a user, delete it from the AIOMetadata configure page; removing the addon here only detaches it from the account.</p>
                </div>
            </div>
        </div>
    )
}
