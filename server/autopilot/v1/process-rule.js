import { autopilotDb as db } from '../write-tripwire.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { decrypt } from '../../crypto.js'
import { FALLBACK_KEYS } from '../../keys.js'
import { isSafeUrlResolved } from '../../utils/ssrf.js'
import { maskContext } from '../../utils/log-helpers.js'
import { isUnifiedEnforcement } from '../../config.js'
import { applyOneActiveFlags, applyAccountChainFlags, chainMemberStates, violationFromStates } from '../one-active.js'
import { withCurrentDestinations } from './destinations.js'
import { unpushedConnectionIds } from './writers.js'
import { evaluateRuleSkip, customCheckUrlsFor, decideTarget, stabilizationFrom } from './failover-evaluate.js'
import { TRANSITION_MESSAGES } from './failover-decision.js'
import { stableStringify } from './commit.js'
import { ownerPredicate } from './owner-scope.js'
import { urlRef, scrubUrls } from './url-ref.js'
import { switchReason, platformResults } from './history-detail.js'
import { PROBE_TIMEOUT_MS } from '../health-checks.js'
import { assertAccountActive, ownerCanWrite, accountBlockedInSnapshot, gateCode, AuthStateError, StateUnavailableError } from '../../admin/account-state.js'

// Reconcile outcomes that mean the push did not happen and should be retried.
const RETRYABLE_RECONCILE = new Set(['failed', 'skipped:backoff', 'skipped:auth-cooldown'])
const reconcileOutcomeKey = (outcome) => (outcome ? (outcome.outcome === 'skipped' ? `skipped:${outcome.reason}` : outcome.outcome) : null)

export function createProcessRule({
    fastify, nowMs, reconciler, decryptRuleField, runtimeState, cycleTargets, siblingChainPlans,
    memberStatus, getHealthLatency, isSubstantial, fetchManifestRaw,
    buildReconciledList, writeStremioCollection, enforceConnectionOnly, syncStremioLive,
    recordFailoverHistory, notifyTransition, deepAudit, planCommit,
    ruleSnapshots = null, connectionRetry = null, stremioDriver = null,
}) {
    const { setRuleRuntimeState, getRuleRuntimeState, clearRuleRuntimeState } = runtimeState
    const noteCheckError = runtimeState.setRuleCheckError ?? (() => {})
    const clearCheckError = runtimeState.clearRuleCheckError ?? (() => {})
    const canWrite = async (rule) => {
        // In-memory owner-state check: a blocked account behaves like a paused rule
        // (zero DB reads, zero platform writes from the write boundaries below).
        if (!(await ownerCanWrite(rule.owner_sync_user))) return false
        const [sql, params] = ownerPredicate(rule.owner_sync_user, 3)
        return !!await db.get(`SELECT 1 FROM autopilot_rules WHERE id = $1 AND account_id = $2 AND is_active = 1${sql} LIMIT 1`, [rule.id, rule.account_id, ...params])
    }

    const recordRuleDecryptFailure = async (rule) => {
        const runtime = getRuleRuntimeState(rule.id) || {}
        const decryptFailures = (runtime.decryptFailures || 0) + 1
        const now = nowMs()
        setRuleRuntimeState(rule.id, {
            ...runtime,
            accountId: rule.account_id,
            lastCheck: now,
            decryptFailures
        })
        if (decryptFailures >= 3) {
            const [ownerSql, ownerParams] = ownerPredicate(rule.owner_sync_user, 4)
            await db.run(`UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2 AND account_id = $3${ownerSql}`, [now, rule.id, rule.account_id, ...ownerParams])
            clearRuleRuntimeState(rule.id)
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Disabled rule ${rule.id} after repeated decrypt failures.`)
        }
    }

    // Re-pushes the current target to the native connections an earlier push missed. Never touches the DB:
    // a Stremio rule mirrors the live Stremio collection, a connection-only rule its stored list.
    const retryConnectionPush = async (rule, entry, ctx) => {
        const { decryptedAuthKey, chain, targetActiveUrl, normalizedTarget, normalizedChain, siblingPlans, preserveUrls = [] } = ctx
        // Account state gate: a blocked owner drops the queue entry entirely, with
        // zero platform calls; it is never rescheduled while blocked.
        try {
            await assertAccountActive(rule.owner_sync_user)
        } catch (stateErr) {
            if (gateCode(stateErr)) {
                connectionRetry.clear(rule.id)
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push retry dropped: the account owner is blocked (${gateCode(stateErr)}).`)
                return
            }
            throw stateErr
        }
        const attempt = entry.attempts + 1
        let unreached = entry.connectionIds
        try {
            if (decryptedAuthKey) {
                const connections = (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user) || [])
                    .filter(c => c.enabled && c.platform !== 'stremio' && (!entry.connectionIds || entry.connectionIds.includes(c.id)))
                if (connections.length === 0) { connectionRetry.clear(rule.id); return }
                const live = await stremioDriver.readAddons(decryptedAuthKey)
                const own = applyOneActiveFlags(live, normalizedChain, normalizedTarget, preserveUrls).list
                const list = await withCurrentDestinations(own, rule.account_id, rule.owner_sync_user)
                const result = await reconciler.enforceAccount(rule.account_id, connections, list, { requiredUrls: chain, requiredActiveUrl: targetActiveUrl, canWrite: () => canWrite(rule), ...(preserveUrls.length > 0 ? { preserveUrls } : {}) })
                runtimeState.conflicts?.recordWrite(rule, normalizedChain.filter(url => !preserveUrls.includes(url)), normalizedTarget, connections.filter(c => !unpushedConnectionIds(connections, result).includes(c.id)).map(c => c.id))
                unreached = unpushedConnectionIds(connections, result)
            } else {
                const result = await enforceConnectionOnly(rule, await ctx.ensureUpdatedAddonList(), chain, targetActiveUrl, siblingPlans, ctx.getMirrorChainUrls(), entry.connectionIds)
                if (result.synced.length === 0 && !result.failedIds) { connectionRetry.clear(rule.id); return }
                unreached = result.failedIds || []
                runtimeState.conflicts?.recordWrite(rule, normalizedChain.filter(url => !preserveUrls.includes(url)), normalizedTarget, result.syncedIds || [])
            }
        } catch (err) {
            if (err instanceof AuthStateError || err instanceof StateUnavailableError) {
                // Blocked mid-retry: drop the entry. State unavailable: retain the
                // retry with backoff. Neither records a connection failure.
                if (err instanceof AuthStateError) {
                    connectionRetry.clear(rule.id)
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push retry dropped mid-flight: ${gateCode(err)}.`)
                    return
                }
                connectionRetry.schedule(rule.id, { accountId: rule.account_id, target: normalizedTarget, connectionIds: unreached })
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push retry deferred: account state cannot be verified.`)
                return
            }
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push retry failed: ${scrubUrls(err.message)}`)
        }
        if (unreached && unreached.length === 0) {
            connectionRetry.clear(rule.id)
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push confirmed after ${attempt} attempt(s).`)
            return
        }
        // Snapshot recheck before rescheduling: a block that landed mid-retry drops
        // the entry instead of arming another attempt against a blocked owner.
        if (accountBlockedInSnapshot(rule.owner_sync_user)) {
            connectionRetry.clear(rule.id)
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push retry dropped before reschedule: the account owner is blocked.`)
            return
        }
        connectionRetry.schedule(rule.id, { accountId: rule.account_id, target: normalizedTarget, connectionIds: unreached })
    }

    const processAutopilotRule = async (rule, siblingRows = null) => {
        // Account state gate at entry: the throw lands in the scheduler's catch, so a
        // blocked owner produces no probe, no platform call and no commit plan.
        await assertAccountActive(rule.owner_sync_user)
        if (rule.is_automatic === 0) {
            // Skip automatic switching for manual-only rules
            return
        }
        const decryptedAuthKey = decryptRuleField(rule, 'auth_key')
        const decryptedChainStr = decryptRuleField(rule, 'priority_chain')
        const hasConnectionTarget = !!rule.connection_id && !!rule.platform && rule.platform !== 'stremio'
        if (!decryptedChainStr || (!decryptedAuthKey && !hasConnectionTarget)) {
            fastify.log.error({ category: 'Autopilot', fmt: 'ap.enforce_skip', acct: rule.account_id, reason: 'undecryptable' }, `[${maskContext(rule.account_id)}] Failed to decrypt rule data. Skipping.`)
            noteCheckError(rule.id, rule.account_id, 'decrypt_failed', 'Rule data could not be decrypted')
            await recordRuleDecryptFailure(rule)
            return
        }
        const decryptedActiveUrl = decryptRuleField(rule, 'active_url') || rule.active_url
        let shouldUpdateNotificationTime = false

        let chain = []
        try {
            if (Array.isArray(decryptedChainStr)) {
                chain = decryptedChainStr
            } else if (typeof decryptedChainStr === 'string' && decryptedChainStr.startsWith('[')) {
                chain = JSON.parse(decryptedChainStr)
            } else if (typeof rule.priority_chain === 'string' && rule.priority_chain.startsWith('[')) {
                chain = JSON.parse(rule.priority_chain)
            }
        } catch (e) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Chain parse failed: ${scrubUrls(e.message)}`)
        }

        chain = (await Promise.all(chain.map(async url => (await isSafeUrlResolved(url)) ? url : null))).filter(Boolean)

        // Other rules of this account own the other chains; never write their state from
        // this rule's snapshot, it is stale from the moment they swap.
        let siblingPlans = await siblingChainPlans(rule.account_id, rule.id, chain, rule.owner_sync_user, siblingRows)
        let preserveUrls = siblingPlans.contestedUrls || []
        let overlapUrls = siblingPlans.overlapUrls || []
        const showConflict = (held = runtimeState.conflicts?.getHold(rule.id)) => {
            if (overlapUrls.length > 0) {
                noteCheckError(rule.id, rule.account_id, 'chain_overlap', 'An addon is in multiple Autopilot rules. Remove it from one.', { affectedRefs: overlapUrls.map(url => urlRef(url)) })
                return true
            }
            if (held) {
                noteCheckError(rule.id, rule.account_id, 'contested_by_other_writer', 'Another writer keeps changing these addons. Enforcement is paused.', held)
                return true
            }
            return false
        }
        const conflictHeartbeat = (extra = {}) => {
            const runtime = getRuleRuntimeState(rule.id) || {}
            const stabilization = extra.stabilization || runtime.stabilization || {}
            return planCommit({
                rule, stabilization, needsSync: false, syncSucceeded: true, hasChanged: false,
                decryptedActiveUrl, targetActiveUrl: decryptedActiveUrl || chain[0],
                shouldUpdateNotificationTime: false, lastDeepAuditToSave: extra.lastDeepAudit ?? runtime.lastDeepAudit,
            })
        }
        const skipContestedTarget = target => preserveUrls.includes(normalizeAddonUrl(target))
        if (siblingPlans.readFailed) {
            noteCheckError(rule.id, rule.account_id, 'sync_failed', 'Sibling rule state could not be read safely. Enforcement will retry.')
            return conflictHeartbeat()
        }
        if (skipContestedTarget(decryptedActiveUrl || chain[0])) {
            showConflict()
            return conflictHeartbeat()
        }

        const skipReason = evaluateRuleSkip({ monitorable: true, chain })
        if (skipReason) {
            fastify.log.error({ category: 'Autopilot', fmt: 'ap.enforce_skip', acct: rule.account_id, reason: 'no-chain' }, `[${maskContext(rule.account_id)}] No valid priority chain. Skipping.`)
            setRuleRuntimeState(rule.id, {
                ...(getRuleRuntimeState(rule.id) || {}),
                accountId: rule.account_id,
                skipReason
            })
            return
        }

        const normalizedChainUrls = chain.map(u => normalizeAddonUrl(u).toLowerCase())
        const currentActiveNorm = normalizeAddonUrl(decryptedActiveUrl || chain[0]).toLowerCase()
        const chainKey = normalizedChainUrls.join('\n')

        // addon_list is loaded only when a swap, an enforcement or an audit needs it. A cache-hit row arrives
        // without it; its chain-member summary answers the steady-state violation check instead.
        let addonList = null
        let addonListRaw = null
        let storedAddonListKey = null
        const adoptAddonList = (raw) => {
            addonListRaw = raw
            let parsed = []
            try {
                const decrypted = raw ? decrypt(raw, FALLBACK_KEYS) : null
                if (Array.isArray(decrypted)) {
                    parsed = decrypted
                } else if (typeof decrypted === 'string' && decrypted.startsWith('[')) {
                    parsed = JSON.parse(decrypted)
                } else if (typeof raw === 'string' && raw.startsWith('[')) {
                    parsed = JSON.parse(raw)
                }
            } catch (e) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Addon list parse failed: ${scrubUrls(e.message)}`)
            }
            addonList = parsed
            storedAddonListKey = stableStringify(addonList)
            const relevantUrls = new Set([...normalizedChainUrls, ...siblingPlans.flatMap(plan => [...plan.urls, plan.target])])
            const identities = addonList.filter(addon => addon?.manifest?.id && relevantUrls.has(normalizeAddonUrl(addon.transportUrl)))
                .map(addon => ({ transportUrl: addon.transportUrl, manifest: { id: addon.manifest.id } }))
            ruleSnapshots?.set(rule.id, rule.updated_at, { chainKey, members: chainMemberStates(addonList, normalizedChainUrls), identities })
        }
        if (rule.addon_list !== undefined) adoptAddonList(rule.addon_list)
        const ensureAddonList = async () => {
            if (addonList) return addonList
            const held = ruleSnapshots?.getList?.(rule.id, rule.updated_at)
            if (held != null) {
                adoptAddonList(held)
                return addonList
            }
            const [ownerSql, ownerParams] = ownerPredicate(rule.owner_sync_user, 3)
            const row = await db.get(`SELECT addon_list, updated_at FROM autopilot_rules WHERE id = $1 AND account_id = $2${ownerSql}`, [rule.id, rule.account_id, ...ownerParams])
            if (!row || (row.updated_at ?? null) !== (rule.updated_at ?? null)) {
                throw Object.assign(new Error('Rule changed during the check; it is re-read next cycle'), { code: 'rule_changed' })
            }
            adoptAddonList(row.addon_list)
            return addonList
        }

        let customChecks = []
        try {
            const raw = rule.custom_check_urls
            let parsed = null
            if (typeof raw === 'string' && raw.length > 0) {
                const decrypted = decryptRuleField(rule, 'custom_check_urls')
                if (decrypted && decrypted.startsWith('[')) {
                    parsed = JSON.parse(decrypted)
                } else if (raw.startsWith('[')) {
                    parsed = JSON.parse(raw)
                }
            } else if (Array.isArray(raw)) {
                parsed = raw
            }
            if (Array.isArray(parsed)) {
                customChecks = parsed.map(item => {
                    if (typeof item === 'string') return item.trim() ? { url: item, appliesTo: [] } : null
                    if (item && typeof item === 'object' && typeof item.url === 'string') {
                        return { url: item.url, appliesTo: Array.isArray(item.appliesTo) ? item.appliesTo.filter(u => typeof u === 'string') : [] }
                    }
                    return null
                }).filter(Boolean).filter(c => c.url)
            }
        } catch (e) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Custom check URLs parse failed: ${scrubUrls(e.message)}`)
        }

        let targetActiveUrl = decryptedActiveUrl || chain[0]
        let foundOnline = false

        // Health is the shared state of each member's target (host-health-table.js), one evaluation per
        // target per cycle for every rule and owner. The rule only reads it and decides.
        const activeIndex = normalizedChainUrls.indexOf(currentActiveNorm)
        const members = await Promise.all(chain.map((url, i) => memberStatus(url, {
            owner: rule.owner_sync_user,
            inUse: i === activeIndex,
            ruleId: rule.id,
            accountId: rule.account_id,
            customUrls: customChecks.length > 0 ? customCheckUrlsFor(customChecks, normalizedChainUrls[i]) : [],
        })))
        const decision = decideTarget(members, activeIndex)
        if (decision.targetIndex !== -1) {
            const i = decision.targetIndex
            const url = chain[i]
            targetActiveUrl = url
            foundOnline = true
            if (decision.reason === 'recovered') {
                await ensureAddonList()
                const normUrl = normalizedChainUrls[i]
                const recoveredAddon = addonList.find(a => normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl)
                if (recoveredAddon && !isSubstantial(recoveredAddon.manifest)) {
                    const freshManifest = await fetchManifestRaw(url, rule.account_id)
                    if (freshManifest && isSubstantial(freshManifest)) {
                        addonList = addonList.map(a =>
                            normalizeAddonUrl(a.transportUrl).toLowerCase() === normUrl
                                ? { ...a, manifest: freshManifest }
                                : a
                        )
                    }
                }
            }
        }
        const stabilization = stabilizationFrom(normalizedChainUrls, members)
        if (skipContestedTarget(targetActiveUrl)) { showConflict(); return conflictHeartbeat({ stabilization }) }

        const decryptedNormalizedActive = currentActiveNorm
        let normalizedTarget = normalizeAddonUrl(targetActiveUrl).toLowerCase()
        // Publish this cycle's decision so sibling rules derive this chain from it, not from
        // the persisted active_url (written only after the whole account batch). The entry
        // snapshots the row as seen here (persisted value + updated_at); siblingChainPlans
        // retires it once any writer (our own batch commit or a manual edit) touches the row.
        cycleTargets.set(rule.id, {
            target: normalizedTarget,
            persisted: normalizeAddonUrl(decryptedActiveUrl || '').toLowerCase(),
            updatedAt: rule.updated_at ?? null,
        })
        const normalizedChain = normalizedChainUrls
        const normalizedChainSet = new Set(normalizedChain)

        // Every writer must derive identical one-active flags via the shared helper, for every
        // chain this account manages, not only this rule's (applyAccountChainFlags), otherwise
        // the writer publishes its stale copy of the sibling chains. Chains this list cannot
        // express are handed to the write-time mirror instead, so the derivation (this rule's
        // decided targets) always outranks the platform's not-yet-updated member set.
        const flagTarget = normalizedTarget
        let updatedAddonList = null
        let mirrorChainUrls = []
        let ownViolation = false
        const ensureUpdatedAddonList = async () => {
            if (updatedAddonList) return updatedAddonList
            const loaded = await ensureAddonList()
            siblingPlans = await siblingChainPlans(rule.account_id, rule.id, chain, rule.owner_sync_user, siblingPlans.sourceRows || siblingRows, loaded)
            if (siblingPlans.readFailed) throw new Error('Sibling rule state could not be read safely. Enforcement will retry.')
            preserveUrls = siblingPlans.contestedUrls || preserveUrls
            overlapUrls = siblingPlans.overlapUrls || overlapUrls
            const ownChain = applyOneActiveFlags(loaded, normalizedChain, flagTarget, preserveUrls)
            const folded = siblingPlans.length > 0 ? applyAccountChainFlags(ownChain.list, siblingPlans) : { list: ownChain.list, skipped: [] }
            ownViolation = ownChain.violationDetected
            updatedAddonList = folded.list
            mirrorChainUrls = folded.skipped.flatMap(p => p.urls)
            return updatedAddonList
        }
        const snapshot = addonList ? null : ruleSnapshots?.get(rule.id, rule.updated_at)
        let violationDetected
        if (snapshot && snapshot.chainKey === chainKey) {
            if (snapshot.identities?.length > 0) {
                siblingPlans = await siblingChainPlans(rule.account_id, rule.id, chain, rule.owner_sync_user, siblingPlans.sourceRows || siblingRows, snapshot.identities)
                preserveUrls = siblingPlans.contestedUrls || preserveUrls
                overlapUrls = siblingPlans.overlapUrls || overlapUrls
            }
            violationDetected = violationFromStates(snapshot.members.filter(([url]) => !preserveUrls.includes(url)), flagTarget)
        } else {
            await ensureUpdatedAddonList()
            violationDetected = ownViolation
        }

        if (skipContestedTarget(targetActiveUrl)) { showConflict(); return conflictHeartbeat({ stabilization }) }

        let hasChanged = normalizedTarget !== decryptedNormalizedActive

        const snapshotLooksClean = !hasChanged && !violationDetected
        const audit = await deepAudit.runDeepAudit({
            rule,
            lastDeepAudit: getRuleRuntimeState(rule.id)?.lastDeepAudit,
            authKey: decryptedAuthKey,
            hasConnectionTarget,
            snapshotLooksClean,
            chain,
            normalizedChainUrls,
            normalizedChainSet,
            customChecks,
            currentActiveNorm,
            normalizedTarget,
            preserveUrls,
        })
        const lastDeepAuditToSave = audit.lastDeepAudit
        const held = runtimeState.conflicts?.observe(rule, audit.observations)
        if (held) {
            const newlyHeld = held.urls.some(url => !preserveUrls.includes(url))
            preserveUrls = [...new Set([...preserveUrls, ...held.urls])]
            showConflict(held)
            if (newlyHeld || preserveUrls.includes(normalizedTarget)) return conflictHeartbeat({ stabilization, lastDeepAudit: lastDeepAuditToSave })
        }
        const deepAuditDrift = audit.drift
        if (audit.drift && audit.canonicalTarget && audit.canonicalTarget !== normalizedTarget) {
            targetActiveUrl = chain[normalizedChainUrls.indexOf(audit.canonicalTarget)] || targetActiveUrl
            normalizedTarget = audit.canonicalTarget
            hasChanged = normalizedTarget !== decryptedNormalizedActive
        }

        const needsSync = hasChanged || violationDetected || deepAuditDrift

        let reconciledList = null
        let syncSucceeded = !needsSync
        // Native connections a swap did not reach; null means all of them (the target list itself failed).
        let unpushedConnections = []
        let confirmedScopes = []
        let pushedPlatforms = null
        if (needsSync) await ensureUpdatedAddonList()
        if (skipContestedTarget(targetActiveUrl)) { showConflict(); return conflictHeartbeat({ stabilization, lastDeepAudit: lastDeepAuditToSave }) }
        if (needsSync) {
            // A rule deleted mid-cycle (its account was removed) must never push its stored list.
            // The owner-state assert beside it covers a block that landed mid-cycle.
            await assertAccountActive(rule.owner_sync_user)
            const [liveOwnerSql, liveOwnerParams] = ownerPredicate(rule.owner_sync_user, 3)
            const live = await db.get(`SELECT 1 FROM autopilot_rules WHERE id = $1 AND account_id = $2 AND is_active = 1${liveOwnerSql} LIMIT 1`, [rule.id, rule.account_id, ...liveOwnerParams])
            if (!live) throw Object.assign(new Error('Rule was removed during the check'), { code: 'rule_changed' })
        }
        if (needsSync) {
            const statusMsg = foundOnline ? `Swapping to: ${urlRef(normalizedTarget)}` : `Outage! Primary offline, keeping/forcing ${urlRef(normalizedTarget)}`
            // Ring: only a real tier switch renders (ap.swap or ap.recovery when the primary came
            // back). Outage re-forcing has no template and keeps today's hidden behavior.
            const ringPlatforms = [decryptedAuthKey ? 'stremio' : null, hasConnectionTarget ? rule.platform : null].filter(Boolean)
            const tierFmt = foundOnline && hasChanged ? (normalizedTarget === normalizedChainUrls[0] ? 'ap.recovery' : 'ap.swap') : null
            const ringFields = tierFmt === 'ap.recovery'
                ? { fmt: tierFmt, acct: rule.account_id, to: urlRef(normalizedTarget), platforms: ringPlatforms }
                : tierFmt === 'ap.swap'
                    ? { fmt: tierFmt, acct: rule.account_id, from: urlRef(currentActiveNorm), to: urlRef(normalizedTarget), platforms: ringPlatforms }
                    : {}
            fastify.log.info({ category: 'Autopilot', ...ringFields }, `[${maskContext(rule.account_id)}] [Enforcement] ${statusMsg} (Swap: ${hasChanged}, Multi-Enabled: ${violationDetected})`)

            const pushStartedAt = Date.now()
            try {
                if (!decryptedAuthKey) {
                    const result = await enforceConnectionOnly(rule, updatedAddonList, chain, targetActiveUrl, siblingPlans, mirrorChainUrls)
                    const { synced } = result
                    if (synced.length === 0) {
                        if (result.chainGuardSkipped) {
                            fastify.log.warn({ category: 'Autopilot', fmt: 'ap.enforce_skip', acct: rule.account_id, reason: 'chain-guard' }, `[${maskContext(rule.account_id)}] Connection enforcement skipped by chain guard; live provider state did not prove the managed chain. Will retry on the next health cycle.`)
                            syncSucceeded = false
                        } else {
                            throw new Error('Connection enforcement failed')
                        }
                    } else {
                        unpushedConnections = result.failedIds || []
                        if (result.recoveredAddons.length > 0) {
                            const recoveredByUrl = new Map(result.recoveredAddons.map(addon => [normalizeAddonUrl(addon?.transportUrl || '').toLowerCase(), addon]))
                            const existingUrls = new Set()
                            reconciledList = updatedAddonList.map(addon => {
                                const url = normalizeAddonUrl(addon?.transportUrl || '').toLowerCase()
                                existingUrls.add(url)
                                return recoveredByUrl.get(url) || addon
                            })
                            for (const addon of result.recoveredAddons) {
                                const url = normalizeAddonUrl(addon?.transportUrl || '').toLowerCase()
                                if (url && !existingUrls.has(url)) reconciledList.push(addon)
                            }
                        } else {
                            reconciledList = updatedAddonList
                        }
                        syncSucceeded = true
                        pushedPlatforms = result.targets ? platformResults(result.targets, { okIds: result.syncedIds, states: result.connectionStates, since: pushStartedAt }) : null
                        confirmedScopes = result.syncedIds || (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user) || []).filter(c => c.enabled && (!rule.connection_id || c.id === rule.connection_id) && result.synced.includes(c.platform) && !(result.failedIds || []).includes(c.id)).map(c => c.id)
                        fastify.log.info({ category: 'Autopilot', fmt: 'ap.push', n: reconciledList?.length ?? updatedAddonList?.length, acct: rule.account_id, ref: urlRef(normalizedTarget), platforms: synced }, `[${maskContext(rule.account_id)}] Synced ${urlRef(normalizedTarget)} to ${synced.join(', ')}.`)
                    }
                } else if (isUnifiedEnforcement() && reconciler?.enforceAccount) {
                    const built = await buildReconciledList(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, rule.id, updatedAddonList, hasChanged, rule.owner_sync_user)
                    built.canonical = await withCurrentDestinations(built.canonical, rule.account_id, rule.owner_sync_user)
                    reconciledList = built.canonical

                    const stremioConn = { id: `${rule.account_id}:stremio`, platform: 'stremio', accountId: rule.account_id, enabled: true, status: 'active', credentials: { authKey: decryptedAuthKey }, capabilities: ['addons'], consecutiveFailures: 0 }
                    const connectionTargets = hasChanged ? (await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)).filter(c => c.enabled && c.platform !== 'stremio') : []
                    const stremioWriter = async (conn) => {
                        try {
                            await writeStremioCollection(conn.credentials.authKey, built.canonical, { remoteAddons: built.remoteAddons, normalizedActive: built.normalizedActive, accountId: rule.account_id, syncUser: rule.owner_sync_user, connectionId: conn.id, ruleId: rule.id, preserveUrls: built.preserveUrls || [] })
                        } catch (err) {
                            if (err.status === 401) {
                                fastify.log.error({ category: 'Autopilot', fmt: 'ap.auth_expired', acct: rule.account_id }, `[${maskContext(rule.account_id)}] Auth Key Expired (401). Disabling rule.`)
                                const [ownerSql, ownerParams] = ownerPredicate(rule.owner_sync_user, 4)
                                await db.run(`UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2 AND account_id = $3${ownerSql}`, [nowMs(), rule.id, rule.account_id, ...ownerParams])
                            }
                            throw err
                        }
                    }

                    const result = await reconciler.enforceAccount(rule.account_id, [stremioConn, ...connectionTargets], built.canonical, { stremioWriter, canWrite: () => canWrite(rule), ...(preserveUrls.length > 0 ? { preserveUrls } : {}) })
                    if (!result.synced.includes('stremio')) throw new Error('Stremio enforcement failed')
                    syncSucceeded = true
                    const syncedPlatforms = result.synced.map(p => p === 'stremio' ? 'Stremio' : p)
                    const unreached = new Set(unpushedConnectionIds(connectionTargets, result))
                    unpushedConnections = [...unreached]
                    confirmedScopes = ['stremio', ...connectionTargets.filter(c => c.enabled && !unreached.has(c.id)).map(c => c.id)]
                    pushedPlatforms = platformResults([stremioConn, ...connectionTargets], { okIds: confirmedScopes.map(id => (id === 'stremio' ? stremioConn.id : id)), states: result.connectionStates, since: pushStartedAt })
                    const failedPlatforms = connectionTargets.filter(c => unreached.has(c.id)).map(c => c.platform)
                    const failedNote = failedPlatforms.length > 0 ? ` (push failed: ${failedPlatforms.join(', ')})` : ''
                    fastify.log.info({ category: 'Autopilot', fmt: 'ap.push', n: built.canonical.length, acct: rule.account_id, ref: urlRef(normalizedTarget), platforms: result.synced, failnote: failedPlatforms.length > 0 ? failedPlatforms : null }, `[${maskContext(rule.account_id)}] Synced ${urlRef(normalizedTarget)} to ${syncedPlatforms.join(', ')}.${failedNote}`)
                } else {
                    reconciledList = await syncStremioLive(decryptedAuthKey, chain, targetActiveUrl, rule.account_id, rule.id, updatedAddonList, hasChanged, rule.owner_sync_user)
                    syncSucceeded = true
                    confirmedScopes = ['stremio']

                    const syncedPlatforms = ['Stremio']
                    const failedPlatforms = []
                    const stremioTarget = { id: `${rule.account_id}:stremio`, platform: 'stremio', enabled: true }
                    pushedPlatforms = [{ id: stremioTarget.id, platform: 'stremio', ok: true }]
                    if (hasChanged && reconciler) {
                        let connTargets = []
                        try {
                            const conns = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
                            const targets = conns.filter(c => c.enabled && c.platform !== 'stremio')
                            connTargets = targets
                            if (targets.length > 0) {
                                const outcome = preserveUrls.length > 0
                                    ? await reconciler.enforceAccount(rule.account_id, targets, reconciledList ?? updatedAddonList, { requiredUrls: chain, requiredActiveUrl: targetActiveUrl, preserveUrls, canWrite: () => canWrite(rule) })
                                    : await reconciler.reconcileAccount(rule.account_id, null, conns, reconciledList ?? updatedAddonList, { canWrite: () => canWrite(rule) })
                                const unreachedIds = preserveUrls.length > 0 ? new Set(unpushedConnectionIds(targets, outcome)) : null
                                const unreached = targets.filter(c => c.enabled && (unreachedIds ? unreachedIds.has(c.id) : RETRYABLE_RECONCILE.has(reconcileOutcomeKey(outcome?.outcomes?.[c.id]))))
                                confirmedScopes.push(...targets.filter(c => c.enabled && (outcome?.outcomes?.[c.id] ? ['written', 'unchanged'].includes(outcome.outcomes[c.id].outcome) : !unreached.includes(c))).map(c => c.id))
                                unpushedConnections = unreached.map(c => c.id)
                                pushedPlatforms = platformResults([stremioTarget, ...targets], { okIds: [stremioTarget.id, ...targets.filter(c => !unreached.includes(c)).map(c => c.id)], states: outcome?.connectionStates ?? reconciler.getConnectionStates?.(rule.account_id), outcomes: outcome?.outcomes, since: pushStartedAt })
                                syncedPlatforms.push(...targets.filter(c => !unreached.includes(c)).map(c => c.platform))
                                failedPlatforms.push(...unreached.map(c => c.platform))
                            }
                        } catch (connErr) {
                            // Typed state refusals are background skips, not sync failures.
                            if (connErr instanceof AuthStateError || connErr instanceof StateUnavailableError) throw connErr
                            unpushedConnections = null
                            failedPlatforms.push('connection sync')
                            pushedPlatforms = [pushedPlatforms[0], ...platformResults(connTargets, { okIds: [], failure: connErr.message })]
                            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection sync failed: ${scrubUrls(connErr.message)}`)
                        }
                    }
                    const failedNote = failedPlatforms.length > 0 ? ` (push failed: ${failedPlatforms.join(', ')})` : ''
                    fastify.log.info({ category: 'Autopilot', fmt: 'ap.push', n: reconciledList?.length ?? updatedAddonList?.length, acct: rule.account_id, ref: urlRef(normalizedTarget), platforms: syncedPlatforms, failnote: failedPlatforms.length > 0 ? failedPlatforms : null }, `[${maskContext(rule.account_id)}] Synced ${urlRef(normalizedTarget)} to ${syncedPlatforms.join(', ')}.${failedNote}`)
                }

                if (syncSucceeded) runtimeState.conflicts?.recordWrite(rule, normalizedChain.filter(url => !preserveUrls.includes(url)), normalizedTarget, confirmedScopes)

                // Post-write owner recheck (snapshot only, zero DB reads): a block that
                // landed while the platform write was in flight suppresses the failover
                // history row, the notification, the retry scheduling and the commit plan.
                const ownerBlockedAfterWrite = accountBlockedInSnapshot(rule.owner_sync_user)

                if (!ownerBlockedAfterWrite && hasChanged && syncSucceeded && connectionRetry) {
                    if (unpushedConnections === null || unpushedConnections.length > 0) {
                        connectionRetry.schedule(rule.id, { accountId: rule.account_id, target: normalizedTarget, connectionIds: unpushedConnections })
                        fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection push will be retried: ${unpushedConnections ? `${unpushedConnections.length} connection(s)` : 'every connection'}.`)
                    } else {
                        connectionRetry.clear(rule.id)
                    }
                }

                if (!ownerBlockedAfterWrite && hasChanged && syncSucceeded) {
                    const primaryUrl = chain[0]
                    const type = normalizedTarget === normalizeAddonUrl(primaryUrl).toLowerCase() ? 'recovery' : 'failover'
                    const msg = TRANSITION_MESSAGES[type]

                    // Notify first so the one insert can record delivery; a worker crash during a slow webhook then loses this row.
                    const notified = {}
                    let notifyError = null
                    try {
                        if (await notifyTransition(rule, { type, msg, chain, targetActiveUrl }, notified)) shouldUpdateNotificationTime = true
                    } catch (err) {
                        notifyError = err
                    }

                    const reason = switchReason({ type, decision, members, activeIndex, targetIndex: normalizedChainUrls.indexOf(normalizedTarget), chain, timeoutMs: PROBE_TIMEOUT_MS })
                    const retryAt = pushedPlatforms?.some(p => !p.ok) ? connectionRetry?.get?.(rule.id)?.nextAt ?? null : null
                    await recordFailoverHistory(rule, type, msg, primaryUrl, targetActiveUrl, {
                        chain: normalizedChain,
                        activeUrl: normalizedTarget,
                        from: currentActiveNorm,
                        ...(reason ? { reason } : {}),
                        ...(pushedPlatforms ? { platforms: pushedPlatforms } : {}),
                        notified: notified.channel ?? null,
                        ...(notified.channel ? { notifiedOk: notified.sent === true } : {}),
                        ...(retryAt ? { retryAt } : {}),
                    }, getHealthLatency(targetActiveUrl))
                    if (notifyError) throw notifyError
                }
                if (ownerBlockedAfterWrite) {
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Post-write effects skipped: the account owner is blocked.`)
                    return null
                }
            } catch (syncErr) {
                if (syncErr instanceof AuthStateError || syncErr instanceof StateUnavailableError) {
                    // A typed state refusal is a background skip: no check error, no
                    // retry scheduling, no dirty update and no commit plan.
                    fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Sync skipped for ${gateCode(syncErr)}; no effects recorded.`)
                    if (syncErr instanceof AuthStateError && connectionRetry) connectionRetry.clear(rule.id)
                    ruleSnapshots?.releaseList?.(rule.id)
                    return null
                }
                fastify.log.error({ category: 'Autopilot', fmt: 'ap.push_failed', acct: rule.account_id, platform: 'stremio', err: syncErr }, `[${maskContext(rule.account_id)}] Stremio sync error: ${scrubUrls(syncErr.message)}`)
                if (!showConflict() && !['chain_overlap', 'contested_by_other_writer'].includes(syncErr.code)) noteCheckError(rule.id, rule.account_id, 'sync_failed', syncErr.message)
            }
        }

        if (accountBlockedInSnapshot(rule.owner_sync_user)) {
            if (connectionRetry) connectionRetry.clear(rule.id)
            return null
        }
        if (connectionRetry && audit.connectionDrift?.length > 0 && !hasChanged) {
            connectionRetry.schedule(rule.id, { accountId: rule.account_id, target: normalizedTarget, connectionIds: audit.connectionDrift, due: true })
        }
        if (connectionRetry && syncSucceeded && !hasChanged) {
            const entry = connectionRetry.takeDue(rule.id, normalizedTarget)
            if (entry) await retryConnectionPush(rule, entry, { decryptedAuthKey, chain, targetActiveUrl, normalizedTarget, normalizedChain, siblingPlans, preserveUrls, ensureUpdatedAddonList, getMirrorChainUrls: () => mirrorChainUrls })
        }

        if (syncSucceeded && !showConflict()) clearCheckError(rule.id)
        if (needsSync && !syncSucceeded) ruleSnapshots?.holdList?.(rule.id, rule.updated_at, addonListRaw)
        else if (needsSync) ruleSnapshots?.releaseList?.(rule.id)

        const update = planCommit({
            rule, stabilization, needsSync, syncSucceeded, hasChanged, decryptedActiveUrl,
            targetActiveUrl, reconciledList, updatedAddonList, storedAddonListKey, shouldUpdateNotificationTime, lastDeepAuditToSave
        })
        // Owner identity rides the dirty update so the scheduler can drop commits for
        // owners blocked between processing and the flush (snapshot check, no DB read).
        if (update) update.ownerSyncUser = rule.owner_sync_user
        return update
    }

    return { processAutopilotRule }
}
