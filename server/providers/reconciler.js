import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { trace, traceEnabled } from '../utils/trace.js'
import { connectionEffectiveAddons, connectionExcludedUrls, chainGuardFailureWithExclusions } from '../utils/addon-destinations.js'
import { REFRESH_BUFFER_MS, baseUrlOutranks, readNuvioSealedBundles } from './token-refresh.js'
import { invalidateCredentialBundleCache } from './credential-bundle-cache.js'
import { isLocalHostname } from '../hydra/client.js'
import { invalidateCanonicalByAuthKey } from '../hydra/canonical-cache.js'
import { AuthStateError, StateUnavailableError, ReadOnlyReplicaError } from '../admin/account-state.js'

// Typed account-state refusals always surface: request paths map them to the fixed
// 403 or 503 body, background cycles record the skip. Never collapsed into a
// generic connection failure.
const isStateRefusal = (err) => err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError

const BACKOFF_THRESHOLD = 3
const BACKOFF_SLOTS = [1, 2, 4, 8, 16]

// Cache owner-scoped connections briefly; credential writes invalidate the cache.
const connectionCache = new Map()
const storedConnections = new WeakMap()
const CONNECTION_CACHE_TTL_MS = 30 * 1000
let connectionCacheGeneration = 0

export function invalidateConnectionCache(syncUser = null) {
    connectionCacheGeneration++
    invalidateCredentialBundleCache(syncUser)
    if (!syncUser) {
        connectionCache.clear()
        return
    }
    for (const [key, entry] of connectionCache) {
        if (entry.syncUser === syncUser) connectionCache.delete(key)
    }
}

// Owner-scoped helpers for the Dashboard cache-clear repair: they delete only that
// owner's cache entries and never touch the generation, so no live connection
// object of any owner can read stale and trigger a token refresh.
export function dropConnectionCacheForOwner(syncUser) {
    if (!syncUser) return 0
    let dropped = 0
    for (const [key, entry] of connectionCache) {
        if (entry.syncUser === syncUser) {
            connectionCache.delete(key)
            dropped++
        }
    }
    return dropped
}

export function connectionCacheCountForOwner(syncUser) {
    if (!syncUser) return 0
    let n = 0
    for (const entry of connectionCache.values()) if (entry.syncUser === syncUser) n++
    return n
}

function getBackoffSkip(consecutiveFailures) {
    if (consecutiveFailures < BACKOFF_THRESHOLD) return 0
    const slotIndex = Math.min(
        Math.floor(Math.log2(consecutiveFailures - BACKOFF_THRESHOLD + 1)),
        BACKOFF_SLOTS.length - 1
    )
    return BACKOFF_SLOTS[slotIndex]
}

const urlMemo = new Map()
function normalizeUrl(url) {
    if (!url) return ''
    const key = String(url)
    const cached = urlMemo.get(key)
    if (cached !== undefined) return cached
    let normalized = key.trim()
    normalized = normalized.replace(/^stremio:\/\//i, 'https://')
    normalized = normalized.replace(/\/manifest\.json$/i, '')
    normalized = normalized.replace(/\/+$/, '')
    normalized = normalized.toLowerCase()
    if (urlMemo.size >= 5000) urlMemo.clear()
    urlMemo.set(key, normalized)
    return normalized
}

// The Nuvio duplicate-row policy (baseUrlOutranks) and the shared sealed-row access
// (readNuvioSealedBundles) live in token-refresh.js next to the refresh path, so the
// resolver, this loader and every refresh caller cannot drift apart.
function buildNativeConnection(type, row, accountId, bundle) {
    return {
        id: row.connection_id || `${accountId}:${type}`,
        platform: type,
        accountId,
        driverType: 'native',
        enabled: bundle.enabled !== false,
        status: 'active',
        credentials: bundle,
        consecutiveFailures: 0,
        capabilities: type === 'nuvio' ? ['addons', 'plugins', 'profiles'] : ['addons'],
    }
}

async function resolveConnections(accountId, syncUser = null) {
    // Legacy rules need an owner before they may read provider credentials.
    if (!syncUser) {
        trace('reconciler', 'resolveConnections.skip', { accountId, reason: 'no-owner' })
        return []
    }
    const cacheKey = JSON.stringify([accountId, syncUser])
    const hit = connectionCache.get(cacheKey)
    if (hit && Date.now() - hit.at < CONNECTION_CACHE_TTL_MS) {
        const connections = structuredClone(hit.connections)
        for (const connection of connections) storedConnections.set(connection, connectionCacheGeneration)
        return connections
    }
    const generation = connectionCacheGeneration

    const rows = await db.query(
        'SELECT connection_id, auth_key, credential_type FROM server_credentials WHERE account_id = $1 AND sync_user = $2 ORDER BY updated_at DESC',
        [accountId, syncUser]
    )
    if (!rows || rows.length === 0) return []

    const connections = []
    // Multiplicity: every DISTINCT connection id resolves to its own connection (its own
    // sealed credential row). Only rows of the SAME connection dedupe — legacy per-device
    // duplicates of one login collapse to the newest row (ORDER BY updated_at DESC), so
    // the pre-multiplicity "one login per platform" shape survives for legacy data while
    // several logins on one platform never collapse into the most recent one.
    const platformRowIndexes = new Map()
    const seenHydra = new Set()
    const seenStremioAccountLevel = new Set()
    const seenStremioConnectionIds = new Set()
    const seenPlatforms = new Set()
    for (const row of rows) {
        if (!row.auth_key) continue
        const type = row.credential_type || 'stremio'

        if (type === 'hydra') {
            if (!row.connection_id || seenHydra.has(row.connection_id)) continue
            seenHydra.add(row.connection_id)
            let bundle = null
            try { bundle = JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) } catch { continue }
            if (!bundle?.baseUrl) continue
            connections.push({
                id: row.connection_id,
                platform: 'hydra',
                accountId,
                driverType: 'hydra-outbound',
                enabled: bundle.enabled !== false,
                status: 'active',
                driverConfig: { baseUrl: bundle.baseUrl, authType: bundle.authType, authHeader: bundle.authHeader },
                credentials: { authValue: bundle.authValue },
                consecutiveFailures: 0,
                capabilities: ['addons']
            })
            continue
        }

        if (type === 'nuvio' || type === 'realstream') {
            let bundle = null
            try { bundle = JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) } catch { continue }
            if (!bundle?.accessToken) continue
            // Rows without a connection id are the legacy per-device shape of ONE login:
            // they collapse to a single stable synth connection per platform.
            const rowKey = row.connection_id || `legacy:${type}`
            const mapKey = `${type}\u0000${rowKey}`
            const existingIdx = platformRowIndexes.get(mapKey)
            if (existingIdx !== undefined) {
                const incumbent = connections[existingIdx]
                if (baseUrlOutranks(bundle, incumbent.credentials)) {
                    connections[existingIdx] = buildNativeConnection(type, row, accountId, bundle)
                }
                continue
            }
            platformRowIndexes.set(mapKey, connections.length)
            connections.push(buildNativeConnection(type, row, accountId, bundle))
            continue
        }

        if (type === 'stremio') {
            // Stremio uses a raw auth key string, not a JSON credential bundle. The
            // account-level row (no connection id) is the CANONICAL login mirror and keeps
            // the legacy `${accountId}:stremio` identity; each per-connection row is a
            // distinct secondary login resolved under the client's own connection id.
            const authKey = decrypt(row.auth_key, FALLBACK_KEYS)
            if (!authKey) continue
            if (!row.connection_id) {
                if (seenStremioAccountLevel.has(accountId)) continue
                seenStremioAccountLevel.add(accountId)
                connections.push({
                    id: `${accountId}:stremio`,
                    platform: 'stremio',
                    accountId,
                    driverType: 'native',
                    enabled: true,
                    status: 'active',
                    credentials: { authKey },
                    consecutiveFailures: 0,
                    capabilities: ['addons']
                })
                continue
            }
            if (seenStremioConnectionIds.has(row.connection_id)) continue
            seenStremioConnectionIds.add(row.connection_id)
            connections.push({
                id: row.connection_id,
                platform: 'stremio',
                accountId,
                driverType: 'native',
                enabled: true,
                status: 'active',
                credentials: { authKey },
                consecutiveFailures: 0,
                capabilities: ['addons']
            })
            continue
        }

        if (seenPlatforms.has(type)) continue
        seenPlatforms.add(type)
    }

    for (const connection of connections) connection.syncUser = syncUser
    // A write during the query must not repopulate the cache with an older view.
    if (generation === connectionCacheGeneration) {
        if (connectionCache.size >= 500) connectionCache.delete(connectionCache.keys().next().value)
        connectionCache.set(cacheKey, { at: Date.now(), syncUser, connections: structuredClone(connections) })
    }
    for (const connection of connections) storedConnections.set(connection, generation)
    return connections
}

const isHydraOutbound = (c) =>
    c?.platform === 'hydra' ||
    c?.driverType === 'hydra' || c?.driverType === 'hydra-outbound' ||
    c?.connectionType === 'hydra-outbound'

// The destination and tokens for a Nuvio connection always come from its sealed
// server_credentials rows (readNuvioSealedBundles); caller-supplied credentials are
// ignored entirely (the client strips them on the wire and the sync route strips them
// again, so anything that still arrives is untrusted). Tokens come from the newest
// readable token-bearing row only, while the URL (and its publishable key) may be
// recovered from any sealed duplicate of the same connection. A connection with no
// usable sealed row fails closed instead of guessing the public default.
function nuvioSealedBundleMissing() {
    const err = new Error('Nuvio credentials not found for this connection, re-authenticate it')
    err.isAuthError = true
    return err
}

async function loadNuvioSealedBundle(connection) {
    if (!connection?.id || !connection.accountId || !connection.syncUser) throw nuvioSealedBundleMissing()
    const { entries, urlBundle } = await readNuvioSealedBundles(connection.id, connection.accountId, connection.syncUser)
    const tokenBundle = entries.find(e => e.bundle.accessToken)?.bundle || null
    if (!tokenBundle) throw nuvioSealedBundleMissing()
    const bundle = { ...tokenBundle }
    if (!bundle.baseUrl && urlBundle?.baseUrl) {
        bundle.baseUrl = urlBundle.baseUrl
        if (!bundle.publishableKey && urlBundle.publishableKey) bundle.publishableKey = urlBundle.publishableKey
    }
    return bundle
}

async function loadDriver(platform, credentials, connection) {
    if (platform === 'stremio' && !isHydraOutbound(connection)) {
        const { createStremioDriver } = await import('./stremio-driver.js')
        return createStremioDriver()
    }
    if (platform === 'nuvio') {
        // client-marked expired: skip refresh (cooldown handles repeated auth failures)
        if (connection?.status === 'expired') {
            const err = new Error('Nuvio credentials expired, re-authenticate this connection')
            err.isAuthError = true
            throw err
        }

        // Destination and tokens always come from the sealed rows; the caller's
        // credentials argument is ignored, and a resolver object whose row changed after
        // resolution is re-read here instead of trusted.
        credentials = await loadNuvioSealedBundle(connection)
        connection.credentials = credentials

        if (connection?.id) {
            const expiresAt = credentials.expiresAt
            if (storedConnections.get(connection) !== connectionCacheGeneration || !expiresAt || expiresAt - Date.now() <= REFRESH_BUFFER_MS) {
                try {
                    const { refreshNuvioToken } = await import('./token-refresh.js')
                    // Destination selection and the sealed-URL heal live inside the shared
                    // refresh path, so this call and the token endpoint use one policy.
                    const fresh = await refreshNuvioToken(connection.id, connection.accountId, connection.syncUser)
                    if (fresh) {
                        credentials = connection.credentials = {
                            ...credentials,
                            accessToken: fresh.accessToken,
                            refreshToken: fresh.refreshToken,
                            expiresAt: fresh.expiresAt,
                            profileId: fresh.profileId ?? credentials.profileId,
                            baseUrl: fresh.baseUrl ?? credentials.baseUrl,
                            publishableKey: fresh.publishableKey ?? credentials.publishableKey,
                        }
                    }
                } catch (err) {
                    if (err.isAuthError || err._authExpired || err._credentialSuperseded) {
                        throw err
                    }
                }
            }
        }

        // Built only now, from the final authoritative bundle: a driver created before
        // the refresh would keep the pre-refresh destination for every later call.
        const { createNuvioDriver } = await import('./nuvio-driver.js')
        return createNuvioDriver({
            baseUrl: credentials.baseUrl,
            publishableKey: credentials.publishableKey
        })
    }
    if (platform === 'realstream') {
        const { createRealStreamDriver } = await import('./realstream-driver.js')
        const driver = createRealStreamDriver({
            baseUrl: credentials.baseUrl
        })

        if (connection?.id) {
            const expiresAt = connection.credentials?.expiresAt
            if (storedConnections.get(connection) !== connectionCacheGeneration || !expiresAt || expiresAt - Date.now() <= REFRESH_BUFFER_MS) {
                try {
                    const { refreshRealStreamToken } = await import('./token-refresh.js')
                    const fresh = await refreshRealStreamToken(connection.id, connection.accountId, connection.syncUser)
                    if (fresh) {
                        connection.credentials = {
                            ...connection.credentials,
                            accessToken: fresh.accessToken,
                            userId: fresh.userId ?? connection.credentials?.userId,
                            expiresAt: fresh.expiresAt,
                        }
                    }
                } catch (err) {
                    if (err.isAuthError || err._authExpired || err._credentialSuperseded) {
                        throw err
                    }
                }
            }
        }

        return driver
    }
    if (connection && isHydraOutbound(connection)) {
        let authValue = connection.credentials?.authValue
        let config = connection.driverConfig
        if (authValue === undefined || !config?.baseUrl) {
            if (!connection.syncUser || !connection.accountId) return null
            const cred = await db.get(
                "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND credential_type = 'hydra' AND sync_user = $2 AND account_id = $3 LIMIT 1",
                [connection.id, connection.syncUser, connection.accountId]
            )
            if (cred?.auth_key) {
                const decrypted = decrypt(cred.auth_key, FALLBACK_KEYS)
                let bundle
                try { bundle = JSON.parse(decrypted) } catch { bundle = { authValue: decrypted } }
                if (!bundle || typeof bundle !== 'object') return null
                if (authValue === undefined) authValue = bundle.authValue
                if (!config?.baseUrl) config = { baseUrl: bundle.baseUrl, authType: bundle.authType, authHeader: bundle.authHeader }
            }
        }
        if (!config?.baseUrl) return null

        const { createHydraClient } = await import('../hydra/client.js')
        return await createHydraClient({ ...config, authValue })
    }
    return null
}

async function readPlatformAddons(driver, connection) {
    const c = connection.credentials
    if (connection.platform === 'stremio' && !isHydraOutbound(connection)) {
        return driver.readAddons(c.authKey)
    }
    if (connection.platform === 'nuvio') {
        return driver.readAddons(c.accessToken, c.profileId)
    }
    if (connection.platform === 'realstream') {
        return driver.readAddons(c.accessToken, c.userId)
    }
    if (isHydraOutbound(connection)) {
        return driver.readAddons()
    }
    return []
}

export function applyCustomMetadata(addon) {
    const meta = addon?.metadata
    if (!meta || (!meta.customName && !meta.customLogo && !meta.customDescription && !meta.hideConfigure)) return addon
    const manifest = addon.manifest || {}
    let updated = addon
    if (meta.customName || meta.customLogo || meta.customDescription) {
        updated = {
            ...addon,
            manifest: {
                ...manifest,
                name: meta.customName || manifest.name,
                logo: meta.customLogo || manifest.logo,
                description: meta.customDescription || manifest.description,
            },
        }
    }
    if (meta.hideConfigure) {
        const m = updated.manifest || {}
        updated = { ...updated, manifest: { ...m, behaviorHints: { ...m.behaviorHints, configurable: false } } }
    }
    return updated
}

// Hydra targets return spec-flat rows, so compare only the fields that round-trip.
function flatManifestMismatch(platformRow, canonicalManifest) {
    for (const field of ['id', 'version']) {
        const live = platformRow?.manifest?.[field] ?? platformRow?.[field]
        const expected = canonicalManifest?.[field]
        if (typeof live === 'string' && live && typeof expected === 'string' && expected && live !== expected) return true
    }
    return false
}

function orderedUrls(addons) {
    const seen = new Set()
    const out = []
    for (const a of addons) {
        const url = normalizeUrl(a?.transportUrl || a?.url)
        if (seen.has(url)) continue
        seen.add(url)
        out.push(url)
    }
    return out
}

function manifestSignature(m) {
    if (!m) return '{}'
    return JSON.stringify({
        id: m.id || '',
        version: m.version || '',
        types: m.types || [],
        resources: m.resources || [],
        catalogs: m.catalogs || []
    })
}

// Stable fingerprint of a canonical list over the diff-compared fields (url, manifest
// signature, custom name), sorted so list order never changes the hash. Consumed by
// auditConnections' fresh-in-sync skip; order-swap re-reads are indistinguishable to
// reconcileAccount's diff, so a skip armed under one is valid for the other.
function canonicalFingerprint(canonical) {
    return JSON.stringify(
        canonical.map(a => [
            normalizeUrl(a.transportUrl),
            manifestSignature(a.manifest),
            a?.metadata?.customName || ''
        ]).sort()
    )
}

// Minimum window in which a connection verifiably matching this exact canonical is not
// re-read by the audit (in-memory only; restart re-reads, the conservative direction).
const MIN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000

// Platform writes replace the full addon list, so two writes racing on one connection
// land in nondeterministic order (route immediate-enforcement vs worker cycle vs client
// reconcile). Serialize per connection; different connections still run in parallel.
const platformWriteQueues = new Map()

function enqueuePlatformWrite(connection, run) {
    const key = connection.id || connection.platform
    const prev = platformWriteQueues.get(key) ?? Promise.resolve()
    const next = prev.catch(() => { }).then(run)
    platformWriteQueues.set(key, next)
    next.finally(() => {
        if (platformWriteQueues.get(key) === next) platformWriteQueues.delete(key)
    }).catch(() => { })
    return next
}

// An account runs one rule per addon chain, and every rule stores the ACCOUNT's whole addon
// list. Pushing that snapshot verbatim therefore rewrites the sibling chains from a copy that
// goes stale the moment the sibling rule swaps: last writer wins, and the loser's failover is
// reverted on the platform. Chain membership is stable, so the caller names the sibling chains;
// their *state* is mirrored from the platform here, which makes concurrent writers agree
// regardless of write order. URLs this rule does not manage are still written from the canonical
// list, so genuine additions are unaffected, and with no sibling chains this is a no-op.
// Only the NAMED members are mirrored or rehydrated: every other live row is one the canonical list
// deliberately omits (a retired addon mid-delete, a manual removal), and re-adding it would
// resurrect a deletion this write is supposed to land.
// `excludedUrls` (normalized) are this connection's destination-policy removals: a
// deliberately excluded member must never be mirrored back as a foreign row either.
async function reconcileForeignChains(driver, connection, canonical, requiredUrls, foreignChainUrls, excludedUrls = null, managedChains = null, preserveUrls = null) {
    const foreign = new Set((Array.isArray(foreignChainUrls) ? foreignChainUrls : []).map(u => normalizeUrl(u)))
    const own = new Set((Array.isArray(requiredUrls) ? requiredUrls : []).map(u => normalizeUrl(u)))
    const preserved = new Set((Array.isArray(preserveUrls) ? preserveUrls : []).map(normalizeUrl).filter(Boolean))
    if (foreign.size === 0 && own.size === 0 && preserved.size === 0) return canonical
    const excluded = excludedUrls instanceof Set && excludedUrls.size > 0 ? excludedUrls : null
    const urlOf = (a) => normalizeUrl(a?.transportUrl || a?.url || '')
    let live = []
    try {
        live = await readPlatformAddons(driver, connection)
    } catch (err) {
        if (preserved.size > 0) return null
        // Conservative fallback: with no live read the stored snapshot is the only source.
        trace('reconciler', 'reconcileForeignChains.readFailed', { platform: connection.platform, error: err.message })
        return canonical
    }
    if (!Array.isArray(live)) return preserved.size > 0 ? null : canonical
    if (live.length === 0 && preserved.size === 0) return canonical

    let out = canonical.filter(a => !foreign.has(urlOf(a)))
    const present = new Set(out.map(urlOf))
    for (const row of live) {
        const url = urlOf(row)
        // Mirror ONLY the named foreign-chain members. Any other live row is one the
        // canonical list deliberately omits (a retired addon mid-delete, a manual
        // removal); re-adding it would resurrect a deletion the write must land.
        if (!url || !foreign.has(url)) continue
        // Destination policy: a member this connection deliberately excludes is
        // intentionally absent — the mirror must not resurrect it.
        if (excluded && excluded.has(url)) continue
        if (present.has(url)) continue
        if ((row.flags?.enabled ?? row.enabled) === false) continue
        present.add(url)
        out.push({
            transportUrl: row.transportUrl || row.url,
            manifest: row.manifest || { name: row.name || '' },
            flags: { ...(row.flags || {}), enabled: (row.flags?.enabled ?? row.enabled) !== false },
        })
    }
    // Rehydrate this writer's own chain from the same live snapshot. This is
    // the recovery path for connection-only rules whose encrypted addon_list
    // no longer carries any exact member of the chain.
    for (const row of live) {
        const url = urlOf(row)
        if (!url || !own.has(url) || excluded?.has(url) || present.has(url)) continue
        present.add(url)
        out.push({
            transportUrl: row.transportUrl || row.url,
            manifest: row.manifest || { name: row.name || '' },
            flags: { ...(row.flags || {}), enabled: (row.flags?.enabled ?? row.enabled) !== false },
        })
    }
    // A stale connection-only snapshot can contain a managed chain only as
    // disabled rows (or omit it entirely). Once the live provider has supplied
    // the named members, apply the decided target before the final guard. This
    // remains fail-closed: a missing target is still rejected by the guard.
    for (const chain of managedChains || []) {
        const members = new Set((chain?.urls || []).map(u => normalizeUrl(u)).filter(Boolean))
        if (members.size === 0) continue
        const target = normalizeUrl(chain.target || '')
        if (!target) continue
        out = out.map(row => {
            const url = urlOf(row)
            if (!members.has(url)) return row
            return { ...row, flags: { ...(row.flags || {}), enabled: url === target } }
        })
    }
    if (preserved.size > 0) {
        out = out.filter(row => !preserved.has(urlOf(row)))
        for (const row of live) {
            const url = urlOf(row)
            if (!preserved.has(url) || excluded?.has(url)) continue
            out.push({
                ...row,
                transportUrl: row.transportUrl || row.url,
                manifest: row.manifest || { name: row.name || '' },
                flags: { ...(row.flags || {}), enabled: (row.flags?.enabled ?? row.enabled) !== false },
            })
        }
    }
    trace('reconciler', 'reconcileForeignChains.merged', { platform: connection.platform, foreign: foreign.size, count: out.length })
    return out
}

// An empty RealStream projection is never a clear in this beta (R2-08): the
// authorized-clear path is removed, so an empty write skips at the driver and is
// reported as a skipped outcome, never as a confirmed write. Autopilot and
// reconcile share that behavior; the global empty-canonical guard above still
// applies to every platform unchanged.

// `prep` runs inside the per-connection queue slot, so the read it needs, the guard it
// applies and the write that follows cannot interleave with another writer's (the read
// target is the platform's own list, which a concurrent writer would otherwise change
// between our read and our write). It returns { list } or { skip, reason }.
// R2-08: a zero-row RealStream write is never an authorized clear anymore: the driver
// resolves every empty projection as a skip, which the caller reports honestly.
async function writePlatformAddons(driver, connection, addons, source, prep = null) {
    const c = connection.credentials
    return enqueuePlatformWrite(connection, async () => {
        let list = addons
        if (typeof prep === 'function') {
            const outcome = (await prep(addons)) || {}
            if (outcome.skip) return { skipped: true, reason: outcome.reason || 'prep-skip' }
            if (Array.isArray(outcome.list)) list = outcome.list
        }
        // RealStream stores collection membership as enabled state and ignores
        // the internal flags field. Keep the existing one-active contract by
        // omitting disabled rows on that wire; Nuvio/Hydra retain explicit
        // enabled flags and receive the full projected list.
        const wireList = connection.platform === 'realstream'
            ? (list || []).filter(a => (a?.flags?.enabled ?? a?.enabled) !== false)
            : (list || [])
        const prepared = wireList.map(a => {
            const withMeta = applyCustomMetadata(a)
            // R9: drivers and the provider wire receive projected provider data only.
            // The internal destination policy never ships — unlike note/metadata it
            // is not user content for the platform.
            if (!withMeta?.destinations) return withMeta
            const { destinations, ...rest } = withMeta
            return rest
        })
        trace('reconciler', 'writePlatformAddons', { platform: connection.platform, source, count: prepared.length, urls: traceEnabled() ? prepared.map(a => a.transportUrl || '') : undefined })
        if (connection.platform === 'stremio' && !isHydraOutbound(connection)) {
            if (!c?.authKey) { const e = new Error('Stremio credentials not loaded'); e.isAuthError = true; throw e }
            try {
                return await driver.writeAddons(c.authKey, prepared)
            } finally {
                invalidateCanonicalByAuthKey(c.authKey)
            }
        }
        if (connection.platform === 'nuvio') {
            if (!c?.accessToken) { const e = new Error('Nuvio credentials not loaded, re-authenticate this connection'); e.isAuthError = true; throw e }
            return driver.writeAddons(c.accessToken, prepared, c.profileId)
        }
        if (connection.platform === 'realstream') {
            if (!c?.accessToken) { const e = new Error('RealStream credentials not loaded, re-authenticate this connection'); e.isAuthError = true; throw e }
            return driver.writeAddons(c.accessToken, prepared, c.userId)
        }
        if (isHydraOutbound(connection)) {
            return driver.writeAddons(prepared)
        }
    })
}

function connectionKey(accountId, connectionId) {
    return `${accountId}:${connectionId}`
}

export function createReconciler(fastify) {
    const connectionState = new Map()
    const syncCycleCounters = new Map()

    const getState = (accountId, connId) => {
        return connectionState.get(connectionKey(accountId, connId)) || {
            consecutiveFailures: 0,
            lastError: null,
            lastErrorAt: null,
            lastSync: 0,
            status: 'active',
            skipCyclesRemaining: 0
        }
    }

    const setState = (accountId, connId, state) => {
        connectionState.set(connectionKey(accountId, connId), state)
    }

    const STATE_TTL_MS = 60 * 60 * 1000
    const MAX_ENTRIES = 10000
    let lastEvictAt = 0
    const evictStaleState = () => {
        const now = Date.now()
        if (now - lastEvictAt < STATE_TTL_MS) return
        lastEvictAt = now
        for (const [key, state] of connectionState.entries()) {
            const lastActivity = Math.max(state.lastSync, state.lastErrorAt || 0)
            const isStale = lastActivity > 0 && now - lastActivity > STATE_TTL_MS
            const isFailing = state.status === 'error' || (state.consecutiveFailures || 0) > 0
            if ((isStale && !isFailing) || (connectionState.size > MAX_ENTRIES && !isFailing)) {
                connectionState.delete(key)
            }
        }
    }

    const recordSuccess = (accountId, connId) => {
        const prev = getState(accountId, connId)
        setState(accountId, connId, {
            ...prev,
            consecutiveFailures: 0,
            lastError: null,
            lastErrorAt: null,
            lastSync: Date.now(),
            status: 'active',
            skipCyclesRemaining: 0
        })
        trace('reconciler', 'recordSuccess', { accountId, connectionId: connId })
    }

    const recordFailure = (accountId, connId, error, isAuthError) => {
        const prev = getState(accountId, connId)
        const consecutiveFailures = prev.consecutiveFailures + 1
        const status = isAuthError ? 'expired' : (consecutiveFailures >= BACKOFF_THRESHOLD ? 'error' : prev.status)
        const skipCyclesRemaining = getBackoffSkip(consecutiveFailures)

        setState(accountId, connId, {
            ...prev,
            consecutiveFailures,
            lastError: error.message || String(error),
            lastErrorAt: Date.now(),
            lastSync: prev.lastSync,
            status,
            skipCyclesRemaining
        })
        trace('reconciler', 'recordFailure', { accountId, connectionId: connId, consecutiveFailures, isAuthError, status, error: error.message || String(error) })
    }

    const EXPIRED_RETRY_COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes; Supabase rate-limits auth to 6 req/min per IP. Hammering it gets users banned.
    const NETWORK_ERROR_COOLDOWN_MS = 2 * 60 * 1000  // 2 minutes for transient network issues

    const skipReasonFor = (accountId, connId) => {
        // A fresh client collection write means the hub is momentarily behind the platforms.
        const writes = fastify.clientCollectionWrites
        if (writes) {
            const last = Math.max(
                writes.get(accountId) || 0,
                writes.get('Bulk Op') || 0,
                writes.get('Profile Swap') || 0,
                writes.get('Clear All') || 0
            )
            if (Date.now() - last < 20000) return 'recent-write'
        }
        const state = getState(accountId, connId)
        if (state.status === 'expired') {
            // Auth errors get a LONG cooldown. Supabase bans IPs that hit auth too frequently.
            const timeSinceError = state.lastErrorAt ? Date.now() - state.lastErrorAt : Infinity
            if (timeSinceError < EXPIRED_RETRY_COOLDOWN_MS) return 'auth-cooldown'
        }
        if (state.status === 'error' && state.consecutiveFailures >= BACKOFF_THRESHOLD) {
            if (state.skipCyclesRemaining > 0) {
                setState(accountId, connId, { ...state, skipCyclesRemaining: state.skipCyclesRemaining - 1 })
                return 'backoff'
            }
        }
        return null
    }
    const shouldSkip = (accountId, connId) => skipReasonFor(accountId, connId) !== null

    const tickCycleCounter = (accountId) => {
        evictStaleState()
        const current = syncCycleCounters.get(accountId) || 0
        syncCycleCounters.set(accountId, current + 1)
    }

    const reconcileAccount = async (accountId, primaryConnectionId, connections, canonicalAddons, opts = {}) => {
        tickCycleCounter(accountId)
        const start = Date.now()
        const canonical = (Array.isArray(canonicalAddons) ? canonicalAddons : []).filter(a => a?.flags?.enabled !== false)
        trace('reconciler', 'reconcileAccount.start', { accountId, canonicalCount: canonical.length })

        // Stremio uses client-side sync pipeline, not server-side reconciliation
        const targetConnections = connections.filter(c => c.enabled && (isHydraOutbound(c) || c.platform !== 'stremio'))
        // Per-connection result: written | unchanged | skipped (reason) | failed (error).
        const outcomes = {}
        for (const c of connections) {
            if (!targetConnections.includes(c)) outcomes[c.id] = { outcome: 'skipped', reason: 'not-a-target' }
        }

        if ((canonical.length === 0 && !opts.allowCollectionShrink) || targetConnections.length === 0) {
            for (const c of targetConnections) outcomes[c.id] = { outcome: 'skipped', reason: 'empty-canonical' }
            trace('reconciler', 'reconcileAccount.complete', { accountId, skipped: true, reason: targetConnections.length === 0 ? 'no-targets' : 'empty-canonical', timing: Date.now() - start })
            return { changes: [], canonical, outcomes }
        }

        const canonicalManifestByUrl = new Map(
            canonical.map(a => [normalizeUrl(a.transportUrl), manifestSignature(a.manifest)])
        )
        const canonicalRawManifestByUrl = new Map(
            canonical.map(a => [normalizeUrl(a.transportUrl), a.manifest])
        )
        const customNameByUrl = new Map(
            canonical
                .filter(a => a?.metadata?.customName)
                .map(a => [normalizeUrl(a.transportUrl), a.metadata.customName])
        )
        // Destination policy (per connection): every target projects its OWN effective
        // list from the canonical descriptors — the hub stays the single superset, a
        // row excluded for this login is simply absent from its write, including an
        // EMPTY write when every row is excluded there (policy-authorized clear, R2).
        // The global empty-canonical guard above is unchanged: a fully-empty
        // canonical list only reaches platforms with explicit allowCollectionShrink.
        const changes = []

        for (const connection of targetConnections) {
            const connId = connection.id
            const skipReason = skipReasonFor(accountId, connId)
            if (skipReason) {
                outcomes[connId] = { outcome: 'skipped', reason: skipReason }
                fastify.log.debug({ category: 'Reconciler' }, `[${accountId}] Skipping ${connection.platform} (${connId}): ${skipReason}`)
                continue
            }

            try {
                const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
                if (!driver) { outcomes[connId] = { outcome: 'skipped', reason: 'no-driver' }; continue }

                const hydraOutbound = isHydraOutbound(connection)
                const effective = connectionEffectiveAddons(canonical, connection)
                // The Hydra client drops local and unparseable URLs on the wire; compare what it sends.
                const compared = hydraOutbound
                    ? effective.filter(a => !isLocalHostname(a?.transportUrl || a?.url || ''))
                    : effective
                const effectiveUrlSet = new Set(compared.map(a => normalizeUrl(a.transportUrl)))

                let needsWrite = true
                try {
                    const platformAddons = await readPlatformAddons(driver, connection)
                    const platformUrlSet = new Set(platformAddons.map(a => normalizeUrl(a.transportUrl || a.url)))
                    // E2 enforcement lives here: a platform row the policy excludes
                    // makes the sets differ, so the projected write REMOVES it.
                    const sameUrls = platformUrlSet.size === effectiveUrlSet.size && [...effectiveUrlSet].every(u => platformUrlSet.has(u))
                    if (sameUrls) {
                        const nameMismatch = customNameByUrl.size > 0 && platformAddons.some(p => {
                            const url = normalizeUrl(p.transportUrl || p.url)
                            const expected = customNameByUrl.get(url)
                            if (expected === undefined) return false
                            const platformName = p.manifest?.name ?? p.name
                            return platformName != null && platformName !== '' && platformName !== expected
                        })
                        const manifestMismatch = platformAddons.some(p => {
                            const url = normalizeUrl(p.transportUrl || p.url)
                            if (hydraOutbound) {
                                return canonicalRawManifestByUrl.has(url) && flatManifestMismatch(p, canonicalRawManifestByUrl.get(url))
                            }
                            const canonicalManifest = canonicalManifestByUrl.get(url)
                            if (canonicalManifest === undefined) return false
                            if (!p.manifest) return false
                            return manifestSignature(p.manifest) !== canonicalManifest
                        })
                        // Nuvio stores sort_order and reads it back ordered, so a reorder converges after one write.
                        const orderMismatch = connection.platform === 'nuvio' &&
                            orderedUrls(platformAddons).join('\n') !== orderedUrls(compared).join('\n')
                        needsWrite = nameMismatch || manifestMismatch || orderMismatch
                    }
                } catch { /* can't read, assume needs write */ }

                if (needsWrite) {
                    const outcome = await writePlatformAddons(driver, connection, effective, 'reconcile', opts.canWrite ? async list => {
                        if (!await opts.canWrite()) return { skip: true, reason: 'rule-paused' }
                        return { list }
                    } : null)
                    if (outcome?.skipped) { outcomes[connId] = { outcome: 'skipped', reason: outcome.reason }; continue }
                    changes.push({ type: 'restore', url: '', platform: connection.platform, primary: false })
                }
                recordSuccess(accountId, connId)
                outcomes[connId] = { outcome: needsWrite ? 'written' : 'unchanged' }
            } catch (err) {
                if (isStateRefusal(err)) throw err
                recordFailure(accountId, connId, err, err.isAuthError)
                outcomes[connId] = { outcome: 'failed', error: err?.message || String(err) }
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] ${connection.platform} push failed: ${err.message}`)
            }
        }

        trace('reconciler', 'reconcileAccount.complete', { accountId, changes: changes.length, platforms: changes.map(c => c.platform), timing: Date.now() - start })
        return { changes, canonical, outcomes }
    }

    const enforceAccount = async (accountId, connections, canonical, opts = {}) => {
        const { stremioWriter, requiredUrls, requiredActiveUrl } = opts
        tickCycleCounter(accountId)
        const canon = (Array.isArray(canonical) ? canonical : []).filter(a => a?.flags?.enabled !== false)
        const start = Date.now()
        trace('reconciler', 'enforceAccount.start', { accountId, canonicalCount: canon.length })
        const synced = []
        const syncedIds = []

        // Chain guard (spec F2): an enforced list that would drop every managed
        // chain member (all disabled -> "neither installed") or lose the active
        // tier must never reach a platform — EXCEPT when the dropped member is a
        // deliberate destination exclusion for THAT connection: the tolerant twin
        // (chainGuardFailureWithExclusions) waives exactly those, never globally
        // disabling the chain and never demanding a backup be enabled to
        // compensate. The guard now runs PER CONNECTION on that connection's
        // projected list; a data problem must not back off the connection
        // (skip means NO write, NO recordSuccess — arming the fresh-in-sync guard
        // with an unwritten list would poison it — and NO recordFailure).
        const configuredChains = Array.isArray(opts.managedChains) && opts.managedChains.length > 0
            ? opts.managedChains
            : (Array.isArray(requiredUrls) && requiredUrls.length > 0 ? [{ urls: requiredUrls, target: requiredActiveUrl }] : [])
        const preserved = new Set((Array.isArray(opts.preserveUrls) ? opts.preserveUrls : []).map(normalizeUrl).filter(Boolean))
        const managedChains = configuredChains.filter(chain => !preserved.has(normalizeUrl(chain.target || '')))
            .map(chain => ({ ...chain, urls: (chain.urls || []).filter(url => !preserved.has(normalizeUrl(url))) }))
        let chainGuardSkipped = false
        let recoveredAddons = []

        for (const connection of (connections || []).filter(c => c.enabled)) {
            const connId = connection.id
            if (shouldSkip(accountId, connId)) {
                fastify.log.debug({ category: 'Reconciler' }, `[${accountId}] Skipping ${connection.platform} (${connId}): in backoff`)
                continue
            }
            try {
                // Per-connection destination projection: the enforced write carries
                // this login's effective list (canon minus its exclusions). Canon
                // non-empty with an EMPTY effective list is a policy-authorized
                // clear — the write removes the target's excluded copies (E2).
                // The guard's PRE list is the unfiltered canon: the exclusion
                // explanation ("every canon-carried member was deliberately
                // excluded HERE") is only derivable against the pre-projection set.
                let effective = connectionEffectiveAddons(canon, connection)
                const excludedUrls = connectionExcludedUrls(canon, connection)
                const foreignUrls = new Set((Array.isArray(opts.foreignChainUrls) ? opts.foreignChainUrls : []).map(normalizeUrl).filter(Boolean))
                // A chain that is completely absent from the canonical snapshot
                // may be rehydrated by the in-slot live mirror. Keep the early
                // guard strict for every chain that has carried members; defer
                // only explicitly named foreign/rehydrated chains.
                const preManagedChains = managedChains.filter(chain => {
                    const members = (chain?.urls || []).map(normalizeUrl).filter(Boolean)
                    const target = normalizeUrl(chain?.target || '')
                    const carriesTarget = !!target && canon.some(a => normalizeUrl(a?.transportUrl || '') === target)
                    const deferred = members.length > 0 && members.every(url => foreignUrls.has(url)) && !carriesTarget
                    return !deferred
                })
                const preFailure = chainGuardFailureWithExclusions(canon, effective, preManagedChains, excludedUrls)
                if (preFailure) {
                    fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Chain guard: enforced list drops a managed chain (${preFailure}); skipping write.`)
                    trace('reconciler', 'enforceAccount.chainGuard', { accountId, platform: connection.platform, chains: managedChains.length, failure: preFailure })
                    chainGuardSkipped = true
                    continue
                }
                // A client-side Stremio writer takes priority; without one the server driver
                // writes Stremio itself (it holds the authKey), so an API-driven enforce —
                // e.g. an AIOMetadata "sync to all" push — can never silently skip Stremio.
                if (connection.platform === 'stremio' && !isHydraOutbound(connection) && stremioWriter) {
                    if (opts.canWrite && !await opts.canWrite()) { chainGuardSkipped = true; continue }
                    await stremioWriter(connection)
                } else {
                    if (canon.length === 0) continue
                    const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
                    if (!driver) continue
                    const outcome = await writePlatformAddons(driver, connection, effective, 'enforce', async (list) => {
                        const merged = await reconcileForeignChains(driver, connection, list, requiredUrls, opts.foreignChainUrls, excludedUrls, managedChains, opts.preserveUrls)
                        if (merged === null) return { skip: true, reason: 'The live collection could not be read to preserve contested addons.' }
                        // Belt-and-braces: no merge step may ride an excluded row
                        // back onto this connection's write (E2).
                        const finalList = excludedUrls.size > 0
                            ? merged.filter(a => !excludedUrls.has(normalizeUrl(a?.transportUrl || a?.url || '')))
                            : merged
                        // The foreign mirror rebuilds sibling-chain member sets from the
                        // live platform: a canon-carried FOREIGN member absent from the
                        // merged list is a by-design drop, not an accidental one.
                        const urlOf = (a) => normalizeUrl(a?.transportUrl || a?.url || '')
                        const preSet = new Set((list || []).map(urlOf).filter(Boolean))
                        const canonSet = new Set((canon || []).map(urlOf).filter(Boolean))
                        const postSet = new Set((finalList || []).map(urlOf).filter(Boolean))
                        const byDesign = new Set()
                        for (const u of (Array.isArray(opts.foreignChainUrls) ? opts.foreignChainUrls : [])) {
                            const norm = normalizeUrl(u)
                            if (norm && (preSet.has(norm) || canonSet.has(norm)) && !postSet.has(norm)) byDesign.add(norm)
                        }
                        const failure = chainGuardFailureWithExclusions(canon, finalList, managedChains, excludedUrls, byDesign)
                        if (failure) {
                            fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Chain guard: merged list would drop a managed chain (${failure}); skipping write.`)
                            return { skip: true, reason: failure }
                        }
                        const canonicalUrls = new Set((list || []).map(urlOf).filter(Boolean))
                        recoveredAddons = finalList.filter(row => {
                            const url = urlOf(row)
                            return url && !canonicalUrls.has(url)
                        })
                        if (opts.canWrite && !await opts.canWrite()) return { skip: true, reason: 'Rule was paused or removed.' }
                        return { list: finalList }
                    })
                    if (outcome && outcome.skipped) { chainGuardSkipped = true; continue }
                }
                recordSuccess(accountId, connId)
                synced.push(connection.platform)
                syncedIds.push(connId)
            } catch (err) {
                if (isStateRefusal(err)) throw err
                recordFailure(accountId, connId, err, err.isAuthError)
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] ${connection.platform} push failed: ${err.message}`)
            }
        }

        trace('reconciler', 'enforceAccount.complete', { accountId, synced, timing: Date.now() - start })
        return { synced, syncedIds, connectionStates: getConnectionStates(accountId), chainGuardSkipped, recoveredAddons }
    }

    // Nuvio instances that reject the optional plugins table; skip after the first 401
    const nuvioPluginsUnsupported = new Set()

    const reconcilePlugins = async (accountId, connection, opts = {}) => {
        if (connection.platform !== 'nuvio') return
        if (!connection.enabled) return
        if (shouldSkip(accountId, connection.id)) return
        if (nuvioPluginsUnsupported.has(connection.id)) return

        const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
        if (!driver || !driver.readPlugins) return
        if (!connection.credentials?.accessToken) return

        const canonicalPlugins = connection.pluginList || []

        try {
            const platformPlugins = await driver.readPlugins(
                connection.credentials.accessToken,
                connection.credentials.profileId
            )

            const canonicalUrls = new Set(canonicalPlugins.map(p => normalizeUrl(p.url)))
            const platformUrls = new Set(platformPlugins.map(p => normalizeUrl(p.url)))

            const needsPush = platformUrls.size !== canonicalUrls.size ||
                [...canonicalUrls].some(u => !platformUrls.has(u)) ||
                [...platformUrls].some(u => !canonicalUrls.has(u))

            if (needsPush && canonicalPlugins.length > 0) {
                // Write boundary: a blocked owner (or any canWrite refusal) skips the
                // push entirely, without punishing the connection state.
                if (opts.canWrite && !await opts.canWrite()) return
                await driver.writePlugins(
                    connection.credentials.accessToken,
                    canonicalPlugins,
                    connection.credentials.profileId
                )
            }
            recordSuccess(accountId, connection.id)
        } catch (err) {
            if (isStateRefusal(err)) throw err
            if (err.isAuthError) {
                // Token was just refreshed, so this 401 means plugins aren't offered on this instance
                nuvioPluginsUnsupported.add(connection.id)
                fastify.log.debug({ category: 'Reconciler' }, `[${accountId}] Nuvio plugins unavailable on this instance (auth rejected); skipping plugin sync.`)
                return
            }
            recordFailure(accountId, connection.id, err, false)
            fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Nuvio plugin sync failed: ${err.message}`)
        }
    }

    // Deep-audit read path for connection-only rules: returns each connection's live
    // collection via the same driver/read machinery as reconcileAccount, without
    // writing. A connection in backoff or fresh-verified in-sync for this exact
    // canonical (the #19 guard) is skipped, never fought. Read errors surface as
    // skipped entries with no recordFailure — the audit observes, it does not punish.
    const auditConnections = async (accountId, connections, canonical) => {
        const canon = (Array.isArray(canonical) ? canonical : []).filter(a => a?.flags?.enabled !== false)
        const canonHash = canonicalFingerprint(canon)
        const results = []
        for (const connection of (connections || []).filter(c => c.enabled)) {
            const connId = connection.id
            if (shouldSkip(accountId, connId)) {
                results.push({ connectionId: connId, platform: connection.platform, skipped: 'backoff' })
                continue
            }
            const state = getState(accountId, connId)
            if (
                state.lastInSync === true &&
                state.lastCanonicalHash === canonHash &&
                Date.now() - (state.lastSync || 0) < MIN_RECONCILE_INTERVAL_MS
            ) {
                trace('reconciler', 'audit-skip', { accountId, connectionId: connId, reason: 'fresh-in-sync' })
                results.push({ connectionId: connId, platform: connection.platform, skipped: 'fresh-in-sync' })
                continue
            }
            try {
                const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
                if (!driver) {
                    results.push({ connectionId: connId, platform: connection.platform, skipped: 'no-driver' })
                    continue
                }
                const addons = await readPlatformAddons(driver, connection)
                results.push({ connectionId: connId, platform: connection.platform, addons: Array.isArray(addons) ? addons : [] })
            } catch (err) {
                trace('reconciler', 'audit-connection-error', { accountId, connectionId: connId, error: err?.message || String(err) })
                results.push({ connectionId: connId, platform: connection.platform, skipped: 'read-error' })
            }
        }
        return results
    }

    const getConnectionStates = (accountId) => {
        const states = {}
        for (const [key, state] of connectionState.entries()) {
            if (key.startsWith(`${accountId}:`)) {
                states[key.split(':').slice(1).join(':')] = { ...state }
            }
        }
        return states
    }

    // Dashboard repair helpers: auth-cooldown (status expired) and backoff state are
    // keyed per (account, connection) with no owner on the key, and two owners may
    // share a platform account id. Ownership is resolved to the exact connection
    // identities the owner's credentials and rules produce (mirroring the ids
    // resolveConnections builds), and state keys match by both parts, never by
    // account id alone. One predicate drives the dry run and the run; healthy
    // connection state is preserved. Zero DB writes.
    const ownerConnectionKeys = async (syncUser) => {
        const keys = new Set()
        const creds = await db.query('SELECT account_id, connection_id, credential_type FROM server_credentials WHERE sync_user = $1', [syncUser])
        for (const row of creds) {
            if (!row.account_id) continue
            const type = row.credential_type || 'stremio'
            const connId = row.connection_id || `${row.account_id}:${type}`
            keys.add(`${row.account_id}:${connId}`)
        }
        const rules = await db.query('SELECT account_id, connection_id, platform FROM autopilot_rules WHERE owner_sync_user = $1', [syncUser])
        for (const row of rules) {
            if (!row.account_id) continue
            // The synthetic account-level Stremio identity belongs to unified Stremio
            // rules only (platform stremio, or a legacy row with neither platform nor
            // connection); a connection-scoped rule owns exactly its own connection id.
            const platform = row.platform || 'stremio'
            if (!row.connection_id && platform === 'stremio') keys.add(`${row.account_id}:${row.account_id}:stremio`)
            if (row.connection_id) keys.add(`${row.account_id}:${row.connection_id}`)
        }
        return keys
    }

    const loginBackoffEntry = (state) => (state.status === 'expired' && state.lastErrorAt != null)
        || state.consecutiveFailures >= BACKOFF_THRESHOLD
        || state.skipCyclesRemaining > 0

    const loginBackoffSummaryForOwner = async (syncUser) => {
        const owned = await ownerConnectionKeys(syncUser)
        let entries = 0
        let authCooldown = 0
        let backoff = 0
        for (const [key, state] of connectionState.entries()) {
            if (!owned.has(key)) continue
            if (!loginBackoffEntry(state)) continue
            entries++
            if (state.status === 'expired' && state.lastErrorAt != null) authCooldown++
            else backoff++
        }
        return { entries, authCooldown, backoff }
    }

    const resetLoginBackoffForOwner = async (syncUser) => {
        const owned = await ownerConnectionKeys(syncUser)
        let cleared = 0
        for (const key of [...connectionState.keys()]) {
            if (!owned.has(key)) continue
            if (!loginBackoffEntry(connectionState.get(key))) continue
            connectionState.delete(key)
            cleared++
        }
        return cleared
    }

    return {
        reconcileAccount,
        enforceAccount,
        reconcilePlugins,
        auditConnections,
        resolveConnections,
        getConnectionStates,
        recordSuccess,
        recordFailure,
        getState,
        loginBackoffSummaryForOwner,
        resetLoginBackoffForOwner,
    }
}
