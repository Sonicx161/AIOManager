import { useEffect, useMemo, useState } from 'react'
import { accountRecentActivity, RECENT_ACTIVITY_WINDOW_MS } from '@/lib/jellyfin/activity'
import type { ActivityItem } from '@/types/activity'

export function useWatchingNow(items: ActivityItem[], enabled = true): ActivityItem | null {
    const [expiries, setExpiries] = useState(0)
    const item = useMemo(
        () => (enabled ? accountRecentActivity(items) ?? null : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [items, enabled, expiries],
    )
    const expiresAt = item ? new Date(item.timestamp).getTime() + RECENT_ACTIVITY_WINDOW_MS : 0
    useEffect(() => {
        if (!expiresAt) return
        const timer = setTimeout(() => setExpiries(n => n + 1), Math.max(0, expiresAt - Date.now()) + 50)
        return () => clearTimeout(timer)
    }, [expiresAt, expiries])
    return item
}
