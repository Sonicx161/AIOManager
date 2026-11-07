import { autopilotDb as db, autopilotTripwire } from '../write-tripwire.js'
import { globalHealthCache, serverState } from '../../state.js'
import { HEALTH_CACHE_TTL_MS } from '../health-checks.js'
import { scrubUrls } from './url-ref.js'
import { accountBlockedInSnapshot } from '../../admin/account-state.js'

export function createScheduler({ fastify, nowMs, cycleTargets, ruleCache, shouldSkipRuleCheck, prefetchSiblingRows, siblingKey, processAutopilotRule, flushUpdates, AUTOPILOT_SCAN_CHUNK_SIZE, AUTOPILOT_MAX_RULES_PER_CYCLE, AUTOPILOT_CYCLE_BUDGET_MS, RULE_RECHECK_MS, AUTOPILOT_CYCLE_WATCHDOG_MS = Math.max(3 * AUTOPILOT_CYCLE_BUDGET_MS, 300000), AUTOPILOT_RULE_CONCURRENCY = 32, probeCycle = null }) {
    const { ruleCacheGet, ruleCacheSet, ruleCacheStats } = ruleCache

    // Watchdog (memory only): a cycle still running past its wall-clock deadline is abandoned. It schedules no
    // further batches, its in-flight rules stay excluded until they settle, and the next cycle starts now.
    let cycleGeneration = 0
    let cycleStartedAt = 0
    const inFlightRules = new Set()
    serverState.autopilotWatchdog = { trips: 0, lastTripAt: null, deadlineMs: AUTOPILOT_CYCLE_WATCHDOG_MS }
    const tripWatchdogIfStalled = () => {
        if (!serverState.isWorkerRunning || !cycleStartedAt) return false
        const runningMs = nowMs() - cycleStartedAt
        if (runningMs < AUTOPILOT_CYCLE_WATCHDOG_MS) return false
        cycleGeneration++
        cycleStartedAt = 0
        serverState.autopilotWatchdog.trips++
        serverState.autopilotWatchdog.lastTripAt = nowMs()
        serverState.isWorkerRunning = false
        fastify.log.error({ category: 'Autopilot' }, `Autonomous Engine: cycle stalled for ${Math.round(runningMs / 1000)}s (deadline ${Math.round(AUTOPILOT_CYCLE_WATCHDOG_MS / 1000)}s). Abandoned it and starting a fresh cycle; ${inFlightRules.size} in-flight rule(s) are held out until they finish.`)
        return true
    }

    const runAutopilot = async () => {
        // Write safe mode skips the whole cycle until restart; the tripwire logs the reminder.
        if (autopilotTripwire.isSafeMode()) {
            autopilotTripwire.remind()
            return
        }
        tripWatchdogIfStalled()
        if (serverState.isWorkerRunning) {
            fastify.log.warn({ category: 'Autopilot' }, 'Autonomous Engine: Previous run still in progress. Skipping cycle.')
            return
        }

        serverState.isWorkerRunning = true
        const generation = ++cycleGeneration
        const live = () => generation === cycleGeneration
        cycleTargets.clear()
        probeCycle?.begin?.()
        serverState.lastWorkerRun = nowMs()
        cycleStartedAt = serverState.lastWorkerRun

        fastify.log.debug({ category: 'Autopilot' }, `Autonomous Engine: Starting budgeted scaling-aware scan.`)

        try {
            const CHUNK_SIZE = AUTOPILOT_SCAN_CHUNK_SIZE
            const startCursor = serverState.autopilotScanCursor || ''
            let lastId = startCursor
            // Each rule is processed at most once per cycle, even when the cursor wraps.
            const seenThisCycle = new Set()
            let totalProcessed = 0
            let hasMore = true
            let wrappedScan = false
            const cycleStart = nowMs()
            const staleCutoff = cycleStart - RULE_RECHECK_MS
            const scanDeadline = cycleStart + AUTOPILOT_CYCLE_BUDGET_MS

            while (live() && hasMore && totalProcessed < AUTOPILOT_MAX_RULES_PER_CYCLE && nowMs() < scanDeadline && !autopilotTripwire.isSafeMode()) {
                const candidateLimit = Math.min(CHUNK_SIZE, AUTOPILOT_MAX_RULES_PER_CYCLE - totalProcessed)
                const candidateRules = await db.query(
                    `SELECT r.id, r.account_id, r.is_automatic, r.updated_at, r.platform,
                            COALESCE(s.last_check, r.last_check) AS last_check
                     FROM autopilot_rules r
                     LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                     WHERE r.is_active = 1
                     AND (r.auth_key IS NOT NULL OR r.connection_id IS NOT NULL)
                     AND r.is_automatic = 1
                     AND r.id > $1
                     AND (COALESCE(s.last_check, r.last_check) IS NULL OR COALESCE(s.last_check, r.last_check) < $2)
                     AND NOT EXISTS (SELECT 1 FROM account_admin_state aas WHERE aas.sync_user = r.owner_sync_user)
                     ORDER BY r.id ASC
                     LIMIT $3`,
                    [lastId, staleCutoff, candidateLimit]
                )

                const freshCandidates = candidateRules.filter(rule => !seenThisCycle.has(rule.id))
                // After the wrap, reaching a rule this cycle already saw means the pass is complete.
                const reachedStart = wrappedScan && freshCandidates.length < candidateRules.length

                if (candidateRules.length === 0 || (reachedStart && freshCandidates.length === 0)) {
                    // A pass that started at the beginning already covered every rule; only a mid-table start wraps.
                    if (lastId && !wrappedScan && startCursor) {
                        lastId = ''
                        serverState.autopilotScanCursor = ''
                        wrappedScan = true
                        continue
                    } else {
                        hasMore = false
                        serverState.autopilotScanCursor = ''
                        break
                    }
                }

                const chunkStartCursor = lastId
                totalProcessed += freshCandidates.length
                lastId = candidateRules[candidateRules.length - 1].id
                serverState.autopilotScanCursor = lastId
                for (const rule of freshCandidates) seenThisCycle.add(rule.id)
                if (reachedStart) hasMore = false

                const dueRules = freshCandidates.filter(rule => !inFlightRules.has(rule.id) && !shouldSkipRuleCheck(rule.id, staleCutoff))

                if (dueRules.length === 0) {
                    if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || nowMs() >= scanDeadline) break
                    continue
                }

                const hitRows = []
                const missIds = []
                for (const candidate of dueRules) {
                    const cached = ruleCacheGet(candidate.id, candidate.updated_at, candidate.platform)
                    if (cached) hitRows.push({ id: candidate.id, row: cached.row, bytes: cached.bytes })
                    else missIds.push(candidate.id)
                }

                const rules = []

                if (missIds.length > 0) {
                    const placeholders = missIds.map((_, index) => `$${index + 1}`).join(',')
                    const missRows = await db.query(
                        `SELECT r.id, r.account_id, r.auth_key, r.priority_chain, r.addon_list, r.active_url, r.webhook_url, r.notify_enabled,
                                COALESCE(s.stabilization, r.stabilization) AS stabilization,
                                r.is_active, r.is_automatic,
                                COALESCE(s.last_check, r.last_check) AS last_check,
                                COALESCE(s.last_notification, r.last_notification) AS last_notification,
                                r.name, r.cooldown_ms, r.message_template, r.owner_sync_user,
                                r.platform, r.connection_id, r.updated_at, r.custom_check_urls
                         FROM autopilot_rules r
                         LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                         WHERE r.id IN (${placeholders})
                         ORDER BY r.id ASC`,
                        missIds
                    )
                    for (const row of missRows) {
                        ruleCacheSet(row.id, row.updated_at, row)
                        ruleCacheStats.misses++
                        rules.push(row)
                    }
                }

                if (hitRows.length > 0) {
                    const hitIds = hitRows.map(h => h.id)
                    const placeholders = hitIds.map((_, index) => `$${index + 1}`).join(',')
                    const volatileRows = await db.query(
                        `SELECT r.id,
                                COALESCE(s.stabilization, r.stabilization) AS stabilization,
                                COALESCE(s.last_check, r.last_check) AS last_check,
                                COALESCE(s.last_notification, r.last_notification) AS last_notification
                         FROM autopilot_rules r
                         LEFT JOIN autopilot_rule_stats s ON s.rule_id = r.id
                         WHERE r.id IN (${placeholders})
                         ORDER BY r.id ASC`,
                        hitIds
                    )
                    const volatileById = new Map(volatileRows.map(v => [v.id, v]))
                    for (const hit of hitRows) {
                        const volatile = volatileById.get(hit.id)
                        if (!volatile) continue
                        rules.push({ ...hit.row, ...volatile })
                        ruleCacheStats.hits++
                        ruleCacheStats.bytesSaved += hit.bytes
                    }
                }

                if (rules.length === 0) {
                    if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || nowMs() >= scanDeadline) break
                    continue
                }

                const siblingRowsByKey = await prefetchSiblingRows(rules)

                const dirtyUpdates = []
                // Worker pool: up to AUTOPILOT_RULE_CONCURRENCY accounts in flight, each finishing on its own
                // (no wait-for-the-slowest batch). An account's rules stay sequential in chunk order.
                const groups = []
                const groupByAccount = new Map()
                for (const rule of rules) {
                    const key = rule.account_id || '_none'
                    let group = groupByAccount.get(key)
                    if (!group) { groupByAccount.set(key, group = []); groups.push(group) }
                    group.push(rule)
                }
                const started = new Set()
                let deadlineHit = false
                const mayStart = () => {
                    if (!live()) return false
                    if (nowMs() >= scanDeadline) deadlineHit = true
                    return !deadlineHit
                }
                const processRule = async (rule) => {
                    inFlightRules.add(rule.id)
                    try {
                        const result = await processAutopilotRule(rule, siblingRowsByKey?.get(siblingKey(rule.owner_sync_user, rule.account_id)))
                        if (result) dirtyUpdates.push(result)
                    } catch (err) {
                        fastify.log.error({ category: 'Autopilot' }, `Rule ${rule.id} error: ${scrubUrls(err.message)}`)
                    } finally {
                        inFlightRules.delete(rule.id)
                    }
                }
                const runGroup = async (accountRules) => {
                    if (!mayStart()) return
                    for (const rule of accountRules) {
                        if (!mayStart()) return
                        started.add(rule.id)
                        await processRule(rule)
                    }
                }
                let nextGroup = 0
                const worker = async () => {
                    while (nextGroup < groups.length && mayStart()) await runGroup(groups[nextGroup++])
                }
                await Promise.all(Array.from({ length: Math.min(AUTOPILOT_RULE_CONCURRENCY, groups.length) }, worker))

                // Deadline: rules not started keep their stale last_check and the cursor rewinds to just before
                // the first of them, so the next cycle starts there and every rule is reached across cycles.
                const deferred = new Set(rules.filter(r => !started.has(r.id)).map(r => r.id))
                if (live() && deferred.size > 0) {
                    const firstDeferred = candidateRules.findIndex(r => deferred.has(r.id))
                    lastId = firstDeferred > 0 ? candidateRules[firstDeferred - 1].id : chunkStartCursor
                    serverState.autopilotScanCursor = lastId
                    totalProcessed -= deferred.size
                    for (const id of deferred) seenThisCycle.delete(id)
                }

                // Dirty updates carry their owner: a block landing between processing
                // and the flush drops the commit (snapshot check, zero DB reads).
                const flushable = dirtyUpdates.filter((u) => !u.ownerSyncUser || !accountBlockedInSnapshot(u.ownerSyncUser))
                await flushUpdates(flushable)

                if (totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || nowMs() >= scanDeadline) break
            }

            if (!live()) return
            const budgetHit = totalProcessed >= AUTOPILOT_MAX_RULES_PER_CYCLE || nowMs() >= scanDeadline
            serverState.autopilotLastCycleEndedAt = nowMs()
            serverState.autopilotLastCycleStats = {
                scanned: totalProcessed,
                cursor: serverState.autopilotScanCursor || '',
                budgetHit,
                durationMs: nowMs() - cycleStart
            }

            if (totalProcessed > 0) {
                const cycleDuration = ((nowMs() - cycleStart) / 1000).toFixed(1)
                const suffix = budgetHit ? ` Budget held at ${totalProcessed}/${AUTOPILOT_MAX_RULES_PER_CYCLE}.` : ''
                fastify.log.info({ category: 'Autopilot' }, `Check Summary: Periodic health scan covered ${totalProcessed} candidate rules in ${cycleDuration}s.${suffix}`)
            }

            if (globalHealthCache.size > 10000) {
                const now = nowMs()
                for (const [key, val] of globalHealthCache.entries()) {
                    if (now - val.timestamp > HEALTH_CACHE_TTL_MS) globalHealthCache.delete(key)
                }
            }

            ruleCache.logStatsWindows()

        } finally {
            // An abandoned cycle leaves the shared cycle state to the cycle that replaced it.
            if (live()) {
                probeCycle?.end?.()
                cycleTargets.clear()
                cycleStartedAt = 0
                serverState.isWorkerRunning = false
            }
        }
    }

    const startAutopilotWorker = () => {
        if (serverState.autopilotInterval) return
        fastify.log.info({ category: 'Autopilot' }, 'Autonomous Engine started. 🚀')

        runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Startup Error: ${err.message}`))

        serverState.autopilotInterval = setInterval(() => {
            runAutopilot().catch(err => fastify.log.error({ category: 'Autopilot' }, `Worker Error: ${err.message}`))
        }, 60 * 1000)
    }

    const stopAutopilotWorker = () => {
        if (serverState.autopilotInterval) {
            clearInterval(serverState.autopilotInterval)
            serverState.autopilotInterval = null
        }
    }

    return { runAutopilot, startAutopilotWorker, stopAutopilotWorker }
}
