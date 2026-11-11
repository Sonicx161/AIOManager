import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { ArrowLeft, BookOpen, Key, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { TabsContent } from '@/components/ui/tabs'
import { ToolbarShell } from '@/components/ui/toolbar-shell'
import { useSyncStore } from '@/store/syncStore'
import { useUIStore } from '@/store/uiStore'
import { maskUrlLevel } from '@/lib/utils'
import { timeAgo } from '@/lib/connection-format'
import type { HydraSubscriber } from '@/api/hydra-providers'
import { PopoverFacts, SectionCard, SectionRow, SectionRows, WorkspaceAction, WorkspaceHeader, WorkspaceStatusPill, WorkspaceTabs } from './workspace'
import { hydraPullUrl, pullFreshness, resolveWorkspaceTab, subscriberIsSender, workspaceTabsFor, DEFAULT_WORKSPACE_TAB } from './workspace/workspace-model'

export const HYDRA_PULL_GUIDE = '/kronorium/accounts/connections#apps-that-pull-from-you'

export function PullAppLogo({ subscriber, className }: { subscriber: Pick<HydraSubscriber, 'name' | 'logo'>; className?: string }) {
    return (
        <div data-theme-part="image-tile" className={`relative flex items-center justify-center overflow-hidden rounded-xl bg-muted/50 ${className || ''}`}>
            {subscriber.logo
                ? <img src={subscriber.logo} alt={subscriber.name} loading="lazy" className="h-full w-full object-contain p-1" />
                : <span className="text-sm font-bold text-muted-foreground">{subscriber.name[0]?.toUpperCase() || '?'}</span>}
        </div>
    )
}

// Backendless Hydra apps: AIOManager can't reach them, so the workspace explains what the app
// does and how it connects, and offers removal only. The lone sender (successful pushes, no
// pulls, sole app on its account) gets the push-only variant; every other app keeps beta's
// pull copy exactly, from register-driven last_seen_at.
export function HydraPullPanel({ subscriber, addonCount, onBack, onRemove, onOpenApiKey }: {
    subscriber: HydraSubscriber
    addonCount: number
    onBack: () => void
    onRemove: (name: string) => void
    onOpenApiKey?: () => void
}) {
    const [tabState, setTab] = useState(DEFAULT_WORKSPACE_TAB)
    const [confirmRemove, setConfirmRemove] = useState(false)
    const serverUrl = useSyncStore(s => s.serverUrl)
    const privacyOn = useUIStore(s => s.isPrivacyModeEnabled)
    const urlLevel = useUIStore(s => s.privacyLevelUrls)
    const tabs = workspaceTabsFor('hydra-pull')
    const tab = resolveWorkspaceTab(tabs, tabState)
    const pullUrl = hydraPullUrl(serverUrl, window.location.origin)
    const maskedPullUrl = maskUrlLevel(pullUrl, privacyOn ? urlLevel : 0)
    const sender = subscriberIsSender(subscriber.last_pull_at, subscriber.last_push_at)
    const freshness = pullFreshness(subscriber.last_seen_at, Date.now())
    const lastPull = subscriber.last_seen_at ? timeAgo(subscriber.last_seen_at) : 'Never'
    const lastActive = subscriber.last_push_at ? timeAgo(subscriber.last_push_at) : 'Unknown'
    const pill = freshness === 'synced' ? 'active' : freshness === 'stale' ? 'degraded' : 'pending'
    const pillText = sender ? 'Linked' : freshness === 'synced' ? 'Synced' : freshness === 'stale' ? 'Stale' : 'Not pulled yet'

    const header = (
        <WorkspaceHeader
            logo={<PullAppLogo subscriber={subscriber} className="h-12 w-12" />}
            title={subscriber.name}
            pill={
                <WorkspaceStatusPill status={pill} label={pillText}>
                    <div className="space-y-1">
                        <p className="truncate text-sm font-semibold">{subscriber.name}</p>
                        <p className="text-xs text-muted-foreground">
                            {sender
                                ? 'Sends its addon to this account when you push from the app.'
                                : freshness === 'stale' ? 'This app has not pulled in over 7 days. Open it to sync again.' : 'Pulls this account’s addons on its own schedule.'}
                        </p>
                    </div>
                    <PopoverFacts facts={[
                        sender
                            ? { label: 'Last active', value: lastActive }
                            : { label: 'Last pull', value: lastPull, tone: freshness === 'stale' ? 'warning' : undefined },
                        { label: 'Connected', value: subscriber.created_at ? new Date(subscriber.created_at).toLocaleDateString() : 'Unknown' },
                    ]} />
                    <Button size="sm" variant="outline" className="h-9 w-full text-xs" asChild>
                        <RouterLink to={HYDRA_PULL_GUIDE}><BookOpen className="h-3.5 w-3.5" />{sender ? 'How Hydra apps connect' : 'How pull apps connect'}</RouterLink>
                    </Button>
                </WorkspaceStatusPill>
            }
            identity={sender ? 'Sender app · Hydra API' : 'Pull app · Hydra API · read-only'}
            actions={
                <WorkspaceAction asChild>
                    <RouterLink to={HYDRA_PULL_GUIDE}><BookOpen className="h-3.5 w-3.5" />Instructions</RouterLink>
                </WorkspaceAction>
            }
            stats={[
                sender
                    ? { label: 'Last active', value: lastActive, sub: subscriber.last_push_at ? new Date(subscriber.last_push_at).toLocaleString() : undefined }
                    : { label: 'Last pull', value: lastPull, sub: subscriber.last_seen_at ? new Date(subscriber.last_seen_at).toLocaleString() : 'Waiting for the first pull', tone: freshness === 'stale' ? 'warning' : undefined },
                { label: 'Connected', value: subscriber.created_at ? timeAgo(subscriber.created_at) : 'Unknown', sub: subscriber.created_at ? new Date(subscriber.created_at).toLocaleDateString() : undefined },
                ...(sender ? [] : [{ label: 'Account addons', value: String(addonCount), sub: 'What this app reads' }]),
            ]}
        />
    )

    return (
        <div className="space-y-4">
            <ToolbarShell className="w-fit max-w-full p-2" contentClassName="gap-2">
                <Button variant="ghost" size="sm" className="h-11 shrink-0 gap-1.5 rounded-xl border border-border/40 bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm hover:bg-muted/50 hover:text-foreground sm:h-8" onClick={onBack}>
                    <ArrowLeft className="h-4 w-4" />
                    Connections
                </Button>
            </ToolbarShell>
            <WorkspaceTabs label={`${subscriber.name} workspace`} tabs={tabs} value={tab} onValueChange={setTab} header={header}>
                <TabsContent value="overview">
                    <div className="grid gap-4 lg:grid-cols-2">
                        {sender ? (
                            <SectionCard title="What it sends" description="This app pushes its addon into AIOManager. AIOManager can't reach the app itself.">
                                <SectionRows>
                                    <SectionRow label="Sends" value="Its own addon manifest URL" />
                                    <SectionRow label="Direction" value="Push only, when you push from the app; no pulls recorded" />
                                    <SectionRow label="Last active" value={subscriber.last_push_at ? `${lastActive} (${new Date(subscriber.last_push_at).toLocaleString()})` : 'Unknown'} />
                                </SectionRows>
                            </SectionCard>
                        ) : (
                            <SectionCard title="What it pulls" description="Backendless apps read from AIOManager. AIOManager can't push to them.">
                                <SectionRows>
                                    <SectionRow label="Reads" value={`This account's addon collection (${addonCount} addon${addonCount === 1 ? '' : 's'})`} />
                                    <SectionRow label="Direction" value="Pull only, on the app's schedule" />
                                    <SectionRow label="Last pull" value={subscriber.last_seen_at ? `${lastPull} (${new Date(subscriber.last_seen_at).toLocaleString()})` : 'Not pulled yet'} tone={freshness === 'stale' ? 'warning' : undefined} />
                                </SectionRows>
                            </SectionCard>
                        )}
                        <SectionCard
                            title="How it connects"
                            description="The app needs this instance URL and the account API key."
                            footer={<>
                                <Button variant="outline" size="sm" className="h-11 gap-1.5 text-xs sm:h-8" asChild>
                                    <RouterLink to={HYDRA_PULL_GUIDE}><BookOpen className="h-3.5 w-3.5" />Read the instructions</RouterLink>
                                </Button>
                                {onOpenApiKey && (
                                    <Button variant="ghost" size="sm" className="h-11 gap-1.5 text-xs sm:h-8" onClick={onOpenApiKey}><Key className="h-3.5 w-3.5" />API key</Button>
                                )}
                            </>}
                        >
                            <SectionRows>
                                <SectionRow label={sender ? 'API URL' : 'Pull URL'} value={maskedPullUrl} mono aside={<CopyButton value={pullUrl} variant="ghost" className="h-8 w-8" iconSize={14} aria-label={sender ? 'Copy API URL' : 'Copy pull URL'} />} />
                                <SectionRow label="Auth" value="Account API key in the X-API-Key header" />
                            </SectionRows>                        </SectionCard>
                    </div>
                </TabsContent>
                <TabsContent value="connection">
                    <SectionCard
                        title="Remove app"
                        description={sender ? 'Removes this app from the list. To stop it sending for good, rotate the account API key.' : 'Removes this app from the list. To stop it pulling for good, rotate the account API key.'}
                        footer={
                            <div className="ml-auto flex items-center gap-1.5">
                                {confirmRemove ? (
                                    <>
                                        <Button size="sm" variant="subtle" className="h-11 text-xs sm:h-8" onClick={() => setConfirmRemove(false)}>Cancel</Button>
                                        <Button size="sm" variant="destructive" className="h-11 gap-1.5 text-xs sm:h-8" onClick={() => { onRemove(subscriber.name); onBack() }}>
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Remove app
                                        </Button>
                                    </>
                                ) : (
                                    <Button size="sm" variant="outline" className="h-11 gap-1.5 text-xs text-destructive hover:text-destructive sm:h-8" onClick={() => setConfirmRemove(true)}>
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Remove app…
                                    </Button>
                                )}
                            </div>
                        }
                    />
                </TabsContent>
            </WorkspaceTabs>
        </div>
    )
}
