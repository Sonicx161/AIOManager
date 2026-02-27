import { cn } from '@/lib/utils'

function Skeleton({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                'animate-pulse rounded-md bg-muted/60',
                className
            )}
            {...props}
        />
    )
}

/** Skeleton shaped like an account card (matches AccountCard layout) */
function AccountCardSkeleton() {
    return (
        <div className="rounded-lg border bg-card p-4 space-y-3">
            <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                </div>
            </div>
            <div className="flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <Skeleton className="h-8 w-full rounded-md" />
        </div>
    )
}

/** Skeleton for a stat card (matches MetricsPage stat blocks) */
function StatCardSkeleton() {
    return (
        <div className="rounded-lg border bg-card p-4 space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-20" />
        </div>
    )
}

/** Skeleton for an activity list item (matches ActivityItemCard layout) */
function ActivityItemSkeleton() {
    return (
        <div className="flex items-center gap-4 rounded-lg border bg-card p-3">
            <Skeleton className="h-16 w-12 rounded-md flex-shrink-0" />
            <div className="space-y-2 flex-1 min-w-0">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-8 w-16 rounded-md flex-shrink-0" />
        </div>
    )
}

/** Full Metrics page skeleton (header + stat grid + charts) */
function MetricsPageSkeleton() {
    return (
        <div className="space-y-8 pb-32 animate-in fade-in duration-500">
            {/* Header */}
            <div className="px-4 flex items-center justify-between">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="h-8 w-28 rounded-full" />
            </div>

            {/* Stat cards grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <StatCardSkeleton key={i} />
                ))}
            </div>

            {/* Chart area */}
            <div className="space-y-4">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-64 w-full rounded-lg" />
            </div>

            {/* Awards area */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
                        <Skeleton className="h-12 w-12 rounded-full mx-auto" />
                        <Skeleton className="h-4 w-24 mx-auto" />
                        <Skeleton className="h-3 w-32 mx-auto" />
                    </div>
                ))}
            </div>
        </div>
    )
}

/** Full Activity page skeleton (header + filter bar + item list) */
function ActivityPageSkeleton() {
    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start gap-4">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-28" />
                    <Skeleton className="h-4 w-72" />
                </div>
                <div className="flex gap-2">
                    <Skeleton className="h-9 w-24 rounded-md" />
                    <Skeleton className="h-9 w-28 rounded-md" />
                </div>
            </div>

            {/* Filter bar */}
            <div className="flex gap-2">
                <Skeleton className="h-9 w-64 rounded-md" />
                <Skeleton className="h-9 w-20 rounded-md" />
                <Skeleton className="h-9 w-20 rounded-md" />
            </div>

            {/* Activity items list */}
            <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                    <ActivityItemSkeleton key={i} />
                ))}
            </div>
        </div>
    )
}

export {
    Skeleton,
    AccountCardSkeleton,
    StatCardSkeleton,
    ActivityItemSkeleton,
    MetricsPageSkeleton,
    ActivityPageSkeleton,
}
