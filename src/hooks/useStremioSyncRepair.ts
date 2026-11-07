import { useCallback, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { useAuthStore } from '@/store/authStore'
import { useAccountStore, getStremioConnection, getStremioConnections } from '@/store/accountStore'
import { useSyncStore } from '@/store/syncStore'
import { getActiveWorkspaceId } from '@/lib/workspace-persistence'
import { syncCredentialsToServer } from '@/lib/activity-server'
import {
    attemptStremioSyncRepair,
    type StremioSyncRepairFailureReason,
    type StremioSyncRepairResult,
} from '@/lib/stremio-sync-repair'

// Retry-oriented copy per guard. No key material, emails or names: the toasts must
// stay usable under the app's privacy labels and safe for logs/screenshots.
const FAILURE_COPY: Record<StremioSyncRepairFailureReason, string> = {
    'signed-out': "Sign in to your AIOManager cloud account, then retry the repair.",
    'vault-locked': "Unlock your vault, then retry the repair.",
    'precondition': "This account no longer needs a repair — the warning clears on its own.",
    'disabled': "This account's primary Stremio login is disabled. Re-enable it, then retry the repair.",
    'context-switched': "Your account, workspace or vault changed during the repair. Check the current account, then retry.",
    'not-confirmed': "The server didn't confirm this account's Stremio credential yet. Check your connection and retry in a moment.",
}

/** Store wiring for the guarded repair core: the session fingerprint mirrors the
 *  activity-server ownership guard (workspace, sync owner, server, vault key object),
 *  and the confirmation source is the authoritative learned server set. */
export async function repairStremioSyncForAccount(accountId: string): Promise<StremioSyncRepairResult> {
    return attemptStremioSyncRepair({
        accountId,
        getSession: () => {
            const { auth, serverUrl } = useSyncStore.getState()
            return {
                workspaceId: getActiveWorkspaceId(),
                authId: auth.id,
                isAuthenticated: auth.isAuthenticated,
                serverUrl,
                vaultKeyRef: useAuthStore.getState().encryptionKey,
            }
        },
        getAccountState: id => {
            const account = useAccountStore.getState().accounts.find(a => a.id === id)
            if (!account) return { exists: false, stremio: null }
            // Canonical selection mirrors the upload core (getStremioConnection):
            // the primary when it is Stremio, else the first stored login, else the
            // synthetic legacy login for authKey-only accounts. Parity with the
            // warning's hasClientStremioKey: the canonical's own sealed key must
            // exist for the split-brain precondition to hold at all.
            const canonical = getStremioConnection(account)
            if (!canonical || !canonical.credentials?.authKey) return { exists: true, stremio: null }
            return {
                exists: true,
                stremio: {
                    primaryConnectionId: account.primaryConnectionId ?? null,
                    canonicalConnectionId: canonical.id,
                    canonicalEnabled: canonical.enabled !== false,
                    accountAuthKey: account.authKey ?? '',
                    apiKey: account.apiKey ?? '',
                    // Sealed values as stored — identity only, never decrypted.
                    logins: getStremioConnections(account).map(c => ({
                        connectionId: c.id,
                        enabled: c.enabled !== false,
                        authKey: c.credentials?.authKey ?? '',
                        userId: c.credentials?.userId ?? '',
                    })),
                },
            }
        },
        syncCredentials: () => syncCredentialsToServer(),
        getServerCredentialedAccounts: () => useSyncStore.getState().serverStremioCredentialedAccounts,
    })
}

export function useStremioSyncRepair(accountId: string) {
    const [isRepairing, setIsRepairing] = useState(false)
    const inFlight = useRef(false)

    const repair = useCallback(async () => {
        if (inFlight.current) return
        inFlight.current = true
        setIsRepairing(true)
        try {
            let result: StremioSyncRepairResult
            try {
                result = await repairStremioSyncForAccount(accountId)
            } catch {
                result = { status: 'failed', reason: 'not-confirmed' }
            }
            if (result.status === 'repaired') {
                toast({
                    variant: 'default',
                    title: 'Stremio sync repaired',
                    description: "The server now holds this account's Stremio credential — external Hydra writes reach its Stremio collection directly.",
                })
            } else {
                toast({
                    variant: 'warning',
                    title: 'Stremio sync repair failed',
                    description: FAILURE_COPY[result.reason],
                    href: `/account/${encodeURIComponent(accountId)}`,
                })
            }
        } finally {
            inFlight.current = false
            setIsRepairing(false)
        }
    }, [accountId])

    return { isRepairing, repair }
}
