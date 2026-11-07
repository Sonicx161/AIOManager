import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, KeyRound, Loader2, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { StatusChip } from '@/components/ui/status-chip'
import { OperationProgress } from '@/components/ui/operation-progress'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { AddonIcon } from '@/components/ui/addon-icon'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getAccountEmail, useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useVaultStore } from '@/store/vaultStore'
import { useUIStore } from '@/store/uiStore'
import { cn, maskEmailLevel, maskNameLevel, maskUrlLevel } from '@/lib/utils'
import { useConnectionStore } from '@/store/connectionStore'
import { captureSyncOwnership, type SyncOwnership } from '@/store/sync-store-helpers'
import { decrypt, encrypt } from '@/lib/crypto'
import { fetchAIOStreamsStatus, fetchAIOStreamsUser, getStoredAIOStreamsPassword, isAIOStreamsAddon, parseAIOStreamsUrl, sanitizeAIOStreamsConfigForUpdate, updateAIOStreamsUser } from '@/lib/aiostreams-utils'
import { fetchAIOMetadataConfig, getStoredAIOMetadataPassword, isAIOMetadataAddon, parseAIOMetadataUrl, updateAIOMetadataConfig } from '@/lib/aiometadata-utils'
import { getAIOMetadataConfigVersion } from '@/lib/aiometadata-config-safety'
import { applyHouseholdSetupPlan, buildHouseholdSetupPlan, configRecords, readHouseholdCapabilities, type HouseholdConfig, type HouseholdSetupPlan, type HouseholdStageResult } from '@/lib/household-setup'
import { openJellyfinSecret, sealJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { normalizeJellyfinUrl, type JellyfinSession } from '@/lib/jellyfin/session'
import type { Account } from '@/types/account'
import { JellyfinSetupDialog } from './JellyfinSetupDialog'
import { friendlyError } from './friendly-error'

const UNREACHABLE = 'Could not reach the AIOStreams or AIOMetadata server. Check its address and your connection, then try again.'

interface ConfigOption { key: string; accountId: string; accountName: string; baseUrl: string; uuid: string; installUrl: string; name: string; logo?: string }
function configOptions(accounts: Account[], service: 'aiostreams' | 'aiometadata'): ConfigOption[] {
    return accounts.flatMap(account => account.addons.flatMap((addon, index) => {
        if (!(service === 'aiostreams' ? isAIOStreamsAddon(addon) : isAIOMetadataAddon(addon))) return []
        const parsed = service === 'aiostreams' ? parseAIOStreamsUrl(addon.transportUrl) : parseAIOMetadataUrl(addon.transportUrl)
        return parsed ? [{ ...parsed, key: `${account.id}:${index}`, accountId: account.id, accountName: account.name,
            installUrl: addon.transportUrl, name: addon.metadata?.customName || addon.manifest.name || serviceName(service),
            logo: addon.metadata?.customLogo || addon.manifest.logo }] : []
    }))
}
const asRecord = (value: unknown): HouseholdConfig => value && typeof value === 'object' && !Array.isArray(value) ? value as HouseholdConfig : {}
const serviceName = (service: string) => service === 'aiostreams' ? 'AIOStreams' : 'AIOMetadata'

interface Loaded {
    destination: HouseholdConfig; effectiveDestination: HouseholdConfig; metadata?: HouseholdConfig
    to: ConfigOption; metadataTo?: ConfigOption
    destinationPassword: string; metadataPassword: string; accessKey: string; addonPassword: string
    ownership: SyncOwnership
    capabilities: ReturnType<typeof readHouseholdCapabilities>
    reservedVariantIds: string[]
}

function HouseholdSetupFrame({ embedded, open, onOpenChange, children }: { embedded: boolean; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
    return embedded
        ? <section aria-label="Set up a person" className="flex min-w-0 flex-col gap-4">{children}</section>
        : <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl sm:max-h-[90dvh]">{children}</DialogContent></Dialog>
}

function SetupSecretInput({ id, label, value, onChange, descriptionId, placeholder }: {
    id: string; label: string; value: string; onChange: (value: string) => void
    descriptionId?: string; placeholder: string
}) {
    const [visible, setVisible] = useState(false)
    return <div className="relative">
        <Input id={id} aria-label={label} aria-describedby={descriptionId} type={visible ? 'text' : 'password'} autoComplete="off" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} className="pr-12" />
        <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`} aria-controls={id} aria-pressed={visible} onClick={() => setVisible(previous => !previous)}>
            {visible ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
        </Button>
    </div>
}

function SetupPasswordField({ id, label, value, onChange, saved, vaultLocked, vaultLoading }: {
    id: string; label: string; value: string; onChange: (value: string) => void
    saved: boolean; vaultLocked: boolean; vaultLoading: boolean
}) {
    const [override, setOverride] = useState(false)
    const automatic = saved && !override && !value
    const status = vaultLoading ? 'Checking Vault…' : vaultLocked ? 'Vault locked · unlock to use saved passwords'
        : automatic ? 'Saved in Vault · used automatically' : saved ? 'Using an override for this setup' : 'No password saved in Vault'
    return <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0 space-y-1">
                <Label htmlFor={automatic ? undefined : id}>{label}</Label>
                <p id={`${id}-status`} role="status" className="flex items-center gap-1.5 text-xs leading-relaxed text-muted-foreground">
                    {automatic && <KeyRound aria-hidden="true" className="h-3 w-3 shrink-0 text-primary" />}{status}
                </p>
            </div>
            {saved && !vaultLocked && <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => {
                if (automatic) setOverride(true)
                else { onChange(''); setOverride(false) }
            }}>{automatic ? 'Override for this setup' : 'Use Vault password'}</Button>}
        </div>
        {!automatic && <SetupSecretInput id={id} label={label} descriptionId={`${id}-status`} value={value} onChange={onChange} placeholder={saved ? 'Enter an override password' : 'Enter a password, if required'} />}
    </div>
}

function SetupPanelEyebrow({ children }: { children: ReactNode }) {
    return <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>
}

function SetupPanelHeader({ eyebrow, requirement, requirementVariant = 'muted' }: { eyebrow: string; requirement: string; requirementVariant?: 'muted' | 'primary' }) {
    return <div className="flex items-center justify-between gap-2"><SetupPanelEyebrow>{eyebrow}</SetupPanelEyebrow><StatusChip size="sm" variant={requirementVariant}>{requirement}</StatusChip></div>
}

function SetupRouteLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{icon}<span className="min-w-0 flex-1">{children}</span></div>
}

export function HouseholdSetupDialog({ accountId, open, onOpenChange, embedded = false, onSavingChange }: { accountId: string; open: boolean; onOpenChange: (open: boolean) => void; embedded?: boolean; onSavingChange?: (saving: boolean) => void }) {
    const accounts = useAccountStore(state => state.accounts)
    const options = useMemo(() => configOptions(accounts, 'aiostreams'), [accounts])
    const destinations = useMemo(() => options.filter(option => option.accountId === accountId), [options, accountId])
    const metadataOptions = useMemo(() => configOptions(accounts, 'aiometadata'), [accounts])
    const vaultKeys = useVaultStore(state => state.keys)
    const vaultLocked = useVaultStore(state => state.isLocked)
    const vaultLoading = useVaultStore(state => state.loading)
    const privacy = useUIStore(state => state.isPrivacyModeEnabled)
    const nameLevel = useUIStore(state => state.privacyLevelNames)
    const emailLevel = useUIStore(state => state.privacyLevelEmail)
    const urlLevel = useUIStore(state => state.privacyLevelUrls)
    const [destinationKey, setDestinationKey] = useState(destinations[0]?.key || '')
    const [metadataKey, setMetadataKey] = useState('')
    const [metadataUrl, setMetadataUrl] = useState('')
    const [destinationPassword, setDestinationPassword] = useState('')
    const [metadataPassword, setMetadataPassword] = useState('')
    const [accessKey, setAccessKey] = useState('')
    const [addonPassword, setAddonPassword] = useState('')
    const [loaded, setLoaded] = useState<Loaded | null>(null)
    const [personName, setPersonName] = useState('')
    const [createVariant, setCreateVariant] = useState(false)
    const [variantName, setVariantName] = useState('')
    const [variantScript, setVariantScript] = useState('')
    const [memberId, setMemberId] = useState('')
    const [metadataMemberId, setMetadataMemberId] = useState('')
    const [plan, setPlan] = useState<HouseholdSetupPlan | null>(null)
    const [results, setResults] = useState<HouseholdStageResult[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [link, setLink] = useState<{ baseUrl: string; username: string; userName: string; accountId: string } | null>(null)
    const [linked, setLinked] = useState<string[]>([])
    const [linkAccountId, setLinkAccountId] = useState(accountId)
    const [showCredentials, setShowCredentials] = useState(false)
    const savedPasswords = useMemo(() => {
        if (vaultLocked || vaultLoading || vaultKeys.length === 0) return { destination: false, metadata: false }
        const destination = destinations.find(option => option.key === destinationKey)
        const metadata = metadataKey === '@custom' ? parseAIOMetadataUrl(metadataUrl.trim()) : metadataOptions.find(option => option.key === metadataKey)
        return {
            destination: !!destination && !!getStoredAIOStreamsPassword(destination.baseUrl, destination.uuid),
            metadata: !!metadata && !!getStoredAIOMetadataPassword(metadata.baseUrl, metadata.uuid),
        }
    }, [vaultKeys, vaultLocked, vaultLoading, destinations, destinationKey, metadataOptions, metadataKey, metadataUrl])
    useEffect(() => { setDestinationPassword('') }, [destinationKey])
    useEffect(() => { setMetadataPassword('') }, [metadataKey, metadataUrl])
    const running = useRef(false)
    const writing = useRef(false)
    const generation = useRef(0)
    useEffect(() => () => { generation.current++ }, [])
    const close = (value: boolean) => { if (!writing.current) { generation.current++; onOpenChange(value) } }

    const load = async () => {
        if (running.current) return
        const to = destinations.find(option => option.key === destinationKey)
        let metadataTo = metadataOptions.find(option => option.key === metadataKey)
        if (!to) { setError('Choose an AIOStreams configuration.'); return }
        if (metadataKey === '@custom') {
            const parsed = parseAIOMetadataUrl(metadataUrl.trim())
            try {
                const url = new URL(metadataUrl.trim())
                if (!parsed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
                metadataTo = { ...parsed, key: '@custom', accountId: '', accountName: 'External configuration', installUrl: metadataUrl.trim(), name: 'AIOMetadata' }
            } catch { setError('Enter a valid AIOMetadata install URL, including /stremio/ and its configuration ID.'); return }
        } else if (metadataKey && !metadataTo) { setError('The selected AIOMetadata configuration is no longer available. Choose it again.'); return }
        const toPassword = destinationPassword || getStoredAIOStreamsPassword(to.baseUrl, to.uuid) || ''
        const metaPassword = metadataTo ? metadataPassword || getStoredAIOMetadataPassword(metadataTo.baseUrl, metadataTo.uuid) || '' : ''
        const ownership = captureSyncOwnership()
        const token = ++generation.current
        running.current = true; setBusy(true); setError('')
        try {
            const [destination, metadata, status, effectiveDestination] = await Promise.all([
                fetchAIOStreamsUser(to.baseUrl, to.uuid, toPassword, { raw: true }),
                metadataTo ? fetchAIOMetadataConfig(metadataTo.baseUrl, metadataTo.uuid, metaPassword, addonPassword || undefined) : undefined,
                fetchAIOStreamsStatus(to.baseUrl),
                fetchAIOStreamsUser(to.baseUrl, to.uuid, toPassword),
            ])
            ownership.assert()
            if (generation.current !== token) return
            const capabilities = readHouseholdCapabilities(status, effectiveDestination.userData)
            if (metadata && getAIOMetadataConfigVersion(metadata) === null) throw new Error('This AIOMetadata instance cannot protect this update from concurrent edits. Update the instance and load again.')
            const rawPersonas = configRecords(asRecord(destination.userData.jellyfin).personas)
            const inheritedPersonas = configRecords(asRecord(effectiveDestination.userData.jellyfin).personas).filter(p => !rawPersonas.some(raw => raw.id === p.id))
            if (inheritedPersonas.length > 0) throw new Error('This config inherits household users from its parent. Set up the person in that parent configuration to preserve its existing users.')
            setLoaded({ destination: destination.userData, effectiveDestination: effectiveDestination.userData, metadata, to, metadataTo,
                destinationPassword: toPassword, metadataPassword: metaPassword, accessKey, addonPassword, ownership, capabilities,
                reservedVariantIds: configRecords(effectiveDestination.userData.variants).map(v => String(v.id)) })
            setPersonName(''); setVariantName(''); setVariantScript(''); setCreateVariant(false)
            setLinkAccountId(accountId)
            setMemberId(''); setMetadataMemberId(''); setPlan(null); setResults([])
            setDestinationPassword(''); setMetadataPassword(''); setAccessKey(''); setAddonPassword('')
        } catch (err) { if (generation.current === token) setError(friendlyError(err, 'Could not load these configurations.', UNREACHABLE)) }
        finally { running.current = false; if (generation.current === token) setBusy(false) }
    }

    const preview = () => {
        if (!loaded) return
        setError('')
        try {
            loaded.ownership.assert()
            setPlan(buildHouseholdSetupPlan({ destination: loaded.destination, effectiveDestination: loaded.effectiveDestination, metadata: loaded.metadata,
                personName, variant: createVariant ? { name: variantName, script: variantScript } : undefined,
                memberId: memberId || undefined, metadataMemberId: metadataMemberId || undefined, installUrl: loaded.to.installUrl,
                ...loaded.capabilities, reservedVariantIds: loaded.reservedVariantIds }))
            setResults([])
        } catch (err) { setError(friendlyError(err, 'Could not build this preview.', UNREACHABLE)) }
    }

    const save = async () => {
        if (!loaded || !plan || running.current) return
        running.current = true; writing.current = true; setBusy(true); setError('')
        onSavingChange?.(true)
        try {
            loaded.ownership.assert()
            await applyHouseholdSetupPlan(plan, {
                aiostreams: {
                    load: async () => { loaded.ownership.assert(); const value = await fetchAIOStreamsUser(loaded.to.baseUrl, loaded.to.uuid, loaded.destinationPassword, { raw: true }); loaded.ownership.assert(); return value.userData },
                    loadEffective: async () => { loaded.ownership.assert(); const value = await fetchAIOStreamsUser(loaded.to.baseUrl, loaded.to.uuid, loaded.destinationPassword); loaded.ownership.assert(); return value.userData },
                    save: async next => { loaded.ownership.assert(); await updateAIOStreamsUser(loaded.to.baseUrl, loaded.to.uuid, loaded.destinationPassword, sanitizeAIOStreamsConfigForUpdate(next), { instanceAccessKey: loaded.accessKey || undefined }); loaded.ownership.assert() },
                },
                aiometadata: loaded.metadataTo ? {
                    load: async () => { loaded.ownership.assert(); const value = await fetchAIOMetadataConfig(loaded.metadataTo!.baseUrl, loaded.metadataTo!.uuid, loaded.metadataPassword, loaded.addonPassword || undefined); loaded.ownership.assert(); return value },
                    save: async (next, base) => {
                        loaded.ownership.assert()
                        const baseVersion = getAIOMetadataConfigVersion(base)
                        if (baseVersion === null) throw new Error('This AIOMetadata instance did not return a config version. Update the instance before setting up a household user.')
                        await updateAIOMetadataConfig(loaded.metadataTo!.baseUrl, loaded.metadataTo!.uuid, loaded.metadataPassword, next, loaded.addonPassword || undefined, { baseVersion })
                        loaded.ownership.assert()
                    },
                } : undefined,
            }, result => { loaded.ownership.assert(); setResults(previous => [...previous.filter(p => p.service !== result.service), result]) })
        } catch (err) { setError(friendlyError(err, 'Setup could not be completed.', UNREACHABLE)) }
        finally { running.current = false; writing.current = false; setBusy(false); onSavingChange?.(false) }
    }

    const saveConnection = async (session: JellyfinSession) => {
        if (!loaded || !link) return
        loaded.ownership.assert()
        if (session.secret.baseUrl !== normalizeJellyfinUrl(link.baseUrl)) throw new Error('Sign in using the server address from this setup before saving the connection.')
        if (session.identity.userName.trim().toLowerCase() !== link.userName.trim().toLowerCase()) throw new Error('The server signed in as a different user. Choose the household user shown in the setup result.')
        const key = useAuthStore.getState().encryptionKey
        if (!key) throw new Error('Unlock your vault before saving a connection.')
        const account = useAccountStore.getState().accounts.find(a => a.id === link.accountId)
        if (!account) throw new Error('The AIOManager account was removed. Choose an account again.')
        for (const connection of account.connections || []) {
            if (connection.platform !== 'jellyfin' || connection.mediaServer?.userId !== session.identity.userId) continue
            const secret = await openJellyfinSecret(connection, value => decrypt(value, key)).catch(() => null)
            loaded.ownership.assert()
            if (secret?.baseUrl === session.secret.baseUrl) throw new Error('This user is already connected to the selected AIOManager account.')
        }
        const credentials = await sealJellyfinSecret(session.secret, value => encrypt(value, key))
        const assertCurrent = () => {
            loaded.ownership.assert()
            if (useAuthStore.getState().encryptionKey !== key) throw new Error('The vault changed while saving. Unlock it and try again.')
        }
        assertCurrent()
        await useConnectionStore.getState().addConnection(account.id, { credentials, mediaServer: session.identity, displayName: session.identity.productName,
            status: 'active', platform: 'jellyfin', connectionType: 'native', enabled: true, capabilities: [] }, { assertCurrent })
        setLinked(previous => [...previous, session.identity.productName])
    }

    const completed = !!plan && results.filter(result => result.status === 'verified').length === (plan.aiometadata ? 2 : 1)
    const hasFailure = results.some(result => result.status === 'failed')
    const verifiedServices = results.filter(result => result.status === 'verified').length
    const totalServices = plan?.aiometadata ? 2 : 1
    const savingService = results.find(result => result.status === 'saving')?.service
    const personas = configRecords(asRecord(loaded?.destination.jellyfin).personas)
    const primaryName = asRecord(asRecord(loaded?.destination.jellyfin).primary).name
    const metadataMembers = configRecords(loaded?.metadata?.jellyfinUsers)
    const privateName = (value: string) => value.includes('@') ? maskEmailLevel(value, privacy ? emailLevel : 0) : maskNameLevel(value, privacy ? nameLevel : 0)
    const localAccountLabel = (account: Account) => privateName(account.name?.trim() || getAccountEmail(account) || 'Unnamed account')
    const linkAccount = accounts.find(account => account.id === linkAccountId)
    const configHost = (option: ConfigOption) => privacy && urlLevel > 0 ? maskUrlLevel(option.baseUrl, urlLevel).replace(/^https?:\/\//, '').replace(/\/+$/, '') : new URL(option.baseUrl).host
    const addonName = (option: ConfigOption) => /^(?:AIOStreams|AIOMetadata)$/i.test(option.name) ? option.name : privateName(option.name)
    const label = (option: ConfigOption) => `${addonName(option)} · ${privateName(option.accountName)} · ${configHost(option)}`
    const configChoice = (option: ConfigOption) => <span className="flex min-w-0 flex-1 items-center gap-3 text-left"><AddonIcon name={option.name} logo={option.logo} className="h-9 w-9 rounded-lg" /><span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]"><span className="block text-sm font-semibold">{addonName(option)}</span><span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{privateName(option.accountName)} · {configHost(option)}</span></span></span>
    const selectedDestination = destinations.find(option => option.key === destinationKey)
    const metadataPaired = !!metadataKey
    const metadataOption = metadataKey && metadataKey !== '@custom' ? metadataOptions.find(option => option.key === metadataKey) : undefined
    const currentStep = !loaded ? 0 : !plan ? 1 : 2

    return <>
        <HouseholdSetupFrame embedded={embedded} open={open} onOpenChange={close}>
                {embedded ? <div className="min-w-0">
                    <h3 className="sr-only">Set up a person</h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">{destinations.length} AIOStreams {destinations.length === 1 ? 'configuration' : 'configurations'}. Set up a person’s Jellyfin sign-in without switching between AIOStreams and AIOMetadata. Choose or create their user, optionally pair AIOMetadata, then attach the sign-in to a local account you manage.</p>
                </div> : <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><Users aria-hidden="true" className="h-4 w-4 text-primary" />Set up a person</DialogTitle>
                    <DialogDescription className="max-w-3xl leading-relaxed">Set up a person’s Jellyfin sign-in here, without switching between AIOStreams and AIOMetadata. Create or choose their user, optionally connect AIOMetadata for the library, then attach their sign-in to a local account you manage.</DialogDescription>
                </DialogHeader>}
                <ol aria-label="Household setup progress" className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5">
                    {['Configurations', 'Person', 'Review & save'].map((step, index) => {
                        const done = completed || index < currentStep
                        return <li key={step} aria-current={index === currentStep && !completed ? 'step' : undefined} className="flex items-center gap-1">
                            <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs', done ? 'border-success/25 bg-success/10 text-success' : index === currentStep ? 'border-primary/25 bg-primary/10 font-medium text-foreground' : 'border-border/40 bg-muted/30 text-muted-foreground')}>
                                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums', done ? 'bg-success/20' : index === currentStep ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{done ? <Check aria-hidden="true" className="h-2.5 w-2.5" /> : index + 1}</span>{step}
                            </span>
                            {index < 2 && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
                        </li>
                    })}
                </ol>
                <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-1 text-sm">
                    {!loaded ? <fieldset disabled={busy} className="@container space-y-4"><div className="grid min-w-0 gap-3 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                        <div data-theme-part="panel" className="min-w-0 space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm"><div className="space-y-1.5"><SetupPanelHeader eyebrow="Playback base" requirement="Required" /><Label htmlFor="household-destination" className="block font-semibold">AIOStreams configuration</Label><p className="text-xs leading-relaxed text-muted-foreground">Choose the configuration this person will use for playback.</p></div><Select disabled={busy} value={destinationKey} onValueChange={setDestinationKey}><SelectTrigger id="household-destination" className="h-auto min-h-14 gap-3 py-2.5 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left [&>span]:line-clamp-none"><SelectValue placeholder="Choose an AIOStreams configuration" /></SelectTrigger><SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">{destinations.map(option => <SelectItem key={option.key} value={option.key} textValue={label(option)} className="py-2.5 [&>span:last-child]:block [&>span:last-child]:min-w-0 [&>span:last-child]:w-full">{configChoice(option)}</SelectItem>)}</SelectContent></Select>{selectedDestination ? <SetupRouteLine icon={<AddonIcon name={selectedDestination.name} logo={selectedDestination.logo} className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px]" />}>Playback for this person comes from the selected AIOStreams configuration.</SetupRouteLine> : destinations.length === 0 ? <p className="text-xs leading-relaxed text-muted-foreground">This account has no AIOStreams configurations yet.</p> : null}</div>
                        <div data-theme-part="panel" className="min-w-0 space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm"><div className="space-y-1.5"><SetupPanelHeader eyebrow="Library pairing" requirement="Optional" /><Label htmlFor="household-metadata" className="block font-semibold">Connect AIOMetadata</Label><p className="max-w-prose text-xs leading-relaxed text-muted-foreground">Use AIOMetadata for their library with AIOStreams for playback. Choose a configuration you manage, or supply their existing install URL. We’ll create or choose a user there and set that user’s playback source.</p></div><Select disabled={busy} value={metadataKey || '@none'} onValueChange={value => setMetadataKey(value === '@none' ? '' : value)}><SelectTrigger id="household-metadata" className="h-auto min-h-14 gap-3 py-2.5 [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left [&>span]:line-clamp-none"><SelectValue /></SelectTrigger><SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]"><SelectItem value="@none" className="py-2">Use AIOStreams on its own</SelectItem>{metadataOptions.map(option => <SelectItem key={option.key} value={option.key} textValue={label(option)} className="py-2.5 [&>span:last-child]:block [&>span:last-child]:min-w-0 [&>span:last-child]:w-full">{configChoice(option)}</SelectItem>)}<SelectItem value="@custom" className="py-2">Use another AIOMetadata configuration…</SelectItem></SelectContent></Select>{metadataKey === '@custom' && <div className="space-y-2 border-t border-border/40 pt-3"><Label htmlFor="household-metadata-url" className="block">AIOMetadata install URL</Label><Input id="household-metadata-url" type="url" autoComplete="off" spellCheck={false} placeholder="https://your-instance/stremio/config-id/manifest.json" value={metadataUrl} onChange={event => setMetadataUrl(event.target.value)} /><p className="text-xs leading-relaxed text-muted-foreground">Use an existing configuration you have permission to edit. Its password is read from your Vault when available, or you can enter it below.</p></div>}<SetupRouteLine icon={metadataOption ? <AddonIcon name={metadataOption.name} logo={metadataOption.logo} className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px]" /> : metadataPaired ? <AddonIcon name="AIOMetadata" className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px]" /> : <AddonIcon name={selectedDestination?.name || 'AIOStreams'} logo={selectedDestination?.logo} className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px]" />}>{metadataPaired ? 'Library pairs with AIOMetadata; playback still comes from AIOStreams.' : 'No pairing yet. The person uses AIOStreams on its own.'}</SetupRouteLine></div>
                    </div>
                        <details open={showCredentials} onToggle={event => setShowCredentials(event.currentTarget.open)} data-theme-part="panel" className="group overflow-hidden rounded-2xl border border-border/40 bg-card shadow-sm">
                            <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/30 text-muted-foreground"><KeyRound aria-hidden="true" className="h-4 w-4" /></span>
                                <span className="min-w-0 flex-1 text-sm font-semibold">Passwords &amp; instance access</span>
                                <StatusChip size="sm">Uses your Vault</StatusChip>
                                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-4 border-t border-border/40 px-4 py-4">
                                <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">Saved configuration passwords are used automatically while your Vault is unlocked. Overrides apply only to this setup and are not saved to the Vault.</p>
                                <SetupPasswordField key={`destination:${destinationKey}`} id="household-destination-password" label="Shared configuration password" value={destinationPassword} onChange={setDestinationPassword} saved={savedPasswords.destination} vaultLocked={vaultLocked} vaultLoading={vaultLoading} />
                                <div className="space-y-2 border-t border-border/40 pt-4"><Label htmlFor="household-instance-access" className="block">AIOStreams instance access key <span className="font-normal text-muted-foreground">· if required</span></Label><SetupSecretInput id="household-instance-access" label="AIOStreams instance access key" value={accessKey} onChange={setAccessKey} placeholder="Enter the instance access key" /></div>
                                {metadataKey && <>
                                    <SetupPasswordField key={`metadata:${metadataKey}:${metadataUrl}`} id="household-metadata-password" label="AIOMetadata configuration password" value={metadataPassword} onChange={setMetadataPassword} saved={savedPasswords.metadata} vaultLocked={vaultLocked} vaultLoading={vaultLoading} />
                                    <div className="space-y-2"><Label htmlFor="household-metadata-instance-password" className="block">AIOMetadata instance password <span className="font-normal text-muted-foreground">· if required</span></Label><SetupSecretInput id="household-metadata-instance-password" label="AIOMetadata instance password" value={addonPassword} onChange={setAddonPassword} placeholder="Enter the instance password" /></div>
                                </>}
                            </div>
                        </details>
                        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">Users share this configuration’s playback settings and services. Choose a configuration you’re comfortable sharing.</p>
                    </fieldset> : !plan ? <fieldset disabled={busy} className="space-y-4">
                        <div data-theme-part="panel" className="min-w-0 rounded-2xl border border-border/40 bg-card p-3 shadow-sm">{configChoice(loaded.to)}</div>
                        <div className="space-y-1.5"><Label htmlFor="household-name">Person’s name</Label><Input id="household-name" value={personName} maxLength={32} onChange={e => { if (variantName === personName) setVariantName(e.target.value); setPersonName(e.target.value) }} /></div>
                        <div className="space-y-1.5"><Label htmlFor="household-member">AIOStreams user</Label><Select disabled={busy} value={memberId || '@new'} onValueChange={value => setMemberId(value === '@new' ? '' : value)}><SelectTrigger id="household-member"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="@new">Create a separate user</SelectItem>{typeof primaryName === 'string' && primaryName.trim() && <SelectItem value="@primary">{privateName(primaryName)} · primary user</SelectItem>}{personas.map(person => <SelectItem key={String(person.id)} value={String(person.id)}>{privateName(String(person.name))}</SelectItem>)}</SelectContent></Select></div>
                        {loaded.metadata && <div className="space-y-1.5"><Label htmlFor="household-metadata-member">AIOMetadata user</Label><Select disabled={busy} value={metadataMemberId || '@new'} onValueChange={value => setMetadataMemberId(value === '@new' ? '' : value)}><SelectTrigger id="household-metadata-member"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="@new">Create a separate user</SelectItem>{metadataMembers.map(person => <SelectItem key={String(person.id)} value={String(person.id)}>{privateName(String(person.name))}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">This user belongs to {loaded.metadataTo ? label(loaded.metadataTo) : 'the selected configuration'}. Only this user’s playback source will be set.</p></div>}
                        <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm">
                            <div className="flex items-start gap-3"><Checkbox id="household-create-variant" checked={createVariant} disabled={busy || !loaded.capabilities.variantsAvailable} onCheckedChange={checked => setCreateVariant(checked === true)} className="mt-0.5 shrink-0" /><div className="min-w-0 space-y-1"><Label htmlFor="household-create-variant">Create a variant for this person <span className="font-normal text-muted-foreground">· optional, advanced</span></Label><p className="text-xs leading-relaxed text-muted-foreground">Use different playback filters, sorting or formatting. You can finish user setup without a new variant.</p></div></div>
                            {!loaded.capabilities.variantsAvailable && <p className="text-xs leading-relaxed text-muted-foreground">{loaded.capabilities.variantUnavailableReason} User setup is still available.</p>}
                            {createVariant && <div className="space-y-3 border-t border-border/40 pt-3">
                                <div className="space-y-1.5"><Label htmlFor="household-variant">Variant name</Label><Input id="household-variant" value={variantName} maxLength={64} onChange={e => setVariantName(e.target.value)} /></div>
                                <div className="space-y-1.5 text-xs"><Label htmlFor="household-variant-script">Variant rules (CEL)</Label><Textarea id="household-variant-script" aria-describedby="household-variant-help" value={variantScript} onChange={e => setVariantScript(e.target.value)} spellCheck={false} autoComplete="off" rows={5} className="resize-y font-mono text-xs" placeholder={'set resultLimits.global = 10\nset excludedResolutions = ["2160p"]'} /><p id="household-variant-help" className="text-xs leading-relaxed text-muted-foreground">These rules apply when this user signs in. Use the <a href="https://docs.aiostreams.viren070.me/reference/config-expressions/#quick-start" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">CEL reference</a> and AIOStreams’ variant preview to check their effect.</p></div>
                            </div>}
                        </div>
                    </fieldset> : <div className="space-y-4">
                        <div className="flex items-center gap-3"><Users className="h-7 w-7 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="break-words font-semibold">{privateName(plan.personName)}</p><p className="text-sm text-muted-foreground">{completed ? 'Setup verified' : hasFailure ? 'Setup needs attention' : 'Review this setup'}</p></div></div>
                        <div data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card p-3 shadow-sm">{configChoice(loaded.to)}{loaded.metadataTo && <div className="border-t border-border/40 pt-3">{configChoice(loaded.metadataTo)}</div>}</div>
                        <dl className="space-y-2 text-sm"><div className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">AIOStreams user</dt><dd className="min-w-0 break-words text-right">{privateName(plan.memberName)}</dd></div>{plan.metadataMemberName && <div className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">AIOMetadata user</dt><dd className="min-w-0 break-words text-right">{privateName(plan.metadataMemberName)}</dd></div>}<div className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">New variant</dt><dd className="min-w-0 break-words text-right">{plan.variantName ? privateName(plan.variantName) : 'None'}</dd></div>{plan.playbackVariantIds.length > 0 && <div className="flex justify-between gap-4"><dt className="shrink-0 text-muted-foreground">Playback variants</dt><dd className="min-w-0 break-words text-right">{plan.playbackVariantIds.map(privateName).join(', ')}</dd></div>}</dl>
                        {!completed && <p className="text-xs leading-relaxed text-muted-foreground">{plan.aiometadata ? 'The selected AIOMetadata user will use AIOStreams for playback. ' : ''}{memberId ? 'The existing user keeps their history and sign-in settings.' : 'The new AIOStreams user gets separate history and starts without tracker connections.'}</p>}
                        {(busy || results.length > 0) && <section aria-label="Setup progress" data-theme-part="panel" className="space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm" role="status">
                                <p className="flex items-center gap-2 font-medium">{busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{completed ? 'Setup saved and verified' : hasFailure && !busy ? 'Setup needs attention' : 'Saving and verifying setup'}</p>
                                <span className="text-xs tabular-nums text-muted-foreground">{verifiedServices} of {totalServices} services verified</span>
                            </div>
                            <Progress value={verifiedServices / totalServices * 100} aria-label="Services saved and verified" aria-valuenow={verifiedServices / totalServices * 100} aria-valuetext={`${verifiedServices} of ${totalServices} services verified`} shimmer={busy} className="h-1.5" />
                            {busy && savingService && <p className="text-xs text-muted-foreground">Checking, saving and reading back {serviceName(savingService)}.</p>}
                            {results.length > 0 && <div className="space-y-2 text-sm" aria-live="polite">{results.map(result => <div key={result.service}><p className="font-medium">{serviceName(result.service)} · {result.status === 'verified' ? 'Saved and verified' : result.status === 'saving' ? 'Saving and verifying…' : 'Not confirmed'}</p>{result.message && <p className="mt-1 text-xs text-muted-foreground">{result.message}</p>}</div>)}</div>}
                        </section>}
                        {hasFailure && <p className="text-xs text-muted-foreground">Verified changes stay saved. Retry checks those changes before continuing, so it does not create duplicate users.</p>}
                        {completed && <div className="space-y-3 border-t border-border/40 pt-4"><p className="text-sm font-medium">Attach the sign-in to a local account</p><p className="text-xs text-muted-foreground">Choose an AIOManager account you already manage. Verify this person’s sign-in before saving its encrypted connection.</p><div className="space-y-1.5"><Label htmlFor="household-local-account">Local account</Label><Select value={linkAccount?.id || ''} onValueChange={value => { setLinkAccountId(value); setLinked([]) }}><SelectTrigger id="household-local-account" className="h-auto min-h-10 [&>span]:whitespace-normal [&>span]:text-left [&>span]:line-clamp-none"><SelectValue placeholder="Choose a local account">{linkAccount ? localAccountLabel(linkAccount) : undefined}</SelectValue></SelectTrigger><SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]">{accounts.map(account => <SelectItem key={account.id} value={account.id} textValue={localAccountLabel(account)}>{localAccountLabel(account)}</SelectItem>)}</SelectContent></Select>{!linkAccount && <p className="text-xs text-muted-foreground">Choose an existing local account before connecting the sign-in.</p>}</div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!linkAccount} onClick={() => { if (linkAccount) setLink({ accountId: linkAccount.id, baseUrl: `${loaded.to.baseUrl}/jellyfin`, username: plan.memberKind === 'primary' ? loaded.to.uuid : `${loaded.to.uuid}/${plan.memberId}`, userName: plan.memberName }) }}>Connect AIOStreams user</Button>{loaded.metadataTo && <Button variant="outline" disabled={!linkAccount} onClick={() => { if (linkAccount) setLink({ accountId: linkAccount.id, baseUrl: `${loaded.metadataTo!.baseUrl}/jellyfin/${loaded.metadataTo!.uuid}`, username: plan.metadataMemberName!, userName: plan.metadataMemberName! }) }}>Connect AIOMetadata user</Button>}</div>{linked.length > 0 && <p className="text-xs text-muted-foreground">Connected: {linked.join(', ')}</p>}</div>}
                    </div>}
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    {busy && !loaded && <OperationProgress status="running" current={0} total={0} label="Loading configurations" detail="Reading your selected configurations and checking instance access." />}
                </div>
                    <div className="flex flex-wrap justify-end gap-2 border-t border-border/40 pt-4">
                        {loaded && !busy && !completed && <Button variant="outline" onClick={() => { setError(''); if (plan && results.length === 0) setPlan(null); else { setLoaded(null); setPlan(null); setResults([]) } }}>Back</Button>}
                        <Button variant="outline" disabled={busy && !!plan} onClick={() => close(false)}>{completed ? 'Done' : 'Cancel'}</Button>
                        {!completed && <Button disabled={busy || !loaded && !destinationKey} onClick={() => { if (!loaded) void load(); else if (!plan) preview(); else void save() }}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{busy ? plan ? 'Saving…' : 'Loading…' : !loaded ? 'Load configurations' : !plan ? 'Preview setup' : hasFailure ? 'Retry unfinished setup' : 'Save and verify'}</Button>}
                    </div>
        </HouseholdSetupFrame>
        {link && <JellyfinSetupDialog open onOpenChange={value => { if (!value) setLink(null) }} initialBaseUrl={link.baseUrl} initialUsername={link.username} expectedSignIn={link} onComplete={saveConnection} />}
    </>
}
