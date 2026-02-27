import { useEffect, useMemo } from 'react'
import { useProviderStore } from '@/store/providerStore'
import { useVaultStore } from '@/store/vaultStore'
import { ProviderHealthBadge } from './ProviderHealthBadge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Activity, ShieldCheck, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function ExpiryDashboard() {
    const { keys } = useVaultStore()
    const { health, refreshAll, isRefreshing } = useProviderStore()

    const providerKeys = useMemo(() => keys.filter(k =>
        ['real-debrid', 'torbox', 'premiumize', 'alldebrid'].includes(k.provider)
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
                        <Card key={key.id} className="overflow-hidden border-muted/40 bg-card/50 backdrop-blur-sm hover:shadow-md transition-all group">
                            <CardHeader className="p-4 pb-2 space-y-0">
                                <div className="flex items-start justify-between">
                                    <div className="space-y-1">
                                        <CardTitle className="text-sm font-bold truncate max-w-[120px]">{key.name}</CardTitle>
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                                                {key.provider.replace('-', ' ')}
                                            </span>
                                        </div>
                                    </div>
                                    <ShieldCheck className="h-4 w-4 text-primary/40 group-hover:text-primary transition-colors" />
                                </div>
                            </CardHeader>
                            <CardContent className="p-4 pt-2">
                                <div className="mt-2 flex items-center justify-between">
                                    {status ? (
                                        <ProviderHealthBadge health={status} />
                                    ) : (
                                        <div className="h-6 w-20 bg-muted animate-pulse rounded-full" />
                                    )}

                                    <div className="flex items-center gap-1">
                                        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" asChild>
                                            <a href={getProviderUrl(key.provider)} target="_blank" rel="noopener noreferrer">
                                                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                                            </a>
                                        </Button>
                                    </div>
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
        default: return '#'
    }
}
