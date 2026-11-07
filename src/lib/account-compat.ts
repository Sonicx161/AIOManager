import type { Account } from '@/types/account'
import type { AddonDescriptor } from '@/types/addon'
import { ACCOUNT_CONTEXT_CLEAR_ALL } from './account-contexts.ts'
import { normalizeForSearch } from './utils.ts'
import { effectiveAddonsFor, excludedUrlsFor } from './addon-destinations.ts'
import { planStremioAccountWrites, resolvePrimaryStremio, stremioConnectionsOf, type StremioWriteTarget } from './connection-identity.ts'

export function accountMatchesQuery(account: Account, rawQuery: string): boolean {
    const q = normalizeForSearch(rawQuery.trim())
    if (!q) return true
    if (normalizeForSearch(account.name || '').includes(q)) return true
    if (normalizeForSearch(getAccountEmail(account) || '').includes(q)) return true
    return false
}


export function getStremioConnection(account: Account) {
    // Several Stremio logins may be bound to one local account; the canonical one is
    // the primary addon connection when it is Stremio, otherwise the first stored
    // login (the pre-multiplicity single connection stays canonical).
    const conn = resolvePrimaryStremio(account.connections, account.primaryConnectionId)
    if (conn) return conn
    if (!account.authKey || account.authKey.length <= 60) return null
    return {
        id: `${account.id}:stremio`,
        platform: 'stremio',
        connectionType: 'native' as const,
        enabled: true,
        status: account.status,
        credentials: {
            authKey: account.authKey,
            ...(account.email ? { email: account.email } : {}),
        },
        lastSync: 0,
        lastKnownAddonCount: 0,
        capabilities: ['addons'],
        consecutiveFailures: 0,
    }
}

/** Every native Stremio login bound to this account (each seals its own auth key). */
export function getStremioConnections(account: Account) {
    return stremioConnectionsOf(account.connections)
}

export function getStremioAuthKey(account: Account): string {
    return getStremioConnection(account)?.credentials?.authKey || ''
}

export function getAccountEmail(account: Account): string | undefined {
    return getStremioConnection(account)?.credentials?.email || account.email
}

export interface StremioFanoutFailure {
    connectionId: string
    isPrimary: boolean
    error: unknown
}

export interface StremioFanoutResult {
    /** Connection ids whose addon collection write succeeded. */
    written: string[]
    /** Per-login failures. Policy (rethrow, backoff, toast) belongs to the caller. */
    failed: StremioFanoutFailure[]
}

/**
 * Push the canonical addon collection to EVERY enabled Stremio login bound to the
 * account, each with its own sealed auth key — a secondary login must never be
 * silently written through the canonical account's session. The canonical login is
 * written first with the caller's exact options; secondaries verify collection
 * shrink against their own remote list (a shared previousCollection would describe a
 * different account) and their failures are reported, never hidden.
 *
 * Destination policy: each login receives its own effective list (the caller's list
 * minus that login's exclusions — platform-wide stremio entries and exact
 * connection-id entries both apply). The rows policy removes are handed to
 * updateAddons as `authorizedRemovals` so the anti-wipe guard can distinguish a
 * deliberate per-target clear from an accidental wipe (R2). The payload is exactly
 * what the hub shows; nothing is held back.
 */
export async function pushAddonsToStremioConnections(
    account: Account,
    addons: AddonDescriptor[],
    options?: { allowCollectionShrink?: boolean; previousCollection?: AddonDescriptor[] },
): Promise<StremioFanoutResult> {
    const targets: StremioWriteTarget[] = planStremioAccountWrites(account)
    if (targets.length === 0) return { written: [], failed: [] }
    const { getCachedAuthKey, getEncryptionKey } = await import('@/store/accountStore')
    const { updateAddons } = await import('@/api/addons')
    const encryptionKey = getEncryptionKey()
    const context = options?.allowCollectionShrink ? ACCOUNT_CONTEXT_CLEAR_ALL : account.id
    const written: string[] = []
    const failed: StremioFanoutFailure[] = []
    const writeOptions = options ?? {}
    for (const target of targets) {
        const destination = { platform: 'stremio', connectionId: target.connectionId }
        const projected = effectiveAddonsFor(addons, destination)
        const authorizedRemovals = excludedUrlsFor(addons, destination)
        try {
            const authKey = await getCachedAuthKey(target.encryptedAuthKey, encryptionKey)
            await updateAddons(authKey, projected, context, target.isPrimary
                ? { ...writeOptions, authorizedRemovals }
                : { allowCollectionShrink: writeOptions.allowCollectionShrink, authorizedRemovals })
            written.push(target.connectionId)
        } catch (error) {
            failed.push({ connectionId: target.connectionId, isPrimary: target.isPrimary, error })
        }
    }
    return { written, failed }
}

export async function pushAddonsToPlatform(account: Account, addons: AddonDescriptor[], _accountId: string, options?: { allowCollectionShrink?: boolean; previousCollection?: AddonDescriptor[] }): Promise<void> {
    const result = await pushAddonsToStremioConnections(account, addons, options)
    // Preserve the single-login contract: the canonical login's failure propagates to
    // the caller. Secondary failures are already isolated per login above.
    const primaryFailure = result.failed.find(f => f.isPrimary)
    if (primaryFailure) throw primaryFailure.error
    const hasNonStremio = (account.connections || []).some(c => c.enabled && (c.connectionType === 'hydra-outbound' || c.platform !== 'stremio'))
    if (hasNonStremio) {
        const { pushToConnections } = await import('@/store/account/accountAddonOps')
        await pushToConnections(account.id, { addons, allowCollectionShrink: options?.allowCollectionShrink })
    }
}
