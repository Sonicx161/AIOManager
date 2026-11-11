import { useState } from 'react'
import { Wrench, KeyRound, PlugZap, ClipboardCopy, Loader2, LifeBuoy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SquircleOverlay } from '@/components/ui/squircle-overlay'
import { toast } from '@/hooks/use-toast'
import { copyTextToClipboard } from '@/components/ui/copy-button'
import { normalizeAddonUrl } from '@/lib/utils'
import { redactCopyText } from '@/lib/redact-copy'
import { boundCount, boundMajorMinor, boundVersion, classifySyncError, knownValue, ACCOUNT_STATUS_VALUES, CONNECTION_STATUS_VALUES, CONNECTION_PLATFORM_VALUES } from '@/lib/support-info'
import { buildSupportCopyText, describeBrowser } from '@/lib/support-info-gather'
import { useAccountStore } from '@/store/accountStore'
import { useAddonStore } from '@/store/addonStore'
import { useConnectionStore } from '@/store/connectionStore'
import { useSyncStore } from '@/store/syncStore'

type ActionKey = 'repair' | 'reauth' | 'connections' | 'diagnostics' | 'support'

// Report-local URL aliases: assigned once per normalized URL within a single
// diagnostics report, so identical URLs share an alias but nothing links back
// to the real URL or across reports.
function buildUrlAliasAssigner() {
    const byNormalized = new Map<string, string>()
    let counter = 0
    return (url: string): string => {
        const key = normalizeAddonUrl(url)
        if (!key) return 'URL ?'
        let alias = byNormalized.get(key)
        if (!alias) {
            counter++
            alias = `URL ${counter}`
            byNormalized.set(key, alias)
        }
        return alias
    }
}

function ActionRow({
    icon,
    title,
    description,
    cta,
    busy,
    busyLabel,
    disabled,
    onClick,
}: {
    icon: React.ReactNode
    title: string
    description: string
    cta: string
    busy: boolean
    busyLabel?: string
    disabled: boolean
    onClick: () => void
}) {
    return (
        <div data-theme-part="panel" className="flex flex-col gap-3 rounded-2xl border border-border/35 bg-background/35 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
                <div className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                    <SquircleOverlay />
                    <span className="relative z-10 text-muted-foreground">{icon}</span>
                </div>
                <div className="space-y-0.5">
                    <h4 className="text-sm font-semibold">{title}</h4>
                    <p className="max-w-xl text-xs text-muted-foreground">{description}</p>
                </div>
            </div>
            <Button
                variant="outline"
                onClick={onClick}
                disabled={disabled || busy}
                className="h-9 shrink-0 gap-2 self-start text-xs tabular-nums sm:self-auto"
            >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {busy ? (busyLabel || 'Working...') : cta}
            </Button>
        </div>
    )
}

export function RepairTools() {
    const accounts = useAccountStore(s => s.accounts)
    const repairAccount = useAccountStore(s => s.repairAccount)
    const syncAccount = useAccountStore(s => s.syncAccount)

    const [running, setRunning] = useState<ActionKey | null>(null)
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

    const expiredCount = accounts.filter(a => a.status === 'expired').length
    const connectionAccountCount = accounts.filter(a => a.connections?.some(c => c.enabled)).length

    const handleRepairAll = async () => {
        if (accounts.length === 0) return
        setRunning('repair')
        setProgress({ done: 0, total: accounts.length })
        let ok = 0
        let failed = 0
        for (const account of accounts) {
            try {
                await repairAccount(account.id)
                ok++
            } catch {
                failed++
            }
            setProgress(p => (p ? { ...p, done: p.done + 1 } : p))
        }
        setProgress(null)
        setRunning(null)
        toast({
            title: 'Repair Complete',
            description: `Refreshed ${ok} account${ok !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}.`,
            variant: failed > 0 ? 'destructive' : undefined,
        })
    }

    const handleReauth = async () => {
        const expired = accounts.filter(a => a.status === 'expired')
        if (expired.length === 0) {
            toast({ title: 'Nothing to re-authenticate', description: 'No accounts are currently expired.' })
            return
        }
        setRunning('reauth')
        setProgress({ done: 0, total: expired.length })
        for (const account of expired) {
            try { await syncAccount(account.id) } catch {}
            setProgress(p => (p ? { ...p, done: p.done + 1 } : p))
        }
        const after = useAccountStore.getState().accounts
        const recovered = expired.filter(e => after.find(a => a.id === e.id)?.status === 'active').length
        const remaining = expired.length - recovered
        setProgress(null)
        setRunning(null)
        toast({
            title: 'Re-authentication Complete',
            description: `${recovered} of ${expired.length} recovered${remaining > 0 ? `; ${remaining} still need a manual sign-in (no saved password).` : '.'}`,
            variant: remaining > 0 ? 'destructive' : undefined,
        })
    }

    const handleRecheckConnections = async () => {
        const targets = accounts.filter(a => a.connections?.some(c => c.enabled))
        if (targets.length === 0) {
            toast({ title: 'No connections', description: 'No accounts have active native connections.' })
            return
        }
        setRunning('connections')
        setProgress({ done: 0, total: targets.length })
        const { refreshConnectionStates } = useConnectionStore.getState()
        for (const account of targets) {
            try { await refreshConnectionStates(account.id) } catch {}
            setProgress(p => (p ? { ...p, done: p.done + 1 } : p))
        }
        setProgress(null)
        setRunning(null)
        toast({ title: 'Connections Re-checked', description: `Refreshed status for ${targets.length} account${targets.length !== 1 ? 's' : ''}.` })
    }

    const handleCopySupportInfo = async () => {
        setRunning('support')
        try {
            const text = await buildSupportCopyText()
            const ok = await copyTextToClipboard(text)
            if (ok) {
                toast({ title: 'Support info copied', description: 'One redacted summary is on your clipboard. Check before sharing.' })
            } else {
                toast({ variant: 'destructive', title: 'Copy unavailable', description: 'The clipboard is blocked on this connection (http). Select the text and copy it manually.' })
            }
        } catch (e) {
            if (import.meta.env.DEV) console.error('[RepairTools] support info failed:', e)
            toast({ variant: 'destructive', title: 'Copy Failed', description: 'Could not build the support summary.' })
        } finally {
            setRunning(null)
        }
    }

    const handleCopyDiagnostics = async () => {
        setRunning('diagnostics')
        try {
            const sync = useSyncStore.getState()
            const library = useAddonStore.getState().library
            const urlAliasFor = buildUrlAliasAssigner()
            const L: string[] = []
            L.push('AIOManager Diagnostics')
            L.push(`Generated: ${new Date().toISOString()}`)
            L.push(`Version (last seen): ${boundMajorMinor(sync.lastSeenVersion)}`)
            L.push(`Display: ${window.matchMedia('(display-mode: standalone)').matches ? 'installed (standalone)' : 'browser tab'} | Online: ${navigator.onLine}`)
            L.push(`Cloud sync: ${sync.auth.isAuthenticated ? 'linked' : 'off'} | initialPullDone: ${sync.isInitialSyncCompleted} | lastSave: ${sync.lastSyncedAt || 'never'}`)
            L.push(`Saved library entries: ${boundCount(Object.keys(library).length)}`)
            L.push(`Accounts: ${boundCount(accounts.length)}`)

            for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
                const account = accounts[accountIndex]
                const addons = account.addons || []
                const enabled = addons.filter(x => x.flags?.enabled !== false).length
                const protectedCount = addons.filter(x => x.flags?.protected).length
                const profiles = account.profiles || []
                const profileAlias = new Map<string, string>()
                profiles.forEach((p, pi) => { if (p?.id) profileAlias.set(p.id, `Profile ${String.fromCharCode(65 + (pi % 26))}`) })
                const defaultCount = profiles.filter(p => p?.id === 'default').length
                const activeAlias = profileAlias.get(account.activeProfileId || '') || 'unknown'
                const statusValue = knownValue(account.status, ACCOUNT_STATUS_VALUES, 'unknown')
                L.push('')
                L.push(`- Account ${accountIndex + 1}: status=${statusValue}`)
                L.push(`    addons: ${boundCount(addons.length)} (enabled ${boundCount(enabled)}, disabled ${boundCount(addons.length - enabled)}, protected ${boundCount(protectedCount)}), deletionMarkers: ${boundCount(Object.keys(account.deletedAddons || {}).length)}`)
                const profileList = profiles.map((p, pi) => profileAlias.get(p?.id || '') || `Profile ${String.fromCharCode(65 + (pi % 26))}`).join(', ')
                L.push(`    profiles: ${boundCount(profiles.length)} [${profileList || 'none'}], active: ${activeAlias}, duplicateDefault: ${defaultCount > 1 ? `YES (${defaultCount})` : 'no'}`)
                const conns = account.connections || []
                if (conns.length) {
                    L.push(`    connections: ${conns.map(c => `${knownValue(c.platform, CONNECTION_PLATFORM_VALUES, 'other')}{${c.enabled ? 'on' : 'off'},${knownValue(c.status, CONNECTION_STATUS_VALUES, 'unknown')},fails=${boundCount(c.consecutiveFailures ?? 0)}}`).join(', ')}`)
                }
                for (let addonIndex = 0; addonIndex < addons.length; addonIndex++) {
                    const ad = addons[addonIndex]
                    const ver = boundVersion(ad.manifest?.version)
                    L.push(`      * Addon ${addonIndex + 1} ${ver === 'unknown' ? 'version unknown' : `v${ver}`} ${ad.flags?.enabled === false ? 'disabled' : 'enabled'} ${urlAliasFor(ad.transportUrl)}`)
                }
            }

            L.push('')
            L.push('Recent sync log:')
            for (const entry of sync.history.slice(0, 20)) {
                const { category, httpStatus } = classifySyncError(entry.message)
                L.push(`  [${entry.status}] ${entry.type}${entry.isAuto ? ' (auto)' : ''} - ${category}${httpStatus !== null ? ` (HTTP ${httpStatus})` : ''} at ${entry.timestamp}`)
            }
            L.push(`Browser: ${describeBrowser(navigator.userAgent)}`)

            await navigator.clipboard.writeText(redactCopyText(L.join('\n')))
            toast({ title: 'Diagnostics Copied', description: 'A debug summary is on your clipboard. It uses report-local aliases (Account 1, Profile A, Addon 3, URL 1); no names, ids, hosts, emails or raw agents.' })
        } catch {
            toast({ variant: 'destructive', title: 'Copy Failed', description: 'Could not access the clipboard.' })
        } finally {
            setRunning(null)
        }
    }

    const pct = progress ? ` ${progress.done}/${progress.total}` : ''

    return (
        <div data-theme-part="panel" className="overflow-hidden rounded-[1.75rem] border border-border/45 bg-card/80 shadow-sm">
            <div className="flex items-center gap-3 p-4">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/35 bg-muted/25">
                    <SquircleOverlay />
                    <Wrench className="relative z-10 h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold">Repair & Recovery</h3>
                    <p className="text-xs text-muted-foreground">Safe fixes for common issues</p>
                </div>
            </div>

            <div className="space-y-2 border-t border-border/40 p-4">
                <ActionRow
                    icon={<LifeBuoy className="h-4 w-4" />}
                    title="Copy support info"
                    description="One cleaned-up block for bug reports: versions, browser and device, recent sync errors, unfinished uploads, storage and platforms in use. No names, ids, tokens or links."
                    cta="Copy"
                    busy={running === 'support'}
                    disabled={running !== null}
                    onClick={handleCopySupportInfo}
                />
                <ActionRow
                    icon={<Wrench className="h-4 w-4" />}
                    title="Repair All Accounts"
                    description="Re-fetch every addon manifest and rebuild broken entries (Unknown Addon, missing icons or catalogs, 0.0.0 versions) across all accounts, then re-sync each."
                    cta="Repair All"
                    busy={running === 'repair'}
                    busyLabel={`Repairing${pct}`}
                    disabled={running !== null || accounts.length === 0}
                    onClick={handleRepairAll}
                />
                <ActionRow
                    icon={<KeyRound className="h-4 w-4" />}
                    title="Re-authenticate Expired Accounts"
                    description="Sign expired accounts back in using their saved passwords, in one pass instead of one at a time."
                    cta={expiredCount > 0 ? `Re-auth (${expiredCount})` : 'Re-auth'}
                    busy={running === 'reauth'}
                    busyLabel={`Signing in${pct}`}
                    disabled={running !== null || accounts.length === 0}
                    onClick={handleReauth}
                />
                <ActionRow
                    icon={<PlugZap className="h-4 w-4" />}
                    title="Re-check Connections"
                    description="Re-validate native Nuvio / RealStream connection tokens and refresh their health status."
                    cta={connectionAccountCount > 0 ? `Re-check (${connectionAccountCount})` : 'Re-check'}
                    busy={running === 'connections'}
                    busyLabel={`Checking${pct}`}
                    disabled={running !== null || connectionAccountCount === 0}
                    onClick={handleRecheckConnections}
                />
                <ActionRow
                    icon={<ClipboardCopy className="h-4 w-4" />}
                    title="Copy Diagnostics"
                    description="Copy a detailed debug summary (per-account addon/profile/connection state, URL fingerprints, recent sync log) using report-local aliases like Account 1, Profile A and Addon 3. No names, ids, hosts or emails included."
                    cta="Copy"
                    busy={running === 'diagnostics'}
                    disabled={running !== null}
                    onClick={handleCopyDiagnostics}
                />
            </div>
        </div>
    )
}
