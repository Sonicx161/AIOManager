import { createHash } from 'node:crypto'
import db from '../db.js'
import { hashApiKey } from '../api-keys.js'
import { isSafeUrl, isSafeUrlResolved } from '../utils/ssrf.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { VERSION } from '../config.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { guardedResilientFetch, guardedWebFetch } from '../utils/safe-fetch.js'
import { writeEncryptedIfChanged } from '../db-guards.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { normalizeHydraAddonInput } from '../utils/addon-shape.js'
import { isExcludedFromDestinations } from '../utils/addon-destinations.js'
import { getLatestStremioCredential, resolveStremioConnectionIdentity } from '../lib/stremio-credentials.js'
import { invalidateCanonicalAddons, readCanonicalCached, rememberCanonicalAuthKey } from '../hydra/canonical-cache.js'
import { addonActionUrlKey, recordAddonActions, withHydraAccountLock, withHydraFanoutLock } from '../lib/addon-actions.js'
import { isReadOnlyReplica } from '../config.js'
import { assertAccountActive, assertWritablePrimary, ownerCanWriteOrFail, AuthStateError, StateUnavailableError, ReadOnlyReplicaError } from '../admin/account-state.js'

const HYDRA_SPEC_VERSION = '1.0.0'
const MAX_ADDON_URL_LENGTH = 2048
const MAX_ADDONS_IN_COLLECTION = 500
const LAST_USED_COALESCE_MS = 60_000

let logger = console

const isValidAddonUrl = (url) =>
    typeof url === 'string' &&
    url.length <= MAX_ADDON_URL_LENGTH &&
    isSafeUrl(url)

const isValidLogoUrl = (url) =>
    typeof url === 'string' &&
    url.length <= MAX_ADDON_URL_LENGTH &&
    isSafeUrl(url)

async function lookupAccountByApiKey(request, reply) {
    const rawKey = request.headers['x-api-key']
    if (!rawKey || typeof rawKey !== 'string') {
        reply.code(401).send({ error: 'unauthorized', message: 'Missing X-API-Key header' })
        return null
    }

    const keyHash = hashApiKey(rawKey)
    const row = await db.get(
        'SELECT account_id, sync_user, last_used_at FROM account_api_keys WHERE api_key_hash = $1',
        [keyHash]
    )
    if (!row) {
        reply.code(401).send({ error: 'unauthorized', message: 'Invalid API key' })
        return null
    }

    // Account state gate: after the key resolves its owner, before any use of the row.
    await assertAccountActive(row.sync_user)

    const now = Date.now()
    // A replica never writes, not even best-effort telemetry, against the follower.
    if (!isReadOnlyReplica() && (!row.last_used_at || now - row.last_used_at >= LAST_USED_COALESCE_MS)) {
        db.run(
            'UPDATE account_api_keys SET last_used_at = $1 WHERE api_key_hash = $2',
            [now, keyHash]
        ).catch(() => {})
    }

    return row
}

// syncUser comes from the API-key lookup, not the request. Every query is scoped to it so a key
// maliciously registered against another user's accountId (account_api_keys is populated from the
// client sync blob) resolves only to the key owner's own data -- never the victim's credentials,
// canonical store, or autopilot rule.

// Hydra consumers poll version/addons frequently; GETs go through the in-memory cache in
// server/hydra/canonical-cache.js. Local Stremio writes (sync push, canonical write, proxy,
// reconciler, autopilot) bust it. Mutation routes always take a fresh read.
export { invalidateCanonicalAddons }

const STREMIO_READ_TIMEOUT_MS = 10_000

function withTimeout(promise, ms, message) {
    let timer
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
    ]).finally(() => clearTimeout(timer))
}

function getCanonicalAddonsCached(accountId, syncUser) {
    return readCanonicalCached(accountId, syncUser, () => getCanonicalAddons(accountId, syncUser))
}

// Mutations build a full-replace from this, so a read failure must stop the write.
async function readFreshCanonical(account, reply) {
    try {
        return await getCanonicalAddons(account.account_id, account.sync_user)
    } catch {
        reply.code(503).header('Retry-After', '30')
        return null
    }
}

const UNAVAILABLE = { error: 'unavailable', message: 'Could not read the current addon collection. Try again shortly.' }

async function getCanonicalAddons(accountId, syncUser) {
    // Stremio accounts are served Stremio-first (the most mature path). Filter to the Stremio
    // credential so a Nuvio/Hydra credential row doesn't get mis-used as a Stremio authKey.
    const cred = await getLatestStremioCredential(accountId, syncUser)
    if (cred?.auth_key) {
        const mixed = await db.get(
            "SELECT 1 FROM server_credentials WHERE account_id = $1 AND sync_user = $2 AND credential_type IN ('nuvio', 'realstream', 'hydra') LIMIT 1",
            [accountId, syncUser]
        )
        if (mixed) {
            logger.warn({ category: 'Hydra' }, `[${accountId}] Account has both Stremio and non-Stremio credentials; inbound reads prefer Stremio and may not reflect the non-Stremio setup.`)
        }
        // Fail closed: a decrypt or read failure must never fall through to a stale
        // canonical row, an autopilot snapshot or [].
        const authKey = decrypt(cred.auth_key, FALLBACK_KEYS)
        if (!authKey) throw new Error('Failed to decrypt credentials')
        rememberCanonicalAuthKey(authKey, accountId, syncUser)
        const { createStremioDriver } = await import('../providers/stremio-driver.js')
        const driver = createStremioDriver()
        const addons = await withTimeout(driver.readAddons(authKey), STREMIO_READ_TIMEOUT_MS, 'Stremio read timed out')
        if (!Array.isArray(addons)) throw new Error('Stremio read returned no collection')
        return addons
    }

    // Hub canonical: the inbound source for accounts the server can't read via Stremio
    // (Nuvio-only / local-only). Written by the client on sync (account_canonical_addons).
    // An empty array here is authoritative: the Hub genuinely has no addons.
    const canonical = await db.get(
        'SELECT addon_list FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2',
        [accountId, syncUser]
    )
    if (canonical?.addon_list) {
        const decrypted = decrypt(canonical.addon_list, FALLBACK_KEYS)
        if (decrypted) {
            try {
                const parsed = JSON.parse(decrypted)
                if (Array.isArray(parsed)) return parsed
            } catch {}
        }
    }

    const rules = await db.query(
        'SELECT addon_list FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 AND is_active = 1 ORDER BY updated_at DESC LIMIT 1',
        [accountId, syncUser]
    )
    if (rules.length > 0 && rules[0].addon_list) {
        const decrypted = decrypt(rules[0].addon_list, FALLBACK_KEYS)
        if (decrypted) {
            const parsed = JSON.parse(decrypted)
            if (Array.isArray(parsed) && parsed.length > 0) return parsed
        }
    }

    return []
}

function computeAddonsVersion(hydraAddons) {
    return createHash('sha256').update(JSON.stringify(hydraAddons)).digest('hex').slice(0, 16)
}

function toHydraAddon(raw) {
    const normalized = normalizeHydraAddonInput(raw)
    if (!normalized) return null
    return {
        transportUrl: normalized.transportUrl,
        id: normalized.manifest.id,
        name: normalized.manifest.name,
        version: normalized.manifest.version,
        logo: normalized.manifest.logo,
        enabled: normalized.flags.enabled,
        types: normalized.manifest.types,
        resources: normalized.manifest.resources
    }
}

const CANONICAL_ONLY_WARNING = 'Written to the AIOManager store only; changes propagate to your Stremio when a logged-in AIOManager client syncs.'

// Destination rules must be current for every external write. A TTL here could
// re-install an addon immediately after its owner excluded a destination.
async function loadCanonicalDestinations(accountId, syncUser) {
    const row = await db.get(
        'SELECT addon_list FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2',
        [accountId, syncUser]
    )
    const byUrl = new Map()
    if (!row?.addon_list) return byUrl
    const decrypted = decrypt(row.addon_list, FALLBACK_KEYS)
    if (!decrypted) throw new Error('Could not read the stored destination rules')
    const parsed = JSON.parse(decrypted)
    if (!Array.isArray(parsed)) throw new Error('Invalid stored addon collection')
    for (const addon of parsed) {
        const url = normalizeAddonUrl(addon?.transportUrl || '').toLowerCase()
        if (url && addon?.destinations) byUrl.set(url, addon.destinations)
    }
    return byUrl
}

function graftStoredDestinations(addons, policyByUrl) {
    if (!policyByUrl || policyByUrl.size === 0) return addons
    return (addons || []).map(a => {
        const url = normalizeAddonUrl(a?.transportUrl || a?.url || '').toLowerCase()
        if (!url || !policyByUrl.has(url)) return a
        return a?.destinations ? a : { ...a, destinations: policyByUrl.get(url) }
    })
}

const addonUrlKey = (a) => normalizeAddonUrl(a?.transportUrl || a?.url || '').toLowerCase()

// A proven alias is the same addon under url normalization (scheme, manifest.json suffix, trailing
// slash, case); a manifest-id match alone never qualifies, so it cannot lift a different config's tombstone.
const isProvenUrlAlias = (a, b) => {
    const aliasKey = (u) => addonActionUrlKey(u).replace(/^https?:\/\//, '')
    return aliasKey(a) !== '' && aliasKey(a) === aliasKey(b) && addonActionUrlKey(a) !== addonActionUrlKey(b)
}

function installEntries(postedUrl, matchedRow) {
    const entries = [{ url: postedUrl, action: 'install' }]
    const matchedUrl = matchedRow?.transportUrl || matchedRow?.url
    if (matchedUrl && isProvenUrlAlias(matchedUrl, postedUrl)) {
        entries.push({ url: matchedUrl, action: 'install' })
    }
    return entries
}

function nonEmptyFields(obj) {
    const out = {}
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === '' || v == null || (Array.isArray(v) && v.length === 0)) continue
        out[k] = v
    }
    return out
}

// Overlay a PUT row on the current row with the same URL. Only the manifest and the
// enabled flag come from the request.
function mergePutRows(addons, current) {
    const currentByUrl = new Map()
    for (const a of current || []) {
        const key = addonUrlKey(a)
        if (key && !currentByUrl.has(key)) currentByUrl.set(key, a)
    }
    return addons.map(raw => {
        const n = normalizeHydraAddonInput(raw)
        if (!n) return null
        const base = currentByUrl.get(addonUrlKey(n))
        const sentManifest = raw.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest) ? raw.manifest : {}
        return {
            ...(base || {}),
            transportUrl: n.transportUrl,
            manifest: { ...(base?.manifest || n.manifest), ...sentManifest, ...nonEmptyFields(n.manifest) },
            flags: { ...(base?.flags || {}), enabled: n.flags.enabled }
        }
    }).filter(Boolean)
}

async function stremioCredentialMode(accountId, syncUser) {
    const cred = await getLatestStremioCredential(accountId, syncUser)
    return cred?.auth_key ? 'stremio' : 'canonical'
}

function propagationFields(mode) {
    return mode === 'stremio'
        ? { propagatedTo: ['stremio'] }
        : { propagatedTo: [], warning: CANONICAL_ONLY_WARNING }
}

// addonActions: [{ url, action }] rows riding the canonical write's transaction.
async function writeCanonicalAddons(account, addons, addonActions = []) {
    const accountId = account.account_id
    const syncUser = account.sync_user || ''
    // Write boundary gates: entry, immediately before the Stremio platform write and
    // before the canonical store write, so a mid-request block performs neither.
    await assertAccountActive(syncUser)
    assertWritablePrimary()
    const cred = await getLatestStremioCredential(accountId, syncUser)

    // Stremio Hubs write through to Stremio (the mature path). Filter to the Stremio
    // credential so a Nuvio/Hydra cred isn't mis-used as a Stremio authKey. The same
    // bug class fixed on the read side in getCanonicalAddons. Scoped to sync_user so a
    // poisoned api-key mapping can't push to another user's Stremio collection.
    let stremioWriteThrough = false
    if (cred?.auth_key) {
        const mixed = await db.get(
            "SELECT 1 FROM server_credentials WHERE account_id = $1 AND sync_user = $2 AND credential_type IN ('nuvio', 'realstream', 'hydra') LIMIT 1",
            [accountId, syncUser]
        )
        if (mixed) {
            logger.warn({ category: 'Hydra' }, `[${accountId}] Account has both Stremio and non-Stremio credentials; inbound writes go to Stremio and may bypass the non-Stremio setup.`)
        }
        const authKey = decrypt(cred.auth_key, FALLBACK_KEYS)
        if (!authKey) throw new Error('Failed to decrypt credentials')
        // R8: NO Hydra bypass — the write-through enforces the canonical login's own
        // destination policy (platform-wide stremio entries AND the exact canonical
        // connection id resolved from the credential). Ambiguous identity fails
        // closed: fall through to the canonical-store path below rather than guess a
        // login or ship an unfiltered list.
        const identity = await resolveStremioConnectionIdentity(accountId, syncUser, authKey)
        const policyByUrl = await loadCanonicalDestinations(accountId, syncUser)
        const needsExactIdentity = [...policyByUrl.values()].some(policy => policy?.excludedConnections?.length > 0)
        if (identity.ambiguous || (identity.legacy && needsExactIdentity)) {
            logger.warn({ category: 'Hydra' }, `[${accountId}] Ambiguous canonical Stremio identity (several connection ids claim the account-level key); failing closed to the canonical store instead of a policy-blind Stremio write.`)
        } else {
            const target = { platform: 'stremio', connectionId: identity.connectionId }
            const excludedUrls = new Set()
            for (const [url, destinations] of policyByUrl) {
                if (isExcludedFromDestinations(destinations, target)) excludedUrls.add(url)
            }
            const kept = []
            for (const a of addons) {
                const url = normalizeAddonUrl(a?.transportUrl || a?.url || '').toLowerCase()
                if (url && excludedUrls.has(url)) continue
                kept.push(a)
            }
            if (kept.length === 0 && (addons || []).length > 0) {
                logger.info({ category: 'Hydra' }, `[${accountId}] Empty Stremio write-through authorized: every inbound addon is deliberately excluded by destination policy.`)
            }
            const { createStremioDriver } = await import('../providers/stremio-driver.js')
            const driver = createStremioDriver()
            // R9: the provider wire carries projected provider data only — strip the
            // internal destination policy before the driver. Stremio has no disabled
            // state, so a disabled row would land as installed.
            const wireRows = kept.filter(a => (a?.flags?.enabled ?? a?.enabled) !== false).map(a => {
                if (!a?.destinations) return a
                const { destinations, ...rest } = a
                return rest
            })
            try {
                await assertAccountActive(syncUser)
                await driver.writeAddons(authKey, wireRows)
            } finally {
                // A failed or timed-out Set may still have landed.
                invalidateCanonicalAddons(accountId, syncUser)
            }
            stremioWriteThrough = true
        }
    }
    if (stremioWriteThrough) {
        if (addonActions.length > 0) {
            await db.tx(tx => recordAddonActions(tx, { syncUser, accountId, entries: addonActions }))
        }
        return 'stremio'
    }

    // Non-Stremio Hub (Nuvio-only / local-only): the inbound write lands in the
    // server-readable canonical store. The client folds it into the Hub on its next
    // sync via a three-way merge; the server stays a dumb store, the client is the
    // single merger (D2). Midnight-safe: writeEncryptedIfChanged compares plaintext
    // and no-ops when unchanged. The row is upserted first so an inbound write to an
    // account the client has synced at least once always lands.
    await assertAccountActive(syncUser)
    const now = Date.now()
    // WHERE scoped to sync_user: if the row is owned by another user (the account_id PK already
    // exists), this update matches nothing rather than overwriting their canonical list.
    await db.tx(async (tx) => {
        await tx.run(
            db.type === 'postgres'
                ? 'INSERT INTO account_canonical_addons (account_id, sync_user, updated_at) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING'
                : 'INSERT OR IGNORE INTO account_canonical_addons (account_id, sync_user, updated_at) VALUES ($1, $2, $3)',
            [accountId, syncUser, now]
        )
        await writeEncryptedIfChanged(
            'account_canonical_addons',
            { sql: 'account_id = $1 AND sync_user = $2', params: [accountId, syncUser] },
            'addon_list',
            JSON.stringify(addons),
            { alsoSet: { sync_user: syncUser, updated_at: now }, runner: tx }
        )
        if (addonActions.length > 0) {
            await recordAddonActions(tx, { syncUser, accountId, entries: addonActions })
        }
    })
    invalidateCanonicalAddons(accountId, syncUser)
    return 'canonical'
}

export async function validateManifest(manifestUrl) {
    if (!isSafeUrl(manifestUrl)) {
        return { valid: false, errors: ['Unsafe or private manifest URL'] }
    }
    let res
    try {
        res = await enqueueProxyRequest(manifestUrl, () => guardedResilientFetch(manifestUrl, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000,
            retries: 1
        }))
    } catch (err) {
        if (err.code === 'ssrf-blocked') return { valid: false, errors: ['Unsafe or private manifest URL'] }
        throw err
    }
    if (!res.ok) {
        return { valid: false, errors: [`Manifest fetch returned HTTP ${res.status}`] }
    }
    let manifest
    try {
        manifest = await res.json()
    } catch {
        return { valid: false, errors: ['Manifest is not valid JSON'] }
    }

    const errors = []
    if (!manifest.id || typeof manifest.id !== 'string') errors.push('Missing or invalid "id"')
    if (!manifest.name || typeof manifest.name !== 'string') errors.push('Missing or invalid "name"')
    if (!manifest.version || typeof manifest.version !== 'string') errors.push('Missing or invalid "version"')
    if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) errors.push('Missing or empty "resources"')
    if (!Array.isArray(manifest.types) || manifest.types.length === 0) errors.push('Missing or empty "types"')

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined, manifest }
}

export function registerHydraRoutes(fastify, reconciler = null) {
    logger = fastify.log

    fastify.get('/hydra/status', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
    }, async () => {
        return {
            name: 'AIOManager',
            version: HYDRA_SPEC_VERSION,
            platformVersion: VERSION,
            capabilities: ['addons', 'sync', 'validate']
        }
    })

    fastify.post('/hydra/register', {
        bodyLimit: 1024 * 10,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const name = String(request.body?.name || 'Unknown').slice(0, 64)
        const logo = isValidLogoUrl(request.body?.logo) ? request.body.logo : null
        const syncUser = account.sync_user || ''
        const now = Date.now()

        // Scoped to the key owner: another user's row for the same accountId is never
        // updated, and the owner-qualified id cannot collide with (or be squatted by) it.
        const updated = await db.run(
            'UPDATE hydra_subscribers SET logo = $1, last_seen_at = $2 WHERE account_id = $3 AND sync_user = $4 AND name = $5',
            [logo, now, account.account_id, syncUser, name]
        )
        if (!updated?.changes) {
            await db.run(
                `INSERT INTO hydra_subscribers (id, account_id, sync_user, name, logo, created_at, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO NOTHING`,
                [JSON.stringify([syncUser, account.account_id, name]), account.account_id, syncUser, name, logo, now, now]
            )
        }
        return { ok: true }
    })

    fastify.get('/hydra/version', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        try {
            const raw = await getCanonicalAddonsCached(account.account_id, account.sync_user)
            const addons = raw.map(toHydraAddon).filter(Boolean)
            return { version: computeAddonsVersion(addons) }
        } catch {
            reply.code(503).header('Retry-After', '30')
            return UNAVAILABLE
        }
    })

    fastify.get('/hydra/addons', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return

        try {
            const raw = await getCanonicalAddonsCached(account.account_id, account.sync_user)
            const addons = raw.map(toHydraAddon).filter(Boolean)
            return { addons }
        } catch {
            reply.code(503).header('Retry-After', '30')
            return UNAVAILABLE
        }
    })

    fastify.post('/hydra/addons', {
        bodyLimit: 1024 * 100,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const { url } = request.body || {}
        if (!url || !isValidAddonUrl(url)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid or missing addon URL' }
        }

        try {
            // The manifest fetch is the slow part: validate before taking the account lock.
            const { valid, manifest } = await validateManifest(url)
            if (!valid) {
                reply.code(400)
                return { error: 'bad_request', message: 'Failed to fetch valid manifest from URL' }
            }

            return await withHydraAccountLock(account, async () => {
                const current = await readFreshCanonical(account, reply)
                if (!current) return UNAVAILABLE

                const norm = normalizeAddonUrl(url)
                const present = current.find(a => normalizeAddonUrl(a.transportUrl || a.url || '') === norm)
                if (present) {
                    // An explicit install of an already-present url still lifts an older delete.
                    await db.tx(tx => recordAddonActions(tx, {
                        syncUser: account.sync_user || '',
                        accountId: account.account_id,
                        entries: installEntries(url, present)
                    }))
                    const addons = current.map(toHydraAddon).filter(Boolean)
                    return { addons, ...propagationFields(await stremioCredentialMode(account.account_id, account.sync_user || '')) }
                }

                const newAddon = { transportUrl: url, manifest }
                const updated = [...current, newAddon]
                const mode = await writeCanonicalAddons(account, updated, [{ url, action: 'install' }])

                return { addons: updated.map(toHydraAddon).filter(Boolean), ...propagationFields(mode) }
            })
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError) throw err
            reply.code(500)
            return { error: 'internal_error', message: 'Failed to install addon' }
        }
    })

    fastify.delete('/hydra/addons', {
        bodyLimit: 1024 * 16,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const url = request.query.url
        if (!url || !isValidAddonUrl(url)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid or missing addon URL' }
        }

        try {
            return await withHydraAccountLock(account, async () => {
                const current = await readFreshCanonical(account, reply)
                if (!current) return UNAVAILABLE

                const norm = normalizeAddonUrl(url)
                const filtered = current.filter(a => normalizeAddonUrl(a.transportUrl || a.url || '') !== norm)

                if (filtered.length === current.length) {
                    // Not installed: record nothing, an explicit delete needs a prior install.
                    reply.code(404)
                    return { error: 'not_found', message: 'Addon not installed' }
                }

                const mode = await writeCanonicalAddons(account, filtered, [{ url, action: 'delete' }])
                return { addons: filtered.map(toHydraAddon).filter(Boolean), ...propagationFields(mode) }
            })
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError) throw err
            reply.code(500)
            return { error: 'internal_error', message: 'Failed to remove addon' }
        }
    })

    fastify.put('/hydra/addons', {
        bodyLimit: 1024 * 512,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const { addons } = request.body || {}
        if (!Array.isArray(addons)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Request body must contain "addons" array' }
        }
        if (addons.length > MAX_ADDONS_IN_COLLECTION) {
            reply.code(400)
            return { error: 'bad_request', message: `Addon collection exceeds maximum size (${MAX_ADDONS_IN_COLLECTION})` }
        }

        for (const a of addons) {
            const url = a?.transportUrl || a?.url
            if (!url || !isValidAddonUrl(url)) {
                reply.code(400)
                return { error: 'bad_request', message: `Invalid addon URL: ${String(url).slice(0, 100)}` }
            }
        }

        try {
            return await withHydraAccountLock(account, async () => {
                const current = await readFreshCanonical(account, reply)
                if (!current) return UNAVAILABLE

                // Tolerant of both wire shapes: spec-flat ({transportUrl, name, ...}) and the
                // AIOManager descriptor shape ({transportUrl, manifest: {...}, flags: {...}}).
                // Rows are rebuilt on the current row so a flat payload keeps catalogs,
                // behaviorHints and config. Request destinations are ignored (no policy
                // injection via the API); the STORED policy is grafted back so an external
                // payload that omits it cannot erase it (R8).
                const storedPolicyByUrl = await loadCanonicalDestinations(account.account_id, account.sync_user)
                const normalized = graftStoredDestinations(mergePutRows(addons, current), storedPolicyByUrl)

                // Catastrophic-shrink guard (belt-and-suspenders; the client merge's
                // "inbound deletes don't shrink" policy is the real protection and self-heals
                // a bad replace on the next sync). Reject only the obvious wipe: clearing a
                // non-trivial collection to empty (or to only disabled rows, which Stremio
                // drops), never a legitimate few-addon removal.
                const enabledCount = normalized.filter(a => a.flags?.enabled !== false).length
                if (enabledCount === 0 && current.length >= 3) {
                    reply.code(409)
                    return { error: 'conflict', message: 'Refusing to clear a non-empty addon collection. Remove addons individually.' }
                }

                const mode = await writeCanonicalAddons(account, normalized)
                return { addons: normalized.map(toHydraAddon).filter(Boolean), ...propagationFields(mode) }
            })
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError) throw err
            reply.code(500)
            return { error: 'internal_error', message: 'Failed to replace addon collection' }
        }
    })

    fastify.get('/hydra/addons/:url/health', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return

        const rawUrl = decodeURIComponent(request.params.url)
        if (!isValidAddonUrl(rawUrl) || !isSafeUrl(rawUrl)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid or unsafe addon URL' }
        }

        try {
            const start = Date.now()
            const res = await enqueueProxyRequest(rawUrl, () => guardedResilientFetch(rawUrl, {
                timeout: 8000,
                retries: 1
            }))
            const latencyMs = Date.now() - start
            return { healthy: res.ok, latencyMs }
        } catch (err) {
            if (err.code === 'ssrf-blocked') {
                reply.code(400)
                return { error: 'bad_request', message: 'Invalid or unsafe addon URL' }
            }
            return { healthy: false, latencyMs: -1 }
        }
    })

    fastify.post('/hydra/reinstall', {
        bodyLimit: 1024 * 100,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const { addonUrl, addonId } = request.body || {}
        if (!addonUrl && !addonId) {
            reply.code(400)
            return { error: 'bad_request', message: 'Must provide addonUrl or addonId' }
        }
        if (addonUrl && !isValidAddonUrl(addonUrl)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid addon URL' }
        }

        try {
            // Resolve the url and fetch its manifest before taking the account lock; the
            // fetch is the slow part and must not block other writers on the account.
            let fetchUrl = addonUrl
            if (!fetchUrl) {
                const preRead = await readFreshCanonical(account, reply)
                if (!preRead) return UNAVAILABLE
                const existing = preRead.find(a => (a.manifest?.id || a.id) === addonId)
                if (!existing) {
                    reply.code(404)
                    return { error: 'not_found', message: 'Addon not installed; provide addonUrl to install it' }
                }
                fetchUrl = existing.transportUrl || existing.url
            }

            const { valid, manifest } = await validateManifest(fetchUrl)
            if (!valid) {
                reply.code(400)
                return { error: 'bad_request', message: 'Failed to fetch valid manifest from URL' }
            }

            const result = await withHydraAccountLock(account, async () => {
                const current = await readFreshCanonical(account, reply)
                if (!current) return UNAVAILABLE

                const target = normalizeAddonUrl(fetchUrl)
                let matchIdx = current.findIndex(a => normalizeAddonUrl(a.transportUrl || a.url || '') === target)
                if (matchIdx < 0 && manifest?.id) {
                    matchIdx = current.findIndex(a => (a.manifest?.id || a.id) === manifest.id)
                }

                let updated
                let actions
                if (matchIdx >= 0) {
                    updated = current.slice()
                    updated[matchIdx] = {
                        ...current[matchIdx],
                        transportUrl: fetchUrl,
                        manifest,
                        metadata: { ...current[matchIdx].metadata, lastUpdated: Date.now() }
                    }
                    actions = installEntries(fetchUrl, current[matchIdx])
                } else {
                    updated = [...current, { transportUrl: fetchUrl, manifest }]
                    actions = [{ url: fetchUrl, action: 'install' }]
                }

                const mode = await writeCanonicalAddons(account, updated, actions)
                return { updated, mode }
            })
            if (result === UNAVAILABLE) return UNAVAILABLE

            // Fan-outs run one at a time per account and each enforces the canonical state read inside its own turn.
            if (reconciler) {
                try {
                    await withHydraFanoutLock(account, async () => {
                        const connections = await reconciler.resolveConnections(account.account_id, account.sync_user)
                        const targets = connections.filter(c => c.enabled)
                        if (targets.length > 0) {
                            const live = await getCanonicalAddons(account.account_id, account.sync_user)
                            const enforced = graftStoredDestinations(live, await loadCanonicalDestinations(account.account_id, account.sync_user))
                            await reconciler.enforceAccount(account.account_id, targets, enforced, { canWrite: () => ownerCanWriteOrFail(account.sync_user) })
                        }
                    })
                } catch (e) {
                    // Typed account-state refusals must reach the route's error mapping,
                    // not collapse into a propagation warning.
                    if (e instanceof AuthStateError || e instanceof StateUnavailableError || e instanceof ReadOnlyReplicaError) throw e
                    logger.warn({ category: 'Hydra' }, `[${account.account_id}] Cross-platform propagation after reinstall failed: ${e.message}`)
                }
            }

            return { addons: result.updated.map(toHydraAddon).filter(Boolean), ...propagationFields(result.mode) }
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError) throw err
            reply.code(500)
            return { error: 'internal_error', message: 'Failed to reinstall addon' }
        }
    })

    fastify.post('/hydra/sync', {
        bodyLimit: 1024 * 16,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return
        assertWritablePrimary()

        const current = await readFreshCanonical(account, reply)
        if (!current) return UNAVAILABLE

        try {
            await writeCanonicalAddons(account, current)
            return { synced: true, addonCount: current.length }
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError || err instanceof ReadOnlyReplicaError) throw err
            reply.code(500)
            return { error: 'internal_error', message: 'Sync failed' }
        }
    })

    fastify.post('/hydra/validate', {
        bodyLimit: 1024 * 100,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return

        const { manifestUrl } = request.body || {}
        if (!manifestUrl || !isValidAddonUrl(manifestUrl)) {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid or missing manifest URL' }
        }

        try {
            const result = await validateManifest(manifestUrl)
            return result
        } catch {
            reply.code(500)
            return { error: 'internal_error', message: 'Manifest validation failed' }
        }
    })

    fastify.post('/hydra/test', {
        bodyLimit: 1024 * 10,
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const account = await lookupAccountByApiKey(request, reply)
        if (!account) return

        const { baseUrl } = request.body || {}
        if (!baseUrl || typeof baseUrl !== 'string') {
            reply.code(400)
            return { error: 'bad_request', message: 'Missing baseUrl' }
        }

        let parsedUrl
        try {
            parsedUrl = new URL(baseUrl)
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error()
        } catch {
            reply.code(400)
            return { error: 'bad_request', message: 'Invalid baseUrl' }
        }

        if (!(await isSafeUrlResolved(baseUrl))) {
            reply.code(400)
            return { error: 'bad_request', message: 'Unsafe or private baseUrl' }
        }

        const results = []

        const testEndpoint = async (label, method, path, headers, body) => {
            const start = Date.now()
            try {
                const opts = {
                    method,
                    headers: { 'Content-Type': 'application/json', ...headers },
                    signal: AbortSignal.timeout(10000)
                }
                if (body) opts.body = JSON.stringify(body)
                const res = await guardedWebFetch(`${parsedUrl.origin}${path}`, opts)
                const elapsed = Date.now() - start
                let resBody
                try { resBody = await res.json() } catch { resBody = null }
                return { endpoint: `${method} ${path}`, status: res.status, latencyMs: elapsed, pass: res.status < 400, details: resBody }
            } catch (e) {
                return { endpoint: `${method} ${path}`, status: 0, latencyMs: Date.now() - start, pass: false, error: e.message }
            }
        }

        const apiKey = request.headers['x-api-key']
        const authHeaders = apiKey ? { 'X-API-Key': apiKey } : {}
        const testManifestUrl = 'https://example.com/test-hydra-compliance/manifest.json'

        const encodedUrl = encodeURIComponent(testManifestUrl)
        const [statusRes, listRes, postDeleteRes, reinstallRes, validateRes] = await Promise.all([
            testEndpoint('GET /hydra/status', 'GET', '/hydra/status'),
            testEndpoint('GET /hydra/addons', 'GET', '/hydra/addons', authHeaders),
            (async () => {
                const post = await testEndpoint('POST /hydra/addons', 'POST', '/hydra/addons', authHeaders, { url: testManifestUrl })
                const del = await testEndpoint('DELETE /hydra/addons', 'DELETE', `/hydra/addons?url=${encodedUrl}`, authHeaders)
                return [post, del]
            })(),
            testEndpoint('POST /hydra/reinstall', 'POST', '/hydra/reinstall', authHeaders, { addonUrl: testManifestUrl }),
            testEndpoint('POST /hydra/validate', 'POST', '/hydra/validate', authHeaders, { manifestUrl: testManifestUrl }),
        ])

        results.push(statusRes, listRes, ...postDeleteRes, reinstallRes, validateRes)

        return { results, totalTests: results.length, passed: results.filter(r => r.pass).length }
    })
}
