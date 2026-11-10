import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn, maskNameLevel } from '@/lib/utils'
import { maskIds } from '@/lib/mask-ids'
import { JellyfinClient, jellyfinSignInErrorMessage, normalizeJellyfinUrl, type JellyfinSession } from '@/lib/jellyfin/session'
import { parseJellyfinSecret } from '@/lib/jellyfin/connection-data'
import { decrypt } from '@/lib/crypto'
import { useAuthStore } from '@/store/authStore'
import { useAccountStore } from '@/store/accountStore'
import { useUIStore } from '@/store/uiStore'
import { isAIOStreamsAddon, parseAIOStreamsUrl, fetchAIOStreamsUser, getStoredAIOStreamsPassword } from '@/lib/aiostreams-utils'
import { isAIOMetadataAddon, parseAIOMetadataUrl, fetchAIOMetadataConfig, fetchAIOMetadataStatus, getStoredAIOMetadataPassword } from '@/lib/aiometadata-utils'

interface Props {
    open: boolean
    onOpenChange: (open: boolean) => void
    onComplete: (session: JellyfinSession) => Promise<void>
    reconnectCredentials?: string
    initialBaseUrl?: string
    initialUsername?: string
    expectedSignIn?: { baseUrl: string; username: string }
    accountId?: string
    onBackToPicker?: () => void
}

interface AddonUserSuggestion { id: string; name: string; provider: 'AIOStreams' | 'AIOMetadata'; baseUrl: string; username: string; password: string }

// Fictitious sample values only — never a real user's name, password or server.
const RETRY_MESSAGE = 'Retrying addon user discovery…'

function Example({ children }: { children: string }) {
    return <span className="rounded border border-border/40 bg-muted px-1 py-0.5 font-mono text-[10px]">{children}</span>
}

function CredentialHelp() {
    const [open, setOpen] = useState(false)
    return (
        <div data-theme-part="panel" className="rounded-xl border border-border/30 bg-muted/20">
            <button
                type="button"
                data-theme-part="button"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
            >
                <span className="text-xs font-semibold">Which username and password?</span>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    Examples for each app
                    <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
                </span>
            </button>
            {open && (
                <div className="space-y-2.5 border-t border-border/30 px-3 py-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        Use the credentials for your media server, not your AIOManager vault password. The examples below are fictitious. Saving links the verified server user to the AIOManager account you are editing. Only the server address and session token are saved encrypted; your password is never saved.
                    </p>
                    <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                        <li>
                            <span className="font-medium text-foreground">Jellyfin server:</span> a user account created in your server's dashboard under Users. Example: username <Example>sonic</Example>, password <Example>matinee-tuesday-52</Example>. Leave the password blank only if that Jellyfin user has none. <a href="https://jellyfin.org/docs/general/server/users/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Official user guide</a>
                        </li>
                        <li>
                            <span className="font-medium text-foreground">AIOStreams:</span> open <strong className="font-medium text-foreground">Save &amp; Install → Jellyfin apps → Connect</strong>. With its plain Server address, such as <Example>https://aiostreams.example.com/jellyfin</Example>, enter the displayed configuration UUID or alias, for example <Example>media-room</Example>, or <Example>media-room/sonic</Example> for a household user. If you copied the full sign-in-picker address instead, keep it intact and enter the user's name, for example <Example>sonic</Example>. Use your configuration password, adding <Example>/PIN</Example> for a user with a PIN, for example <Example>bright-falcon-77/4821</Example>. <a href="https://docs.aiostreams.viren070.me/apps/jellyfin/#what-to-type-at-a-glance" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">What to type, at a glance</a>
                        </li>
                        <li>
                            <span className="font-medium text-foreground">AIOMetadata:</span> open your configuration, save, then click <strong className="font-medium text-foreground">Jellyfin</strong> next to Install. Copy its full server address, such as <Example>https://aiometa.example.com/jellyfin/1a2b3c</Example>. Enter a username from that configuration's client sign-in list — example <Example>alex</Example> — and your configuration password or the separate client password from the Jellyfin dialog, for example <Example>quiet-orbit-64</Example>. <a href="https://github.com/cedya77/aiometadata/blob/dev/docs/jellyfin.md" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Official Jellyfin guide</a>
                        </li>
                    </ul>
                </div>
            )}
        </div>
    )
}

export function JellyfinSetupDialog({ open, onOpenChange, onComplete, reconnectCredentials, initialBaseUrl = '', initialUsername = '', expectedSignIn, accountId, onBackToPicker }: Props) {
    const account = useAccountStore(state => accountId ? state.accounts.find(item => item.id === accountId) : undefined)
    const hasProviderAddons = !!account?.addons.some(addon => isAIOStreamsAddon(addon) || isAIOMetadataAddon(addon))
    const encryptionKey = useAuthStore(state => state.encryptionKey)
    const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
    const [loadingAddress, setLoadingAddress] = useState(!!reconnectCredentials)
    const [method, setMethod] = useState<'password' | 'token'>('password')
    const [username, setUsername] = useState(initialUsername)
    const [password, setPassword] = useState('')
    const [accessToken, setAccessToken] = useState('')
    const [userId, setUserId] = useState('')
    const [session, setSession] = useState<JellyfinSession | null>(null)
    const [discoveredUsers, setDiscoveredUsers] = useState<Array<{ Id: string; Name?: string }>>([])
    const [discoveringUsers, setDiscoveringUsers] = useState(false)
    const [discoveryMessage, setDiscoveryMessage] = useState('')
    const [addonSuggestions, setAddonSuggestions] = useState<AddonUserSuggestion[]>([])
    const [aiomAddonPassword, setAIOMAddonPassword] = useState('')
    const [aiomNeedsAddonPassword, setAIOMNeedsAddonPassword] = useState(false)
    const [discoveryNonce, setDiscoveryNonce] = useState(0)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const isPrivacyModeEnabled = useUIStore(s => s.isPrivacyModeEnabled)
    const privacyLevelNames = useUIStore(s => s.privacyLevelNames)
    const namePrivacyLevel = isPrivacyModeEnabled ? privacyLevelNames : 0
    const running = useRef(false)
    const request = useRef<AbortController | null>(null)
    const discoveryRequest = useRef<AbortController | null>(null)
    const discoveryGeneration = useRef(0)
    useEffect(() => () => { request.current?.abort(); discoveryRequest.current?.abort() }, [])
    // Addon discovery is explicitly retried after the optional AIOM password is entered.
    useEffect(() => {
        if (!open || !account || !accountId) return
        let cancelled = false
        const load = async () => {
            const suggestions: AddonUserSuggestion[] = []
            let needsAddonPassword = false
            await Promise.all((account.addons || []).filter(addon => addon.flags?.enabled !== false).map(async addon => {
                try {
                    if (isAIOStreamsAddon(addon)) {
                        const parsed = parseAIOStreamsUrl(addon.transportUrl)
                        const password = parsed && getStoredAIOStreamsPassword(parsed.baseUrl, parsed.uuid)
                        if (!parsed || !password) return
                        const result = await fetchAIOStreamsUser(parsed.baseUrl, parsed.uuid, password)
                        const jellyfin = result.userData.jellyfin as Record<string, unknown> | undefined
                        const primary = jellyfin?.primary as Record<string, unknown> | undefined
                        if (typeof primary?.name === 'string' && primary.name.trim()) suggestions.push({ id: `aios:primary:${parsed.uuid}`, name: primary.name.trim(), provider: 'AIOStreams', baseUrl: `${parsed.baseUrl}/jellyfin`, username: parsed.uuid, password })
                        const personas = Array.isArray(jellyfin?.personas) ? jellyfin.personas : []
                        for (const entry of personas) {
                            if (!entry || typeof entry !== 'object') continue
                            const person = entry as Record<string, unknown>
                            if (typeof person.id === 'string' && typeof person.name === 'string' && person.name.trim()) suggestions.push({ id: `aios:${parsed.uuid}:${person.id}`, name: person.name.trim(), provider: 'AIOStreams', baseUrl: `${parsed.baseUrl}/jellyfin`, username: `${parsed.uuid}/${person.id}`, password })
                        }
                    } else if (isAIOMetadataAddon(addon)) {
                        const parsed = parseAIOMetadataUrl(addon.transportUrl)
                        const password = parsed && getStoredAIOMetadataPassword(parsed.baseUrl, parsed.uuid)
                        if (!parsed || !password) return
                        const status = await fetchAIOMetadataStatus(parsed.baseUrl)
                        if (status?.requiresAddonPassword === true && !aiomAddonPassword.trim()) {
                            needsAddonPassword = true
                            return
                        }
                        const config = await fetchAIOMetadataConfig(parsed.baseUrl, parsed.uuid, password, aiomAddonPassword.trim() || undefined)
                        const users = Array.isArray(config.jellyfinUsers) ? config.jellyfinUsers : []
                        const configuredName = typeof config.jellyfinUserName === 'string' ? config.jellyfinUserName.trim() : ''
                        if (users.length === 0 && configuredName) {
                            suggestions.push({ id: `aiom:${parsed.uuid}:configured`, name: configuredName, provider: 'AIOMetadata', baseUrl: `${parsed.baseUrl}/jellyfin/${parsed.uuid}`, username: configuredName, password })
                        }
                        for (const entry of users) {
                            if (!entry || typeof entry !== 'object') continue
                            const person = entry as Record<string, unknown>
                            if (typeof person.name === 'string' && person.name.trim()) suggestions.push({ id: `aiom:${parsed.uuid}:${String(person.id || person.name)}`, name: person.name.trim(), provider: 'AIOMetadata', baseUrl: `${parsed.baseUrl}/jellyfin/${parsed.uuid}`, username: person.name.trim(), password })
                        }
                    }
                } catch { /* unavailable addon config stays out of the picker */ }
            }))
            if (!cancelled) {
                setDiscoveryMessage(message => message === RETRY_MESSAGE ? '' : message)
                setAIOMNeedsAddonPassword(needsAddonPassword)
                setAddonSuggestions(suggestions.filter((item, index, all) => all.findIndex(other => other.provider === item.provider && other.baseUrl === item.baseUrl && other.username.toLowerCase() === item.username.toLowerCase()) === index))
            }
        }
        void load()
        return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, account, accountId, discoveryNonce])
    useEffect(() => {
        if (!reconnectCredentials) return
        if (!encryptionKey) {
            setBaseUrl(''); setLoadingAddress(false)
            setError('Unlock your vault to load the saved server address.')
            return
        }
        let cancelled = false
        setLoadingAddress(true)
        void decrypt(reconnectCredentials, encryptionKey).then(value => {
            const saved = parseJellyfinSecret(value)
            if (!cancelled) { setBaseUrl(saved.baseUrl); setError('') }
        }).catch(() => {
            if (!cancelled) setError('The saved server address could not be loaded. Enter the complete address to reconnect.')
        }).finally(() => { if (!cancelled) setLoadingAddress(false) })
        return () => { cancelled = true }
    }, [reconnectCredentials, encryptionKey])

    const close = (value: boolean) => {
        if (running.current) return
        if (!value) {
            discoveryGeneration.current++
            discoveryRequest.current?.abort()
            setBaseUrl(''); setUsername(''); setPassword(''); setAccessToken(''); setUserId('')
            setSession(null); setError(''); setMethod('password'); setDiscoveredUsers([]); setDiscoveryMessage(''); setAddonSuggestions([]); setAIOMAddonPassword(''); setAIOMNeedsAddonPassword(false); setDiscoveryNonce(0)
        }
        onOpenChange(value)
    }
    const submit = async () => {
        if (running.current || loadingAddress || (reconnectCredentials && !encryptionKey)) return
        running.current = true; setBusy(true); setError('')
        const controller = new AbortController()
        request.current = controller
        try {
            if (session) {
                await onComplete(session)
                running.current = false
                close(false)
            } else {
                if (expectedSignIn) {
                    if (normalizeJellyfinUrl(baseUrl) !== normalizeJellyfinUrl(expectedSignIn.baseUrl)) throw new Error('Sign in using the server address from this setup before saving the connection.')
                    if (method !== 'password' || username.trim().toLowerCase() !== expectedSignIn.username.trim().toLowerCase()) throw new Error('Sign in as the household user selected in this setup. Use the prefilled username.')
                }
                const result = await new JellyfinClient(baseUrl, crypto.randomUUID()).signIn({ baseUrl, method, username, password, accessToken, userId }, controller.signal)
                controller.signal.throwIfAborted()
                setPassword(''); setAccessToken(''); setSession(result)
            }
        } catch (err) { if (!controller.signal.aborted) setError(jellyfinSignInErrorMessage(err, { method, userId })) }
        finally { request.current = null; running.current = false; if (!controller.signal.aborted) setBusy(false) }
    }

    const discoverUsers = async () => {
        if (discoveringUsers || busy || !baseUrl.trim()) return
        const targetBaseUrl = baseUrl
        const generation = ++discoveryGeneration.current
        setDiscoveringUsers(true); setDiscoveryMessage(''); setError('')
        const controller = new AbortController()
        discoveryRequest.current = controller
        try {
            const users = await new JellyfinClient(targetBaseUrl, crypto.randomUUID()).listPublicUsers(controller.signal)
            if (generation !== discoveryGeneration.current || targetBaseUrl !== baseUrl) return
            const usable = users.filter(user => typeof user.Id === 'string' && user.Id && typeof user.Name === 'string' && user.Name.trim())
            setDiscoveredUsers(usable)
            setDiscoveryMessage(usable.length > 0 ? `${usable.length} user${usable.length === 1 ? '' : 's'} found. Choose one to prefill the sign-in.` : 'No public users were returned. Enter the username manually.')
        } catch (err) {
            if (generation !== discoveryGeneration.current || targetBaseUrl !== baseUrl) return
            setDiscoveredUsers([])
            setDiscoveryMessage(err instanceof Error ? 'This endpoint does not expose a public user list. Enter the username manually.' : 'User discovery was unavailable. Enter the username manually.')
        } finally {
            if (discoveryRequest.current === controller) discoveryRequest.current = null
            if (generation === discoveryGeneration.current) setDiscoveringUsers(false)
        }
    }

    const verifiedServerName = session?.identity.serverName?.trim()
    const distinctVerifiedServerName = verifiedServerName && verifiedServerName !== session?.identity.productName ? verifiedServerName : ''
    let submitLabel = session ? 'Save connection' : 'Verify sign-in'
    if (busy) submitLabel = session ? 'Saving…' : 'Connecting…'
    if (loadingAddress) submitLabel = 'Loading address…'

    return <Dialog open={open} onOpenChange={close}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Connect Jellyfin</DialogTitle>
                <DialogDescription>Works with Jellyfin, AIOStreams (AIOS) and AIOMetadata (AIOM). Features depend on the server.</DialogDescription>
            </DialogHeader>
            <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
                {session ? <div className="space-y-2 text-sm">
                    <p className="font-medium">{session.identity.productName}</p>
                    {distinctVerifiedServerName && <p className="break-words text-muted-foreground">{distinctVerifiedServerName}</p>}
                    <p>Remote user: {maskNameLevel(session.identity.userName, namePrivacyLevel)}</p>
                    {!isPrivacyModeEnabled && <p className="break-all font-mono text-xs text-muted-foreground">User ID: {maskIds(session.identity.userId)}</p>}
                    <p className="text-muted-foreground">Confirm this is the user whose media you want to read. The server address and token are saved encrypted. Your password is never saved.</p>
                </div> : <fieldset disabled={busy || loadingAddress} className="min-w-0 space-y-3">
                    {hasProviderAddons && <div className="min-w-0 space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3"><p className="text-sm font-medium">From the installed AIOS / AIOM addons on this account</p>{addonSuggestions.length > 0 ? <><p className="text-xs leading-relaxed text-muted-foreground">Choose a user from the AIOStreams and AIOMetadata addons already installed on this AIOManager account.</p><div className="grid min-w-0 gap-2 sm:grid-cols-2">{addonSuggestions.map(suggestion => <button type="button" key={suggestion.id} className="min-w-0 w-full rounded-lg border border-border/40 bg-card/70 px-3 py-2 text-left hover:border-primary/50" onClick={() => { discoveryGeneration.current++; discoveryRequest.current?.abort(); setDiscoveringUsers(false); setBaseUrl(suggestion.baseUrl); setUsername(suggestion.username); setPassword(suggestion.password); setMethod('password'); setDiscoveredUsers([]); setDiscoveryMessage(`${suggestion.provider} user selected. Verify sign-in to continue.`) }}><span className="block truncate text-sm font-medium">{suggestion.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{suggestion.provider} · {maskIds(suggestion.username)}</span></button>)}</div></> : <><p className="rounded-lg border border-dashed border-border/50 px-3 py-3 text-xs leading-relaxed text-muted-foreground">{aiomNeedsAddonPassword ? 'AIOMetadata needs its separate addon password before its users can be listed.' : 'AIOS/AIOM addons are installed, but no users could be loaded yet.'}</p><div className="flex min-w-0 gap-2"><Input className="min-w-0 flex-1" type="password" aria-label="AIOMetadata addon password" placeholder="AIOMetadata addon password (if required)" value={aiomAddonPassword} onChange={event => setAIOMAddonPassword(event.target.value)} /><Button type="button" variant="outline" className="shrink-0" onClick={() => { setDiscoveryMessage(RETRY_MESSAGE); setDiscoveryNonce(value => value + 1) }}>Retry</Button></div></>}</div>}
                    <div className="space-y-1"><Label htmlFor="jf-address">Full server address</Label><div className="flex min-w-0 gap-2"><Input className="min-w-0 flex-1" id="jf-address" type="url" required value={baseUrl} onChange={e => { discoveryGeneration.current++; discoveryRequest.current?.abort(); setBaseUrl(e.target.value); setDiscoveredUsers([]); setDiscoveryMessage(''); setDiscoveringUsers(false) }} placeholder="https://server.example/jellyfin" autoComplete="off" /><Button className="shrink-0" type="button" variant="outline" disabled={busy || discoveringUsers || !baseUrl.trim()} onClick={() => void discoverUsers()}>{discoveringUsers ? 'Finding…' : 'Find users'}</Button></div></div>
                    <p className="text-xs text-muted-foreground">Keep the complete configuration path supplied by your server. Sign-in runs directly in your browser.</p>
                    {discoveredUsers.length > 0 && <div className="space-y-1"><Label htmlFor="jf-discovered-user">Choose a discovered user</Label><select id="jf-discovered-user" className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={username} onChange={event => setUsername(event.target.value)}><option value="">Select a user…</option>{discoveredUsers.map(user => <option key={user.Id} value={user.Name}>{user.Name}</option>)}</select></div>}
                    {discoveryMessage && <p className="text-xs text-muted-foreground" role="status">{discoveryMessage}</p>}
                    {!expectedSignIn && <div className="flex flex-wrap gap-2" role="group" aria-label="Sign-in method">
                        <Button type="button" variant={method === 'password' ? 'default' : 'outline'} onClick={() => setMethod('password')}>Username &amp; password</Button>
                        <Button type="button" variant={method === 'token' ? 'default' : 'outline'} onClick={() => setMethod('token')}>Token / API key</Button>
                    </div>}
                    {method === 'password' ? <>
                        <div className="space-y-1"><Label htmlFor="jf-username">Server username</Label><Input id="jf-username" required value={username} onChange={e => setUsername(e.target.value)} placeholder="e.g. sonic, media-room or media-room/sonic" autoComplete="username" /></div>
                        <div className="space-y-1"><Label htmlFor="jf-password">Password</Label><Input id="jf-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Blank if this user has none" autoComplete="current-password" /></div>
                    </> : <>
                        <div className="space-y-1"><Label htmlFor="jf-token">Session token or API key</Label><Input id="jf-token" type="password" required value={accessToken} onChange={e => setAccessToken(e.target.value)} autoComplete="off" /></div>
                        <div className="space-y-1"><Label htmlFor="jf-userid">Remote user ID (required for API keys)</Label><Input id="jf-userid" value={userId} onChange={e => setUserId(e.target.value)} autoComplete="off" /></div>
                        <p className="text-xs text-muted-foreground">Session tokens can identify their user automatically. For an API key, select a specific user by ID; AIOManager verifies that user before saving.</p>
                    </>}
                </fieldset>}
                {!session && <CredentialHelp />}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    {onBackToPicker && !session && <Button type="button" variant="outline" disabled={busy || discoveringUsers} onClick={() => { close(false); onBackToPicker() }}>Back to connection picker</Button>}
                    <Button type="button" variant="subtle" disabled={busy} onClick={() => close(false)}>Cancel</Button>
                    {session && <Button type="button" variant="outline" disabled={busy} onClick={() => setSession(null)}>Back</Button>}
                    <Button type="submit" disabled={busy || discoveringUsers || loadingAddress || (!!reconnectCredentials && !encryptionKey)}>{submitLabel}</Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
}
