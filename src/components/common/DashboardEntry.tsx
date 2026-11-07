import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { apiFetch } from '@/lib/http-client'
import { cn } from '@/lib/utils'

/** A public status check only; admin data and authentication stay on the dashboard. */
export function DashboardEntry({ className }: { className?: string }) {
    const { data: visible } = useQuery({
        queryKey: ['admin-entry'],
        queryFn: async ({ signal }) => {
            const result = await apiFetch<{ enabled?: boolean; rememberedBrowser?: boolean }>('/admin/status', {
                signal, authHeaders: {}, timeoutMs: 5000,
            })
            // Fail closed: only a browser whose known-device cookie verifies sees the entry.
            return result.ok && result.data?.enabled === true && result.data?.rememberedBrowser === true
        },
        staleTime: 60_000,
        retry: false,
    })

    if (!visible) return null

    return (
        <Link
            to="/dashboard"
            className={cn(
                'text-xs text-muted-foreground hover:text-primary transition-colors',
                className,
            )}
        >
            Dashboard →
        </Link>
    )
}
