import { createHash } from 'node:crypto'
import db from '../db.js'
import { encrypt, decrypt } from '../crypto.js'
import { PRIMARY_KEY, FALLBACK_KEYS } from '../keys.js'
import { verifyAuth } from '../auth.js'
import { assertWritablePrimary } from '../admin/account-state.js'
import { isSafeUrlResolved } from '../utils/ssrf.js'
import { guardedFetch } from '../utils/safe-fetch.js'
import { maskContext } from '../utils/log-helpers.js'
import { serverState } from '../state.js'
import { trace } from '../utils/trace.js'
import { applyOneActiveFlags } from '../autopilot/one-active.js'
import { nextRuleVersion } from '../autopilot/v1/rule-version.js'
import { resolveRuleSkipReason } from '../autopilot/engine.js'
import { getGlobalWebhook, setGlobalWebhook, maskWebhookUrl } from '../autopilot/global-webhook.js'
import { autopilotDb, autopilotTripwire, autopilotOwnerBudget, ownerSaveDb, runAsOwner } from '../autopilot/write-tripwire.js'
import { ACCOUNT_DELETED_ERROR, deleteAccountActivity, isAccountTombstoned, liftAccountTombstone, recordAccountTombstone, withAccountWriteLock } from '../lib/account-tombstones.js'
import { findNewRuleOverlap, RULE_OVERLAP_MESSAGE } from '../lib/rule-overlap.js'
import { normalizeAddonUrl } from '../utils/addon-url.js'
import { autopilotWorkerEnabled } from '../lib/autopilot-worker.js'

const AUTOPILOT_BODY_LIMIT = 1024 * 1024 * 5

// A replayed URL-less Nuvio bundle must not erase the sealed custom destination: with the
// last baseUrl gone, every later server-side push targets the public api.nuvio.tv. Carry
// the sealed destination (and its publishable key) forward, scoped to owner + account +
// type + the same connection (NULL connection_id for legacy rows), considering readable
// duplicates so a newer URL-less row cannot hide the last URL. Destination fields only:
// an older duplicate's tokens are never revived, and a request URL is never evidence.
// Same policy as preserveExistingNuvioBaseUrl in routes/providers.js.
export async function preserveNuvioSealedDestination(conn, owner, accountId, connectionId, encryptedAuthKey) {
    if (!owner || !accountId) return encryptedAuthKey
    let incoming = null
    try { incoming = JSON.parse(decrypt(encryptedAuthKey, FALLBACK_KEYS)) } catch { return encryptedAuthKey }
    if (!incoming || typeof incoming !== 'object' || incoming.baseUrl) return encryptedAuthKey
    const rows = await conn.query(
        `SELECT auth_key FROM server_credentials WHERE sync_user = $1 AND account_id = $2 AND credential_type = 'nuvio' AND ${connectionId ? 'connection_id = $3' : 'connection_id IS NULL'} ORDER BY updated_at DESC`,
        connectionId ? [owner, accountId, connectionId] : [owner, accountId]
    )
    for (const row of rows || []) {
        if (!row?.auth_key) continue
        let bundle = null
        try { bundle = JSON.parse(decrypt(row.auth_key, FALLBACK_KEYS)) } catch { continue }
        if (!bundle || typeof bundle !== 'object') continue
        if (bundle.baseUrl) {
            incoming.baseUrl = bundle.baseUrl
            if (!incoming.publishableKey && bundle.publishableKey) incoming.publishableKey = bundle.publishableKey
            return encrypt(JSON.stringify(incoming), PRIMARY_KEY)
        }
    }
    return encryptedAuthKey
}

export function registerAutopilotRoutes(fastify, autopilotEngine) {
    // Client-minted incarnation token of a connection (SOL-R1-BETA-04): rows bound to a
    // connection carry the generation of the incarnation that wrote them, so a delayed
    // cleanup can never claim rows a re-added incarnation registered.
    const readConnectionGeneration = (value) => {
        if (typeof value !== 'string') return null
        const trimmed = value.trim()
        return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null
    }

    // An unchanged rule re-synced by a re-added incarnation must still adopt that
    // incarnation's generation, or a stale cleanup of the old generation could later
    // claim the row the live connection still uses.
    const refreshRuleConnectionGeneration = async (conn, owner, id, connectionId, generation) => {
        if (!connectionId || !generation) return
        await ownerSaveDb(owner, conn).run(
            'UPDATE autopilot_rules SET connection_generation = $1 WHERE id = $2 AND owner_sync_user = $3 AND connection_id = $4',
            [generation, id, owner, connectionId]
        )
    }

    async function upsertCredential(owner, accountId, accountName, encryptedAuthKey, credentialType = 'stremio', connectionId = null, conn = db, connectionGeneration = null) {
        if (!encryptedAuthKey && !connectionId) return
        try {
            const credId = connectionId ? `${owner}:${connectionId}` : `${owner}:${accountId}`
            const now = Date.now()
            // Replay protection runs inside the caller's account write lock, through the
            // supplied conn, so a carried-forward destination is written in the same
            // transaction that upserts the replayed bundle.
            if (credentialType === 'nuvio') {
                encryptedAuthKey = await preserveNuvioSealedDestination(conn, owner, accountId, connectionId, encryptedAuthKey)
            }
            const previous = !connectionId ? await conn.get(
                'SELECT auth_key, canonical_connection_id FROM server_credentials WHERE id = $1 AND sync_user = $2',
                [credId, owner]
            ) : null
            const canonicalConnectionId = previous?.canonical_connection_id
                && decrypt(previous.auth_key, FALLBACK_KEYS) === decrypt(encryptedAuthKey, FALLBACK_KEYS)
                ? previous.canonical_connection_id : null
            if (conn.type === 'postgres') {
                await conn.run(
                    `INSERT INTO server_credentials (id, sync_user, account_id, account_name, auth_key, updated_at, credential_type, connection_id, canonical_connection_id, connection_generation)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     ON CONFLICT (id) DO UPDATE SET auth_key = EXCLUDED.auth_key, updated_at = EXCLUDED.updated_at, credential_type = EXCLUDED.credential_type, connection_id = EXCLUDED.connection_id, canonical_connection_id = EXCLUDED.canonical_connection_id, connection_generation = COALESCE(EXCLUDED.connection_generation, server_credentials.connection_generation)`,
                    [credId, owner, accountId, accountName || '', encryptedAuthKey, now, credentialType, connectionId, canonicalConnectionId, connectionId ? connectionGeneration : null]
                )
            } else {
                await conn.run(
                    `INSERT INTO server_credentials (id, sync_user, account_id, account_name, auth_key, updated_at, credential_type, connection_id, canonical_connection_id, connection_generation)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     ON CONFLICT (id) DO UPDATE SET auth_key = excluded.auth_key, updated_at = excluded.updated_at, credential_type = excluded.credential_type, connection_id = excluded.connection_id, canonical_connection_id = excluded.canonical_connection_id, connection_generation = COALESCE(excluded.connection_generation, connection_generation)`,
                    [credId, owner, accountId, accountName || '', encryptedAuthKey, now, credentialType, connectionId, canonicalConnectionId, connectionId ? connectionGeneration : null]
                )
            }
            const { invalidateConnectionCache } = await import('../providers/reconciler.js')
            invalidateConnectionCache(owner)
        } catch (credErr) {
            fastify.log.warn({ category: 'Autopilot' }, `Failed to upsert credential for ${maskContext(accountId)}: ${credErr.message}`)
        }
    }
    const { sendNotification, syncStremioLive, getRuleRuntimeState, getRuleCheckError, getRuleRevision, clearRuleRuntimeState, clearAccountRuleRuntimeState, decryptRuleField, beginRuleCacheRead, endRuleCacheRead, retireRuleCaches, retireRuleSecrets } = autopilotEngine
    // Engine's versioned decrypt cache (keyed by rule id + updated_at, ciphertext
    // revalidated before reuse). Falls back to a plain decrypt when a harness passes
    // an engine stub without it.
    const ruleDecryptField = decryptRuleField || ((rule, field) => decrypt(rule[field], FALLBACK_KEYS))
    const ENFORCEMENT_DEBOUNCE_MS = 30_000
    const MAX_BATCH_STATE_ACCOUNTS = 500
    const enforcementDebounce = new Map()
    let lastDebouncePrune = 0

    const stableStringify = (value) => {
        if (value === undefined) return 'undefined'
        if (value === null || typeof value !== 'object') return JSON.stringify(value)
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

        return `{${Object.keys(value)
            .filter(key => value[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`
    }

    const plainJsonEqual = (left, right) =>
        stableStringify(left ?? null) === stableStringify(right ?? null)

    const isSafeAutopilotUrl = async (url) =>
        typeof url === 'string' && await isSafeUrlResolved(url.replace(/^stremio:\/\//i, 'https://'))


    // appliesTo is stored verbatim: the engine never widens non-empty scopes and [] stays born-global.
    const normCustomChecks = (arr) => {
        if (!Array.isArray(arr)) return []
        return arr.map(item => {
            if (typeof item === 'string') return { url: item, appliesTo: [] }
            if (item && typeof item === 'object' && typeof item.url === 'string') {
                const appliesTo = Array.isArray(item.appliesTo) ? item.appliesTo.filter(u => typeof u === 'string') : []
                return { url: item.url, appliesTo }
            }
            return null
        }).filter(Boolean)
    }

    // appliesTo entries are comparison keys only — format-check, never SSRF-check.
    const isValidAppliesToEntry = (entry) => {
        if (typeof entry !== 'string' || !entry.trim()) return false
        const trimmed = entry.trim()
        const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)
        if (schemeMatch && !/^(?:https?|stremio)$/i.test(schemeMatch[1])) return false
        const candidate = schemeMatch ? trimmed : `https://${trimmed}`
        try {
            const { protocol } = new URL(candidate)
            return protocol === 'http:' || protocol === 'https:' || protocol === 'stremio:'
        } catch {
            return false
        }
    }

    const validateRulePayload = async ({ id, accountId, authKey, connectionId, priorityChain, activeUrl, addonList, customCheckUrls }) => {
        if (typeof id !== 'string' || !id || typeof accountId !== 'string' || !accountId || (!authKey && !connectionId) || !Array.isArray(priorityChain) || priorityChain.length === 0) {
            return 'Missing required Autopilot data'
        }
        const chainResults = await Promise.all(priorityChain.map(isSafeAutopilotUrl))
        if (!chainResults.every(Boolean)) return 'Priority chain contains an unsafe URL'
        if (activeUrl && !(await isSafeAutopilotUrl(activeUrl))) return 'Active URL is unsafe'
        if (addonList && Array.isArray(addonList) && addonList.length > 500) return 'Addon list exceeds maximum size (500)'
        if (customCheckUrls !== undefined && customCheckUrls !== null) {
            if (!Array.isArray(customCheckUrls)) return 'customCheckUrls must be an array'
            if (customCheckUrls.length > 5) return 'customCheckUrls exceeds maximum of 5 entries'
            for (const entry of customCheckUrls) {
                let checkUrl
                let appliesTo
                if (typeof entry === 'string') {
                    checkUrl = entry
                    appliesTo = []
                } else if (entry && typeof entry === 'object' && typeof entry.url === 'string') {
                    checkUrl = entry.url
                    appliesTo = Array.isArray(entry.appliesTo) ? entry.appliesTo : []
                } else {
                    return 'customCheckUrls entries must be a string or { url, appliesTo } object'
                }
                if (!/^https?:\/\//i.test(checkUrl)) return 'customCheckUrls must contain valid http(s) URLs'
                if (!(await isSafeUrlResolved(checkUrl.replace(/^stremio:\/\//i, 'https://')))) return 'customCheckUrls contains an unsafe URL'
                if (appliesTo.length > 10) return 'customCheckUrls appliesTo exceeds maximum of 10 addons'
                if (appliesTo.some(au => !isValidAppliesToEntry(au))) return 'customCheckUrls appliesTo entries must be valid addon URLs'
            }
        }
        return null
    }

    const parseRuleArray = (raw) => {
        if (!raw) return []
        try {
            const value = Array.isArray(raw) ? raw : JSON.parse(decrypt(raw, FALLBACK_KEYS) || 'null')
            return Array.isArray(value) ? value : null
        } catch {
            return null
        }
    }

    const newOverlapError = async (conn, owner, accountId, id, priorityChain, addonList, previousRule) => {
        const previousChain = parseRuleArray(previousRule?.priority_chain)
        const previousUrls = new Set((previousChain || []).map(normalizeAddonUrl))
        if (previousChain !== null && priorityChain.every(url => previousUrls.has(normalizeAddonUrl(url)))) return null
        const siblings = await conn.query(
            'SELECT id, priority_chain, addon_list FROM autopilot_rules WHERE owner_sync_user = $1 AND account_id = $2 AND id <> $3',
            [owner, accountId, id]
        )
        const readable = siblings.map(row => ({ id: row.id, priorityChain: parseRuleArray(row.priority_chain), addonList: parseRuleArray(row.addon_list) || [] }))
        if (previousChain === null || readable.some(row => row.priorityChain === null)) {
            return { code: 'rule_state_unreadable', message: 'An existing Autopilot chain could not be read. Repair it before changing chain membership.' }
        }
        const overlap = findNewRuleOverlap({ priorityChain, previousChain, addonList, previousAddonList: parseRuleArray(previousRule?.addon_list) || [], siblings: readable })
        return overlap ? { code: 'chain_overlap', message: RULE_OVERLAP_MESSAGE } : null
    }

    // The worker owns addon_list/active_url on automatic rules: an open tab's background
    // echo must never rewrite them or re-enforce a stale copy of them.
    const STORED_STATE_UNREADABLE = 'stored addon list unreadable; enforcement skipped'

    const engineOwnedSyncFields = (existingRule, { addonList, activeUrl, is_automatic }) => {
        if (!existingRule || existingRule.is_automatic !== 1 || !is_automatic) return { addonList, activeUrl }
        const listBlobPresent = Boolean(existingRule.addon_list)
        const activeBlobPresent = Boolean(existingRule.active_url)
        try {
            const storedList = listBlobPresent ? JSON.parse(decrypt(existingRule.addon_list, FALLBACK_KEYS) || 'null') : null
            const storedActive = activeBlobPresent ? decrypt(existingRule.active_url, FALLBACK_KEYS) : null
            // Unreadable stored blobs must never adopt the client's copy - the rule requires repair.
            if ((listBlobPresent && storedList === null) || (activeBlobPresent && storedActive === null)) {
                return { blocked: true }
            }
            return { addonList: storedList ?? addonList, activeUrl: storedActive ?? activeUrl }
        } catch {
            return { blocked: true }
        }
    }

    // Moving an automatic rule to another platform or connection would push its stored
    // engine-owned addon list to the new target, so a re-send may never retarget it.
    const RULE_RETARGET_REFUSED = 'Rule target cannot change'
    const retargetsEngineOwnedRule = (existingRule, { platform, connectionId, is_automatic }) =>
        Boolean(existingRule && existingRule.is_automatic === 1 && is_automatic && existingRule.addon_list)
        && ((existingRule.platform || 'stremio').toLowerCase() !== (platform || 'stremio').toLowerCase()
            || (existingRule.connection_id || null) !== (connectionId || null))

    async function checkPlaintextEqual(existingRule, { authKey, priorityChain, addonList, activeUrl, webhookUrl, notifyEnabled, is_active, is_automatic, cooldown_ms, messageTemplate, name, customCheckUrls }) {
        if (!existingRule) return false
        const existingAuthKey = existingRule.auth_key ? decrypt(existingRule.auth_key, FALLBACK_KEYS) : ''
        const existingChainStr = existingRule.priority_chain ? decrypt(existingRule.priority_chain, FALLBACK_KEYS) : ''
        if (existingRule.priority_chain && !existingChainStr) throw new Error('Decryption failed')
        const existingChain = existingChainStr ? JSON.parse(existingChainStr) : []
        const existingAddonList = existingRule.addon_list ? JSON.parse(decrypt(existingRule.addon_list, FALLBACK_KEYS) || 'null') : null
        const existingActiveUrl = existingRule.active_url ? decrypt(existingRule.active_url, FALLBACK_KEYS) : null
        const existingWebhookUrl = existingRule.webhook_url ? decrypt(existingRule.webhook_url, FALLBACK_KEYS) : null
        let existingCustomCheckUrls = []
        try {
            if (existingRule.custom_check_urls) {
                const decrypted = decrypt(existingRule.custom_check_urls, FALLBACK_KEYS)
                const source = decrypted && decrypted.startsWith('[') ? decrypted : (existingRule.custom_check_urls.startsWith('[') ? existingRule.custom_check_urls : null)
                if (source) existingCustomCheckUrls = JSON.parse(source)
            }
        } catch (e) { existingCustomCheckUrls = [] }

        return existingAuthKey === (authKey || '') &&
            JSON.stringify(existingChain) === JSON.stringify(priorityChain) &&
            JSON.stringify(existingAddonList) === JSON.stringify(addonList ?? null) &&
            (existingActiveUrl || null) === (activeUrl || null) &&
            (existingWebhookUrl || null) === (webhookUrl || null) &&
            (notifyEnabled == null || (existingRule.notify_enabled ?? null) === (notifyEnabled ? 1 : 0)) &&
            !!existingRule.is_active === !!is_active &&
            !!existingRule.is_automatic === !!is_automatic &&
            (existingRule.cooldown_ms ?? null) === (cooldown_ms ?? null) &&
            (existingRule.message_template ?? null) === (messageTemplate ?? null) &&
            existingRule.name === name &&
            JSON.stringify(normCustomChecks(existingCustomCheckUrls)) === JSON.stringify(normCustomChecks(customCheckUrls))
    }

    async function upsertRuleRecord({ id, accountId, name, authKey, priorityChain, activeUrl, addonList, webhookUrl, notifyEnabled, is_active, is_automatic, cooldown_ms, messageTemplate, platform, connectionId, customCheckUrls, connectionGeneration }, existingRule, authUser, preserveEngineOwned = false, conn = db) {
        const effectivePlatform = (platform || 'stremio').toLowerCase()
        const encryptedAuthKey = authKey ? encrypt(authKey, PRIMARY_KEY) : null
        const encryptedChain = encrypt(JSON.stringify(priorityChain), PRIMARY_KEY)
        // preserveEngineOwned (spec F4): the stored addon_list/active_url blobs are
        // unreadable and must survive this upsert untouched - never nulled (the
        // ON CONFLICT UPDATE self-assigns them), never replaced by client values.
        // Blocked always implies an existing row, so the INSERT VALUES never land.
        const encryptedActiveUrl = (activeUrl && !preserveEngineOwned) ? encrypt(activeUrl, PRIMARY_KEY) : null
        const encryptedAddonList = (addonList && !preserveEngineOwned) ? encrypt(JSON.stringify(addonList), PRIMARY_KEY) : null
        const encryptedWebhookUrl = webhookUrl ? encrypt(webhookUrl, PRIMARY_KEY) : null
        // NULL means "no statement" (older client) and keeps the stored mode; 0 is a real per-rule off.
        const notifyEnabledCol = notifyEnabled == null ? null : (notifyEnabled ? 1 : 0)
        const customCheckNormArr = normCustomChecks(customCheckUrls)
        const encryptedCustomChecks = customCheckNormArr.length > 0 ? encrypt(JSON.stringify(customCheckNormArr), PRIMARY_KEY) : null
        const now = Date.now()
        const resolvedOwner = (existingRule?.owner_sync_user) || authUser
        const saveDb = ownerSaveDb(authUser, conn)

        if (db.type === 'postgres') {
            await saveDb.run(`
                INSERT INTO autopilot_rules (id, account_id, name, auth_key, priority_chain, addon_list, active_url, webhook_url, notify_enabled, is_active, is_automatic, updated_at, cooldown_ms, message_template, owner_sync_user, platform, connection_id, custom_check_urls, edited_at, connection_generation)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    auth_key = EXCLUDED.auth_key,
                    priority_chain = EXCLUDED.priority_chain,
                    ${preserveEngineOwned
                        ? 'addon_list = autopilot_rules.addon_list,\n                    active_url = autopilot_rules.active_url,'
                        : 'addon_list = EXCLUDED.addon_list,\n                    active_url = EXCLUDED.active_url,'}
                    webhook_url = EXCLUDED.webhook_url,
                    notify_enabled = COALESCE(EXCLUDED.notify_enabled, autopilot_rules.notify_enabled),
                    is_active = EXCLUDED.is_active,
                    is_automatic = EXCLUDED.is_automatic,
                    updated_at = ${nextRuleVersion('EXCLUDED.updated_at', 'autopilot_rules.updated_at')},
                    edited_at = EXCLUDED.edited_at,
                    cooldown_ms = EXCLUDED.cooldown_ms,
                    message_template = EXCLUDED.message_template,
                    owner_sync_user = EXCLUDED.owner_sync_user,
                    platform = EXCLUDED.platform,
                    connection_id = EXCLUDED.connection_id,
                    custom_check_urls = EXCLUDED.custom_check_urls,
                    connection_generation = COALESCE(EXCLUDED.connection_generation, autopilot_rules.connection_generation)
                WHERE autopilot_rules.owner_sync_user = EXCLUDED.owner_sync_user
                  AND autopilot_rules.account_id = EXCLUDED.account_id AND (
                    autopilot_rules.name IS DISTINCT FROM EXCLUDED.name OR
                    autopilot_rules.auth_key IS DISTINCT FROM EXCLUDED.auth_key OR
                    autopilot_rules.priority_chain IS DISTINCT FROM EXCLUDED.priority_chain OR
                    ${preserveEngineOwned ? '' : `autopilot_rules.addon_list IS DISTINCT FROM EXCLUDED.addon_list OR
                    autopilot_rules.active_url IS DISTINCT FROM EXCLUDED.active_url OR
                    `}
                    autopilot_rules.webhook_url IS DISTINCT FROM EXCLUDED.webhook_url OR
                    (EXCLUDED.notify_enabled IS NOT NULL AND autopilot_rules.notify_enabled IS DISTINCT FROM EXCLUDED.notify_enabled) OR
                    autopilot_rules.is_active IS DISTINCT FROM EXCLUDED.is_active OR
                    autopilot_rules.is_automatic IS DISTINCT FROM EXCLUDED.is_automatic OR
                    autopilot_rules.cooldown_ms IS DISTINCT FROM EXCLUDED.cooldown_ms OR
                    autopilot_rules.message_template IS DISTINCT FROM EXCLUDED.message_template OR
                    autopilot_rules.platform IS DISTINCT FROM EXCLUDED.platform OR
                    autopilot_rules.connection_id IS DISTINCT FROM EXCLUDED.connection_id OR
                    autopilot_rules.connection_generation IS DISTINCT FROM EXCLUDED.connection_generation OR
                    autopilot_rules.custom_check_urls IS DISTINCT FROM EXCLUDED.custom_check_urls)
            `, [id, accountId, name, encryptedAuthKey, encryptedChain, encryptedAddonList, encryptedActiveUrl, encryptedWebhookUrl, notifyEnabledCol, is_active ? 1 : 0, is_automatic ? 1 : 0, now, cooldown_ms, messageTemplate || null, resolvedOwner, effectivePlatform, connectionId || null, encryptedCustomChecks, now, connectionId ? connectionGeneration || null : null])
        } else {
            await saveDb.run(`
                INSERT INTO autopilot_rules (id, account_id, name, auth_key, priority_chain, addon_list, active_url, webhook_url, notify_enabled, is_active, is_automatic, updated_at, cooldown_ms, message_template, owner_sync_user, platform, connection_id, custom_check_urls, edited_at, connection_generation)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    auth_key = excluded.auth_key,
                    priority_chain = excluded.priority_chain,
                    ${preserveEngineOwned
                        ? 'addon_list = autopilot_rules.addon_list,\n                    active_url = autopilot_rules.active_url,'
                        : 'addon_list = excluded.addon_list,\n                    active_url = excluded.active_url,'}
                    webhook_url = excluded.webhook_url,
                    notify_enabled = COALESCE(excluded.notify_enabled, autopilot_rules.notify_enabled),
                    is_active = excluded.is_active,
                    is_automatic = excluded.is_automatic,
                    updated_at = ${nextRuleVersion('excluded.updated_at', 'autopilot_rules.updated_at')},
                    edited_at = excluded.edited_at,
                    cooldown_ms = excluded.cooldown_ms,
                    message_template = excluded.message_template,
                    owner_sync_user = excluded.owner_sync_user,
                    platform = excluded.platform,
                    connection_id = excluded.connection_id,
                    custom_check_urls = excluded.custom_check_urls,
                    connection_generation = COALESCE(excluded.connection_generation, autopilot_rules.connection_generation)
                WHERE autopilot_rules.owner_sync_user = excluded.owner_sync_user
                  AND autopilot_rules.account_id = excluded.account_id AND (
                    COALESCE(autopilot_rules.name, '') != COALESCE(excluded.name, '') OR
                    autopilot_rules.auth_key IS NOT excluded.auth_key OR
                    autopilot_rules.priority_chain != excluded.priority_chain OR
                    ${preserveEngineOwned ? '' : `COALESCE(autopilot_rules.addon_list, '') != COALESCE(excluded.addon_list, '') OR
                    COALESCE(autopilot_rules.active_url, '') != COALESCE(excluded.active_url, '') OR
                    `}
                    COALESCE(autopilot_rules.webhook_url, '') != COALESCE(excluded.webhook_url, '') OR
                    (excluded.notify_enabled IS NOT NULL AND autopilot_rules.notify_enabled IS NOT excluded.notify_enabled) OR
                    autopilot_rules.is_active != excluded.is_active OR
                    autopilot_rules.is_automatic != excluded.is_automatic OR
                    COALESCE(autopilot_rules.cooldown_ms, 0) != COALESCE(excluded.cooldown_ms, 0) OR
                    COALESCE(autopilot_rules.message_template, '') != COALESCE(excluded.message_template, '') OR
                    COALESCE(autopilot_rules.platform, 'stremio') != COALESCE(excluded.platform, 'stremio') OR
                    autopilot_rules.connection_id IS NOT excluded.connection_id OR
                    autopilot_rules.connection_generation IS NOT excluded.connection_generation OR
                    COALESCE(autopilot_rules.custom_check_urls, '') != COALESCE(excluded.custom_check_urls, ''))
            `, [id, accountId, name, encryptedAuthKey, encryptedChain, encryptedAddonList, encryptedActiveUrl, encryptedWebhookUrl, notifyEnabledCol, is_active ? 1 : 0, is_automatic ? 1 : 0, now, cooldown_ms, messageTemplate || null, resolvedOwner, effectivePlatform, connectionId || null, encryptedCustomChecks, now, connectionId ? connectionGeneration || null : null])
        }

        const saved = await conn.get('SELECT account_id, owner_sync_user, updated_at FROM autopilot_rules WHERE id = $1', [id])
        if (!saved || saved.owner_sync_user !== resolvedOwner || saved.account_id !== accountId) {
            throw Object.assign(new Error('Rule changed while saving. Refresh and try again.'), { statusCode: 409 })
        }
        if (effectivePlatform === 'stremio' && encryptedAuthKey) {
            await upsertCredential(resolvedOwner, accountId, name, encryptedAuthKey, 'stremio', null, conn)
        }
        return { resolvedOwner, encryptedAuthKey, updatedAt: saved.updated_at }
    }

    const hashEnforcementPayload = ({ authKey, safeChain, targetActiveUrl, storedAddons }) =>
        createHash('sha256')
            .update(stableStringify({ authKey, safeChain, targetActiveUrl, storedAddons }))
            .digest('hex')

    const pruneEnforcementDebounce = (now) => {
        if (now - lastDebouncePrune < ENFORCEMENT_DEBOUNCE_MS) return
        lastDebouncePrune = now

        for (const [ruleId, entry] of enforcementDebounce) {
            if (now - entry.timestamp >= ENFORCEMENT_DEBOUNCE_MS) {
                enforcementDebounce.delete(ruleId)
            }
        }
    }

    const shouldDebounceEnforcement = (ruleId, payloadHash) => {
        if (!ruleId) return false

        const now = Date.now()
        pruneEnforcementDebounce(now)

        const entry = enforcementDebounce.get(ruleId)
        if (entry?.payloadHash === payloadHash && now - entry.timestamp < ENFORCEMENT_DEBOUNCE_MS) {
            return true
        }

        enforcementDebounce.set(ruleId, { payloadHash, timestamp: now })
        return false
    }

    const clearDebouncedEnforcement = (ruleId, payloadHash) => {
        const entry = enforcementDebounce.get(ruleId)
        if (entry?.payloadHash === payloadHash) {
            enforcementDebounce.delete(ruleId)
        }
    }

    const parseStabilization = (rule, readToken) => {
        if (!rule.stabilization) return {}
        try {
            // ruleDecryptField is safe for stats-sourced stabilization: the memo is
            // keyed by the rule's updated_at but revalidates the exact ciphertext, so
            // a heartbeat that rewrites the stats blob misses and re-decrypts.
            return JSON.parse(ruleDecryptField(rule, 'stabilization', readToken) || '{}')
        } catch {
            return {}
        }
    }

    const buildAutopilotState = (rule, readToken) => {
        const runtime = getRuleRuntimeState?.(rule.id)
        let customCheckUrls = []
        try {
            if (rule.custom_check_urls) {
                const decrypted = ruleDecryptField(rule, 'custom_check_urls', readToken)
                const source = decrypted && decrypted.startsWith('[') ? decrypted : (rule.custom_check_urls.startsWith('[') ? rule.custom_check_urls : null)
                if (source) customCheckUrls = normCustomChecks(JSON.parse(source))
            }
        } catch (e) { customCheckUrls = [] }
        const priorityChain = rule.priority_chain ? JSON.parse(ruleDecryptField(rule, 'priority_chain', readToken) || '[]') : []
        const checkError = getRuleCheckError?.(rule.id)
        const lastCheck = runtime?.lastCheck ?? rule.last_check
        return {
            id: rule.id,
            name: rule.name || null,
            cooldownMs: rule.cooldown_ms || null,
            priorityChain,
            activeUrl: runtime?.activeUrl ?? (rule.active_url ? ruleDecryptField(rule, 'active_url', readToken) : null),
            webhookUrl: rule.webhook_url ? ruleDecryptField(rule, 'webhook_url', readToken) : '',
            // Only a saved mode is a statement (NULL = legacy row / older client): the
            // client keeps its local value when the key is absent.
            ...(rule.notify_enabled == null ? {} : { notifyEnabled: rule.notify_enabled === 1 }),
            isActive: rule.is_active === 1,
            isAutomatic: rule.is_automatic === 1,
            lastCheck: checkError && !(lastCheck >= checkError.at) ? checkError.at : lastCheck,
            stabilization: runtime?.stabilization ?? parseStabilization(rule, readToken),
            customCheckUrls: Array.isArray(customCheckUrls) ? customCheckUrls : [],
            messageTemplate: rule.message_template || null,
            platform: rule.platform || null,
            connectionId: rule.connection_id || null,
            skipReason: resolveRuleSkipReason(rule, runtime, priorityChain),
            ...(checkError ? { lastError: {
                code: checkError.code,
                message: checkError.message,
                ...(Array.isArray(checkError.affectedRefs) ? { affectedRefs: checkError.affectedRefs.filter(ref => typeof ref === 'string' && /^ad_[a-f0-9]{16}$/i.test(ref)).slice(0, 500) } : {}),
                ...(Number.isFinite(checkError.retryAt) && checkError.retryAt >= 0 ? { retryAt: checkError.retryAt } : {}),
                ...(Number.isFinite(checkError.retryHours) && checkError.retryHours > 0 ? { retryHours: checkError.retryHours } : {}),
            } } : {})
        }
    }

    const buildAutopilotStates = (rules, context, readToken) => {
        const states = []
        let skippedCount = 0
        for (const rule of rules || []) {
            try {
                states.push(buildAutopilotState(rule, readToken))
            } catch (err) {
                skippedCount++
                fastify.log.warn({ category: 'Autopilot' }, `Skipped unreadable rule ${rule.id} for ${context}: ${err.message}`)
            }
        }
        const response = { states, lastWorkerRun: serverState.lastWorkerRun, lastCycle: serverState.autopilotLastCycleStats }
        if (skippedCount > 0) {
            response.partial = true
            response.skippedCount = skippedCount
        }
        return response
    }

    const loadStoredAddonList = async (id, ownerSyncUser) => {
        try {
            const row = await autopilotDb.get('SELECT addon_list FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, ownerSyncUser])
            if (!row?.addon_list) return null

            const decrypted = decrypt(row.addon_list, FALLBACK_KEYS)
            if (!decrypted) return null
            return JSON.parse(decrypted)
        } catch {
            return undefined
        }
    }

    const scheduleRuleEnforcement = async ({ id, accountId, authKey, connectionId, platform, ownerSyncUser, priorityChain, addonList, is_active, is_automatic }) => {
        if (!syncStremioLive || (!authKey && !connectionId) || is_active === 0 || is_active === false || is_automatic === 0 || is_automatic === false) return
        // Echo writes share the engine's tripwire; in safe mode the save stands and nothing is pushed.
        if (autopilotTripwire.isSafeMode()) return
        if (!Array.isArray(priorityChain) || priorityChain.length === 0) return

        const chainSafety = await Promise.all(priorityChain.map(isSafeAutopilotUrl))
        const safeChain = priorityChain.filter((_, i) => chainSafety[i])
        if (safeChain.length === 0) return

        runAsOwner(ownerSyncUser, () => runEchoEnforcement({ id, accountId, authKey, connectionId, platform, ownerSyncUser, safeChain, addonList }))
    }

    // Per-owner write budget for saves and their echo: an owner over it gets a 429; nobody else is affected.
    const ownerBudgetError = (owner) => {
        const retryAfterMs = autopilotOwnerBudget.retryAfterMs(owner)
        if (retryAfterMs <= 0) return null
        const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000))
        return { retryAfterMs, error: `Too many Autopilot changes, try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` }
    }
    const sendOwnerBudget429 = (reply, limited) => {
        reply.header('Retry-After', String(Math.ceil(limited.retryAfterMs / 1000)))
        reply.status(429)
        return { error: limited.error, retryAfterMs: limited.retryAfterMs }
    }

    const enforceAfterSave = async (args) => {
        try {
            await scheduleRuleEnforcement(args)
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(args.accountId)}] Echo scheduling failed: ${err.message}`)
        }
    }

    const runEchoEnforcement = async ({ id, accountId, authKey, connectionId, platform, ownerSyncUser, safeChain, addonList }) => {
        // Derive, never replay (spec F1): re-read the committed rule row so the echo
        // pushes flag state derived from the engine's latest swap, never a snapshot
        // that can predate it. The re-read happens BEFORE the payload hash so a
        // mid-window engine commit changes the hash and busts the debounce.
        let storedAddons
        let targetActiveUrl
        try {
            const freshRow = id
                ? await autopilotDb.get('SELECT addon_list, active_url, is_active FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, ownerSyncUser])
                : null
            if (!freshRow || freshRow.is_active === 0) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Rule ${id} vanished before echo enforcement; skipping.`)
                return
            }
            let freshList = null
            if (freshRow.addon_list) {
                const decrypted = decrypt(freshRow.addon_list, FALLBACK_KEYS)
                if (!decrypted) throw new Error('stored addon_list is unreadable')
                freshList = JSON.parse(decrypted)
            }
            // Active-url resolution mirrors buildAutopilotState: runtime state beats
            // the stored blob beats the chain head.
            const runtimeActive = getRuleRuntimeState?.(id)?.activeUrl
            let storedActive = null
            if (!runtimeActive && freshRow.active_url) {
                storedActive = decrypt(freshRow.active_url, FALLBACK_KEYS)
                if (!storedActive) throw new Error('stored active_url is unreadable')
            }
            const resolvedActive = runtimeActive ?? storedActive ?? safeChain[0]
            targetActiveUrl = (resolvedActive && await isSafeAutopilotUrl(resolvedActive)) ? resolvedActive : safeChain[0]
            const baseList = Array.isArray(freshList) ? freshList : (Array.isArray(addonList) ? addonList : [])
            const derived = applyOneActiveFlags(baseList, safeChain, targetActiveUrl)
            if (derived.violationDetected) {
                fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Echo re-derived one-active flags for rule ${id} (stored snapshot had chain violations).`)
            }
            storedAddons = derived.list
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Echo re-read failed for rule ${id} (${err.message}); skipping enforcement.`)
            return
        }
        const payloadHash = hashEnforcementPayload({ authKey: authKey || connectionId, safeChain, targetActiveUrl, storedAddons })
        if (shouldDebounceEnforcement(id, payloadHash)) return

        // Route sync is user initiated; enforce immediately so backups are hidden
        // without waiting for the next worker pass or a frontend refresh.
        Promise.resolve()
            .then(() => syncStremioLive({ authKey, platform: (platform || 'stremio').toLowerCase(), connectionId, accountId, ownerSyncUser }, safeChain, targetActiveUrl, accountId, id, storedAddons, false))
            .then(async (reconciledList) => {
                if (id && Array.isArray(reconciledList)) {
                    const storedAddonList = await loadStoredAddonList(id, ownerSyncUser)
                    // encrypt() uses a random IV, so compare plaintext before touching TOAST-heavy addon_list.
                    if (plainJsonEqual(storedAddonList, reconciledList)) return

                    await autopilotDb.run(`UPDATE autopilot_rules SET addon_list = $1, updated_at = ${nextRuleVersion('$2')} WHERE id = $3 AND owner_sync_user = $4`, [
                        encrypt(JSON.stringify(reconciledList), PRIMARY_KEY),
                        Date.now(),
                        id,
                        ownerSyncUser
                    ])
                }
            })
            .catch(err => {
                clearDebouncedEnforcement(id, payloadHash)
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Immediate enforcement failed after rule sync: ${err.message}`)
            })
    }

    fastify.post('/api/autopilot/sync', { bodyLimit: AUTOPILOT_BODY_LIMIT, config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req) => 'apsync:' + req.ip } } }, async (request, reply) => {
        let { id, accountId, name, authKey, connectionId, platform, priorityChain, activeUrl, is_active, is_automatic, addonList, webhookUrl, notifyEnabled, cooldown_ms, messageTemplate, customCheckUrls, connectionGeneration } = request.body
        const connectionGenerationToken = readConnectionGeneration(connectionGeneration)
        const start = Date.now()
        trace('autopilot', 'sync.start', { ruleId: id, accountId })

        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()
        const limited = ownerBudgetError(authUser)
        if (limited) return sendOwnerBudget429(reply, limited)

        const validationError = await validateRulePayload({ id, accountId, authKey, connectionId, priorityChain, activeUrl, addonList, customCheckUrls })
        if (validationError) {
            reply.status(400);
            return { error: validationError }
        }
        return withAccountWriteLock(authUser, [accountId], async (conn) => {
            if (await isAccountTombstoned(authUser, accountId, conn)) {
                reply.status(409)
                return { error: ACCOUNT_DELETED_ERROR }
            }

            const existingRule = await conn.get('SELECT account_id, auth_key, priority_chain, addon_list, active_url, webhook_url, notify_enabled, is_active, is_automatic, cooldown_ms, message_template, name, owner_sync_user, custom_check_urls, platform, connection_id, connection_generation FROM autopilot_rules WHERE id = $1', [id])

            if (existingRule && existingRule.owner_sync_user && existingRule.owner_sync_user !== authUser) {
                reply.status(403);
                return { error: 'Forbidden: rule belongs to another user' }
            }
            if (existingRule && !existingRule.owner_sync_user) {
                reply.status(403);
                return { error: 'Forbidden: rule has no owner and cannot be modified' }
            }
            if (existingRule && existingRule.account_id !== accountId) {
                reply.status(409)
                return { error: 'Rule account cannot change' }
            }
            const overlapError = await newOverlapError(conn, authUser, accountId, id, priorityChain, addonList, existingRule)
            if (overlapError) {
                reply.status(409)
                return { ...overlapError, error: overlapError.message }
            }
            if (retargetsEngineOwnedRule(existingRule, { platform, connectionId, is_automatic })) {
                reply.status(409)
                return { error: RULE_RETARGET_REFUSED }
            }

            // Spec F4: unreadable stored blobs must never adopt the client's copy, but rule
            // field edits (name, chain, webhook, ...) still persist ; the upsert runs in
            // preserve mode and enforcement is skipped with a warning surfaced to the client.
            const engineOwnedSyncFieldsResult = engineOwnedSyncFields(existingRule, { addonList, activeUrl, is_automatic })
            const engineOwnedBlocked = engineOwnedSyncFieldsResult.blocked === true
            if (engineOwnedBlocked) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Stored addon state for rule ${id} is unreadable; preserving server blobs, skipping enforcement (rule requires repair).`)
            } else {
                addonList = engineOwnedSyncFieldsResult.addonList
                activeUrl = engineOwnedSyncFieldsResult.activeUrl
            }

            const rulePayload = { authKey, priorityChain, addonList, activeUrl, webhookUrl, notifyEnabled, is_active, is_automatic, cooldown_ms, messageTemplate, name, customCheckUrls }

            try {
                const isEqual = await checkPlaintextEqual(existingRule, rulePayload)
                if (isEqual) {
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Rule unchanged, skipping write.`)
                    if (connectionGenerationToken && existingRule.connection_generation !== connectionGenerationToken) {
                        await refreshRuleConnectionGeneration(conn, existingRule.owner_sync_user || authUser, id, connectionId, connectionGenerationToken)
                    }
                    if (authKey) {
                        const encryptedAuthKey = encrypt(authKey, PRIMARY_KEY)
                        await upsertCredential(existingRule.owner_sync_user || authUser, accountId, name, encryptedAuthKey, (platform || 'stremio').toLowerCase(), connectionId || null, conn, connectionGenerationToken)
                    }
                    if (!engineOwnedBlocked) {
                        await enforceAfterSave({ id, accountId, authKey, connectionId, platform, ownerSyncUser: existingRule.owner_sync_user || authUser, priorityChain, activeUrl, addonList, is_active, is_automatic })
                    }
                    trace('autopilot', 'sync.success', { ruleId: id, accountId, skipped: true, timing: Date.now() - start })
                    return engineOwnedBlocked ? { success: true, skipped: true, warning: STORED_STATE_UNREADABLE } : { success: true, skipped: true }
                }
            } catch (cmpErr) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Plaintext comparison failed, falling back to upsert: ${cmpErr.message}`)
            }

            const saved = await upsertRuleRecord({ id, accountId, name, ...rulePayload, platform, connectionId, connectionGeneration: connectionGenerationToken }, existingRule, authUser, engineOwnedBlocked, conn)
            retireRuleSecrets?.(id, saved.updatedAt)

            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Rule synced to server (Swap & Hide Mode).`)
            if (!engineOwnedBlocked) {
                clearRuleRuntimeState?.(id)
                await enforceAfterSave({ id, accountId, authKey, connectionId, platform, ownerSyncUser: authUser, priorityChain, activeUrl, addonList, is_active, is_automatic })
            }
            trace('autopilot', 'sync.success', { ruleId: id, accountId, skipped: false, timing: Date.now() - start })
            return engineOwnedBlocked ? { success: true, warning: STORED_STATE_UNREADABLE } : { success: true }
        })
    })


    fastify.post('/api/autopilot/sync-batch', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const rules = request.body
        const start = Date.now()
        if (!Array.isArray(rules)) return reply.code(400).send({ error: 'Expected array' })
        if (rules.length > 100) return reply.code(400).send({ error: 'Batch too large. Maximum 100 rules per request.' })
        trace('autopilot', 'batch-sync.start', { count: rules.length })

        const authUser = await verifyAuth(request)
        if (!authUser) return reply.code(401).send({ error: 'Unauthorized' })
        assertWritablePrimary()
        const batchLimited = ownerBudgetError(authUser)
        if (batchLimited) return sendOwnerBudget429(reply, batchLimited)

        const results = []
        for (const ruleData of rules) {
            if (!ruleData || typeof ruleData !== 'object') {
                results.push({ id: null, ok: false, error: 'Invalid rule payload' })
                continue
            }
            const ruleLimited = ownerBudgetError(authUser)
            if (ruleLimited) {
                results.push({ id: ruleData.id || null, ok: false, error: ruleLimited.error, retryAfterMs: ruleLimited.retryAfterMs })
                continue
            }
            let { id, accountId, name, authKey, connectionId, platform, priorityChain, activeUrl, is_active, is_automatic, addonList, webhookUrl, notifyEnabled, cooldown_ms, messageTemplate, customCheckUrls, connectionGeneration } = ruleData
            const connectionGenerationToken = readConnectionGeneration(connectionGeneration)

            const validationError = await validateRulePayload({ id, accountId, authKey, connectionId, priorityChain, activeUrl, addonList, customCheckUrls })
            if (validationError) {
                results.push({ id: id || null, ok: false, error: validationError })
                continue
            }
            await withAccountWriteLock(authUser, [accountId], async (conn) => {
                if (await isAccountTombstoned(authUser, accountId, conn)) {
                    results.push({ id, ok: false, error: ACCOUNT_DELETED_ERROR })
                    return
                }

                try {
                    const existingRule = await conn.get('SELECT account_id, auth_key, priority_chain, addon_list, active_url, webhook_url, notify_enabled, is_active, is_automatic, cooldown_ms, message_template, name, owner_sync_user, custom_check_urls, platform, connection_id, connection_generation FROM autopilot_rules WHERE id = $1', [id])

                    if (existingRule && existingRule.owner_sync_user !== authUser) {
                        results.push({ id, ok: false, error: 'Forbidden' })
                        return
                    }
                    if (existingRule && existingRule.account_id !== accountId) {
                        results.push({ id, ok: false, error: 'Rule account cannot change' })
                        return
                    }
                    const overlapError = await newOverlapError(conn, authUser, accountId, id, priorityChain, addonList, existingRule)
                    if (overlapError) {
                        results.push({ id, ok: false, ...overlapError, error: overlapError.message })
                        return
                    }
                    if (retargetsEngineOwnedRule(existingRule, { platform, connectionId, is_automatic })) {
                        results.push({ id, ok: false, error: RULE_RETARGET_REFUSED })
                        return
                    }

                    const engineOwned = engineOwnedSyncFields(existingRule, { addonList, activeUrl, is_automatic })
                    const engineOwnedBlocked = engineOwned.blocked === true
                    if (engineOwnedBlocked) {
                        fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Stored addon state for rule ${id} is unreadable; preserving server blobs, skipping enforcement (rule requires repair).`)
                    } else {
                        addonList = engineOwned.addonList
                        activeUrl = engineOwned.activeUrl
                    }

                    const rulePayload = { authKey, priorityChain, addonList, activeUrl, webhookUrl, notifyEnabled, is_active, is_automatic, cooldown_ms, messageTemplate, name, customCheckUrls }

                    try {
                        const isEqual = await checkPlaintextEqual(existingRule, rulePayload)
                        if (isEqual) {
                            if (connectionGenerationToken && existingRule.connection_generation !== connectionGenerationToken) {
                                await refreshRuleConnectionGeneration(conn, existingRule.owner_sync_user || authUser, id, connectionId, connectionGenerationToken)
                            }
                            if (authKey) {
                                const encryptedAuthKey = encrypt(authKey, PRIMARY_KEY)
                                await upsertCredential(existingRule.owner_sync_user || authUser, accountId, name, encryptedAuthKey, (platform || 'stremio').toLowerCase(), connectionId || null, conn, connectionGenerationToken)
                            }
                            if (engineOwnedBlocked) {
                                results.push({ id, ok: false, error: STORED_STATE_UNREADABLE })
                                return
                            }
                            await enforceAfterSave({ id, accountId, authKey, connectionId, platform, ownerSyncUser: existingRule.owner_sync_user || authUser, priorityChain, activeUrl, addonList, is_active, is_automatic })
                            results.push({ id, ok: true, skipped: true })
                            return
                        }
                    } catch (cmpErr) {
                        fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Plaintext comparison failed, falling back to upsert: ${cmpErr.message}`)
                    }

                    const saved = await upsertRuleRecord({ id, accountId, name, ...rulePayload, platform, connectionId, connectionGeneration: connectionGenerationToken }, existingRule, authUser, engineOwnedBlocked, conn)
                    retireRuleSecrets?.(id, saved.updatedAt)
                    if (engineOwnedBlocked) {
                        results.push({ id, ok: false, error: STORED_STATE_UNREADABLE })
                        return
                    }

                    clearRuleRuntimeState?.(id)
                    await enforceAfterSave({ id, accountId, authKey, connectionId, platform, ownerSyncUser: authUser, priorityChain, activeUrl, addonList, is_active, is_automatic })
                    results.push({ id, ok: true })
                } catch (e) {
                    fastify.log.error({ category: 'Autopilot' }, `[${maskContext(accountId || id)}] Batch sync failed: ${e.message}`)
                    results.push({ id, ok: false, error: 'Unable to sync Autopilot rule' })
                }
            })
        }

        const okCount = results.filter(r => r.ok).length
        trace('autopilot', 'batch-sync.complete', { count: rules.length, ok: okCount, failed: results.length - okCount, timing: Date.now() - start })
        return { results }
    })


    fastify.get('/api/autopilot/state/:accountId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const ownerCheck = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 LIMIT 1', [accountId, authUser])
        if (!ownerCheck) {
            const hasRules = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 LIMIT 1', [accountId])
            if (hasRules) { reply.status(403); return { error: 'Forbidden' } }
        }

        const readToken = beginRuleCacheRead?.()
        try {
            const rules = await db.query(`
                SELECT r.id, r.updated_at, r.priority_chain, r.active_url, r.webhook_url, r.notify_enabled, r.is_active, r.is_automatic,
                       COALESCE(s.last_check, r.last_check) AS last_check,
                       COALESCE(s.stabilization, r.stabilization) AS stabilization,
                       r.name, r.cooldown_ms, r.custom_check_urls, r.message_template, r.platform, r.connection_id, CASE WHEN r.auth_key IS NULL AND r.connection_id IS NULL THEN 1 ELSE 0 END AS unmonitored
                FROM autopilot_rules r
                LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                WHERE r.account_id = $1 AND r.owner_sync_user = $2
            `, [accountId, authUser])

            return buildAutopilotStates(rules, maskContext(accountId), readToken)
        } catch (err) {
            fastify.log.error({ category: 'Autopilot' }, `State fetch failed for ${maskContext(accountId)}: ${err.message}`)
            reply.status(500)
            return { error: 'Unable to load Autopilot state', lastWorkerRun: serverState.lastWorkerRun, lastCycle: serverState.autopilotLastCycleStats }
        } finally {
            endRuleCacheRead?.(readToken)
        }
    })

    fastify.post('/api/autopilot/active-rules', { bodyLimit: 1024 * 64, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const { accountId, activeRuleIds } = request.body || {}
        if (!accountId || !Array.isArray(activeRuleIds)) {
            reply.status(400); return { error: 'accountId and activeRuleIds required' }
        }

        const ids = activeRuleIds.filter(x => typeof x === 'string' && x)
        const now = Date.now()
        try {
            let result
            if (ids.length > 0) {
                const placeholders = ids.map((_, i) => `$${i + 4}`).join(',')
                result = await db.run(
                    `UPDATE autopilot_rules SET is_active = 0, updated_at = ${nextRuleVersion('$1')}
                     WHERE account_id = $2 AND owner_sync_user = $3 AND is_active = 1 AND id NOT IN (${placeholders})`,
                    [now, accountId, authUser, ...ids]
                )
            } else {
                result = await db.run(
                    `UPDATE autopilot_rules SET is_active = 0, updated_at = ${nextRuleVersion('$1')}
                     WHERE account_id = $2 AND owner_sync_user = $3 AND is_active = 1`,
                    [now, accountId, authUser]
                )
            }
            return { ok: true, deactivated: result?.changes ?? 0 }
        } catch (err) {
            fastify.log.error({ category: 'Autopilot' }, `active-rules prune failed for ${maskContext(accountId)}: ${err.message}`)
            reply.status(500); return { error: 'Failed to reconcile active rules' }
        }
    })

    fastify.get('/api/autopilot/history/:accountId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const ownerCheck = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 LIMIT 1', [accountId, authUser])
        if (!ownerCheck) {
            const hasRules = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 LIMIT 1', [accountId])
            if (hasRules) { reply.status(403); return { error: 'Forbidden' } }
        }

        const history = await db.query('SELECT * FROM failover_history WHERE account_id = $1 AND rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $2) ORDER BY timestamp DESC LIMIT 10', [accountId, authUser])

        const decryptedHistory = (history || []).map(log => ({
            ...log,
            primary_name: log.primary_name ? decrypt(log.primary_name, FALLBACK_KEYS) : log.primary_name,
            backup_name: log.backup_name ? decrypt(log.backup_name, FALLBACK_KEYS) : log.backup_name,
            message: log.message ? decrypt(log.message, FALLBACK_KEYS) : log.message,
            metadata: log.metadata ? decrypt(log.metadata, FALLBACK_KEYS) : null
        }))

        return { history: decryptedHistory }
    })

    fastify.post('/api/autopilot/test-webhook', { bodyLimit: 1024 * 100, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { webhookUrl, accountName } = request.body
        const start = Date.now()
        trace('autopilot', 'test-webhook.start', {})
        if (!webhookUrl) {
            reply.status(400);
            return { error: 'Webhook URL required' }
        }
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        if (!(await isSafeUrlResolved(webhookUrl))) {
            reply.status(400);
            return { error: 'Invalid webhook URL' }
        }

        await sendNotification(webhookUrl, {
            type: 'info',
            message: '🚀 **Connectivity Test Successful**\n\nYour AIOManager Autopilot alerts are configured correctly and active.\n\n**Environment**: High-Scale Optimization\n**Encryption**: AES-256 Verified ✅',
            accountName: accountName || 'Test Account',
            activeName: 'System Test',
            owner: authUser,
        })

        trace('autopilot', 'test-webhook.success', { timing: Date.now() - start })
        return { success: true }
    })

    fastify.get('/api/autopilot/global-webhook', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const url = await getGlobalWebhook(authUser)
        return { configured: !!url, ...(url ? { masked: maskWebhookUrl(url) } : {}) }
    })

    fastify.put('/api/autopilot/global-webhook', { bodyLimit: 1024 * 4, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const { webhookUrl } = request.body || {}
        if (typeof webhookUrl !== 'string') { reply.status(400); return { error: 'webhookUrl (string) required' } }
        const trimmed = webhookUrl.trim()
        if (trimmed === '') {
            await setGlobalWebhook(authUser, null)
            return { configured: false }
        }
        if (!/^https?:\/\//i.test(trimmed)) { reply.status(400); return { error: 'Webhook URL must be http(s)' } }
        if (!(await isSafeUrlResolved(trimmed))) { reply.status(400); return { error: 'Invalid webhook URL' } }

        await setGlobalWebhook(authUser, trimmed)
        return { configured: true, masked: maskWebhookUrl(trimmed) }
    })

    fastify.post('/api/autopilot/test-url', { bodyLimit: 1024 * 100, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { url } = request.body
        if (!url || typeof url !== 'string') {
            reply.status(400);
            return { error: 'URL required' }
        }
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        if (!(await isSafeUrlResolved(url))) {
            reply.status(400);
            return { error: 'Invalid URL' }
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)
        try {
            const probe = { signal: controller.signal, maxHops: 3, discardBody: true }
            let response = await guardedFetch(url, { ...probe, method: 'HEAD' })
            if (response.status === 404 || response.status === 405) response = await guardedFetch(url, { ...probe, method: 'GET' })
            const ok = response.status >= 200 && response.status < 300
            return { ok, status: response.status }
        } catch (err) {
            if (err && (err.code === 'ssrf-blocked' || err.code === 'too-many-redirects')) return { ok: false, status: 0, error: 'Blocked unsafe redirect or no response' }
            const isTimeout = err && (err.name === 'AbortError' || err.code === 'timeout' || err.code === 'connect-timeout')
            return { ok: false, status: 0, error: isTimeout ? 'Timed out after 10s' : 'Request failed' }
        } finally {
            clearTimeout(timeout)
        }
    })

    fastify.post('/api/autopilot/:id/pause', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) return reply.code(401).send({ error: 'Unauthorized' })
        assertWritablePrimary()
        const { id } = request.params
        const rule = await db.get('SELECT account_id FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, authUser])
        if (!rule) return reply.code(404).send({ error: 'Rule not found' })
        return withAccountWriteLock(authUser, [rule.account_id], async (conn) => {
            const current = await conn.get('SELECT account_id FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, authUser])
            if (!current || current.account_id !== rule.account_id) return reply.code(404).send({ error: 'Rule not found' })
            const now = Date.now()
            await ownerSaveDb(authUser, conn).run(`UPDATE autopilot_rules SET is_active = 0, updated_at = ${nextRuleVersion('$1')}, edited_at = $2 WHERE id = $3 AND account_id = $4 AND owner_sync_user = $5 AND is_active <> 0`, [now, now, id, rule.account_id, authUser])
            clearRuleRuntimeState?.(id)
            return { success: true }
        })
    })

    fastify.post('/api/autopilot/:id/retry-conflict', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) return reply.code(401).send({ error: 'Unauthorized' })
        assertWritablePrimary()
        const { id } = request.params
        const rule = await db.get('SELECT account_id FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, authUser])
        if (!rule) return reply.code(404).send({ error: 'Rule not found' })
        return withAccountWriteLock(authUser, [rule.account_id], async (conn) => {
            const current = await conn.get('SELECT account_id FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2', [id, authUser])
            if (!current || current.account_id !== rule.account_id) return reply.code(404).send({ error: 'Rule not found' })
            if (typeof autopilotEngine.retryContestedRule !== 'function') return reply.code(503).send({ error: 'Conflict retry is unavailable' })
            autopilotEngine.retryContestedRule(id)
            return { success: true }
        })
    })

    fastify.delete('/api/autopilot/:id', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { id } = request.params
        const start = Date.now()
        trace('autopilot', 'delete.start', { ruleId: id })
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const rule = await db.get('SELECT owner_sync_user FROM autopilot_rules WHERE id = $1', [id])
        if (rule && rule.owner_sync_user !== authUser) {
            reply.status(403);
            return { error: 'Forbidden' }
        }

        const removed = await db.tx(async (tx) => {
            const rows = await tx.query('DELETE FROM autopilot_rules WHERE id = $1 AND owner_sync_user = $2 RETURNING id, updated_at', [id, authUser])
            if (rows.length) await tx.run('DELETE FROM autopilot_rule_stats WHERE rule_id = $1', [id])
            return rows
        })
        retireRuleCaches?.(removed)
        clearRuleRuntimeState?.(id)
        trace('autopilot', 'delete.success', { ruleId: id, timing: Date.now() - start })
        return { success: true }
    })

    fastify.delete('/api/autopilot/account/:accountId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const ownerCheck = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 LIMIT 1', [accountId, authUser])
        if (!ownerCheck) {
            const hasRules = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 LIMIT 1', [accountId])
            if (hasRules) { reply.status(403); return { error: 'Forbidden' } }
            return { success: true, deleted: 0 }
        }

        const result = await db.tx(async (tx) => {
            const removed = await tx.query('DELETE FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 RETURNING id, updated_at', [accountId, authUser])
            const ruleIds = removed.map(r => r.id)
            for (let offset = 0; offset < ruleIds.length; offset += 500) {
                const ids = ruleIds.slice(offset, offset + 500)
                const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
                await tx.run(`DELETE FROM autopilot_rule_stats WHERE rule_id IN (${placeholders})`, ids)
                await tx.run(`DELETE FROM failover_history WHERE rule_id IN (${placeholders})`, ids)
            }
            return { changes: removed.length, ruleIds: removed }
        })
        retireRuleCaches?.(result.ruleIds)
        clearAccountRuleRuntimeState?.(accountId)
        fastify.log.info({ category: 'Autopilot' }, `Bulk-deleted rules for account ${maskContext(accountId)}...`)
        return { success: true, deleted: result?.changes || 0 }
    })

    fastify.get('/api/accounts/server-residue', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const rows = new Map()
        const collect = (list, key) => {
            for (const row of list || []) {
                if (!row?.account_id) continue
                const entry = rows.get(row.account_id) || { accountId: row.account_id, rules: 0, credentials: 0, canonical: 0, newest: {} }
                entry[key] += Number(row.count) || 0
                entry.newest[key] = Math.max(entry.newest[key] || 0, Number(row.newest) || 0)
                rows.set(row.account_id, entry)
            }
        }
        collect(await db.query('SELECT account_id, COUNT(*) AS count, MAX(COALESCE(edited_at, updated_at, 0)) AS newest FROM autopilot_rules WHERE owner_sync_user = $1 AND account_id IS NOT NULL GROUP BY account_id', [authUser]), 'rules')
        collect(await db.query('SELECT account_id, COUNT(*) AS count, MAX(COALESCE(updated_at, 0)) AS newest FROM server_credentials WHERE sync_user = $1 AND account_id IS NOT NULL GROUP BY account_id', [authUser]), 'credentials')
        collect(await db.query('SELECT account_id, COUNT(*) AS count, MAX(COALESCE(updated_at, 0)) AS newest FROM account_canonical_addons WHERE sync_user = $1 AND account_id IS NOT NULL GROUP BY account_id', [authUser]), 'canonical')
        // A live rule rotates its account's provider tokens and engine commits bump updated_at, so
        // with rules present only the rules' edited_at (user saves) says whether the account is in use.
        const accounts = [...rows.values()].map(({ newest, ...entry }) => ({
            ...entry,
            newestUpdatedAt: entry.rules > 0 ? (newest.rules || 0) : Math.max(newest.credentials || 0, newest.canonical || 0),
        }))
        const ruleRows = await db.query(
            `SELECT r.id, r.account_id, r.platform, r.connection_id, r.edited_at,
                    CASE WHEN r.auth_key IS NOT NULL AND r.auth_key <> '' AND COALESCE(r.platform, 'stremio') = 'stremio' THEN 1 ELSE 0 END AS has_stremio_key,
                    CASE WHEN EXISTS (SELECT 1 FROM server_credentials c WHERE c.sync_user = r.owner_sync_user AND c.account_id = r.account_id
                        AND ((r.connection_id IS NOT NULL AND c.connection_id = r.connection_id)
                            OR (r.connection_id IS NULL AND (c.credential_type = 'stremio' OR c.credential_type IS NULL)))) THEN 1 ELSE 0 END AS has_connection
             FROM autopilot_rules r WHERE r.owner_sync_user = $1 ORDER BY r.account_id, r.id`,
            [authUser]
        )
        const rules = ruleRows.map(row => ({
            ruleId: row.id,
            accountId: row.account_id,
            platform: row.platform || 'stremio',
            connectionId: row.connection_id || null,
            hasConnection: Number(row.has_connection) === 1,
            hasStremioKey: Number(row.has_stremio_key) === 1,
            editedAt: Number(row.edited_at) || 0,
        }))
        return { accounts: accounts.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0)), rules }
    })

    fastify.delete('/api/accounts/:accountId/server-state', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()
        const start = Date.now()

        let removedRuleIds = []
        const counts = await withAccountWriteLock(authUser, [accountId], (conn) => conn.tx(async (tx) => {
            removedRuleIds = await tx.query('DELETE FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 RETURNING id, updated_at', [accountId, authUser])
            const ruleIds = removedRuleIds.map(r => r.id)
            for (let offset = 0; offset < ruleIds.length; offset += 500) {
                const ids = ruleIds.slice(offset, offset + 500)
                const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
                await tx.run(`DELETE FROM autopilot_rule_stats WHERE rule_id IN (${placeholders})`, ids)
                await tx.run(`DELETE FROM failover_history WHERE rule_id IN (${placeholders})`, ids)
            }
            const rules = { changes: removedRuleIds.length }
            const credentials = await tx.run('DELETE FROM server_credentials WHERE account_id = $1 AND sync_user = $2', [accountId, authUser])
            const canonical = await tx.run('DELETE FROM account_canonical_addons WHERE account_id = $1 AND sync_user = $2', [accountId, authUser])
            await tx.run('DELETE FROM account_addon_actions WHERE account_id = $1 AND sync_user = $2', [accountId, authUser])
            await deleteAccountActivity(tx, authUser, accountId)
            await recordAccountTombstone(tx, authUser, accountId)
            return { rules: rules?.changes || 0, credentials: credentials?.changes || 0, canonical: canonical?.changes || 0 }
        }))
        retireRuleCaches?.(removedRuleIds)
        if (counts.rules > 0) {
            clearAccountRuleRuntimeState?.(accountId)
            const { invalidateConnectionCache } = await import('../providers/reconciler.js')
            invalidateConnectionCache(authUser)
        }
        trace('autopilot', 'server-state.delete', { accountId: maskContext(accountId), rules: counts.rules, credentials: counts.credentials, canonical: counts.canonical, timing: Date.now() - start })
        return { success: true, ...counts }
    })

    // An explicit account restore re-allows rule and credential writes for it.
    fastify.delete('/api/accounts/:accountId/server-tombstone', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()
        const lifted = await liftAccountTombstone(authUser, accountId)
        trace('autopilot', 'server-tombstone.lift', { accountId: maskContext(accountId), lifted })
        return { success: true, lifted }
    })

    // The account's last Stremio login was removed: its per-connection and account-level
    // Stremio rows go, every other provider's credential stays. The delete is bound to the
    // removal moment (client clock, mapped onto the server clock through sentAt), so a
    // login registered after the removal is never caught by a late retry.
    fastify.delete('/api/accounts/:accountId/server-state/stremio-credentials', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()
        const removedAt = Number(request.query?.removedAt)
        const sentAt = Number(request.query?.sentAt)
        if (!Number.isFinite(removedAt) || !Number.isFinite(sentAt) || removedAt > sentAt) {
            reply.status(400)
            return { error: 'removedAt and sentAt are required' }
        }
        const cutoff = removedAt + (Date.now() - sentAt)
        const stremioRows = "account_id = $1 AND sync_user = $2 AND (credential_type = 'stremio' OR credential_type IS NULL)"

        const { credentials, kept } = await withAccountWriteLock(authUser, [accountId], async (conn) => {
            const result = await conn.run(`DELETE FROM server_credentials WHERE ${stremioRows} AND COALESCE(updated_at, 0) <= $3`, [accountId, authUser, cutoff])
            const remaining = await conn.get(`SELECT COUNT(*) AS count FROM server_credentials WHERE ${stremioRows}`, [accountId, authUser])
            return { credentials: result?.changes || 0, kept: Number(remaining?.count) || 0 }
        })
        if (credentials > 0) {
            const { invalidateConnectionCache } = await import('../providers/reconciler.js')
            invalidateConnectionCache(authUser)
        }
        trace('autopilot', 'stremio-credentials.delete', { accountId: maskContext(accountId), credentials, kept })
        return { success: true, credentials, kept }
    })

    // A removed connection's server-side residue goes in one owner-scoped operation:
    // the Autopilot rules bound to it (their stored addon_list and priority chain
    // included) with stats and history, plus its credential rows. Without this the
    // engine keeps a live rule's snapshot pushing to the removed connection, or the
    // surviving credentials keep receiving the wrong platform's list. Cleanup happens
    // once here; the worker never rewrites addon_list or priority_chain per cycle.
    // The optional generation is the removed incarnation's token: the delete claims
    // only rows of that generation, so a cleanup delayed past a same-id re-add cannot
    // remove the re-added incarnation's rows. Null-generation rows (pre-migration or
    // older clients) are claimed only while no row of a different generation exists
    // for this connection, in either table: such a row proves a newer incarnation
    // re-registered. A request carrying no generation (older client) may only claim
    // null rows, never a newer client's generation rows.
    fastify.delete('/api/accounts/:accountId/server-state/connection/:connectionId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId, connectionId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()
        if (!connectionId) { reply.status(400); return { error: 'connectionId is required' } }
        const generation = readConnectionGeneration(request.query?.generation)
        const start = Date.now()

        let removedRuleIds = []
        const counts = await withAccountWriteLock(authUser, [accountId], (conn) => conn.tx(async (tx) => {
            let claimLegacy = 1
            if (generation) {
                const newerRule = await tx.get(
                    `SELECT 1 AS newer FROM autopilot_rules
                     WHERE account_id = $1 AND owner_sync_user = $2 AND connection_id = $3
                       AND connection_generation IS NOT NULL AND connection_generation <> $4 LIMIT 1`,
                    [accountId, authUser, connectionId, generation])
                const newerCredential = newerRule ? null : await tx.get(
                    `SELECT 1 AS newer FROM server_credentials
                     WHERE account_id = $1 AND sync_user = $2 AND connection_id = $3
                       AND connection_generation IS NOT NULL AND connection_generation <> $4 LIMIT 1`,
                    [accountId, authUser, connectionId, generation])
                if (newerRule || newerCredential) claimLegacy = 0
            }
            const generationFilter = generation
                ? 'AND (connection_generation = $4 OR (connection_generation IS NULL AND $5 = 1))'
                : 'AND connection_generation IS NULL'
            const scopedParams = generation ? [accountId, authUser, connectionId, generation, claimLegacy] : [accountId, authUser, connectionId]
            removedRuleIds = await tx.query(`DELETE FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 AND connection_id = $3 ${generationFilter} RETURNING id, updated_at`, scopedParams)
            const ruleIds = removedRuleIds.map(r => r.id)
            for (let offset = 0; offset < ruleIds.length; offset += 500) {
                const ids = ruleIds.slice(offset, offset + 500)
                const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
                await tx.run(`DELETE FROM autopilot_rule_stats WHERE rule_id IN (${placeholders})`, ids)
                await tx.run(`DELETE FROM failover_history WHERE rule_id IN (${placeholders})`, ids)
            }
            const rules = { changes: removedRuleIds.length }
            const credentials = await tx.run(`DELETE FROM server_credentials WHERE account_id = $1 AND sync_user = $2 AND connection_id = $3 ${generationFilter}`, scopedParams)
            return { rules: rules?.changes || 0, credentials: credentials?.changes || 0 }
        }))
        retireRuleCaches?.(removedRuleIds)
        if (counts.rules > 0) clearAccountRuleRuntimeState?.(accountId)
        const { invalidateConnectionCache } = await import('../providers/reconciler.js')
        invalidateConnectionCache(authUser)
        trace('autopilot', 'connection-state.delete', { accountId: maskContext(accountId), connectionId: maskContext(connectionId), rules: counts.rules, credentials: counts.credentials, generationScoped: Boolean(generation), timing: Date.now() - start })
        return { success: true, ...counts }
    })

    fastify.delete('/api/autopilot/history/:accountId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountId } = request.params
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const ownerCheck = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 AND owner_sync_user = $2 LIMIT 1', [accountId, authUser])
        if (!ownerCheck) {
            const hasRules = await db.get('SELECT 1 FROM autopilot_rules WHERE account_id = $1 LIMIT 1', [accountId])
            if (hasRules) { reply.status(403); return { error: 'Forbidden' } }
        }

        const result = await db.run('DELETE FROM failover_history WHERE account_id = $1 AND rule_id IN (SELECT id FROM autopilot_rules WHERE owner_sync_user = $2)', [accountId, authUser])
        fastify.log.info({ category: 'Autopilot' }, `Cleared autopilot history for account ${maskContext(accountId)}`)
        return { success: true, deleted: result?.changes || 0 }
    })


    fastify.get('/api/autopilot/pulse', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const row = await db.get('SELECT COUNT(*) as count FROM autopilot_rules WHERE owner_sync_user = $1 AND is_active = 1', [authUser])
        // Read-only version of the owner's rule state (count + newest rule/stats update). Both
        // updated_at columns are bumped by every engine and user write, so an unchanged version
        // lets the client skip the states pull. No writes of any kind here.
        const versionRows = await db.query(
            `SELECT r.id, r.updated_at AS rules_updated, s.updated_at AS stats_updated
             FROM autopilot_rules r
             LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
             WHERE r.owner_sync_user = $1`,
            [authUser]
        )
        let rulesUpdated = 0, statsUpdated = 0, memoryRevision = 0
        for (const v of versionRows || []) {
            rulesUpdated = Math.max(rulesUpdated, Number(v.rules_updated) || 0)
            statsUpdated = Math.max(statsUpdated, Number(v.stats_updated) || 0)
            memoryRevision = Math.max(memoryRevision, getRuleRevision?.(v.id) || 0)
        }
        const stateVersion = `${(versionRows || []).length}:${rulesUpdated}:${statsUpdated}:${memoryRevision}`
        // Global tripwire state only: when it tripped and why, no per-user data.
        const tripped = autopilotTripwire.status()
        const safeMode = tripped ? { since: tripped.since, reason: tripped.reason } : null
        // Memory only: watchdog trips since boot and how long ago the last cycle finished.
        const watchdog = serverState.autopilotWatchdog
        const endedAt = serverState.autopilotLastCycleEndedAt
        return {
            lastWorkerRun: serverState.lastWorkerRun, activeRuleCount: row?.count || 0, lastCycle: serverState.autopilotLastCycleStats, safeMode,
            lastCycleAgeMs: endedAt ? Math.max(0, Date.now() - endedAt) : null,
            watchdog: watchdog ? { trips: watchdog.trips, lastTripAt: watchdog.lastTripAt } : null,
            stateVersion,
            // Global worker flag from the same AUTOPILOT_WORKER parsing boot used; no per-user data.
            workerEnabled: autopilotWorkerEnabled(),
        }
    })


    fastify.post('/api/autopilot/states', { bodyLimit: 1024 * 100, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { accountIds, limit, offset } = request.body || {}
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        if (!Array.isArray(accountIds) || accountIds.length === 0) { return {} }
        if (accountIds.length > MAX_BATCH_STATE_ACCOUNTS) { reply.status(400); return { error: `Too many account IDs (max ${MAX_BATCH_STATE_ACCOUNTS})` } }

        const readToken = beginRuleCacheRead?.()
        try {
            const placeholders = accountIds.map((_, i) => `$${i + 2}`).join(',')
            const rules = await db.query(
                `SELECT r.id, r.updated_at, r.account_id, r.priority_chain, r.active_url, r.webhook_url, r.notify_enabled, r.is_active, r.is_automatic,
                        COALESCE(s.last_check, r.last_check) AS last_check,
                        COALESCE(s.stabilization, r.stabilization) AS stabilization,
                        r.name, r.cooldown_ms, r.custom_check_urls, r.message_template, r.platform, r.connection_id, CASE WHEN r.auth_key IS NULL AND r.connection_id IS NULL THEN 1 ELSE 0 END AS unmonitored
                 FROM autopilot_rules r
                 LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                 WHERE r.owner_sync_user = $1 AND r.account_id IN (${placeholders})`,
                [authUser, ...accountIds]
            )

            const allRules = rules || []
            const totalCount = allRules.length
            const slicedRules = (limit != null && offset != null)
                ? allRules.slice(offset, offset + limit)
                : allRules

            const result = {}
            let skippedCount = 0
            for (const rule of slicedRules) {
                if (!result[rule.account_id]) result[rule.account_id] = []
                try {
                    result[rule.account_id].push(buildAutopilotState(rule, readToken))
                } catch (err) {
                    skippedCount++
                    fastify.log.error({ category: 'Autopilot' }, `Failed to decrypt rule ${rule.id}: ${err.message}`)
                }
            }
            return {
                states: result,
                lastWorkerRun: serverState.lastWorkerRun,
                totalCount,
                lastCycle: serverState.autopilotLastCycleStats,
                partial: skippedCount > 0,
                skippedCount
            }
        } finally {
            endRuleCacheRead?.(readToken)
        }
    })

}
