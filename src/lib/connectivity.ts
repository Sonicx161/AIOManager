export interface SyncFailureEntry {
  id: string
  timestamp: string
  status: 'success' | 'error'
  message: string
}

export const OFFLINE_BOOT_GRACE_MS = 3000
export const PROBE_BACKOFF_MS = [5000, 10000, 20000, 40000, 60000]

const NETWORK_FAILURE = /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_(connection|internet|network|name)|\b(502|504)\b/i

export function isNetworkFailureMessage(message: string): boolean {
  return NETWORK_FAILURE.test(message)
}

// History is newest first. The newest entry since boot decides: a network failure raises
// suspicion, any later success clears it, and entries from earlier sessions are ignored.
export function latestNetworkFailure(history: SyncFailureEntry[], sinceMs: number): SyncFailureEntry | null {
  for (const entry of history) {
    const at = new Date(entry.timestamp).getTime()
    if (!Number.isFinite(at) || at < sinceMs) continue
    return entry.status === 'error' && isNetworkFailureMessage(entry.message) ? entry : null
  }
  return null
}

export function nextProbeDelay(attempt: number): number {
  return PROBE_BACKOFF_MS[Math.min(Math.max(attempt, 0), PROBE_BACKOFF_MS.length - 1)]
}

export function shouldShowOfflineBanner(input: { offline: boolean; authenticated: boolean; now: number; bootAt: number }): boolean {
  return input.offline && input.authenticated && input.now - input.bootAt >= OFFLINE_BOOT_GRACE_MS
}
