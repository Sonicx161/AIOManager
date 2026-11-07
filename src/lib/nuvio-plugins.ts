import type { Connection, NuvioPluginDescriptor } from '@/types/connection'

function toDescriptor(row: Record<string, unknown>, i: number): NuvioPluginDescriptor {
    return {
        url: String(row.url ?? ''),
        name: String(row.name ?? ''),
        enabled: row.enabled !== false,
        sort_order: Number(row.sort_order ?? i),
        repo_type: row.repo_type != null ? String(row.repo_type) : undefined,
    }
}

export async function readNuvioPlugins(accountId: string, conn: Connection): Promise<NuvioPluginDescriptor[]> {
    const { fetchConnectionToken, hashRejectedToken, isNuvioJwtAuthError } = await import('@/api/connection')
    const { nuvioDriverFor } = await import('@/lib/drivers/factory')
    const { getOrFetchNuvioToken } = await import('@/lib/nuvio-token-cache')
    const scope = { accountId, baseUrl: conn.credentials?.baseUrl }
    let token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl), scope)
    const driver = nuvioDriverFor(conn)
    let rows
    try { rows = await driver.readPlugins(token.accessToken, token.profileId ?? conn.credentials?.profileId) }
    catch (error) {
        const { isAuthError } = await import('@/store/accountStore')
        if (!isAuthError(error)) throw error
        // A JWT-type 401 names the exact rejected token by hash so the server force-revalidates it.
        const forcedHash = isNuvioJwtAuthError(error) ? await hashRejectedToken(token.accessToken) : undefined
        const { invalidateNuvioToken } = await import('@/lib/nuvio-token-cache')
        invalidateNuvioToken(conn.id, scope)
        token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl, forcedHash ? { rejectedTokenHash: forcedHash } : undefined), scope)
        rows = await driver.readPlugins(token.accessToken, token.profileId ?? conn.credentials?.profileId)
    }
    return (Array.isArray(rows) ? rows : []).map(toDescriptor).sort((a, b) => a.sort_order - b.sort_order)
}

// sync_push_plugins is full-replace: the list sent is the complete state. Edits are staged and
// pushed on save, so an explicit removal (including the last plugin) propagates, unlike the
// background addon sync which guards against empty pushes.
export async function writeNuvioPlugins(accountId: string, conn: Connection, plugins: NuvioPluginDescriptor[]): Promise<void> {
    const { fetchConnectionToken, hashRejectedToken, isNuvioJwtAuthError } = await import('@/api/connection')
    const { nuvioDriverFor } = await import('@/lib/drivers/factory')
    const { getOrFetchNuvioToken } = await import('@/lib/nuvio-token-cache')
    const scope = { accountId, baseUrl: conn.credentials?.baseUrl }
    let token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl), scope)
    let profileId = token.profileId ?? conn.credentials?.profileId
    const ordered = plugins.map((p, i) => ({ ...p, sort_order: i }))
    const driver = nuvioDriverFor(conn)
    try { await driver.writePlugins(token.accessToken, ordered, profileId) }
    catch (error) {
        const { isAuthError } = await import('@/store/accountStore')
        if (!isAuthError(error)) throw error
        // A JWT-type 401 names the exact rejected token by hash so the server force-revalidates it.
        const forcedHash = isNuvioJwtAuthError(error) ? await hashRejectedToken(token.accessToken) : undefined
        const { invalidateNuvioToken } = await import('@/lib/nuvio-token-cache')
        invalidateNuvioToken(conn.id, scope)
        token = await getOrFetchNuvioToken(conn.id, () => fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl, forcedHash ? { rejectedTokenHash: forcedHash } : undefined), scope)
        profileId = token.profileId ?? conn.credentials?.profileId
        await driver.writePlugins(token.accessToken, ordered, profileId)
    }
}
