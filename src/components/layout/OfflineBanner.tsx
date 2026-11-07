import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { useSyncStore } from '@/store/syncStore'
import { getSyncApiPath } from '@/store/sync-store-helpers'
import { latestNetworkFailure, nextProbeDelay, OFFLINE_BOOT_GRACE_MS, shouldShowOfflineBanner } from '@/lib/connectivity'
import { Button } from '@/components/ui/button'

const BOOT_AT = Date.now()
const PROBE_TIMEOUT_MS = 5000

async function probeBackend(serverUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${getSyncApiPath(serverUrl)}/health`, { cache: 'no-store', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function useBackendOffline() {
  const serverUrl = useSyncStore(s => s.serverUrl)
  const history = useSyncStore(s => s.history)
  const failure = latestNetworkFailure(history, BOOT_AT)
  const failureId = failure?.id ?? null

  const [offline, setOffline] = useState(false)
  const [checking, setChecking] = useState(false)
  const attempt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearedFailure = useRef<string | null>(null)
  const alive = useRef(true)

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const probe = useCallback(async () => {
    clearTimer()
    setChecking(true)
    const ok = await probeBackend(serverUrl)
    if (!alive.current) return
    setChecking(false)
    if (ok) {
      attempt.current = 0
      clearedFailure.current = failureId
      setOffline(false)
      return
    }
    setOffline(true)
    timer.current = setTimeout(() => { void probe() }, nextProbeDelay(attempt.current++))
  }, [serverUrl, failureId, clearTimer])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimer()
    }
  }, [clearTimer])

  useEffect(() => {
    if (failureId && failureId !== clearedFailure.current) void probe()
  }, [failureId, probe])

  useEffect(() => {
    const onOffline = () => setOffline(true)
    const onOnline = () => { void probe() }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [probe])

  useEffect(() => {
    if (offline && !timer.current && !checking) {
      timer.current = setTimeout(() => { void probe() }, nextProbeDelay(attempt.current++))
    }
  }, [offline, checking, probe])

  return { offline, checking, retry: probe }
}

export function OfflineBanner() {
  const authenticated = useSyncStore(s => s.auth.isAuthenticated)
  const { offline, checking, retry } = useBackendOffline()
  const [graceOver, setGraceOver] = useState(() => Date.now() - BOOT_AT >= OFFLINE_BOOT_GRACE_MS)

  useEffect(() => {
    if (graceOver) return
    const timer = setTimeout(() => setGraceOver(true), Math.max(0, BOOT_AT + OFFLINE_BOOT_GRACE_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [graceOver])

  if (!graceOver || !shouldShowOfflineBanner({ offline, authenticated, now: Date.now(), bootAt: BOOT_AT })) return null

  return (
    <div role="status" data-theme-tone="status" data-theme-part="panel" className="pointer-events-auto relative z-50 border-b border-warning/30 bg-warning/10">
      <div className="mx-auto flex w-full max-w-[1800px] items-center gap-2.5 px-4 py-1.5">
        <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" />
        <p className="min-w-0 flex-1 text-xs leading-snug text-foreground/90">
          Can&apos;t reach the server. Changes are saved here and will sync when it&apos;s back.
        </p>
        <Button size="sm" variant="ghost" onClick={() => { void retry() }} disabled={checking} className="h-7 shrink-0 gap-1.5 px-2 text-xs font-bold">
          <RefreshCw className={checking ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
          Retry
        </Button>
      </div>
    </div>
  )
}
