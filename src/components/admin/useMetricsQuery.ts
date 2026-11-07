/**
 * Dashboard host metrics poll (DP-02): refreshes every 30 s while a metrics
 * screen is open and stops as soon as the session ends, exactly like the
 * overview query it mirrors.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getMetrics } from '@/api/admin'
import { adminRetry, overviewRefetchInterval } from '@/lib/admin-queries'

export function useMetricsQuery(enabled: boolean) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: ['admin-metrics'],
    queryFn: getMetrics,
    enabled,
    staleTime: 30_000,
    retry: adminRetry,
    // Stops as soon as the session ends, so no 401s after sign-out.
    refetchInterval: overviewRefetchInterval(queryClient),
  })
}
