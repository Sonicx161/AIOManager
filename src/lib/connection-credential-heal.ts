import type { Connection } from '@/types/connection'

// Bundle shapes mirror the add-flow upload (connectionStore.addConnection), so a
// healed re-registration is byte-compatible with what the sign-in flow stores.
export function connectionCredentialBundle(connection: Connection): Record<string, unknown> | null {
    const credentials = connection.credentials
    if (!credentials?.accessToken) return null
    if (connection.platform === 'nuvio') {
        return {
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            profileId: credentials.profileId || null,
            baseUrl: credentials.baseUrl || null,
            publishableKey: credentials.publishableKey || null,
        }
    }
    if (connection.platform === 'realstream') {
        return {
            accessToken: credentials.accessToken,
            userId: credentials.userId || null,
            expiresAt: credentials.expiresAt,
            baseUrl: credentials.baseUrl || null,
            email: credentials.email || null,
            password: credentials.password || null,
        }
    }
    return null
}

// Bounded self-heal: at most one credential re-registration per connection per
// signed-in session, regardless of how many token fetches see the 404. The
// session scope (workspace, login, vault key) is supplied by the caller; every
// scope transition resets the latch, so a later session, or a return from
// another workspace, gets its own bounded attempt.
let healScope = ''
const healAttempted = new Set<string>()

export function beginCredentialHealAttempt(scope: string, connectionId: string): boolean {
    if (scope !== healScope) {
        healScope = scope
        healAttempted.clear()
    }
    if (healAttempted.has(connectionId)) return false
    healAttempted.add(connectionId)
    return true
}

export function resetCredentialHealAttemptsForTest(): void {
    healScope = ''
    healAttempted.clear()
}
