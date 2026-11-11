// Gathers browser and session facts for the "Copy support info" block
// (src/lib/support-info.ts builds and redacts the text). Structured fields
// only: free-text sync failure messages are mapped to fixed categories here
// and then dropped, so no message text can reach the clipboard. No account
// names, ids, emails, tokens or URLs are read.

import {
    buildSupportInfoText,
    classifySyncError,
    CONNECTION_PLATFORM_VALUES,
    describeBrowser,
    knownValue,
    type SupportCrashFacts,
    type SupportInfoFacts,
    type SupportPlatform,
} from './support-info.ts'
import { redactCopyText } from './redact-copy.ts'
import { useSyncStore } from '@/store/syncStore'
import { useAccountStore } from '@/store/accountStore'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'
import { readPendingPushMarker } from '@/lib/pending-push-marker'
import pkg from '../../package.json'

const HEALTH_TIMEOUT_MS = 2500

async function fetchServerHealth(): Promise<{ version?: string } | null> {
    try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
        if (!res.ok) return null
        return (await res.json()) as { version?: string }
    } catch {
        return null
    }
}

async function readStorageLine(): Promise<string | null> {
    try {
        if (!navigator.storage?.estimate) return null
        const { usage = 0, quota = 0 } = await navigator.storage.estimate()
        if (!quota) return null
        let persistence = ''
        try {
            persistence = (await navigator.storage.persisted()) ? ', persistent' : ', best-effort'
        } catch { /* persistence state is optional */ }
        const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`
        return `${mb(usage)} used of ${mb(quota)} (${Math.round((usage / quota) * 100)}%)${persistence}`
    } catch {
        return null
    }
}

/** Coarse browser and OS family, re-exported for the diagnostics copy. */
export { describeBrowser }

/** Per-platform enabled/disabled counts of canonical platforms only. */
function readConnectionPlatforms(): SupportPlatform[] {
    const accounts = useAccountStore.getState().accounts || []
    const counts = new Map<string, { enabledCount: number; disabledCount: number }>()
    for (const account of accounts) {
        for (const c of account.connections || []) {
            if (!c?.platform) continue
            const platform = knownValue(c.platform, CONNECTION_PLATFORM_VALUES, 'other')
            const entry = counts.get(platform) || { enabledCount: 0, disabledCount: 0 }
            if (c.enabled === true) entry.enabledCount++
            else entry.disabledCount++
            counts.set(platform, entry)
        }
    }
    return [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([platform, c]) => ({ platform, ...c }))
}

/**
 * One call per copy action; the result is already structured and redacted.
 * When crash facts are supplied (ErrorBoundary), a sanitized crash block is
 * included; the free-text message survives only if it passes strict checks.
 */
export async function buildSupportCopyText(crash?: SupportCrashFacts | null): Promise<string> {
    const sync = useSyncStore.getState()
    const marker = readPendingPushMarker(getActiveWorkspaceId())
    const health = await fetchServerHealth()
    const storage = await readStorageLine()
    const facts: SupportInfoFacts = {
        generatedAt: new Date().toISOString(),
        appVersion: pkg.version,
        serverVersion: health?.version ?? null,
        serverReachable: health !== null,
        browser: describeBrowser(navigator.userAgent),
        device: `${window.innerWidth}x${window.innerHeight}, ${window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse'}`,
        pwa: window.matchMedia('(display-mode: standalone)').matches,
        storage,
        recentErrors: (sync.history || [])
            .filter(e => e.status === 'error')
            .slice(0, 5)
            .map(e => {
                const { category, httpStatus } = classifySyncError(e.message)
                return { timestamp: e.timestamp, type: e.type, category, httpStatus }
            }),
        pendingPushes: marker ? [marker] : [],
        platforms: readConnectionPlatforms(),
        crash: crash ?? null,
    }
    return redactCopyText(buildSupportInfoText(facts))
}
