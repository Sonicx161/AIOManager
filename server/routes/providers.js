import { verifyAuth } from '../auth.js'
import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { isSafeUrlResolved } from '../utils/ssrf.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { applyOneActiveFlags } from '../autopilot/one-active.js'
import { listStremioCredentialedAccountIds, stremioCredentialVersion } from '../lib/stremio-credentials.js'
import { mapNuvioLoginError, nuvioDriverFrom } from './nuvio-route-helpers.js'

// An authenticated user "owns" an accountId iff they have a stored credential or canonical row for
// it. Used to reject cross-tenant access (the sync/status endpoints take an accountId from the URL,
// which is otherwise unscoped). Unowned -> the caller has nothing to sync/read, so endpoints return
// the empty success shape rather than a 403 (no account-existence oracle, and it can't break a
// first sync, since an account with no stored credentials has nothing for the server to reconcile).
async function accountBelongsTo(accountId, syncUser) {
    if (!accountId || !syncUser) return false
    const cred = await db.get(
        'SELECT 1 AS ok FROM server_credentials WHERE account_id = $1 AND sync_user = $2 LIMIT 1',
        [accountId, syncUser]
    )
    if (cred) return true
    const canon = await db.get(
        'SELECT 1 AS ok FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2 LIMIT 1',
        [accountId, syncUser]
    )
    return Boolean(canon)
}

export function registerProviderRoutes(fastify, reconciler) {
    // Spec F3 (managed-chain blindness): an active automatic rule's chain members
    // are engine-owned. A client-driven reconcile must neither drop them nor
    // re-flag them from the client's local copy: non-chain client changes flow
    // through, chain members are re-derived from the rules' stored state. Rules
    // scope by owner (multi-tenant table) and by connection (born-global rules
    // govern every connection, matching engine.js's cross-platform propagation).
    async function loadManagedChainRules(accountId, authUser, connectionIds) {
        const ids = [...new Set((connectionIds || []).filter(Boolean))]
        const scopeSql = ids.length > 0
            ? `(connection_id IS NULL OR connection_id IN (${ids.map((_, i) => `$${i + 3}`).join(',')}))`
            : 'connection_id IS NULL'
        const rows = await db.query(
            `SELECT id, priority_chain, addon_list, active_url FROM autopilot_rules
             WHERE account_id = $1 AND owner_sync_user = $2 AND is_active = 1 AND is_automatic = 1 AND ${scopeSql}
             ORDER BY id ASC`,
            [accountId, authUser, ...ids]
        )
        const rules = []
        for (const row of rows || []) {
            let chain = null
            let storedList = []
            let activeUrl = null
            try {
                if (row.priority_chain) {
                    const decryptedChain = decrypt(row.priority_chain, FALLBACK_KEYS)
                    if (!decryptedChain) throw new Error('priority_chain blob present but unreadable')
                    chain = JSON.parse(decryptedChain)
                }
                if (row.addon_list) {
                    const decryptedList = decrypt(row.addon_list, FALLBACK_KEYS)
                    if (!decryptedList) throw new Error('addon_list blob present but unreadable')
                    const parsed = JSON.parse(decryptedList)
                    if (Array.isArray(parsed)) storedList = parsed
                }
                if (row.active_url) {
                    activeUrl = decrypt(row.active_url, FALLBACK_KEYS)
                    if (!activeUrl) throw new Error('active_url blob present but unreadable')
                }
            } catch (err) {
                // Fail closed: a rule whose state cannot be read cannot have its chain
                // protected, so no unprotected list may be pushed either.
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Automatic rule ${row.id} has unreadable state (${err.message}); skipping the reconcile write for chain protection.`)
                return { rules: null, failClosed: true }
            }
            if (!Array.isArray(chain) || chain.length === 0) {
                fastify.log.warn({ category: 'Reconciler' }, `[${accountId}] Automatic rule ${row.id} has no usable priority chain; skipping the reconcile write for chain protection.`)
                return { rules: null, failClosed: true }
            }
            rules.push({ ruleId: row.id, chain, storedList, activeUrl: activeUrl || chain[0] })
        }
        return { rules, failClosed: false }
    }

    function applyManagedChainOverlay(clientAddons, matchedRules) {
        const chainUrlSet = new Set()
        for (const rule of matchedRules) {
            for (const url of rule.chain) chainUrlSet.add(normalizeAddonUrl(url))
        }
        const base = (clientAddons || []).filter(a => a && !chainUrlSet.has(normalizeAddonUrl(a.transportUrl)))
        // Union of chains across ALL matched rules; the first rule (stable id order)
        // to claim a URL wins a multi-rule overlap.
        const claimed = new Map()
        for (const rule of matchedRules) {
            const derived = applyOneActiveFlags(rule.storedList, rule.chain, rule.activeUrl)
            const normalizedActive = normalizeAddonUrl(rule.activeUrl)
            for (const url of rule.chain) {
                const norm = normalizeAddonUrl(url)
                if (claimed.has(norm)) continue
                const member = derived.list.find(a => normalizeAddonUrl(a.transportUrl) === norm)
                claimed.set(norm, member ?? { transportUrl: url, flags: { enabled: norm === normalizedActive } })
            }
        }
        return [...base, ...claimed.values()]
    }

    fastify.post('/api/providers/sync/:accountId', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { accountId } = request.params
        const { primaryConnectionId, connections, addons, allowCollectionShrink } = request.body || {}

        if (!(await accountBelongsTo(accountId, authUser))) {
            return { synced: true, changes: [], connectionStates: {} }
        }

        try {
            const clientConnections = Array.isArray(connections)
                ? connections.filter(c => c && c.id).map(c => ({ ...c, syncUser: authUser }))
                : null
            const resolvedConnections = (clientConnections && clientConnections.length > 0)
                ? clientConnections
                : await reconciler.resolveConnections(accountId, authUser)

            if (!resolvedConnections || resolvedConnections.length === 0) {
                return { synced: true, changes: [], connectionStates: {} }
            }

            // Managed-chain overlay (spec F3). Skipped for empty/absent client
            // lists: today's empty-canonical guard already makes those no-ops, and
            // overlaying chain-only content would replace the platform list with
            // just the active tier, dropping every non-chain platform addon.
            let effectiveAddons = addons
            let overlayBlocked = false
            if (Array.isArray(addons) && addons.length > 0) {
                const overlay = await loadManagedChainRules(accountId, authUser, resolvedConnections.map(c => c.id))
                if (overlay.failClosed) {
                    overlayBlocked = true
                } else if (overlay.rules.length > 0) {
                    effectiveAddons = applyManagedChainOverlay(addons, overlay.rules)
                }
            }

            const result = overlayBlocked
                ? { changes: [], canonical: [] }
                : await reconciler.reconcileAccount(
                    accountId,
                    primaryConnectionId,
                    resolvedConnections,
                    effectiveAddons,
                    { allowCollectionShrink: allowCollectionShrink === true }
                )

            if (result.changes.length > 0) {
                fastify.log.info({ category: 'Reconciler' }, `[${accountId}] Reconciled: ${result.changes.length} changes`)
            }

            for (const conn of resolvedConnections.filter(c => c.platform === 'nuvio')) {
                await reconciler.reconcilePlugins(accountId, conn)
            }

            const states = reconciler.getConnectionStates(accountId)

            return {
                synced: true,
                changes: result.changes,
                connectionStates: states
            }
        } catch (err) {
            fastify.log.error({ category: 'Reconciler' }, `[${accountId}] Sync failed: ${err.message}`)
            reply.code(500)
            return { error: 'Sync failed' }
        }
    })

    fastify.get('/api/providers/status/:accountId', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { accountId } = request.params
        if (!(await accountBelongsTo(accountId, authUser))) {
            return { connectionStates: {} }
        }
        const states = reconciler.getConnectionStates(accountId)
        return { connectionStates: states }
    })

    fastify.get('/api/providers/subscribers/:accountId', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { accountId } = request.params
        const rows = await db.query(
            'SELECT name, logo, created_at, last_seen_at FROM hydra_subscribers WHERE account_id = $1 AND sync_user = $2 ORDER BY last_seen_at DESC',
            [accountId, authUser]
        )
        return { subscribers: rows || [] }
    })

    fastify.delete('/api/providers/subscribers/:accountId', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { accountId } = request.params
        const { name } = request.body || {}
        if (!name) { reply.code(400); return { error: 'Missing name' } }

        await db.run(
            'DELETE FROM hydra_subscribers WHERE account_id = $1 AND sync_user = $2 AND name = $3',
            [accountId, authUser, name]
        )
        return { ok: true }
    })

    // Re-auth from a device that lacks the instance URL must never erase the row's stored
    // self-hosted baseUrl: a baseUrl-less bundle makes every server-side push target api.nuvio.tv.
    async function preserveExistingNuvioBaseUrl(connectionId, syncUser, credentialValue) {
        let incoming = null
        try { incoming = typeof credentialValue === 'string' ? JSON.parse(credentialValue) : credentialValue } catch { return credentialValue }
        if (!incoming || typeof incoming !== 'object' || incoming.baseUrl) return credentialValue
        const rows = await db.query(
            "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND sync_user = $2 AND credential_type = 'nuvio' ORDER BY updated_at DESC, id ASC",
            [connectionId, syncUser]
        )
        for (const existing of rows || []) {
            if (!existing?.auth_key) continue
            try {
                const bundle = JSON.parse(decrypt(existing.auth_key, FALLBACK_KEYS))
                if (bundle?.baseUrl) {
                    incoming = { ...incoming, baseUrl: bundle.baseUrl }
                    if (!incoming.publishableKey && bundle.publishableKey) incoming.publishableKey = bundle.publishableKey
                    return JSON.stringify(incoming)
                }
            } catch { }
        }
        return credentialValue
    }

    fastify.post('/api/providers/connections/:connectionId/credentials', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { connectionId } = request.params
        const { accountId, credential, credentialType } = request.body || {}
        if (!accountId || !credential) { reply.code(400); return { error: 'Missing accountId or credential' } }

        let credObj = null
        if (typeof credential === 'object') credObj = credential
        else if (typeof credential === 'string') { try { credObj = JSON.parse(credential) } catch { } }
        if (credObj && typeof credObj === 'object' && credObj.baseUrl && !(await isSafeUrlResolved(credObj.baseUrl))) {
            reply.code(400); return { error: 'Invalid or unsafe baseUrl' }
        }

        const type = ['nuvio', 'realstream', 'hydra'].includes(credentialType) ? credentialType : 'hydra'
        let credentialValue = typeof credential === 'object' ? JSON.stringify(credential) : credential
        if (type === 'nuvio') {
            credentialValue = await preserveExistingNuvioBaseUrl(connectionId, authUser, credentialValue)
        }
        const encrypted = encrypt(credentialValue, PRIMARY_KEY)
        const id = `${type}:${accountId}:${connectionId}`

        const existing = await db.get('SELECT sync_user FROM server_credentials WHERE id = $1', [id])
        if (existing && existing.sync_user !== authUser) {
            reply.code(403); return { error: 'Forbidden' }
        }

        if (db.type === 'postgres') {
            await db.run(`
                INSERT INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (id) DO UPDATE SET auth_key = $4, credential_type = $6, updated_at = $7
            `, [id, authUser, accountId, encrypted, connectionId, type, Date.now()])
        } else {
            await db.run(`
                INSERT OR REPLACE INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [id, authUser, accountId, encrypted, connectionId, type, Date.now()])
        }
        const { invalidateConnectionCache } = await import('../providers/reconciler.js')
        invalidateConnectionCache(authUser)

        return { ok: true }
    })

    fastify.delete('/api/providers/connections/:connectionId/credentials', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { connectionId } = request.params
        await db.run(
            'DELETE FROM server_credentials WHERE connection_id = $1 AND sync_user = $2',
            [connectionId, authUser]
        )
        const { invalidateConnectionCache } = await import('../providers/reconciler.js')
        invalidateConnectionCache(authUser)
        return { ok: true }
    })

    // Vends a fresh Nuvio access token to the client. The server is the single owner of the
    // rotating refresh token (refreshNuvioToken is single-flighted), so client push + failover
    // never double-rotate it.
    fastify.post('/api/providers/connections/:connectionId/token', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { connectionId } = request.params
        const { accountId, platform, baseUrl } = request.body || {}
        if (!accountId || !['nuvio', 'realstream'].includes(platform)) { reply.code(400); return { error: 'Missing accountId or unsupported platform' } }
        if (baseUrl && typeof baseUrl === 'string' && !(await isSafeUrlResolved(baseUrl))) {
            reply.code(400); return { error: 'Invalid or unsafe baseUrl' }
        }

        if (platform === 'nuvio') {
            try {
                const owned = await db.get(
                    "SELECT 1 FROM server_credentials WHERE connection_id = $1 AND sync_user = $2 AND credential_type = 'nuvio' LIMIT 1",
                    [connectionId, authUser]
                )
                if (!owned) { reply.code(404); return { error: 'Connection not found' } }

                const { refreshNuvioToken } = await import('../providers/token-refresh.js')
                const bundle = await refreshNuvioToken(connectionId, accountId, { baseUrl: typeof baseUrl === 'string' && baseUrl ? baseUrl : undefined }, authUser)
                if (!bundle?.accessToken) { reply.code(401); return { error: 'Nuvio session expired, re-authenticate' } }
                return { accessToken: bundle.accessToken, expiresAt: bundle.expiresAt, profileId: bundle.profileId ?? null }
            } catch (err) {
                if (err.isAuthError || err._authExpired) { reply.code(401); return { error: 'Nuvio session expired, re-authenticate' } }
                fastify.log.error({ err, connectionId, accountId, category: 'ConnectionToken' }, `Nuvio token fetch failed: ${err.message}`)
                reply.code(502); return { error: 'Nuvio token refresh failed' }
            }
        }

        // RealStream: server owns custody — refresh via PocketBase auth-refresh, falling back to
        // full re-authentication using the stored email+password if the token has fully expired.
        try {
            const owned = await db.get(
                "SELECT 1 FROM server_credentials WHERE connection_id = $1 AND sync_user = $2 AND credential_type = 'realstream' LIMIT 1",
                [connectionId, authUser]
            )
            if (!owned) { reply.code(404); return { error: 'Connection not found' } }

            const { refreshRealStreamToken } = await import('../providers/token-refresh.js')
            const bundle = await refreshRealStreamToken(connectionId, authUser)
            if (!bundle?.accessToken) { reply.code(401); return { error: 'RealStream session expired, re-authenticate' } }
            return { accessToken: bundle.accessToken, expiresAt: bundle.expiresAt, profileId: null }
        } catch (err) {
            if (err.isAuthError || err._authExpired) { reply.code(401); return { error: 'RealStream session expired, re-authenticate' } }
            fastify.log.error({ err, connectionId, accountId, category: 'ConnectionToken' }, `RealStream token fetch failed: ${err.message}`)
            reply.code(502); return { error: 'RealStream token refresh failed' }
        }
    })

    // Switches which Nuvio profile a connection syncs to. Updates only profileId in the stored
    // bundle, never the rotating tokens, so a client switch can't clobber a server-rotated token.
    fastify.post('/api/providers/connections/:connectionId/profile', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { connectionId } = request.params
        const { profileId } = request.body || {}
        if (!profileId || typeof profileId !== 'string') { reply.code(400); return { error: 'Missing profileId' } }

        const cred = await db.get(
            "SELECT auth_key FROM server_credentials WHERE connection_id = $1 AND sync_user = $2 AND credential_type = 'nuvio' LIMIT 1",
            [connectionId, authUser]
        )
        if (!cred?.auth_key) { reply.code(404); return { error: 'Connection not found' } }

        let bundle
        try { bundle = JSON.parse(decrypt(cred.auth_key, FALLBACK_KEYS)) } catch { reply.code(500); return { error: 'Could not read connection credential' } }

        bundle.profileId = profileId
        const encrypted = encrypt(JSON.stringify(bundle), PRIMARY_KEY)
        const result = await db.run(
            "UPDATE server_credentials SET auth_key = $1, updated_at = $2 WHERE connection_id = $3 AND sync_user = $4 AND credential_type = 'nuvio' AND auth_key = $5",
            [encrypted, Date.now(), connectionId, authUser, cred.auth_key]
        )
        const rowsAffected = result.changes
        if (rowsAffected === 0) {
            reply.code(409)
            return { error: 'Conflict', message: 'Profile was updated by another operation. Please retry.' }
        }
        const { invalidateConnectionCache } = await import('../providers/reconciler.js')
        invalidateConnectionCache(authUser)
        return { ok: true }
    })

    // One-click account backup: proxies the Nuvio account-export RPC and sends the raw export
    // JSON as the response body (the client downloads it directly).
    fastify.post('/api/providers/nuvio/backup-export', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { accountId, connectionId } = request.body || {}
        if (!accountId || !connectionId) { reply.code(400); return { error: 'Missing accountId or connectionId' } }

        const owned = await db.get(
            "SELECT 1 FROM server_credentials WHERE connection_id = $1 AND sync_user = $2 AND credential_type = 'nuvio' LIMIT 1",
            [connectionId, authUser]
        )
        if (!owned) { reply.code(404); return { error: 'Connection not found' } }

        try {
            const { refreshNuvioToken } = await import('../providers/token-refresh.js')
            const bundle = await refreshNuvioToken(connectionId, accountId, undefined, authUser)
            if (!bundle?.accessToken) { reply.code(401); return { error: 'Nuvio session expired, re-authenticate' } }

            // Security: exports read a stored credential, so the driver comes from the stored bundle only — client baseUrl/publishableKey would let the caller steer the exfil target.
            const { createNuvioDriver } = await import('../providers/nuvio-driver.js')
            const driver = createNuvioDriver({
                baseUrl: bundle.baseUrl || undefined,
                publishableKey: bundle.publishableKey || undefined,
            })
            return reply.send(await driver.exportAccountBackup(bundle.accessToken))
        } catch (err) {
            if (err.isAuthError || err._authExpired) { reply.code(401); return { error: 'Nuvio session expired, re-authenticate' } }
            fastify.log.error({ err, connectionId, accountId, category: 'NuvioBackup' }, `Nuvio backup export failed: ${err.message}`)
            reply.code(502)
            return { error: 'Nuvio backup export failed' }
        }
    })

    fastify.post('/api/providers/nuvio/auth', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { email, password, baseUrl } = request.body || {}
        if (!email || !password) { reply.code(400); return { error: 'Missing email or password' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const driver = await nuvioDriverFrom(request.body)
            const tokens = await driver.authenticate(email, password)
            let profiles = []
            try {
                profiles = await driver.pullProfiles(tokens.accessToken)
            } catch { }
            return { tokens, profiles: Array.isArray(profiles) ? profiles : [] }
        } catch (err) {
            return mapNuvioLoginError(reply, err, {
                authMessage: 'Invalid email or password',
                timeoutMessage: 'Nuvio login timed out. Supabase may be cold-starting. Please try again in a few seconds.'
            })
        }
    })

    // TV QR login step 1: the anonToken is returned so clients reuse it for polls (anon grants are rate-limited upstream).
    fastify.post('/api/providers/nuvio/qr/start', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { deviceNonce, deviceName, baseUrl } = request.body || {}
        if (!deviceNonce) { reply.code(400); return { error: 'Missing deviceNonce' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const driver = await nuvioDriverFrom(request.body)
            const anonToken = await driver.getAnonymousToken()
            // Nuvio allowlists redirect base URLs; only their own tv-login page is a known-valid
            // target, so client-provided origins are ignored (they can never pass validation).
            const session = await driver.startTvLoginSession({ deviceNonce, redirectBaseUrl: 'https://nuvio.tv/tv-login', deviceName: deviceName || 'AIOManager' }, anonToken)
            if (!session?.code) { reply.code(502); return { error: 'Nuvio did not return a login session' } }
            return {
                code: session.code,
                qrContent: session.qr_content,
                qrImageUrl: session.qr_image_url ?? null,
                webUrl: session.web_url,
                expiresAt: session.expires_at,
                pollIntervalSeconds: session.poll_interval_seconds ?? 5,
                anonToken
            }
        } catch (err) {
            return mapNuvioLoginError(reply, err, { authMessage: 'Could not start Nuvio TV login' })
        }
    })

    // TV QR login step 2: polls with the client's anonToken; anon JWTs expire mid-flow, so refetch exactly once on 401.
    fastify.post('/api/providers/nuvio/qr/poll', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { code, deviceNonce, anonToken, baseUrl } = request.body || {}
        if (!code || !deviceNonce) { reply.code(400); return { error: 'Missing code or deviceNonce' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const driver = await nuvioDriverFrom(request.body)

            let token = anonToken || await driver.getAnonymousToken()
            try {
                return { status: await driver.pollTvLoginSession({ code, deviceNonce }, token) }
            } catch (err) {
                if (!err.isAuthError || !anonToken) throw err
                token = await driver.getAnonymousToken()
                return { status: await driver.pollTvLoginSession({ code, deviceNonce }, token) }
            }
        } catch (err) {
            return mapNuvioLoginError(reply, err, { authMessage: 'Could not poll Nuvio TV login', sessionAware: true })
        }
    })

    // TV QR login step 3: swaps the approved code for tokens; response shape mirrors nuvio/auth.
    fastify.post('/api/providers/nuvio/qr/exchange', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { code, deviceNonce, baseUrl } = request.body || {}
        if (!code || !deviceNonce) { reply.code(400); return { error: 'Missing code or deviceNonce' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const driver = await nuvioDriverFrom(request.body)
            const { accessToken, refreshToken, expiresAt } = await driver.exchangeTvLogin({ code, deviceNonce })
            let profiles = []
            try {
                profiles = await driver.pullProfiles(accessToken)
            } catch { }
            return { tokens: { accessToken, refreshToken, expiresAt }, profiles: Array.isArray(profiles) ? profiles : [] }
        } catch (err) {
            return mapNuvioLoginError(reply, err, { authMessage: 'Login session expired or already used', sessionAware: true })
        }
    })

    fastify.post('/api/providers/realstream/auth', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { email, password, baseUrl } = request.body || {}
        if (!email || !password) { reply.code(400); return { error: 'Missing email or password' } }

        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const { createRealStreamDriver } = await import('../providers/realstream-driver.js')
            const driver = createRealStreamDriver(baseUrl ? { baseUrl } : {})
            const tokens = await driver.authenticate(email, password)
            // Password is NOT stored. Only the token bundle is returned for handoff.
            return { tokens }
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                reply.code(504)
                return { error: 'RealStream login timed out. Please try again in a few seconds.' }
            }
            if (err.status === 429) {
                reply.code(429)
                return { error: 'Too many login attempts. Please wait a few minutes before retrying.' }
            }
            const status = err.isAuthError ? 401 : 502
            reply.code(status)
            return { error: err.isAuthError ? 'Invalid email or password' : 'RealStream service unreachable' }
        }
    })

    fastify.post('/api/providers/nuvio/signup', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { email, password, publishableKey, baseUrl } = request.body || {}
        if (!email || !password) { reply.code(400); return { error: 'Missing email or password' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const { createNuvioDriver } = await import('../providers/nuvio-driver.js')
            const driver = createNuvioDriver({ ...(baseUrl ? { baseUrl } : {}), ...(publishableKey ? { publishableKey } : {}) })
            const tokens = await driver.register(email, password)
            let profiles = []
            try { profiles = await driver.pullProfiles(tokens.accessToken) } catch { }
            return { tokens, profiles: Array.isArray(profiles) ? profiles : [] }
        } catch (err) {
            if (err.needsConfirmation) { reply.code(202); return { error: err.message, needsConfirmation: true } }
            if (err.name === 'TimeoutError' || err.name === 'AbortError') { reply.code(504); return { error: 'Nuvio signup timed out. Please try again.' } }
            if (err.status === 429) { reply.code(429); return { error: 'Too many attempts. Please wait a few minutes.' } }
            const status = err.isAuthError ? 400 : 502
            reply.code(status)
            return { error: err.isAuthError ? (err.message || 'Could not create account') : 'Nuvio service unreachable' }
        }
    })

    fastify.post('/api/providers/realstream/signup', {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { email, password, name, baseUrl } = request.body || {}
        if (!email || !password) { reply.code(400); return { error: 'Missing email or password' } }
        if (baseUrl && !(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe baseUrl' } }

        try {
            const { createRealStreamDriver } = await import('../providers/realstream-driver.js')
            const driver = createRealStreamDriver(baseUrl ? { baseUrl } : {})
            const tokens = await driver.register(email, password, name)
            return { tokens }
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') { reply.code(504); return { error: 'RealStream signup timed out. Please try again.' } }
            if (err.status === 429) { reply.code(429); return { error: 'Too many attempts. Please wait a few minutes.' } }
            const status = err.isAuthError ? 400 : 502
            reply.code(status)
            return { error: err.isAuthError ? (err.message || 'Could not create account') : 'RealStream service unreachable' }
        }
    })

    fastify.post('/api/providers/hydra/test', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const { baseUrl, authType, authHeader, authValue } = request.body || {}
        if (!baseUrl || typeof baseUrl !== 'string') { reply.code(400); return { error: 'Missing baseUrl' } }

        if (!(await isSafeUrlResolved(baseUrl))) { reply.code(400); return { error: 'Invalid or unsafe URL' } }

        try {
            const { createHydraClient } = await import('../hydra/client.js')
            const client = await createHydraClient({ baseUrl, authType, authHeader, authValue })
            const status = await client.status()
            return status
        } catch (err) {
            reply.code(502)
            return { error: err.message || 'Provider unreachable' }
        }
    })

    fastify.get('/api/providers/canonical', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.code(401); return { error: 'Unauthorized' } }

        const version = await db.get(
            'SELECT COUNT(*) AS n, MAX(updated_at) AS max_ts FROM account_canonical_addons WHERE sync_user = $1',
            [authUser]
        )
        // The response also tells the client which accounts the server can read via a
        // server-side Stremio credential (those are excluded from client canonical pushes),
        // so the ETag must cover credential changes too or a 304 would pin a stale set.
        // Deliberately Stremio-scoped: Nuvio/RealStream credentials never gate canonical
        // membership, and their access tokens are auto-refreshed server-side — including
        // them would bust every client's cache on each token rotation for no semantic change.
        const credVersion = await stremioCredentialVersion(authUser)
        const etag = `canonical:${authUser}:${version?.n || 0}:${version?.max_ts || 0}:${credVersion?.n || 0}:${credVersion?.max_ts || 0}`
        if (request.headers['if-none-match'] === etag) {
            reply.status(304)
            reply.header('ETag', etag)
            return reply.send()
        }

        const rows = await db.query(
            'SELECT account_id, addon_list, updated_at FROM account_canonical_addons WHERE sync_user = $1',
            [authUser]
        )
        const canonical = {}
        for (const row of rows) {
            let addons = []
            if (row.addon_list) {
                const decrypted = decrypt(row.addon_list, FALLBACK_KEYS)
                if (decrypted) {
                    try {
                        const parsed = JSON.parse(decrypted)
                        if (Array.isArray(parsed)) addons = parsed
                    } catch { }
                }
            }
            canonical[row.account_id] = { addons, updatedAt: row.updated_at || 0 }
        }
        reply.header('ETag', etag)
        return { canonical, serverStremioCredentialedAccounts: await listStremioCredentialedAccountIds(authUser) }
    })
}
