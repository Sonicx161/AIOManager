import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, ExternalLink, Info, Lock, RefreshCw, Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, maskEmailLevel, maskProfileLevel } from '@/lib/utils'
import { useUIStore } from '@/store/uiStore'
import { useAccountStore } from '@/store/accountStore'
import { parseNuvioMemberAccess, type NuvioMemberStatus } from '@/lib/nuvio-tier'
import { cachedRead, isDisplayCacheFresh, peekDisplayCache } from '@/lib/display-read-cache'
import { avatarCatalogBackendKey } from '@/lib/nuvio-avatar-catalog-cache'
import { readNuvioAvatars, readNuvioMemberAccess, readNuvioProfiles, type NuvioProfileRow } from '@/lib/nuvio-data'
import type { NuvioAvatar } from '@/lib/nuvio-avatars'
import { DEFAULT_BASE_URL } from '@/lib/drivers/nuvio'
import type { Connection, ConnectionStatus } from '@/types/connection'
import { NuvioTierBadge } from './ConnectionMembershipTab'
import { nuvioReadIdentity, useNuvioResource } from './NuvioWorkspace'
import { resolveNuvioSyncTarget, storedNuvioTargetId } from './nuvio-sync-target'
import { SectionCard, SectionRow, SectionRows, WorkspaceError } from './workspace/SectionCard'
import { NUVIO_PERKS, backendLabel, membershipErrorMessage, nuvioMembershipView, nuvioPerkUnlocked, type SessionState } from './workspace/workspace-model'
import { timeAgo } from '@/lib/connection-format'

const formatMonth = (ts: number) => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })

export interface NuvioMembershipState {
    member: NuvioMemberStatus | undefined
    loading: boolean
    error: string | null
    checkedAt: number | null
    refresh: () => void
}

// One membership cache key for the hub grid card and the workspace Overview
// (#32): both paint from the same entry, so a revisit within the TTL re-reads
// nothing. Keyed by the full read identity (account + connection + backend +
// login) and cleared on vault lock and logout with the display read cache.
export function nuvioMembershipCacheKey(accountId: string, connection: Connection): string {
    return `nuvio:member:${nuvioReadIdentity(accountId, connection, false)}`
}

// The tier read lives with the workspace so it can show loading, error and refresh.
// The hub's card badge result seeds it to avoid a second read on open.
export function useNuvioMembership(accountId: string, connection: Connection, initial: NuvioMemberStatus | undefined, enabled: boolean): NuvioMembershipState {
    const [member, setMember] = useState<NuvioMemberStatus | undefined>(initial)
    const [loading, setLoading] = useState(!initial && enabled)
    const [error, setError] = useState<string | null>(null)
    const [checkedAt, setCheckedAt] = useState<number | null>(initial ? Date.now() : null)
    const generation = useRef(0)
    const connectionRef = useRef(connection)
    connectionRef.current = connection
    const identity = nuvioReadIdentity(accountId, connection, false)
    const keyRef = useRef('')
    keyRef.current = nuvioMembershipCacheKey(accountId, connection)

    const refresh = useCallback(() => {
        if (!enabled) return
        const gen = ++generation.current
        setLoading(true)
        setError(null)
        // Manual refresh bypasses the cache and renews the stored entry.
        cachedRead(keyRef.current, () => readNuvioMemberAccess(accountId, connectionRef.current), { force: true })
            .then(rows => {
                if (gen !== generation.current) return
                setMember(parseNuvioMemberAccess(rows))
                setCheckedAt(Date.now())
            })
            .catch(err => { if (gen === generation.current) setError(membershipErrorMessage(err)) })
            .finally(() => { if (gen === generation.current) setLoading(false) })
    }, [accountId, enabled])

    useEffect(() => {
        if (initial) { setMember(initial); setCheckedAt(c => c ?? Date.now()); setLoading(false) }
    }, [initial])

    useEffect(() => {
        if (!enabled) { generation.current++; setLoading(false); return }
        const cached = peekDisplayCache<unknown>(keyRef.current)
        if (cached) {
            // A previous visit or the hub card already read this membership: paint
            // it immediately and re-read only once the entry is stale.
            const gen = ++generation.current
            setMember(parseNuvioMemberAccess(cached.value))
            setCheckedAt(cached.fetchedAt)
            setLoading(false)
            setError(null)
            if (isDisplayCacheFresh(cached)) return
            setLoading(true)
            cachedRead(keyRef.current, () => readNuvioMemberAccess(accountId, connectionRef.current))
                .then(rows => { if (gen === generation.current) { setMember(parseNuvioMemberAccess(rows)); setCheckedAt(Date.now()) } })
                .catch(err => { if (gen === generation.current) setError(membershipErrorMessage(err)) })
                .finally(() => { if (gen === generation.current) setLoading(false) })
            return
        }
        if (!initial) refresh()
        // Re-read only when the login identity changes, not on status churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [identity, enabled])

    return { member, loading, error, checkedAt, refresh }
}

function ProfileStack({ profiles }: { profiles: NuvioProfileRow[] }) {
    return (
        <span className="flex items-center pl-1" aria-hidden="true">
            {profiles.slice(0, 4).map(p => (
                <span
                    key={p.id}
                    className={cn('-ml-1 flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ring-2 ring-card', !p.avatar_color_hex && 'bg-muted text-muted-foreground')}
                    style={p.avatar_color_hex ? { backgroundColor: p.avatar_color_hex, color: '#fff' } : undefined}
                >
                    {p.profile_index}
                </span>
            ))}
        </span>
    )
}

export function NuvioOverview({ accountId, connection, status, session, membership, onOpenTab, health }: {
    accountId: string
    connection: Connection
    status: ConnectionStatus
    session: SessionState
    membership: NuvioMembershipState
    onOpenTab: (tab: string) => void
    health: ReactNode
}) {
    const activeProfileId = useAccountStore(s => s.accounts.find(a => a.id === accountId)?.activeProfileId)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const emailLevel = useUIStore(s => s.privacyLevelEmail)
    const profileLevel = useUIStore(s => s.privacyLevelProfiles)
    const canRead = connection.enabled !== false && status !== 'expired' && connection.capabilities.includes('profiles')

    const profileIdentity = nuvioReadIdentity(accountId, connection, false)
    const loadProfiles = useCallback(() => readNuvioProfiles(accountId, connection), [accountId, connection])
    // Shares the Profiles tab's cache entry: Overview and the roster read once.
    const profilesRead = useNuvioResource<NuvioProfileRow[]>(loadProfiles, profileIdentity, canRead, 'profiles')
    const avatarConnection = useMemo(() => ({ credentials: connection.credentials }), [connection.credentials])
    const loadAvatars = useCallback(() => readNuvioAvatars(accountId, avatarConnection), [accountId, avatarConnection])
    const avatarsRead = useNuvioResource<NuvioAvatar[]>(loadAvatars, `${avatarCatalogBackendKey(connection.credentials?.baseUrl)}|avatars`, connection.enabled !== false, 'avatars')

    const profiles = useMemo(() => profilesRead.data || [], [profilesRead.data])
    const target = useMemo(() => resolveNuvioSyncTarget(
        profiles.map(p => ({ id: p.id, index: p.profile_index, name: p.name })),
        storedNuvioTargetId({ credentials: connection.credentials, profileMapping: connection.profileMapping, activeProfileId }),
    ), [profiles, connection.credentials, connection.profileMapping, activeProfileId])

    const email = connection.credentials?.email
    const backend = backendLabel(connection.credentials?.baseUrl, DEFAULT_BASE_URL)
    const profileName = (name?: string) => maskProfileLevel(name || 'Profile', privacyOn ? profileLevel : 0)
    const { member, loading, error, checkedAt, refresh } = membership
    const view = member ? nuvioMembershipView(member, formatMonth) : null
    const avatars = avatarsRead.data || []
    const categories = new Set(avatars.map(a => a.category).filter(Boolean)).size
    const profilesWithAvatar = profiles.filter(p => p.avatar_id).length
    const avatarsUnlocked = nuvioPerkUnlocked(member, 'supporter')

    const membershipBody = error ? (
        <WorkspaceError title="Couldn't read your membership" message={error} onRetry={refresh}
            action={<Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onOpenTab('connection')}>Open Connection</Button>} />
    ) : !view ? (
        <div className="space-y-2" role="status" aria-label="Checking membership">
            {connection.enabled === false
                ? <p className="text-xs text-muted-foreground">Enable this connection to read its membership.</p>
                : <><Skeleton className="h-6 w-28" /><Skeleton className="h-4 w-44" /></>}
        </div>
    ) : (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <NuvioTierBadge member={member!} />
                <span className="text-xs text-muted-foreground">{view.detail}</span>
            </div>
            <SectionRows>
                {view.endsAt != null && <SectionRow label="Ends" value={formatMonth(view.endsAt)} />}
                <SectionRow label="Perks unlocked" value={view.perksUnlocked == null ? 'Unknown for this tier' : `${view.perksUnlocked} of ${view.perksTotal}`} />
                <SectionRow label="Discord role" value={view.discord} tone={member?.supporter ? undefined : 'muted'} />
            </SectionRows>
        </>
    )

    return (
        <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <SectionCard
                    title="Membership"
                    description={checkedAt && !loading ? `Your Nuvio supporter tier. Checked ${timeAgo(checkedAt)}.` : 'Your Nuvio supporter tier.'}
                    footer={!error && view ? (
                        <>
                            <Button variant={member?.supporter ? 'outline' : 'default'} size="sm" className="h-11 gap-1.5 text-xs sm:h-8" asChild>
                                <a href="https://nuvio.tv/support" target="_blank" rel="noreferrer">
                                    {member?.supporter ? 'Manage membership' : 'Become a supporter'}
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            </Button>
                            <Button variant="outline" size="sm" className="h-11 gap-1.5 text-xs sm:h-8" onClick={refresh} disabled={loading}>
                                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                                Refresh
                            </Button>
                        </>
                    ) : undefined}
                >
                    {membershipBody}
                </SectionCard>

                <SectionCard title="This Nuvio account" description="From this connection and the Nuvio API.">
                    <SectionRows>
                        <SectionRow label="Signed in as" value={email ? maskEmailLevel(email, privacyOn ? emailLevel : 0) : 'Not recorded'} tone={email ? undefined : 'muted'} />
                        <SectionRow
                            label="Backend"
                            value={backend.host}
                            mono
                            aside={<span data-theme-part="badge" className="rounded-full border border-border/40 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">{backend.custom ? 'Custom' : 'Default'}</span>}
                        />
                        <SectionRow
                            label="Profiles"
                            value={!canRead ? 'Not loaded' : profilesRead.error ? 'Could not load' : profilesRead.loading && !profilesRead.data ? 'Loading…' : `${profiles.length} of 4 used`}
                            tone={profilesRead.error ? 'destructive' : !canRead ? 'muted' : undefined}
                            aside={profiles.length > 0 ? <ProfileStack profiles={profiles} /> : undefined}
                        />
                        <SectionRow
                            label="Pushes to"
                            value={target.danglingId
                                ? `Profile ${profileName(target.danglingId)} no longer exists`
                                : target.active
                                    ? `${profileName(target.active.name)} (profile ${target.active.index})${target.isDefault ? ', by default' : ''}`
                                    : profiles.length === 0 ? 'Primary profile' : 'Not set'}
                            tone={target.danglingId ? 'warning' : undefined}
                            aside={<Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={() => onOpenTab('profiles')}>Change<ChevronRight className="h-3.5 w-3.5" /></Button>}
                        />
                        <SectionRow label="Session" value={session === 'Session stored' ? 'Stored, refreshed by the server' : session} tone={session === 'Re-auth required' || session === 'Sign in required' ? 'destructive' : undefined} />
                    </SectionRows>
                </SectionCard>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <SectionCard
                    title="Perks you can use here"
                    description="Supporter perks AIOManager can act on."
                    footer={
                        <details className="group w-full">
                            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-medium text-primary sm:min-h-0 [&::-webkit-details-marker]:hidden">
                                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                                See what {member?.tier === 'supporter-plus' ? 'your plan' : 'Supporter'} unlocks
                            </summary>
                            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                                {NUVIO_PERKS.map(perk => {
                                    const on = nuvioPerkUnlocked(member, perk.tier)
                                    return (
                                        <li key={perk.id} className="flex items-start gap-2 rounded-xl border border-border/40 bg-card px-3 py-2">
                                            <span className={cn('mt-0.5 shrink-0', on ? 'text-success' : 'text-muted-foreground')}>{on ? <Check className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}</span>
                                            <span className="min-w-0">
                                                <span className="block text-xs font-medium">{perk.label}</span>
                                                <span className="block text-xs text-muted-foreground">{on ? perk.detail : perk.tier === 'supporter-plus' ? 'Supporter Plus' : 'Supporter and up'}</span>
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>
                            <p className="mt-2 text-xs text-muted-foreground">Perk list from nuvio.tv/support.</p>
                        </details>
                    }
                >
                    <div className="flex flex-wrap items-center gap-3">
                        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/40', avatarsUnlocked ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground')}>
                            {avatarsUnlocked ? <Smile className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">Avatar collection</p>
                            <p className="text-xs text-muted-foreground">
                                {connection.enabled === false ? 'Enable this connection to read the avatar catalog.'
                                    : avatarsRead.error ? 'Could not load the avatar catalog.'
                                        : !avatarsRead.data ? 'Loading the avatar catalog…'
                                            : `${avatars.length} avatar${avatars.length === 1 ? '' : 's'} in the catalog${categories > 1 ? ` across ${categories} categories` : ''}.${profilesRead.data ? ` ${profilesWithAvatar} of ${profiles.length} profile${profiles.length === 1 ? '' : 's'} use one.` : ''}`}
                            </p>
                        </div>
                        <Button variant="outline" size="sm" className="h-11 text-xs sm:h-8" onClick={() => onOpenTab('profiles')} disabled={connection.enabled === false}>Pick avatars</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Themes, backgrounds, the badge and the Discord role apply inside the Nuvio app.</p>
                </SectionCard>
                {health}
            </div>

            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Informational only. AIOManager never changes your Nuvio plan.</span>
            </p>
        </div>
    )
}
