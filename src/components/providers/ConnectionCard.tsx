import { Switch } from '@/components/ui/switch'
import { ChevronRight } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Connection, ConnectionStatus } from '@/types/connection'
import { connectionStatusParts, displayStatus, tokenExpiry } from '@/lib/connection-format'
import { connectionPresentation, isHealthyConnection } from './connection-state'
import { ConnectionStatusPill, PlatformLogo, connectionLabel, connectionLogoProduct } from './ConnectionPrimitives'

interface ConnectionCardProps {
    connection: Connection
    status: ConnectionStatus
    lastSync?: number
    lastError?: string | null
    syncing?: boolean
    onEdit: () => void
    onToggle: () => void
    email?: string
    contextLabel?: string
    badge?: React.ReactNode
    addonCount?: number
    /** Which truth the count represents: the account's recorded collection or the count recorded at the connection's last sync. */
}

export const ConnectionCard = memo(function ConnectionCard({
    connection,
    status,
    lastSync,
    syncing,
    onEdit,
    onToggle,
    email,
    badge,
    addonCount,
}: ConnectionCardProps) {
    const name = connectionLabel(connection)
    const expiry = tokenExpiry(connection)
    const display = displayStatus(status, expiry)

    const [enabled, setEnabled] = useState(connection.enabled !== false)
    useEffect(() => { setEnabled(connection.enabled !== false) }, [connection.enabled])

    const { pill, showLive } = connectionPresentation(enabled, display)
    const healthy = isHealthyConnection(enabled, display)

    const tint =
        !showLive ? undefined :
        display === 'expired' || display === 'error' ? 'border-destructive/30' :
        display === 'expiring' || display === 'degraded' ? 'border-warning/30' :
        undefined

    const statusParts = connectionStatusParts({
        name,
        identity: email,
        addonCount,
        enabled,
        platform: connection.platform,
        lastSync,
        mediaServerLastCheckedAt: connection.mediaServer?.lastCheckedAt,
    })

    const stop = (e: React.SyntheticEvent) => e.stopPropagation()
    const stopActivate = (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }

    return (
        <div
            role="button"
            tabIndex={0}
            data-theme-part="card"
            onClick={onEdit}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit() } }}
            className={cn(
                'group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border/40 bg-card px-3 py-2 text-left text-card-foreground shadow-sm sm:gap-4 sm:rounded-2xl sm:px-4 sm:py-3.5',
                'transition-[background-color,border-color] duration-200 hover:border-border/70 hover:bg-card/95',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tint
            )}
        >
            <PlatformLogo platform={connection.platform} product={connectionLogoProduct(connection)} className="h-10 w-10 shrink-0 sm:h-11 sm:w-11" isHydra={connection.connectionType === 'hydra-outbound'} />
            <div className="min-w-0 flex-1">
                {/* Phone keeps the chips beside the name (the name yields, chips never
                    shrink) and lets the status wrap onto a second line instead of
                    truncating. Desktop renders the single truncated line as before. */}
                <div className="flex min-w-0 flex-wrap max-sm:flex-nowrap items-center gap-x-2 gap-y-0.5">
                    <span className="min-w-0 truncate text-sm font-semibold leading-tight sm:text-[15px]">{name}</span>
                    {badge}
                </div>
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-tight text-muted-foreground sm:mt-1 sm:block sm:truncate sm:text-[13px] sm:leading-snug">
                    {statusParts.identity && (
                        <>
                            <span className="max-sm:min-w-0 max-sm:max-w-full max-sm:truncate">{statusParts.identity}</span>
                            {/* Full-width zero-height break on phone; the joined separator on desktop. */}
                            <span aria-hidden="true" className="max-sm:block max-sm:h-0 max-sm:basis-full max-sm:overflow-hidden">{' \u00b7 '}</span>
                        </>
                    )}
                    <span>{statusParts.activity}</span>
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-2" onClick={stop} onKeyDown={stopActivate}>
                {!healthy && <ConnectionStatusPill status={pill} />}
                <Switch
                    checked={enabled}
                    onCheckedChange={() => { setEnabled(v => !v); onToggle() }}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}
                    disabled={syncing}
                />
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
            </div>
        </div>
    )
})
