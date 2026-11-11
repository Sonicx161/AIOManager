import { autopilotDb as db } from '../write-tripwire.js'
import { normalizeAddonUrl } from '../../utils/addon-url.js'
import { maskContext } from '../../utils/log-helpers.js'
import { ownerPredicate } from './owner-scope.js'
import { urlRef, scrubUrls } from './url-ref.js'
import { loadCanonicalDestinations, withCurrentDestinations, resolveStremioConnectionId, stremioExcludedUrlsFromPolicy } from './destinations.js'
import { preserveLiveMembers } from '../one-active.js'
import { invalidateCanonicalAddons, invalidateCanonicalByAuthKey } from '../../hydra/canonical-cache.js'
import { ownerCanWrite } from '../../admin/account-state.js'

async function mapConcurrent(items, limit, worker) {
    const results = new Array(items.length)
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const i = nextIndex++
            results[i] = await worker(items[i], i)
        }
    })
    await Promise.all(workers)
    return results
}

// Targets an enforce result did not reach; by id when the reconciler reports ids, else by platform.
export const unpushedConnectionIds = (targets, result) => (targets || [])
    .filter(c => !(Array.isArray(result?.syncedIds) ? result.syncedIds.includes(c.id) : (result?.synced || []).includes(c.platform)))
    .map(c => c.id)

export function createWriters({ fastify, nowMs, reconciler, stremioDriver, siblingChainPlans, buildReconciledList, fetchAndRefreshManifest, prepareAddonsForStremio, areCollectionsDifferent, runtimeState = null }) {
    const canWriteRule = async (ruleId, accountId, owner) => {
        if (!ruleId) return true
        // In-memory owner-state check first: a blocked owner behaves like a paused rule.
        if (!(await ownerCanWrite(owner))) return false
        const [sql, params] = ownerPredicate(owner, 3)
        return !!await db.get(`SELECT 1 FROM autopilot_rules WHERE id = $1 AND account_id = $2 AND is_active = 1${sql} LIMIT 1`, [ruleId, accountId, ...params])
    }
    const writeStremioCollection = async (authKey, canonical, { remoteAddons = [], normalizedActive, accountId, syncUser, connectionId, ruleId, preserveUrls = [] }) => {
        const preserved = preserveLiveMembers(canonical || [], remoteAddons, preserveUrls)
        const refreshedMerged = await mapConcurrent(preserved, 5, async addon => {
            const normUrl = normalizeAddonUrl(addon.transportUrl).toLowerCase()
            if (!preserveUrls.includes(normUrl) && normUrl === normalizedActive && addon.flags?.enabled !== false) {
                const freshManifest = await fetchAndRefreshManifest(addon.transportUrl, accountId)
                if (freshManifest) {
                    fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Refreshed manifest for active addon: ${urlRef(addon.transportUrl)}`)
                    return { ...addon, manifest: freshManifest }
                }
            }
            return addon
        })

        // Filter after flag overlays and merges, for this exact login as well
        // as its platform. A sibling login's exclusion never changes this one.
        const policyByUrl = await loadCanonicalDestinations(accountId, syncUser)
        const targetId = await resolveStremioConnectionId(accountId, syncUser, authKey, connectionId)
        const stremioExcluded = stremioExcludedUrlsFromPolicy(policyByUrl, targetId)
        const policyFiltered = stremioExcluded.size > 0
            ? refreshedMerged.filter(a => !stremioExcluded.has(normalizeAddonUrl(a.transportUrl || '').toLowerCase()))
            : refreshedMerged

        const finalAddons = prepareAddonsForStremio(policyFiltered)

        if (finalAddons.length === 0 && remoteAddons.length > 0) {
            // Policy-aware empty guard: an empty result is allowed only when every
            // live remote URL is a deliberate stremio exclusion (all-removed-
            // explained). Anything unexplained is still a wipe attempt.
            const remoteUrls = (remoteAddons || []).map(a => normalizeAddonUrl(a.transportUrl || '').toLowerCase()).filter(Boolean)
            const allExplained = remoteUrls.length > 0 && remoteUrls.every(u => stremioExcluded.has(u))
            if (!allExplained) {
                throw new Error('Sync produced an empty list, aborting to prevent wiping Stremio collection.')
            }
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(accountId)}] Empty Stremio write authorized: every live addon is deliberately excluded by destination policy.`)
        }

        if (areCollectionsDifferent(finalAddons, remoteAddons)) {
            if (!await canWriteRule(ruleId, accountId, syncUser)) throw Object.assign(new Error('Rule was paused or removed during the check'), { code: 'rule_changed' })
            try {
                await stremioDriver.writeAddons(authKey, finalAddons)
            } finally {
                invalidateCanonicalAddons(accountId, syncUser)
                invalidateCanonicalByAuthKey(authKey)
            }
        }
        return finalAddons
    }

    // onlyConnectionIds narrows the push to those connections (a retry of earlier failed pushes).
    const enforceConnectionOnly = async (rule, reconciledAddons, chain = [], activeUrl = null, siblingPlans = null, mirrorUrls = null, onlyConnectionIds = null) => {
        if (!reconciler?.enforceAccount) return { synced: [] }
        const connections = await reconciler.resolveConnections(rule.account_id, rule.owner_sync_user)
        const targets = (connections || []).filter(c =>
            c.enabled && c.platform !== 'stremio' && (!rule.connection_id || c.id === rule.connection_id)
            && (!onlyConnectionIds || onlyConnectionIds.includes(c.id))
        )
        if (targets.length === 0) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only rule has no matching enabled connection. Skipping enforcement.`)
            return { synced: [] }
        }
        // Chain guard: refuses writes that would drop the managed chain or its active tier.
        const guardOpts = (Array.isArray(chain) && chain.length > 0)
            ? { requiredUrls: chain, requiredActiveUrl: activeUrl }
            : {}
        const plans = siblingPlans || (await siblingChainPlans(rule.account_id, rule.id, chain, rule.owner_sync_user, null, reconciledAddons))
        if (plans.readFailed) return { synced: [], syncedIds: [], failedIds: targets.map(c => c.id), chainGuardSkipped: true, recoveredAddons: [] }
        const preserveUrls = plans.contestedUrls || []
        const held = runtimeState?.conflicts.getHold(rule.id)
        if (held) runtimeState?.setRuleCheckError(rule.id, rule.account_id, 'contested_by_other_writer', 'Another writer keeps changing these addons. Enforcement is paused.', held)
        if (preserveUrls.includes(normalizeAddonUrl(activeUrl))) return { synced: [], syncedIds: [], failedIds: targets.map(c => c.id), chainGuardSkipped: true, recoveredAddons: [] }
        if (!await canWriteRule(rule.id, rule.account_id, rule.owner_sync_user)) return { synced: [], syncedIds: [], failedIds: targets.map(c => c.id), chainGuardSkipped: true, recoveredAddons: [] }
        const currentAddons = await withCurrentDestinations(reconciledAddons, rule.account_id, rule.owner_sync_user)
        const targetNorm = normalizeAddonUrl(activeUrl || '').toLowerCase()
        const carriesEnabledOwnTarget = currentAddons.some(addon =>
            normalizeAddonUrl(addon?.transportUrl || '').toLowerCase() === targetNorm && addon?.flags?.enabled !== false
        )
        // If the encrypted snapshot has no enabled member for its own chain,
        // let the write-slot live read rehydrate it. The final guard still
        // blocks the write when the provider cannot prove the chain exists.
        const recoveryUrls = carriesEnabledOwnTarget ? [] : chain
        const foreignChainUrls = [...new Set([...(mirrorUrls || []), ...recoveryUrls])]
        const result = await reconciler.enforceAccount(rule.account_id, targets, currentAddons, {
            ...guardOpts,
            canWrite: () => canWriteRule(rule.id, rule.account_id, rule.owner_sync_user),
            ...(preserveUrls.length > 0 ? { preserveUrls } : {}),
            // Only the chains this rule cannot derive are mirrored from the platform: a decided
            // target outranks a platform list that has not caught up with it yet, and mirroring a
            // decided chain would make the guard refuse a perfectly valid write.
            // An explicitly supplied empty mirror set means the snapshot
            // expresses every sibling chain and must stay authoritative. Only
            // the omitted argument uses the legacy sibling-plan fallback.
            foreignChainUrls: mirrorUrls !== null && mirrorUrls !== undefined
                ? foreignChainUrls
                : plans.flatMap(p => p.urls),
            // Guard scope: every chain this account manages, not just this rule's.
            managedChains: [{ urls: chain, target: activeUrl }, ...plans],
        })
        if (result.synced.length > 0) {
            const confirmed = result.syncedIds || targets.filter(c => !unpushedConnectionIds(targets, result).includes(c.id)).map(c => c.id)
            runtimeState?.conflicts.recordWrite(rule, chain.filter(url => !preserveUrls.includes(normalizeAddonUrl(url))), activeUrl, confirmed)
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Connection-only enforcement pushed to ${result.synced.join(', ')}.`)
        }
        return {
            synced: result.synced,
            syncedIds: result.syncedIds || targets.filter(c => result.synced.includes(c.platform) && !unpushedConnectionIds(targets, result).includes(c.id)).map(c => c.id),
            failedIds: unpushedConnectionIds(targets, result),
            targets: targets.map(c => ({ id: c.id, platform: c.platform, enabled: c.enabled })),
            connectionStates: result.connectionStates || null,
            chainGuardSkipped: result.chainGuardSkipped === true,
            recoveredAddons: result.recoveredAddons || [],
        }
    }

    // ownerSyncUser scopes the 401 disable when the descriptor does not carry it; the owner lookup below is unchanged.
    const syncStremioLive = async (authKeyOrDescriptor, chain, activeUrl, accountId, ruleId, storedAddonList = [], forceReinstall = false, ownerSyncUser = undefined) => {
        const descriptor = typeof authKeyOrDescriptor === 'string' ? { authKey: authKeyOrDescriptor } : (authKeyOrDescriptor || {})
        const authKey = descriptor.authKey
        if (!authKey) {
            const rule = { account_id: accountId, id: ruleId, owner_sync_user: descriptor.ownerSyncUser, connection_id: descriptor.connectionId, platform: descriptor.platform }
            const result = await enforceConnectionOnly(rule, storedAddonList, chain, activeUrl, await siblingChainPlans(accountId, ruleId, chain, descriptor.ownerSyncUser))
            if (result.chainGuardSkipped) {
                // Broken chain state: skip so the engine can reconstitute on the next pass.
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Chain guard skipped enforcement for rule ${ruleId}: stored addon list does not carry the active chain tier.`)
                return null
            }
            return storedAddonList
        }
        let owner = descriptor.ownerSyncUser !== undefined ? descriptor.ownerSyncUser : ownerSyncUser
        try {
            owner = descriptor.ownerSyncUser ?? owner ?? (await db.get('SELECT owner_sync_user FROM autopilot_rules WHERE id = $1 AND account_id = $2', [ruleId, accountId]))?.owner_sync_user
            const built = await buildReconciledList(authKey, chain, activeUrl, accountId, ruleId, storedAddonList, forceReinstall, owner)
            built.canonical = await withCurrentDestinations(built.canonical, accountId, owner)
            await writeStremioCollection(authKey, built.canonical, { remoteAddons: built.remoteAddons, normalizedActive: built.normalizedActive, accountId, syncUser: owner, connectionId: descriptor.connectionId, ruleId, preserveUrls: built.preserveUrls || [] })
            runtimeState?.conflicts.recordWrite({ id: ruleId, account_id: accountId, owner_sync_user: owner }, chain.filter(url => !(built.preserveUrls || []).includes(normalizeAddonUrl(url))), activeUrl, ['stremio'])
            return built.canonical
        } catch (err) {
            if (err.status === 401) {
                fastify.log.error({ category: 'Autopilot' }, `[${maskContext(accountId)}] Auth Key Expired (401). Disabling rule.`)
                const [ownerSql, ownerParams] = ownerPredicate(owner, 4)
                await db.run(`UPDATE autopilot_rules SET is_active = 0, updated_at = $1 WHERE id = $2 AND account_id = $3${ownerSql}`, [nowMs(), ruleId, accountId, ...ownerParams])
            }
            fastify.log.error({ category: 'Autopilot' }, `[${maskContext(accountId)}] Mirror sync failed: ${scrubUrls(err.message)}`)
            throw err
        }
    }

    return { writeStremioCollection, enforceConnectionOnly, syncStremioLive }
}
