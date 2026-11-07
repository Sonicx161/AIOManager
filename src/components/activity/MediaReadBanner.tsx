import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { groupMediaReadIssues } from '@/lib/jellyfin/read-issues'
import type { MediaReadIssue } from '@/hooks/useJellyfinActivity'

interface MediaReadBannerProps {
    issues: MediaReadIssue[]
    accountName: (accountId: string) => string
    onRetry: () => void
    busy?: boolean
}

export function MediaReadBanner({ issues, accountName, onRetry, busy }: MediaReadBannerProps) {
    const navigate = useNavigate()
    const { entries, hiddenCount } = useMemo(() => groupMediaReadIssues(issues, accountName), [issues, accountName])
    if (entries.length === 0) return null
    const reconnect = (accountId: string) => navigate(`/account/${accountId}?tab=connections`)
    return (
        <div data-theme-part="panel" className="space-y-2 rounded-xl border border-border/40 bg-card p-3 text-xs text-muted-foreground" role="status">
            {entries.map(entry => (
                <div key={entry.key} className="space-y-1.5">
                    <p className="text-foreground">{entry.headline}</p>
                    <div className="flex flex-wrap items-center gap-2">
                        {entry.reconnectAccountId && (
                            <Button size="sm" variant="outline" onClick={() => reconnect(entry.reconnectAccountId!)}>Reconnect</Button>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={onRetry}>Retry</Button>
                    </div>
                    <details>
                        <summary className="cursor-pointer font-medium">Details</summary>
                        <ul className="mt-1.5 space-y-1">
                            {entry.details.map(detail => (
                                <li key={`${detail.accountId}:${detail.label}`}>
                                    <span className="font-medium text-foreground">{detail.accountName} · {detail.label}:</span> {detail.text}
                                    {detail.canReconnect && (
                                        <button type="button" className="ml-1.5 underline underline-offset-2 hover:text-foreground" onClick={() => reconnect(detail.accountId)}>Reconnect</button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </details>
                </div>
            ))}
            {hiddenCount > 0 && <p>+{hiddenCount} more {hiddenCount === 1 ? 'server' : 'servers'} with problems</p>}
        </div>
    )
}
