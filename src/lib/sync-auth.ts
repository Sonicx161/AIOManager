import { deriveSyncToken } from '@/lib/crypto'
import { resolveSessionWireToken } from '@/lib/session-sync-token'

// Single source for the x-sync-password wire value. The persisted auth keeps password '', so the
// stored session token must win after a reload; a real in-memory password derives the same value.
export function getSyncPasswordHeader(auth: { id: string; password: string }): Promise<string> {
    return resolveSessionWireToken(auth.id, auth.password, deriveSyncToken)
}

export async function getSyncAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    try {
        const { useSyncStore } = await import('@/store/syncStore')
        const auth = useSyncStore.getState().auth
        if (auth.isAuthenticated) {
            headers['x-sync-user'] = auth.id
            headers['x-sync-password'] = await getSyncPasswordHeader(auth)
        }
    } catch {}
    return headers
}

export function invalidateSyncAuthCache(): void {}
