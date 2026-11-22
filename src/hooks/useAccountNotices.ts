import { useEffect, useState, useSyncExternalStore } from 'react'
import { chooseNoticesCredential, computeNoticesIdentity, createNoticesSession, noticesUrl, requestNotices, revealOnThisVisit, type NoticesIdentity } from '@/lib/account-notices'
import { deriveSyncToken } from '@/lib/crypto'
import { deviceAuthHeadersFor, uninterceptedFetch } from '@/lib/device-session'
import { getSessionAuthKey, getSessionSyncCredential } from '@/lib/session-sync-token'
import { getActiveWorkspaceId, sanitizeWorkspaceId } from '@/lib/workspace-persistence'
import { getSyncApiPath } from '@/store/sync-store-helpers'
import { useAuthStore } from '@/store/authStore'
import { useSyncStore } from '@/store/syncStore'

function currentIdentity(): NoticesIdentity | null {
    const { auth, serverUrl } = useSyncStore.getState()
    const { isLocked, encryptionKey } = useAuthStore.getState()
    return computeNoticesIdentity({
        authId: auth.id,
        isAuthenticated: auth.isAuthenticated,
        isLocked,
        hasVaultKey: !!encryptionKey,
        activeWorkspaceId: getActiveWorkspaceId(),
        apiBase: getSyncApiPath(serverUrl),
    }, sanitizeWorkspaceId)
}

function credentialFor(identity: NoticesIdentity) {
    const { auth } = useSyncStore.getState()
    const id = identity.workspaceId
    return chooseNoticesCredential({
        identity,
        device: deviceAuthHeadersFor(id),
        sessionKey: getSessionAuthKey(id),
        sessionToken: getSessionSyncCredential(id)?.token ?? null,
        password: auth.id === id ? auth.password : '',
        now: Date.now(),
        pageUrl: window.location.href,
    })
}

async function fetchNotices(identity: NoticesIdentity, isCurrent: () => boolean) {
    const credential = credentialFor(identity)
    if (!credential) return { ok: false } as const
    const headers = 'headers' in credential
        ? credential.headers
        : { 'x-sync-user': identity.workspaceId, 'x-sync-password': await deriveSyncToken(credential.password) }
    if (!isCurrent()) return { ok: false } as const
    return requestNotices(uninterceptedFetch(), noticesUrl(identity), headers)
}

const session = createNoticesSession({ getIdentity: currentIdentity, fetchNotices, canRequest: identity => credentialFor(identity) !== null })
useSyncStore.subscribe(session.identityChanged)
useAuthStore.subscribe(session.identityChanged)

function useSessionState() {
    return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}

// Notices arriving within a second of Settings opening show now; later ones wait for the next visit.
export function useNoticesVisible() {
    const visibleKey = useSyncExternalStore(session.subscribe, session.visibleKey, session.visibleKey)
    const [mountedAt] = useState(() => Date.now())
    const [shownKey, setShownKey] = useState<string | null>(() => session.visibleKey())
    useEffect(() => session.mount(), [])
    useEffect(() => {
        if (visibleKey === null || shownKey === visibleKey) return
        if (revealOnThisVisit(1, mountedAt, Date.now())) setShownKey(visibleKey)
    }, [visibleKey, shownKey, mountedAt])
    return visibleKey !== null && shownKey === visibleKey
}

export function useNoticesList() {
    useSessionState()
    return session.visibleNotices()
}

export function useNoticesNewIds() {
    const state = useSessionState()
    const [newIds] = useState(() => session.peekNewIds())
    useEffect(() => { if (state.status === 'ready') session.markNewShown() }, [state.status])
    return newIds
}

export function useNoticesBadgeCount() {
    useSessionState()
    return session.pendingNewCount()
}
