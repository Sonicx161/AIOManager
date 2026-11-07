import db from '../db.js'
import { decrypt } from '../crypto.js'
import { encrypt } from '../crypto.js'
import { FALLBACK_KEYS, PRIMARY_KEY } from '../keys.js'
import { getCachedAuth, setCachedAuth, hashAuthPassword } from '../state.js'
import { timingSafeEqual } from '../auth.js'
import { listStremioCredentialedAccountIds } from '../lib/stremio-credentials.js'
import { verifySyncPassword, upgradeLegacyPasswordHash } from '../lib/sync-password.js'
import { tombstonedAccountIds, withAccountWriteLock } from '../lib/account-tombstones.js'
import { assertAccountActive, assertWritablePrimary } from '../admin/account-state.js'

async function validateSyncAuth(request, reply) {
    // Account state gate: first statement, ahead of the deviceAuth early return and
    // every password path. No try/catch exists in this helper and none may be added.
    await assertAccountActive(request.deviceAuth?.accountUuid || request.headers['x-sync-user'])
    if (request.deviceAuth?.accountUuid) return request.deviceAuth.accountUuid
    const syncUser = request.headers['x-sync-user']
    const syncPassword = request.headers['x-sync-password']
    if (!syncUser || !syncPassword) {
        reply.status(401)
        return null
    }

    const cachedPw = getCachedAuth('sync:' + syncUser)
    if (cachedPw && timingSafeEqual(cachedPw, hashAuthPassword(syncPassword))) {
        return syncUser
    }

    const row = await db.get('SELECT password FROM kv_store WHERE key = $1', [syncUser])
    if (!row) {
        reply.status(401)
        return null
    }

    const verified = await verifySyncPassword(syncPassword, row.password)
    let authorized = verified === true
    if (verified === null) {
        const decryptedPassword = decrypt(row.password, FALLBACK_KEYS)
        if (decryptedPassword && timingSafeEqual(decryptedPassword, syncPassword)) {
            authorized = true
            await upgradeLegacyPasswordHash(db, syncUser, syncPassword)
        }
    }
    if (!authorized) {
        reply.status(401)
        return null
    }

    setCachedAuth('sync:' + syncUser, syncPassword)
    return syncUser
}

export function registerActivityRoutes(fastify, activityEngine) {
    fastify.get('/api/activity/events', {
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const syncUser = await validateSyncAuth(request, reply)
        if (!syncUser) return { error: 'Invalid credentials' }

        if (!activityEngine.isEnabled()) {
            return { events: [], hasMore: false, disabled: true }
        }

        const limit = Math.min(Math.max(parseInt(request.query.limit || '500', 10), 1), 5000)
        const offset = Math.max(parseInt(request.query.offset || '0', 10), 0)
        const since = parseInt(request.query.since || '0', 10)
        const accountId = request.query.accountId
        const eventType = request.query.type

        let sql = 'SELECT * FROM activity_events WHERE sync_user = $1'
        const params = [syncUser]

        if (since > 0) {
            params.push(since)
            sql += ` AND event_ts >= $${params.length}`
        }
        if (accountId) {
            // Two distinct parameter slots: this db layer expands each $n token to its own
            // bind, so reusing one index for both predicates under-binds the statement.
            params.push(accountId)
            const eqIdx = params.length
            params.push(`${accountId}::`)
            // Per-connection rows live under `${accountId}::${connectionId}`; an
            // account-scoped query must return them alongside the canonical rows.
            sql += ` AND (account_id = $${eqIdx} OR account_id LIKE ($${params.length} || '%'))`
        }
        if (eventType) {
            params.push(eventType)
            sql += ` AND event_type = $${params.length}`
        }

        sql += ` ORDER BY event_ts DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(limit, offset)

        let events = []
        try {
            events = await db.query(sql, params)
        } catch (dbErr) {
            fastify.log.error({ category: 'Activity' }, `Events query failed: ${dbErr.message}`)
            reply.status(503)
            return { error: 'database_unavailable', events: [], hasMore: false }
        }

        return {
            events: events.map(e => ({
                id: e.id,
                accountId: e.account_id,
                accountName: e.account_name,
                itemId: e.item_id,
                uniqueItemId: e.unique_item_id,
                name: e.item_name,
                type: e.item_type,
                poster: e.poster,
                season: e.season,
                episode: e.episode,
                videoId: e.video_id,
                eventType: e.event_type,
                timestamp: e.event_ts,
                duration: e.duration,
                progress: e.progress,
                watched: e.watched,
                timesWatched: e.times_watched,
                isInProgress: e.is_in_progress === 1,
                overallTimeWatched: e.overall_time_watched,
            })),
            hasMore: events.length === limit
        }
    })

    fastify.get('/api/activity/status', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const syncUser = await validateSyncAuth(request, reply)
        if (!syncUser) return { error: 'Invalid credentials' }

        if (!activityEngine.isEnabled()) {
            return {
                totalEvents: 0,
                totalSnapshots: 0,
                engineRunning: activityEngine.isRunning(),
                engineEnabled: false,
                engineConfig: activityEngine.getConfig?.()
            }
        }

        let eventCount = { count: 0 }
        let snapshotCount = { count: 0 }
        try {
            eventCount = await db.get(
                'SELECT COUNT(*) as count FROM activity_events WHERE sync_user = $1',
                [syncUser]
            )
            snapshotCount = await db.get(
                'SELECT COUNT(*) as count FROM activity_snapshots WHERE sync_user = $1',
                [syncUser]
            )
        } catch (dbErr) {
            fastify.log.error({ category: 'Activity' }, `Status query failed: ${dbErr.message}`)
            reply.status(503)
            return {
                error: 'database_unavailable',
                totalEvents: 0,
                totalSnapshots: 0,
                engineRunning: activityEngine.isRunning(),
                engineEnabled: activityEngine.isEnabled(),
                engineConfig: activityEngine.getConfig?.()
            }
        }

        return {
            totalEvents: Number(eventCount?.count || 0),
            totalSnapshots: Number(snapshotCount?.count || 0),
            engineRunning: activityEngine.isRunning(),
            engineEnabled: activityEngine.isEnabled(),
            engineConfig: activityEngine.getConfig?.()
        }
    })

    fastify.post('/api/activity/trigger', {
        config: { rateLimit: { max: 6, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const syncUser = await validateSyncAuth(request, reply)
        if (!syncUser) return { error: 'Invalid credentials' }
        assertWritablePrimary()

        return activityEngine.triggerScan()
    })

    // Per-event delete fired (fire-and-forget) by clients after dropping the matching local
    // watch events. Owner-scoped by sync_user + event id, idempotent (unknown ids delete
    // nothing). Not gated on activityEngine.isEnabled(): like the credential route, removing
    // rows is data management, not telemetry.
    fastify.delete('/api/activity/events/:eventId', {
        config: { rateLimit: { max: 120, timeWindow: '1 minute' } }
    }, async (request, reply) => {
        const syncUser = await validateSyncAuth(request, reply)
        if (!syncUser) return { error: 'Invalid credentials' }
        assertWritablePrimary()

        const eventId = decodeURIComponent(request.params.eventId || '')
        if (!eventId || eventId.length > 512) {
            reply.status(400)
            return { error: 'Invalid event id' }
        }

        try {
            const result = await db.run(
                'DELETE FROM activity_events WHERE sync_user = $1 AND id = $2',
                [syncUser, eventId]
            )
            return { deleted: Math.max(0, Number(result?.changes ?? 0)) }
        } catch (dbErr) {
            fastify.log.error({ category: 'Activity' }, `Event delete failed: ${dbErr.message}`)
            reply.status(503)
            return { error: 'database_unavailable' }
        }
    })

    fastify.post('/api/credentials/sync', {
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        bodyLimit: 1024 * 512
    }, async (request, reply) => {
        const syncUser = await validateSyncAuth(request, reply)
        if (!syncUser) return { error: 'Invalid credentials' }
        assertWritablePrimary()

        const { accounts, connections, liveConnectionIds, removedStremioLogins, allAccountIds } = request.body
        if (!Array.isArray(accounts)) {
            reply.status(400)
            return { error: 'Expected { accounts: [...] }' }
        }

        // Not gated on activityEngine.isEnabled(): server_credentials rows are what
        // external Hydra writes use to reach Stremio directly, so persisting them is
        // an identity concern, not activity telemetry. Only the activity-event routes
        // above stay engine-gated.
        //
        // Multiplicity: `accounts` keeps the CANONICAL login in the legacy account-level
        // row (no connection id) — the exact shape every existing server reader pins.
        // `connections` registers SECONDARY logins, one row per connection id. The
        // reported live set drives connection-scoped pruning: unlinking one login prunes
        // exactly its row and its scoped events/snapshots — never a sibling's, never the
        // canonical account-level row or the canonical history.
        // Deleted accounts take no new credential rows; their entries are skipped, not refused.
        const requestedAccountIds = [
            ...accounts.slice(0, 200).map(a => a?.accountId),
            ...(Array.isArray(connections) ? connections : []).slice(0, 400).map(c => c?.accountId),
        ]
        return withAccountWriteLock(syncUser, requestedAccountIds, async (conn) => {
            const deletedIds = await tombstonedAccountIds(syncUser, requestedAccountIds, conn)
            const capped = accounts.slice(0, 200).filter(a => !deletedIds.has(a?.accountId))
            const cappedConnections = (Array.isArray(connections) ? connections : []).slice(0, 400).filter(c => !deletedIds.has(c?.accountId))
            const existingRows = await conn.query(
                'SELECT id, account_id, account_name, auth_key, connection_id, canonical_connection_id, credential_type, connection_generation, sync_user FROM server_credentials WHERE sync_user = $1',
                [syncUser]
            )
            const existingByAccount = new Map()
            for (const row of existingRows) {
                if (!existingByAccount.has(row.account_id)) existingByAccount.set(row.account_id, [])
                existingByAccount.get(row.account_id).push(row)
            }
            const existingById = new Map(existingRows.map(row => [row.id, row]))
            // Per-connection row ids carry no owner component, so ownership must be resolved
            // GLOBALLY: the owner-scoped query above cannot see another owner's row with the
            // same id, and an unchecked upsert would silently steal it.
            const requestedConnIds = cappedConnections
                .map(c => c && c.accountId && c.connectionId ? `stremio:${c.accountId}:${c.connectionId}` : null)
                .filter(Boolean)
            const foreignOwners = new Set()
            if (requestedConnIds.length > 0) {
                const globalRows = await conn.query(
                    `SELECT id, sync_user FROM server_credentials WHERE id IN (${requestedConnIds.map((_, i) => `$${i + 1}`).join(',')})`,
                    requestedConnIds
                )
                for (const row of globalRows) {
                    if (row.sync_user !== syncUser) foreignOwners.add(row.id)
                }
            }
            // The canonical connection id per account (accounts[].connectionId) ; the promoted
            // login whose secondary scope must be adopted into the bare scope on re-point, and
            // whose per-connection row is superseded by the account-level row afterwards.
            const canonicalConnectionByAccount = new Map()
            for (const acc of capped) {
                if (acc?.accountId && acc.connectionId) canonicalConnectionByAccount.set(acc.accountId, acc.connectionId)
            }
            let upserted = 0
            let skipped = 0
            let pruned = 0
            await conn.tx(async (tx) => {
                const now = Date.now()

                for (const acc of capped) {
                    if (!acc.accountId) continue
                    const credId = `${syncUser}:${acc.accountId}`
                    // Deliberately disabled canonical: the account-level credential row goes
                    // (account-level server APIs must stop acting on this login) but the
                    // bare-scope history and snapshots are kept ; re-enabling re-upserts the
                    // key and the retained baselines resume exactly where they left off.
                    if (acc.disabled === true && !acc.authKey) {
                        const existing = existingById.get(credId)
                        if (existing) {
                            await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [credId, syncUser])
                            pruned++
                        }
                        continue
                    }
                    if (!acc.authKey) continue
                    const accountName = acc.accountName || ''
                    const existing = existingById.get(credId)
                    if (existing) {
                        let existingAuthKey = null
                        try {
                            existingAuthKey = decrypt(existing.auth_key, FALLBACK_KEYS)
                        } catch { /* rewrite unreadable legacy credentials */ }
                        if (existingAuthKey === acc.authKey && (existing.account_name || '') === accountName
                            && (existing.canonical_connection_id || null) === (acc.connectionId || null)) {
                            skipped++
                            continue
                        }
                        // Canonical re-point (deliberate: primary switch or removal-promotion,
                        // never a decrypt race ; key identity must actually change). The durable
                        // owner of the outgoing bare scope is resolved by MATCHING the previous
                        // account-level key against the per-connection rows (a client hint in
                        // supersededConnectionId is only trusted when its row's key agrees), so a
                        // rapid A→B→C before a sync can never misattribute one login's history to
                        // another. Stable-origin moves preserve every historical event id.
                        if (existingAuthKey && existingAuthKey !== acc.authKey) {
                            const perConnectionRows = (existingByAccount.get(acc.accountId) || []).filter(r => r.connection_id && r.credential_type === 'stremio')
                            let prevOwner = existing.canonical_connection_id || null
                            if (!prevOwner && acc.supersededConnectionId) {
                                const hinted = perConnectionRows.find(r => r.connection_id === acc.supersededConnectionId)
                                if (hinted) {
                                    try {
                                        if (decrypt(hinted.auth_key, FALLBACK_KEYS) === existingAuthKey) prevOwner = hinted.connection_id
                                    } catch { /* hint row unreadable: fall through to membership match */ }
                                }
                            }
                            if (!prevOwner && acc.supersededConnectionId) {
                                const hinted = perConnectionRows.find(r => r.connection_id === acc.supersededConnectionId)
                                // Removal-promotion: the demoted login's per-connection row may
                                // already be deleted client-side, so the hint stands when no
                                // COMPETING row owns the previous account-level key ; the client
                                // only records it on a deliberate canonical transition.
                                if (!hinted) prevOwner = acc.supersededConnectionId
                            }
                            if (!prevOwner) {
                                for (const r of perConnectionRows) {
                                    try {
                                        if (decrypt(r.auth_key, FALLBACK_KEYS) === existingAuthKey) { prevOwner = r.connection_id; break }
                                    } catch { /* unreadable candidate: cannot own the bare scope */ }
                                }
                            }
                            const deliberateRepoint = acc.connectionId ? prevOwner !== acc.connectionId : !!acc.supersededConnectionId
                            if (prevOwner && deliberateRepoint) {
                                const demotedScope = `${acc.accountId}::${prevOwner}`
                                await tx.run(
                                    'UPDATE activity_events SET account_id = $1 WHERE sync_user = $2 AND account_id = $3',
                                    [demotedScope, syncUser, acc.accountId]
                                )
                                await tx.run(
                                    'UPDATE activity_snapshots SET account_id = $1 WHERE sync_user = $2 AND account_id = $3',
                                    [demotedScope, syncUser, acc.accountId]
                                )
                                // Promoted-login adoption: the new canonical's existing secondary
                                // scope becomes the bare canonical scope (stable-origin move ;
                                // every historical event id is preserved, only the scope changes).
                                if (acc.connectionId && acc.connectionId !== prevOwner) {
                                    const promotedScope = `${acc.accountId}::${acc.connectionId}`
                                    await tx.run(
                                        'UPDATE activity_events SET account_id = $1 WHERE sync_user = $2 AND account_id = $3',
                                        [acc.accountId, syncUser, promotedScope]
                                    )
                                    await tx.run(
                                        'UPDATE activity_snapshots SET account_id = $1 WHERE sync_user = $2 AND account_id = $3',
                                        [acc.accountId, syncUser, promotedScope]
                                    )
                                }
                            }
                        }
                    }
                    const encryptedAuthKey = encrypt(acc.authKey, PRIMARY_KEY)

                    if (db.type === 'postgres') {
                        await tx.run(
                            `INSERT INTO server_credentials (id, sync_user, account_id, account_name, auth_key, updated_at, canonical_connection_id)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)
                             ON CONFLICT (id) DO UPDATE SET
                                account_name = EXCLUDED.account_name,
                                auth_key = EXCLUDED.auth_key,
                                updated_at = EXCLUDED.updated_at,
                                canonical_connection_id = EXCLUDED.canonical_connection_id`,
                            [credId, syncUser, acc.accountId, accountName, encryptedAuthKey, now, acc.connectionId || null]
                        )
                    } else {
                        await tx.run(
                            `INSERT OR REPLACE INTO server_credentials (id, sync_user, account_id, account_name, auth_key, updated_at, canonical_connection_id)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [credId, syncUser, acc.accountId, accountName, encryptedAuthKey, now, acc.connectionId || null]
                        )
                    }
                    upserted++
                }

                for (const conn of cappedConnections) {
                    if (!conn.accountId || !conn.connectionId || !conn.authKey) continue
                    // Ownership: a per-connection row id is globally unique per (account,
                    // connection); another owner's row is never overwritten, and the upsert
                    // itself is owner-guarded so a racing writer cannot steal the id either.
                    const credId = `stremio:${conn.accountId}:${conn.connectionId}`
                    // Incarnation token of the connection (SOL-R1-BETA-04): stamps the row
                    // so a delayed cleanup of a previous same-id incarnation cannot claim it.
                    const generationToken = typeof conn.generation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(conn.generation.trim()) ? conn.generation.trim() : null
                    if (foreignOwners.has(credId)) {
                        continue
                    }
                    const existing = existingById.get(credId)
                    if (existing) {
                        let existingAuthKey = null
                        try {
                            existingAuthKey = decrypt(existing.auth_key, FALLBACK_KEYS)
                        } catch { /* rewrite unreadable credentials */ }
                        if (existingAuthKey === conn.authKey) {
                            // Same key re-registered by a newer incarnation still adopts
                            // that incarnation's generation; a stale cleanup must not
                            // later claim the row the live login uses.
                            if (generationToken && existing.connection_generation !== generationToken) {
                                await tx.run(
                                    'UPDATE server_credentials SET connection_generation = $1 WHERE id = $2 AND sync_user = $3 AND connection_id = $4',
                                    [generationToken, credId, syncUser, conn.connectionId]
                                )
                            }
                            skipped++
                            continue
                        }
                    }
                    const encryptedAuthKey = encrypt(conn.authKey, PRIMARY_KEY)
                    if (db.type === 'postgres') {
                        await tx.run(
                            `INSERT INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at, connection_generation)
                             VALUES ($1, $2, $3, $4, $5, 'stremio', $6, $7)
                             ON CONFLICT (id) DO UPDATE SET
                                auth_key = EXCLUDED.auth_key,
                                updated_at = EXCLUDED.updated_at,
                                connection_generation = COALESCE(EXCLUDED.connection_generation, server_credentials.connection_generation)
                             WHERE server_credentials.sync_user = EXCLUDED.sync_user`,
                            [credId, syncUser, conn.accountId, encryptedAuthKey, conn.connectionId, now, generationToken]
                        )
                    } else {
                        await tx.run(
                            `INSERT INTO server_credentials (id, sync_user, account_id, auth_key, connection_id, credential_type, updated_at, connection_generation)
                             VALUES ($1, $2, $3, $4, $5, 'stremio', $6, $7)
                             ON CONFLICT (id) DO UPDATE SET
                                auth_key = excluded.auth_key,
                                updated_at = excluded.updated_at,
                                connection_generation = COALESCE(excluded.connection_generation, connection_generation)
                             WHERE sync_user = excluded.sync_user`,
                            [credId, syncUser, conn.accountId, encryptedAuthKey, conn.connectionId, now, generationToken]
                        )
                    }
                    upserted++
                }

                const knownIds = Array.isArray(allAccountIds) && allAccountIds.length > 0
                    ? new Set(allAccountIds)
                    : new Set([
                        ...capped.filter(a => a.accountId).map(a => a.accountId),
                        ...cappedConnections.filter(c => c.accountId).map(c => c.accountId),
                    ])
                // Prune live-set: EXISTENCE-based when the client reports it (a paused or
                // vault-unreadable login still exists and must keep its rows/history); older
                // clients fall back to the registerable set.
                const liveReports = Array.isArray(liveConnectionIds) && liveConnectionIds.length > 0 ? liveConnectionIds : cappedConnections
                const liveConnections = new Set(
                    liveReports
                        .filter(c => c && c.accountId && c.connectionId)
                        .map(c => `${c.accountId}\u0000${c.connectionId}`)
                )
                // Deliberately disabled logins: credential row goes, history/snapshots stay.
                const disabledConnections = new Set(
                    (Array.isArray(liveConnectionIds) ? liveConnectionIds : [])
                        .filter(c => c && c.accountId && c.connectionId && c.enabled === false)
                        .map(c => `${c.accountId}\u0000${c.connectionId}`)
                )
                const removedAccounts = new Set((Array.isArray(removedStremioLogins) ? removedStremioLogins : []).filter(a => typeof a === 'string'))
                // A pending offline removal can arrive after another device restored a
                // login. Current membership wins over that stale destructive signal.
                const reportedStremioAccounts = new Set([
                    ...capped.filter(a => a?.accountId && (a.authKey || a.connectionId || a.disabled === true)).map(a => a.accountId),
                    ...cappedConnections.filter(c => c?.accountId && c.connectionId).map(c => c.accountId),
                    ...liveReports.filter(c => c?.accountId && c.connectionId).map(c => c.accountId),
                ])

                for (const [accountId, rows] of existingByAccount.entries()) {
                    if (!knownIds.has(accountId)) {
                        // Account gone entirely: prune every row and every history scope it owns
                        // (bare + `accountId::connectionId`), exactly like the legacy contract.
                        for (const row of rows) {
                            await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [row.id, syncUser])
                            pruned++
                        }
                        await tx.run(
                            'DELETE FROM activity_events WHERE sync_user = $1 AND account_id = $2',
                            [syncUser, accountId]
                        )
                        await tx.run(
                            'DELETE FROM activity_events WHERE sync_user = $1 AND account_id LIKE ($2 || \'::%\')',
                            [syncUser, `${accountId}::`]
                        )
                        await tx.run(
                            'DELETE FROM activity_snapshots WHERE sync_user = $1 AND account_id = $2',
                            [syncUser, accountId]
                        )
                        await tx.run(
                            'DELETE FROM activity_snapshots WHERE sync_user = $1 AND account_id LIKE ($2 || \'::%\')',
                            [syncUser, `${accountId}::`]
                        )
                        continue
                    }
                    // Deliberate last-login removal: the account-level row AND the bare-scope
                    // history are pruned on this explicit signal only ; never on a decrypt
                    // failure or a disabled login, which cannot produce it.
                    if (removedAccounts.has(accountId) && !reportedStremioAccounts.has(accountId)) {
                        await tx.run('DELETE FROM server_credentials WHERE sync_user = $1 AND account_id = $2 AND connection_id IS NULL', [syncUser, accountId])
                        await tx.run('DELETE FROM activity_events WHERE sync_user = $1 AND account_id = $2', [syncUser, accountId])
                        await tx.run('DELETE FROM activity_snapshots WHERE sync_user = $1 AND account_id = $2', [syncUser, accountId])
                        pruned++
                        continue
                    }
                    const canonicalId = canonicalConnectionByAccount.get(accountId)
                    // Newest-wins cleanup for stremio rows of a LIVE member: legacy per-device
                    // duplicate rows of the same connection are deleted (readers already
                    // dedupe newest-first; this keeps the table honest).
                    const stremioRowsByConnection = new Map()
                    for (const row of rows) {
                        if (!(row.credential_type === 'stremio' || row.credential_type === null)) continue
                        if (!row.connection_id) continue
                        const prev = stremioRowsByConnection.get(row.connection_id)
                        if (!prev || (row.updated_at ?? 0) > (prev.updated_at ?? 0)) stremioRowsByConnection.set(row.connection_id, row)
                    }
                    for (const row of rows) {
                        if (!row.connection_id) continue
                        // Membership/disable/canonical-handover semantics are STREMIO-only:
                        // liveConnectionIds reports stremio secondaries, so touching any other
                        // credential type here would delete Nuvio/RealStream/Hydra rows on every
                        // stremio credentials sync. (Account-deleted above prunes all types,
                        // matching the legacy whole-account contract.)
                        if (!(row.credential_type === 'stremio' || row.credential_type === null)) continue
                        const memberKey = `${accountId}\u0000${row.connection_id}`
                        // Stale duplicate rows of a live connection: superseded by the newest.
                        if (row !== stremioRowsByConnection.get(row.connection_id)) {
                            await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [row.id, syncUser])
                            pruned++
                            continue
                        }
                        // The promoted canonical's old per-connection row is superseded by the
                        // account-level row: drop the duplicate credential, keep the (already
                        // adopted) scope history.
                        if (row.connection_id === canonicalId) {
                            await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [row.id, syncUser])
                            continue
                        }
                        // Deliberately disabled member: credential row only, history retained.
                        if (disabledConnections.has(memberKey)) {
                            await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [row.id, syncUser])
                            continue
                        }
                        if (liveConnections.has(memberKey)) continue
                        // Genuine unlink: prune exactly this login's row and its scoped history ;
                        // siblings and the canonical account-level row are untouched.
                        await tx.run('DELETE FROM server_credentials WHERE id = $1 AND sync_user = $2', [row.id, syncUser])
                        await tx.run(
                            'DELETE FROM activity_events WHERE sync_user = $1 AND account_id = $2',
                            [syncUser, `${accountId}::${row.connection_id}`]
                        )
                        await tx.run(
                            'DELETE FROM activity_snapshots WHERE sync_user = $1 AND account_id = $2',
                            [syncUser, `${accountId}::${row.connection_id}`]
                        )
                        pruned++
                    }
                }
            })

            const { invalidateConnectionCache } = await import('../providers/reconciler.js')
            invalidateConnectionCache(syncUser)

            return { synced: upserted, skipped, pruned, serverStremioCredentialedAccounts: await listStremioCredentialedAccountIds(syncUser, conn) }
        })
    })
}
