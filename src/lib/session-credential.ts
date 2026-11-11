import { deriveSyncToken, exportSyncKeyRaw } from './crypto.ts'
import { saveSessionSyncToken } from './session-sync-token.ts'

export async function saveSessionCredentialForPassword(accountId: string, password: string, syncSaltB64?: string | null): Promise<boolean> {
    if (!accountId || !password) return false
    try {
        const keySalt = syncSaltB64 ? Uint8Array.from(atob(syncSaltB64), (c) => c.charCodeAt(0)) : undefined
        const syncKeyRaw = await exportSyncKeyRaw(password, keySalt)
        const token = await deriveSyncToken(password)
        return saveSessionSyncToken(accountId, token, btoa(String.fromCharCode(...syncKeyRaw)))
    } catch {
        return false
    }
}
