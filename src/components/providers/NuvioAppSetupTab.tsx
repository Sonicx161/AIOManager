import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Info, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAccountStore } from '@/store/accountStore'
import { readNuvioHomeLayout, readNuvioMediaServers } from '@/lib/nuvio-data'
import { catalogDirectory, mapHomeLayout } from '@/lib/nuvio-app-setup'
import { getEffectiveManifest } from '@/lib/addon-utils'
import type { Connection } from '@/types/connection'
import { SectionCard, WorkspaceError, WorkspaceLoading } from './workspace/SectionCard'
import { nuvioReadIdentity, useNuvioResource } from './NuvioWorkspace'

const Empty = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-muted-foreground">{children}</p>

export function NuvioAppSetupTab({ accountId, connection }: { accountId: string; connection: Connection }) {
    const identity = nuvioReadIdentity(accountId, connection, true)
    const loadServers = useCallback(() => readNuvioMediaServers(accountId, connection), [accountId, connection])
    const loadLayout = useCallback(() => readNuvioHomeLayout(accountId, connection), [accountId, connection])
    const servers = useNuvioResource(loadServers, identity, true, 'media-servers')
    const layout = useNuvioResource(loadLayout, identity, true, 'home-layout')
    const addons = useAccountStore(s => s.accounts.find(a => a.id === accountId)?.addons)
    const directory = useMemo(() => catalogDirectory((addons || []).map(addon => ({ manifest: getEffectiveManifest(addon) }))), [addons])
    const rows = useMemo(() => (layout.data?.shared ? mapHomeLayout(layout.data.items, directory) : []), [layout.data, directory])
    const busy = servers.loading || servers.revalidating || layout.loading || layout.revalidating
    const refresh = () => {
        void servers.reload()
        void layout.reload()
    }

    const serverBody = servers.error && !servers.data ? <WorkspaceError message={servers.error} onRetry={servers.reload} />
        : !servers.data ? <WorkspaceLoading label="Loading media servers…" compact />
            : !servers.data.shared ? <Empty>This Nuvio server does not share media servers.</Empty>
                : servers.data.items.length === 0 ? <Empty>No media servers linked in the Nuvio app.</Empty>
                    : (
                        <ul className="divide-y divide-border/30">
                            {servers.data.items.map(server => (
                                <li key={server.key} className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0">
                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-semibold text-muted-foreground" aria-hidden="true">{server.type.charAt(0)}</span>
                                    <div className="min-w-0">
                                        <p className="truncate text-[13px] font-semibold">{server.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{server.host ? `${server.type} · ${server.host}` : server.type}</p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )

    const layoutBody = layout.error && !layout.data ? <WorkspaceError message={layout.error} onRetry={layout.reload} />
        : !layout.data ? <WorkspaceLoading label="Loading home layout…" compact />
            : !layout.data.shared ? <Empty>This Nuvio server does not share the home layout.</Empty>
                : rows.length === 0 ? <Empty>This profile uses Nuvio's default home screen.</Empty>
                    : (
                        <ol className="divide-y divide-border/30">
                            {rows.map((row, i) => (
                                <li key={row.key} className={cn('flex min-w-0 items-baseline gap-2.5 py-2 text-[13px] first:pt-0 last:pb-0', row.hidden && 'text-muted-foreground')}>
                                    <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                                    {row.source && <span className="shrink-0 text-xs text-muted-foreground">{row.source}</span>}
                                </li>
                            ))}
                        </ol>
                    )

    return (
        <div className="space-y-3">
            <div className="grid gap-4 lg:grid-cols-2">
                <SectionCard title="Media servers" description="Servers this Nuvio profile is linked to in the app.">
                    {serverBody}
                </SectionCard>
                <SectionCard
                    title="Home layout"
                    description="Catalog rows on this profile's home screen, in order."
                    footer={(
                        <Button variant="outline" size="sm" className="h-11 gap-1.5 text-xs sm:h-8" onClick={refresh} disabled={busy}>
                            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
                            Refresh
                        </Button>
                    )}
                >
                    {layoutBody}
                </SectionCard>
            </div>
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Read-only. Change these in the Nuvio app.</span>
            </p>
        </div>
    )
}
