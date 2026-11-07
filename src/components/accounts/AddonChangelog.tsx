import { useAccountStore } from '@/store/accountStore'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { getTimeAgo, normalizeAddonUrl } from '@/lib/utils'
import { maskSecretUrl } from '@/lib/mask-secret-url'
import { Plus, Trash2, RefreshCw, Clock } from 'lucide-react'
import { useMemo } from 'react'
import { AddonIcon } from '@/components/ui/addon-icon'

interface AddonChangelogProps {
    accountId?: string
}

export function AddonChangelog({ accountId }: AddonChangelogProps) {
    const changelog = useAccountStore((state) => state.changelog)
    const accounts = useAccountStore((state) => state.accounts)
    const clearChangelog = useAccountStore((state) => state.clearChangelog)

    const filteredChangelog = useMemo(() => {
        if (!accountId) return changelog
        const account = accounts.find((candidate) => candidate.id === accountId)
        const installedUrls = new Set(
            (account?.addons || []).map((addon) => normalizeAddonUrl(addon.transportUrl))
        )
        return changelog.filter((entry) => {
            if (entry.accountId !== accountId) return false
            if (!entry.addonUrl || entry.action === 'removed') return true
            return installedUrls.has(normalizeAddonUrl(entry.addonUrl))
        })
    }, [changelog, accountId, accounts])

    const getAccountName = (id: string) => accounts.find(a => a.id === id)?.name || 'Unknown'
    const resolveEntryAddon = (entry: typeof filteredChangelog[number]) => {
        if (!entry.addonUrl && !entry.addonId) return null
        const account = accounts.find((candidate) => candidate.id === entry.accountId)
        if (!account) return null
        const normalizedEntryUrl = entry.addonUrl ? normalizeAddonUrl(entry.addonUrl) : null
        if (normalizedEntryUrl) {
            const byUrl = account.addons.find((addon) => normalizeAddonUrl(addon.transportUrl) === normalizedEntryUrl)
            if (byUrl) return byUrl
        }
        if (entry.addonId) {
            const byId = account.addons.find((addon) => addon.manifest?.id === entry.addonId)
            if (byId) return byId
        }
        return null
    }

    return (
        <div data-theme-part="panel" className="rounded-2xl border border-border/40 overflow-hidden flex flex-col bg-card/50 shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-border/30 px-3 py-2">
                <div>
                    <p className="text-sm font-semibold">{accountId ? 'Account Changelog' : 'Changelog'}</p>
                    <p className="text-xs text-muted-foreground">Updates, installs and removals</p>
                </div>
                {filteredChangelog.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => clearChangelog(accountId)}
                    >
                        Clear
                    </Button>
                )}
            </div>
            <ScrollArea className="max-h-[calc(100vh-12rem)] min-h-[200px]">
                {filteredChangelog.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center gap-3 h-full">
                        <div style={{
                            width: '48px', height: '48px', borderRadius: '50%',
                            background: 'hsl(var(--muted) / 0.4)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>
                            <Clock className="h-5 w-5 text-muted-foreground opacity-40" />
                        </div>
                        <p className="text-sm text-muted-foreground">No changes recorded yet</p>
                        <p style={{ fontFamily: '"Inter", monospace', fontSize: '10px', color: 'hsl(var(--muted-foreground) / 0.6)', letterSpacing: '0.05em' }}>
                            Updates, installs and removals will appear here
                        </p>
                    </div>
                ) : (
                    <div className="p-3 flex flex-col gap-2">
                        {filteredChangelog.map((entry) => {
                            const currentAddon = resolveEntryAddon(entry)
                            const addonName = currentAddon?.metadata?.customName || entry.addonName
                            const addonLogo = currentAddon?.metadata?.customLogo || entry.addonLogo
                            return (
                            <div key={entry.id} data-theme-part="panel" className="flex items-center justify-between gap-3 text-sm bg-card border border-border/40 rounded-xl px-3 py-2.5 shadow-sm hover:shadow-md hover:border-border transition-[transform,opacity,box-shadow]">
                                <div className="flex gap-3 items-center min-w-0">
                                    <div className="relative shrink-0">
                                        <AddonIcon
                                            name={addonName}
                                            logo={addonLogo}
                                            className="h-8 w-8"
                                            textClassName="text-xs"
                                            imageClassName="p-0.5"
                                        />
                                        <div className={`absolute -bottom-1 -right-1 z-20 p-0.5 rounded-full ring-2 ring-background ${entry.action === 'installed' ? 'bg-success text-white' :
                                            entry.action === 'removed' ? 'bg-destructive text-white' :
                                                entry.action === 'replaced' ? 'bg-warning text-white' : 'bg-primary text-primary-foreground'
                                            }`}>
                                            {entry.action === 'installed' ? <Plus className="h-2.5 w-2.5" /> :
                                                entry.action === 'removed' ? <Trash2 className="h-2.5 w-2.5" /> :
                                                    <RefreshCw className="h-2.5 w-2.5" />}
                                        </div>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <p className="font-semibold truncate leading-none">
                                                {addonName}
                                            </p>
                                            <span data-theme-part="badge" className={`text-xs font-bold px-1 py-0.5 rounded uppercase ${entry.action === 'installed' ? 'bg-success/10 text-success' :
                                                entry.action === 'removed' ? 'bg-destructive/10 text-destructive' :
                                                    entry.action === 'replaced' ? 'bg-warning/10 text-warning' : 'bg-primary/12 text-primary'
                                                }`}>
                                                {entry.action}
                                            </span>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {entry.action === 'installed' ? 'Newly installed' : entry.action === 'removed' ? 'Removed from account' : entry.action === 'replaced' ? 'URL replaced' : 'Updated to latest'}
                                            {!accountId && ` • ${getAccountName(entry.accountId)}`}
                                        </p>
                                        {entry.action === 'replaced' && entry.oldAddonUrl && entry.newAddonUrl && (
                                            <p className="mt-0.5 max-w-[48rem] truncate font-mono text-[11px] text-muted-foreground/70">
                                                {maskSecretUrl(entry.oldAddonUrl)} {'->'} {maskSecretUrl(entry.newAddonUrl)}
                                            </p>
                                        )}
                                        {entry.addonUrl && (
                                            <p className="mt-0.5 max-w-[48rem] truncate font-mono text-[11px] text-muted-foreground/70">
                                                {maskSecretUrl(entry.addonUrl)}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <span className="text-xs text-muted-foreground font-medium shrink-0 pt-1">
                                    {getTimeAgo(new Date(entry.timestamp))}
                                </span>
                            </div>
                        )})}
                    </div>
                )}
            </ScrollArea>
        </div>
    )
}
