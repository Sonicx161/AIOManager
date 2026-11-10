import { normalizeAddonUrl } from '@/lib/utils'
import { filterResurrected } from '@/lib/addon-tombstones'
import { evaluateAbsorbOutcome } from './absorb-outcome'
import { trace } from '@/lib/trace'
import { mapConcurrent } from '@/lib/concurrency'
import type { Account } from '@/types/account'
import type { AddonDescriptor } from '@/types/addon'
import type { CinemetaManifest } from '@/types/cinemeta'

export interface DiscoveredEntry {
    transportUrl: string
    name: string
    enabled: boolean
    platform: string
    connectionId: string
}

export interface ConnectionRead {
    connectionId: string
    platform: string
    entries: DiscoveredEntry[]
}

export interface FailedRead {
    message: string
    isAuthError: boolean
}

export interface DiscoveryResult {
    discovered: DiscoveredEntry[]
    failedReadConnIds: Set<string>
    // Every entry of each connection that was read successfully, before hub dedupe.
    reads: ConnectionRead[]
    failedReads: Map<string, FailedRead>
}

function normalizeRawEntry(platform: string, raw: Record<string, unknown>): { url: string; name: string; enabled: boolean } | null {
    if (platform === 'nuvio') {
        const url = String(raw.url || '')
        if (!url) return null
        return { url, name: String(raw.name || ''), enabled: raw.enabled !== false }
    }
    if (platform === 'realstream') {
        const url = String(raw.manifestUrl || raw.baseUrl || '')
        if (!url) return null
        return { url, name: String(raw.name || ''), enabled: raw.enabled !== false }
    }
    return null
}

export async function discoverFromConnections(account: Account, accountId: string): Promise<DiscoveryResult> {
    const connections = (account.connections || []).filter(
        c => c.enabled && (c.platform === 'nuvio' || c.platform === 'realstream')
    )
    const failedReadConnIds = new Set<string>()
    const failedReads = new Map<string, FailedRead>()
    if (connections.length === 0) return { discovered: [], failedReadConnIds, reads: [], failedReads }

    const existingUrls = new Set((account.addons || []).map(a => normalizeAddonUrl(a.transportUrl)))

    const { fetchConnectionToken } = await import('@/api/connection')
    const { getOrFetchRealStreamToken, invalidateRealStreamToken } = await import('@/lib/realstream-token-cache')
    const { realStreamTokenOwner } = await import('@/lib/realstream-token-owner')
    const { nuvioDriverFor, realStreamDriverFor } = await import('@/lib/drivers/factory')

    const discovered: DiscoveredEntry[] = []

    const workerResults = await mapConcurrent(connections, 3, async (conn) => {
        const connDiscovered: DiscoveredEntry[] = []
        try {
            let rawAddons: Record<string, unknown>[] = []

            if (conn.platform === 'nuvio') {
                const { getCachedNuvioToken, setCachedNuvioToken } = await import('@/lib/nuvio-token-cache')
                let token = getCachedNuvioToken(conn.id)
                if (!token) {
                    token = await fetchConnectionToken(accountId, conn.id, 'nuvio', conn.credentials?.baseUrl)
                    setCachedNuvioToken(conn.id, token)
                }
                const profileId = conn.credentials?.profileIndex || conn.credentials?.profileId
                rawAddons = await nuvioDriverFor(conn).readAddons(token.accessToken, profileId) as Record<string, unknown>[]
            } else {
                const token = await getOrFetchRealStreamToken(realStreamTokenOwner(accountId, conn), () => fetchConnectionToken(accountId, conn.id, 'realstream'))
                const userId = conn.credentials?.userId || ''
                if (!userId) {
                    invalidateRealStreamToken(conn.id)
                    return { connId: conn.id, platform: conn.platform, entries: connDiscovered, failed: { message: 'Missing RealStream user id', isAuthError: false } }
                }
                rawAddons = await realStreamDriverFor(conn).readAddons(token.accessToken, userId) as Record<string, unknown>[]
            }

            for (const raw of rawAddons || []) {
                const entry = normalizeRawEntry(conn.platform, raw)
                if (!entry) continue
                connDiscovered.push({
                    transportUrl: entry.url,
                    name: entry.name,
                    enabled: entry.enabled,
                    platform: conn.platform,
                    connectionId: conn.id,
                })
            }
            return { connId: conn.id, platform: conn.platform, entries: connDiscovered, failed: null }
        } catch (err) {
            if (import.meta.env.DEV) console.warn(`[Discovery] read failed for ${conn.platform} (${conn.id}):`, err)
            const message = err instanceof Error && err.message ? err.message : 'Read failed'
            return { connId: conn.id, platform: conn.platform, entries: connDiscovered, failed: { message, isAuthError: (err as { isAuthError?: boolean } | null)?.isAuthError === true } }
        }
    })

    const reads: ConnectionRead[] = []
    for (const result of workerResults) {
        if (result.failed) {
            failedReadConnIds.add(result.connId)
            failedReads.set(result.connId, result.failed)
        } else {
            reads.push({ connectionId: result.connId, platform: result.platform, entries: result.entries })
        }
        for (const entry of result.entries) {
            const normalizedUrl = normalizeAddonUrl(entry.transportUrl)
            if (existingUrls.has(normalizedUrl)) continue
            discovered.push(entry)
            existingUrls.add(normalizedUrl)
        }
    }

    return { discovered, failedReadConnIds, reads, failedReads }
}

export interface AbsorbResult {
    addons: AddonDescriptor[]
    failedReadConnIds: Set<string>
    failedReads: Map<string, FailedRead>
    reads: ConnectionRead[]
    // Connections whose own list still holds addons the user deleted.
    deletionConnIds: Set<string>
    changed: boolean
    // A connection served addons the user had deleted. They were filtered locally, but
    // the connection's own list still holds them - the caller must push the cleaned
    // list back so the deletion propagates instead of resurrecting on every cycle.
    propagateDeletions: boolean
}

export async function absorbConnectionAddons(account: Account, accountId: string): Promise<AbsorbResult> {
    const { discovered: rawDiscovered, failedReadConnIds, failedReads, reads } = await discoverFromConnections(account, accountId)
    trace('discovery.absorb', 'discovered', { accountId, raw: rawDiscovered.length, failedConns: failedReadConnIds.size })
    const existing = account.addons || []
    const discovered = filterResurrected(rawDiscovered, existing, account.deletedAddons)
    const tombstonedCount = rawDiscovered.length - discovered.length
    const deletionConnIds = new Set(reads
        .filter(r => filterResurrected(r.entries, existing, account.deletedAddons).length < r.entries.length)
        .map(r => r.connectionId))
    const base = { failedReadConnIds, failedReads, reads, deletionConnIds }
    trace('discovery.absorb', 'post-tombstone', { accountId, survived: discovered.length, stripped: rawDiscovered.length - discovered.length })
    if (discovered.length === 0) {
        trace('discovery.absorb', 'noop', { accountId })
        // A tombstone-only discovery still needs its deletion written back to the
        // connection, or the stale remote list resurrects the addons on every cycle.
        const outcome = evaluateAbsorbOutcome(rawDiscovered.length, 0, tombstonedCount)
        return { addons: existing, ...base, changed: outcome.changed, propagateDeletions: outcome.propagateDeletions }
    }

    const { fetchAddonManifest } = await import('@/api/addons')
    const { sanitizeAddonManifest } = await import('@/store/accountStore')
    const { getEffectiveManifest } = await import('@/lib/addon-utils')
    const { mergeAddons } = await import('@/lib/utils')
    const { isCinemetaAddon, detectAllPatches, applyCinemetaConfiguration } = await import('@/lib/cinemeta-utils')

    const newDescriptors: AddonDescriptor[] = await Promise.all(discovered.map(async (d) => {
        const base = { transportUrl: d.transportUrl, flags: { enabled: d.enabled }, metadata: { lastUpdated: Date.now() } }
        try {
            const { manifest } = await fetchAddonManifest(d.transportUrl, accountId)
            let repaired = sanitizeAddonManifest(manifest, d.transportUrl)
            const probe = { ...base, manifest: repaired } as AddonDescriptor
            if (isCinemetaAddon(probe)) {
                const patches = detectAllPatches(repaired as CinemetaManifest)
                if (patches.searchArtifactsPatched || patches.standardCatalogsPatched || patches.metaResourcePatched) {
                    repaired = applyCinemetaConfiguration(repaired as CinemetaManifest, {
                        removeSearchArtifacts: patches.searchArtifactsPatched,
                        removeStandardCatalogs: patches.standardCatalogsPatched,
                        removeMetaResource: patches.metaResourcePatched,
                    }) as AddonDescriptor['manifest']
                }
            }
            const descriptor = { ...base, manifest: repaired } as AddonDescriptor
            return { ...descriptor, manifest: getEffectiveManifest(descriptor) }
        } catch {
            return { ...base, manifest: sanitizeAddonManifest({ name: d.name } as AddonDescriptor['manifest'], d.transportUrl) } as AddonDescriptor
        }
    }))

    const surviving = newDescriptors
    if (surviving.length === 0) return { addons: existing, ...base, changed: false, propagateDeletions: tombstonedCount > 0 }
    // Absorb is an additive union: keepMissingLocal stops the mirror-drop from removing hub addons,
    // and the hub owns the enable state for matched rows (DC-R2-01).
    trace('discovery.absorb', 'absorbed', { accountId, newAddons: newDescriptors.length, existing: existing.length })
    const outcome = evaluateAbsorbOutcome(rawDiscovered.length, surviving.length, tombstonedCount)
    return { addons: mergeAddons(existing, surviving, { keepMissingLocal: true, keepLocalFlags: true }), ...base, changed: outcome.changed, propagateDeletions: outcome.propagateDeletions }
}

export function invalidateConnectionCache(connectionId?: string) {
    if (connectionId) {
        import('@/lib/nuvio-token-cache').then(({ invalidateNuvioToken }) => {
            invalidateNuvioToken(connectionId)
        }).catch(() => {})
    }
}
