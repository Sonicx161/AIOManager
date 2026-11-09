import { resilientFetch } from '@/lib/api-resilience'
import { useSyncStore, getSyncApiPath } from '@/store/syncStore'
import { getSyncPasswordHeader } from '@/lib/sync-auth'

export interface AddonActionEntry {
    urlKey: string
    transportUrl: string
    lastInstallAt: number | null
    lastDeleteAt: number | null
    installSeq: number
    deleteSeq: number
    deleteToken: string | null
}

export interface AddonDeleteAck {
    url: string
    token: string
}

export interface AddonActionContext {
    base: string
    headers: Record<string, string>
}

// Requests use the server and credentials captured when this context was built, never a later live auth read.
export async function captureAddonActionContext(): Promise<AddonActionContext | null> {
    const { auth, serverUrl } = useSyncStore.getState()
    if (!auth?.id || !auth.isAuthenticated) return null
    return {
        base: getSyncApiPath(serverUrl),
        headers: {
            'Content-Type': 'application/json',
            'x-sync-user': auth.id,
            'x-sync-password': await getSyncPasswordHeader(auth),
        },
    }
}

export async function queryAddonActions(accountId: string, urlKeys: string[], ctx: AddonActionContext): Promise<AddonActionEntry[]> {
    const res = await resilientFetch(`${ctx.base}/addon-actions/query`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ accountId, urlKeys }),
        timeout: 15000,
    })
    if (!res.ok) {
        throw new Error(`Failed to read addon actions (${res.status})`)
    }
    const body = await res.json() as { actions?: AddonActionEntry[] }
    return Array.isArray(body.actions) ? body.actions : []
}

export async function postAddonActionDeletes(accountId: string, deletes: AddonDeleteAck[], ctx: AddonActionContext): Promise<void> {
    const res = await resilientFetch(`${ctx.base}/addon-actions/delete`, {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({ accountId, deletes }),
        timeout: 15000,
    })
    if (!res.ok) {
        throw new Error(`Failed to record addon deletions (${res.status})`)
    }
}
