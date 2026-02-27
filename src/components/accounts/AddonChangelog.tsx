import { useAccountStore } from '@/store/accountStore'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getTimeAgo } from '@/lib/utils'
import { Plus, Trash2, RefreshCw, Clock } from 'lucide-react'
import { useMemo } from 'react'

interface AddonChangelogProps {
    accountId?: string
}

export function AddonChangelog({ accountId }: AddonChangelogProps) {
    const changelog = useAccountStore((state) => state.changelog)
    const accounts = useAccountStore((state) => state.accounts)

    const filteredChangelog = useMemo(() => {
        if (!accountId) return changelog
        return changelog.filter((entry) => entry.accountId === accountId)
    }, [changelog, accountId])

    if (filteredChangelog.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
                <div style={{
                    width: '48px', height: '48px', borderRadius: '50%',
                    background: 'rgba(255,255,255,0.04)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                    <Clock className="h-5 w-5 text-muted-foreground opacity-40" />
                </div>
                <p className="text-sm text-muted-foreground">No changes recorded yet</p>
                <p style={{ fontFamily: '"DM Mono", monospace', fontSize: '10px', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.05em' }}>
                    Updates, installs and removals will appear here
                </p>
            </div>
        )
    }

    const getAccountName = (id: string) => accounts.find(a => a.id === id)?.name || 'Unknown'

    return (
        <div className="rounded-lg border border-border/30 overflow-hidden">
            <ScrollArea className="h-[200px]">
                <div className="divide-y divide-border/30">
                    {filteredChangelog.map((entry) => (
                        <div key={entry.id} className="p-3 flex items-center justify-between gap-3 text-sm hover:bg-accent/20 transition-colors">
                            <div className="flex gap-3 items-center min-w-0">
                                <div className="relative shrink-0">
                                    {entry.addonLogo ? (
                                        <img src={entry.addonLogo} alt="" className="h-8 w-8 rounded-lg object-cover bg-muted" />
                                    ) : (
                                        <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                                            <Plus className="h-4 w-4 text-muted-foreground" />
                                        </div>
                                    )}
                                    <div className={`absolute -bottom-1 -right-1 p-0.5 rounded-full ring-2 ring-background ${entry.action === 'installed' ? 'bg-green-500 text-white' :
                                            entry.action === 'removed' ? 'bg-red-500 text-white' :
                                                'bg-blue-500 text-white'
                                        }`}>
                                        {entry.action === 'installed' ? <Plus className="h-2.5 w-2.5" /> :
                                            entry.action === 'removed' ? <Trash2 className="h-2.5 w-2.5" /> :
                                                <RefreshCw className="h-2.5 w-2.5" />}
                                    </div>
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                        <p className="font-semibold truncate leading-none">
                                            {entry.addonName}
                                        </p>
                                        <span className={`text-[9px] font-bold px-1 py-0.5 rounded uppercase tracking-wider ${entry.action === 'installed' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
                                                entry.action === 'removed' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
                                                    'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                                            }`}>
                                            {entry.action}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {entry.action === 'installed' ? 'Newly installed' : entry.action === 'removed' ? 'Removed from account' : 'Updated to latest'}
                                        {!accountId && ` • ${getAccountName(entry.accountId)}`}
                                    </p>
                                </div>
                            </div>
                            <span className="text-[10px] text-muted-foreground font-medium shrink-0 pt-1">
                                {getTimeAgo(new Date(entry.timestamp))}
                            </span>
                        </div>
                    ))}
                </div>
            </ScrollArea>
        </div>
    )
}
