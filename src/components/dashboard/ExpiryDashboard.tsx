import { useEffect, useMemo } from 'react'
import { useProviderStore } from '@/store/providerStore'
import { useVaultStore } from '@/store/vaultStore'

import { Button } from '@/components/ui/button'
import { RefreshCw, Activity, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ExpiryDashboard() {
    const { keys } = useVaultStore()
    const { health, refreshAll, isRefreshing } = useProviderStore()

    const providerKeys = useMemo(() => keys.filter(k =>
        ['real-debrid', 'torbox', 'premiumize', 'alldebrid', 'debrid-link'].includes(k.provider)
    ), [keys])

    useEffect(() => {
        // Initial refresh if we have keys and haven't checked recently
        const shouldRefresh = providerKeys.some(k => !health[k.id] || Date.now() - health[k.id].lastChecked > 3600000)
        if (shouldRefresh && !isRefreshing) {
            refreshAll()
        }
    }, [health, isRefreshing, providerKeys, refreshAll])

    if (providerKeys.length === 0) {
        return null
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-primary/10 text-primary">
                        <Activity className="h-5 w-5" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold tracking-tight">Provider Health</h2>
                        <p className="text-xs text-muted-foreground">Monitoring your active debrid subscriptions.</p>
                    </div>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refreshAll()}
                    disabled={isRefreshing}
                    className="h-8 shadow-none bg-background/50 border-muted hover:bg-background"
                >
                    <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                    Sync Status
                </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {providerKeys.map((key) => {
                    const status = health[key.id]
                    return (
                        <Card key={key.id} className="overflow-hidden border bg-card/50 shadow-sm backdrop-blur-sm hover:shadow-md transition-all group">
                            <CardHeader className="p-4 pb-2 space-y-0">
                                <div className="flex flex-row items-start justify-between">
                                    <div className="flex flex-col">
                                        <CardTitle className="text-sm font-bold truncate max-w-[120px]">{key.name}</CardTitle>
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mt-0.5">
                                            {key.provider.replace('-', ' ')}
                                        </span>
                                    </div>
                                    {status ? (
                                        <div className={`px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-widest border ${status.status === 'active' ? 'bg-green-500/10 text-green-500 border-green-500/20' :
                                            status.status === 'expired' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' :
                                                'bg-destructive/10 text-destructive border-destructive/20'
                                            }`}>
                                            {status.status || 'UNKNOWN'}
                                        </div>
                                    ) : (
                                        <div className="h-5 w-16 bg-muted animate-pulse rounded-sm" />
                                    )}
                                </div>
                            </CardHeader>
                            <CardContent className="p-4 pt-1">
                                <div className="mt-1 space-y-1">
                                    {status ? (
                                        <>
                                            <div className="flex flex-col items-start my-2">
                                                {status.daysRemaining !== null && status.daysRemaining !== undefined ? (() => {
                                                    const total = status.daysRemaining
                                                    const years = Math.floor(total / 365)
                                                    const months = Math.floor((total % 365) / 30)
                                                    const days = total % 30
                                                    const parts = []
                                                    if (years > 0) parts.push(`${years}y`)
                                                    if (months > 0) parts.push(`${months}mo`)
                                                    if (days > 0 || parts.length === 0) parts.push(`${days}d`)
                                                    return (
                                                        <>
                                                            <span className="text-2xl font-black text-foreground leading-tight">{parts.join(' ')}</span>
                                                            {status.expiresAt ? (
                                                                <span className="text-[10px] text-muted-foreground mt-0.5">Expires {new Date(status.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                                                            ) : (
                                                                <span className="h-3 w-1 opacity-0 mt-0.5" />
                                                            )}
                                                        </>
                                                    )
                                                })() : (
                                                    <span className="text-2xl font-black text-muted-foreground leading-tight">—</span>
                                                )}
                                            </div>

                                            {status.error && (
                                                <p className="text-[10px] text-destructive leading-tight italic mb-2">
                                                    {status.error}
                                                </p>
                                            )}

                                            <div className="flex items-center justify-between border-t border-border/40 mt-3 pt-3">
                                                <span className="text-[10px] text-muted-foreground">{status.lastChecked ? new Date(status.lastChecked).toLocaleTimeString() : 'Never'}</span>
                                                <a
                                                    href={getProviderUrl(key.provider)}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center text-[10px] text-primary hover:underline"
                                                >
                                                    API Dashboard <ExternalLink className="h-2.5 w-2.5 ml-1" />
                                                </a>
                                            </div>
                                        </>
                                    ) : (
                                        <div className="space-y-1 my-2">
                                            <div className="h-6 w-20 bg-muted animate-pulse rounded" />
                                            <div className="h-3 w-28 bg-muted animate-pulse rounded" />

                                            <div className="flex justify-between items-center pt-3 mt-3 border-t border-border/40">
                                                <div className="h-3 w-16 bg-muted animate-pulse rounded" />
                                                <div className="h-3 w-16 bg-muted animate-pulse rounded" />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    )
                })}
            </div>
        </div>
    )
}

function getProviderUrl(provider: string) {
    switch (provider) {
        case 'real-debrid': return 'https://real-debrid.com/premium'
        case 'torbox': return 'https://torbox.app/settings'
        case 'premiumize': return 'https://www.premiumize.me/account'
        case 'alldebrid': return 'https://alldebrid.com/apikeys'
        case 'debrid-link': return 'https://debrid-link.com/webapp/apikey'
        default: return '#'
    }
}
