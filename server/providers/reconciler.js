import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { trace } from '../utils/trace.js'
import { chainGuardFailure } from '../autopilot/one-active.js'

const BACKOFF_THRESHOLD = 3
const BACKOFF_SLOTS = [1, 2, 4, 8, 16]

function getBackoffSkip(consecutiveFailures) {
    if (consecutiveFailures < BACKOFF_THRESHOLD) return 0
    const slotIndex = Math.min(
        Math.floor(Math.log2(consecutiveFailures - BACKOFF_THRESHOLD + 1)),
        BACKOFF_SLOTS.length - 1
    )
    return BACKOFF_SLOTS[slotIndex]
}

function normalizeUrl(url) {
    if (!url) return ''
    let normalized = url.trim()
    normalized = normalized.replace(/^stremio:\/\//i, 'https://')
    normalized = normalized.replace(/\/manifest\.json$/i, '')
    normalized = normalized.replace(/\/+$/, '')
    return normalized.toLowerCase()
}

// syncUser scopes the lookup to the owning user. The HTTP endpoint (providers.js) MUST pass the
// authenticated user so a caller can't resolve another user's stored credentials by accountId
// (cross-tenant IDOR). Server-trusted callers (the autopilot worker, which derives account_id from
// owner-scoped rules) may omit it.
async function resolveConnections(accountId, syncUser = null) {
    const rows = await db.query(
        syncUser
            ? 'SELECT connection_id, auth_key, credential_type FROM server_credentials WHERE account_id = $1 AND sync_user = $2 ORDER BY updated_at DESC'
            : 'SELECT connection_id, auth_key, credential_type FROM server_credentials WHERE account_id = $1 ORDER BY updated_at DESC',
        syncUser ? [accountId, syncUser] : [accountId]
    )
    if (!rows || rows.length === 0) return []

    const connections = []
    const seenPlatforms = new Set()
    const seenHydra = new Set()
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

        // one connection per platform; keep the most recent (older rows are stale per-device dupes)
        if (seenPlatforms.has(type)) continue
        seenPlatforms.add(type)

        // Stremio uses raw auth key string, not JSON credential bundle
        if (type === 'stremio') {
            const authKey = decrypt(row.auth_key, FALLBACK_KEYS)
            if (authKey) {
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
            }
        } else if (type === 'nuvio' || type === 'realstream') {
            let bundle = null
            try { bundle = JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) } catch { continue }
            if (bundle?.accessToken) {
                // enabled defaults true: the connection's enabled flag isn't stored server-side yet
                connections.push({
                    id: row.connection_id,
                    platform: type,
                    accountId,
                    driverType: 'native',
                    enabled: true,
                    status: 'active',
                    credentials: bundle,
                    consecutiveFailures: 0,
                    capabilities: type === 'nuvio' ? ['addons', 'plugins', 'profiles'] : ['addons']
                })
            }
        }
    }

    return connections
}

const isHydraOutbound = (c) =>
    c?.platform === 'hydra' ||
    c?.driverType === 'hydra' || c?.driverType === 'hydra-outbound' ||
    c?.connectionType === 'hydra-outbound'

async function loadDriver(platform, credentials, connection) {
    if (platform === 'stremio' && !isHydraOutbound(connection)) {
        const { createStremioDriver } = await import('./stremio-driver.js')
        return createStremioDriver()
    }
    if (platform === 'nuvio') {
        const { createNuvioDriver } = await import('./nuvio-driver.js')
        const driver = createNuvioDriver({
            baseUrl: credentials.baseUrl,
            publishableKey: credentials.publishableKey
        })

        // client-marked expired: skip refresh (cooldown handles repeated auth failures)
        if (connection?.status === 'expired') {
            const err = new Error('Nuvio credentials expired, re-authenticate this connection')
            err.isAuthError = true
            throw err
        }

        if (connection?.id) {
            try {
                const { refreshNuvioToken } = await import('./token-refresh.js')
                const fresh = await refreshNuvioToken(connection.id, connection.accountId)
                if (fresh) {
                    connection.credentials = {
                        ...connection.credentials,
                        accessToken: fresh.accessToken,
                        refreshToken: fresh.refreshToken,
                        expiresAt: fresh.expiresAt,
                        profileId: fresh.profileId ?? connection.credentials?.profileId,
                    }
                }
            } catch (err) {
                if (err.isAuthError || err._authExpired) {
                    throw err
                }
            }
        }

        return driver
    }
    if (platform === 'realstream') {
        const { createRealStreamDriver } = await import('./realstream-driver.js')
        const driver = createRealStreamDriver({
            baseUrl: credentials.baseUrl
        })

        if (connection?.id) {
            try {
                const { refreshRealStreamToken } = await import('./token-refresh.js')
                const fresh = await refreshRealStreamToken(connection.id)
                if (fresh) {
                    connection.credentials = {
                        ...connection.credentials,
                        accessToken: fresh.accessToken,
                        userId: fresh.userId ?? connection.credentials?.userId,
                        expiresAt: fresh.expiresAt,
                    }
                }
            } catch (err) {
                if (err.isAuthError || err._authExpired) {
                    throw err
                }
            }
        }

        return driver
    }
    if (connection && isHydraOutbound(connection)) {
        let authValue = connection.credentials?.authValue
        let config = connection.driverConfig
        if (authValue === undefined || !config?.baseUrl) {
            const cred = await db.get(
                "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND credential_type = 'hydra' LIMIT 1",
                [connection.id]
            )
            if (cred?.auth_key) {
                const decrypted = decrypt(cred.auth_key, FALLBACK_KEYS)
                let bundle
                try { bundle = JSON.parse(decrypted) } catch { bundle = { authValue: decrypted } }
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
// reverted on the platform (observed 2026-10-06 — rule logs "Swapping to: <backup>", client
// keeps the dead primary). Chain membership is stable, so the caller names the sibling chains;
// their *state* is mirrored from the platform here, which makes concurrent writers agree
// regardless of write order. URLs this rule does not manage are still written from the canonical
// list, so genuine additions are unaffected, and with no sibling chains this is a no-op.
async function reconcileForeignChains(driver, connection, canonical, requiredUrls, foreignChainUrls) {
    const foreign = new Set((Array.isArray(foreignChainUrls) ? foreignChainUrls : []).map(u => normalizeUrl(u)))
    if (foreign.size === 0) return canonical
    const own = new Set((Array.isArray(requiredUrls) ? requiredUrls : []).map(u => normalizeUrl(u)))
    const urlOf = (a) => normalizeUrl(a?.transportUrl || a?.url || '')
    let live = []
    try {
        live = await readPlatformAddons(driver, connection)
    } catch (err) {
        // Conservative fallback: with no live read the stored snapshot is the only source.
        trace('reconciler', 'reconcileForeignChains.readFailed', { platform: connection.platform, error: err.message })
        return canonical
    }
    if (!Array.isArray(live) || live.length === 0) return canonical

    const out = canonical.filter(a => !foreign.has(urlOf(a)))
    const present = new Set(out.map(urlOf))
    for (const row of live) {
        const url = urlOf(row)
        if (!url || present.has(url) || own.has(url)) continue
        if ((row.flags?.enabled ?? row.enabled) === false) continue
        present.add(url)
        out.push({
            transportUrl: row.transportUrl || row.url,
            manifest: row.manifest || { name: row.name || '' },
            flags: { ...(row.flags || {}), enabled: true },
        })
    }
    trace('reconciler', 'reconcileForeignChains.merged', { platform: connection.platform, foreign: foreign.size, count: out.length })
    return out
}

// `prep` runs inside the per-connection queue slot, so the read it needs, the guard it
// applies and the write that follows cannot interleave with another writer's (the read
// target is the platform's own list, which a concurrent writer would otherwise change
// between our read and our write). It returns { list } or { skip, reason }.
async function writePlatformAddons(driver, connection, addons, source, prep = null) {
    const c = connection.credentials
    return enqueuePlatformWrite(connection, async () => {
        let list = addons
        if (typeof prep === 'function') {
            const outcome = (await prep(addons)) || {}
            if (outcome.skip) return { skipped: true, reason: outcome.reason || 'prep-skip' }
            if (Array.isArray(outcome.list)) list = outcome.list
        }
        const prepared = (list || []).map(applyCustomMetadata)
        trace('reconciler', 'writePlatformAddons', { platform: connection.platform, source, count: prepared.length, urls: prepared.map(a => a.transportUrl || '') })
        if (connection.platform === 'stremio' && !isHydraOutbound(connection)) {
            if (!c?.authKey) { const e = new Error('Stremio credentials not loaded'); e.isAuthError = true; throw e }
            return driver.writeAddons(c.authKey, prepared)
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

    const shouldSkip = (accountId, connId) => {
        // A fresh client collection write means the hub is momentarily behind the platforms.
        const writes = fastify.clientCollectionWrites
        if (writes) {
            const last = Math.max(
                writes.get(accountId) || 0,
                writes.get('Bulk Op') || 0,
                writes.get('Profile Swap') || 0,
                writes.get('Clear All') || 0
            )
            if (Date.now() - last < 20000) return true
        }
        const state = getState(accountId, connId)
        if (state.status === 'expired') {
            // Auth errors get a LONG cooldown. Supabase bans IPs that hit auth too frequently.
            const timeSinceError = state.lastErrorAt ? Date.now() - state.lastErrorAt : Infinity
            if (timeSinceError < EXPIRED_RETRY_COOLDOWN_MS) return true
        }
        if (state.status === 'error' && state.consecutiveFailures >= BACKOFF_THRESHOLD) {
            if (state.skipCyclesRemaining > 0) {
                setState(accountId, connId, { ...state, skipCyclesRemaining: state.skipCyclesRemaining - 1 })
                return true
            }
        }
        return false
    }

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

        if ((canonical.length === 0 && !opts.allowCollectionShrink) || targetConnections.length === 0) {
            trace('reconciler', 'reconcileAccount.complete', { accountId, skipped: true, reason: targetConnections.length === 0 ? 'no-targets' : 'empty-canonical', timing: Date.now() - start })
            return { changes: [], canonical }
        }

        const canonicalUrlSet = new Set(canonical.map(a => normalizeUrl(a.transportUrl)))
        const canonicalManifestByUrl = new Map(
            canonical.map(a => [normalizeUrl(a.transportUrl), manifestSignature(a.manifest)])
        )
        const customNameByUrl = new Map(
            canonical
                .filter(a => a?.metadata?.customName)
                .map(a => [normalizeUrl(a.transportUrl), a.metadata.customName])
        )
        const changes = []

        for (const connection of targetConnections) {
            const connId = connection.id
            if (shouldSkip(accountId, connId)) {
                fastify.log.debug({ category: 'Reconciler' }, `[${accountId}] Skipping ${connection.platform} (${connId}): in backoff`)
                continue
            }

            try {
                const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
                if (!driver) continue

                let needsWrite = true
                try {
                    const platformAddons = await readPlatformAddons(driver, connection)
                    const platformUrlSet = new Set(platformAddons.map(a => normalizeUrl(a.transportUrl || a.url)))
                    const sameUrls = platformUrlSet.size === canonicalUrlSet.size && [...canonicalUrlSet].every(u => platformUrlSet.has(u))
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
                            const canonicalManifest = canonicalManifestByUrl.get(url)
                            if (canonicalManifest === undefined) return false
                            if (!p.manifest) return false
                            return manifestSignature(p.manifest) !== canonicalManifest
                        })
                        needsWrite = nameMismatch || manifestMismatch
                    }
                } catch { /* can't read, assume needs write */ }

                if (needsWrite) {
                    await writePlatformAddons(driver, connection, canonical, 'reconcile')
                    changes.push({ type: 'restore', url: '', platform: connection.platform, primary: false })
                }
                recordSuccess(accountId, connId)
            } catch (err) {
                recordFailure(accountId, connId, err, err.isAuthError)
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] ${connection.platform} push failed: ${err.message}`)
            }
        }

        trace('reconciler', 'reconcileAccount.complete', { accountId, changes: changes.length, platforms: changes.map(c => c.platform), timing: Date.now() - start })
        return { changes, canonical }
    }

    const enforceAccount = async (accountId, connections, canonical, opts = {}) => {
        const { stremioWriter, requiredUrls, requiredActiveUrl } = opts
        tickCycleCounter(accountId)
        const canon = (Array.isArray(canonical) ? canonical : []).filter(a => a?.flags?.enabled !== false)
        const start = Date.now()
        trace('reconciler', 'enforceAccount.start', { accountId, canonicalCount: canon.length })
        const synced = []

        // Chain guard (spec F2): an enforced list that would drop every managed
        // chain member (all disabled -> "neither installed") or lose the active
        // tier must never reach a platform. Computed once, after the enabled
        // filter: survivors are chain URLs actually present-and-enabled in canon.
        // Skip means NO write, NO recordSuccess (arming the fresh-in-sync guard
        // with an unwritten list would poison it), NO recordFailure (a data
        // problem must not back off the connection).
        const managedChains = Array.isArray(opts.managedChains) && opts.managedChains.length > 0
            ? opts.managedChains
            : (Array.isArray(requiredUrls) && requiredUrls.length > 0 ? [{ urls: requiredUrls, target: requiredActiveUrl }] : [])
        let chainGuardSkipped = false
        {
            const failure = chainGuardFailure(canon, managedChains)
            if (failure) {
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Chain guard: enforced list drops a managed chain (${failure}); skipping write.`)
                trace('reconciler', 'enforceAccount.chainGuard', { accountId, chains: managedChains.length, failure })
                return { synced: [], connectionStates: getConnectionStates(accountId), chainGuardSkipped: true }
            }
        }

        for (const connection of (connections || []).filter(c => c.enabled)) {
            const connId = connection.id
            if (shouldSkip(accountId, connId)) {
                fastify.log.debug({ category: 'Reconciler' }, `[${accountId}] Skipping ${connection.platform} (${connId}): in backoff`)
                continue
            }
            try {
                // A client-side Stremio writer takes priority; without one the server driver
                // writes Stremio itself (it holds the authKey), so an API-driven enforce —
                // e.g. an AIOMetadata "sync to all" push — can never silently skip Stremio.
                if (connection.platform === 'stremio' && !isHydraOutbound(connection) && stremioWriter) {
                    await stremioWriter(connection)
                } else {
                    if (canon.length === 0) continue
                    const driver = await loadDriver(connection.platform, connection.credentials || {}, connection)
                    if (!driver) continue
                    const outcome = await writePlatformAddons(driver, connection, canon, 'enforce', async (list) => {
                        const merged = await reconcileForeignChains(driver, connection, list, requiredUrls, opts.foreignChainUrls)
                        const failure = chainGuardFailure(merged, managedChains)
                        if (failure) {
                            fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Chain guard: merged list would drop a managed chain (${failure}); skipping write.`)
                            return { skip: true, reason: failure }
                        }
                        return { list: merged }
                    })
                    if (outcome && outcome.skipped) { chainGuardSkipped = true; continue }
                }
                recordSuccess(accountId, connId)
                synced.push(connection.platform)
            } catch (err) {
                recordFailure(accountId, connId, err, err.isAuthError)
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] ${connection.platform} push failed: ${err.message}`)
            }
        }

        trace('reconciler', 'enforceAccount.complete', { accountId, synced, timing: Date.now() - start })
        return { synced, connectionStates: getConnectionStates(accountId), chainGuardSkipped }
    }

    // Nuvio instances that reject the optional plugins table; skip after the first 401
    const nuvioPluginsUnsupported = new Set()

    const reconcilePlugins = async (accountId, connection) => {
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
                await driver.writePlugins(
                    connection.credentials.accessToken,
                    canonicalPlugins,
                    connection.credentials.profileId
                )
            }
            recordSuccess(accountId, connection.id)
        } catch (err) {
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

    return {
        reconcileAccount,
        enforceAccount,
        reconcilePlugins,
        auditConnections,
        resolveConnections,
        getConnectionStates,
        recordSuccess,
        recordFailure,
        getState
    }
}
