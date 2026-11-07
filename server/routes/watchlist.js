import db from '../db.js'
import { verifyAuth } from '../auth.js'
import { assertWritablePrimary } from '../admin/account-state.js'

const HOUSEHOLD_ACCOUNT_ID = '__household__'

export function registerWatchlistRoutes(fastify) {
    fastify.post('/api/watchlist/add', {
        bodyLimit: 4096,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const { itemId, type, name, poster, accountId } = request.body || {}
        if (!itemId || typeof itemId !== 'string') {
            reply.status(400); return { error: 'itemId required' }
        }

        const effectiveAccountId = accountId || HOUSEHOLD_ACCOUNT_ID
        const cleanType = type === 'series' ? 'series' : 'movie'
        const cleanName = typeof name === 'string' ? name.slice(0, 256) : null
        const cleanPoster = typeof poster === 'string' && poster.startsWith('http') ? poster.slice(0, 1024) : null
        const now = Date.now()

        try {
            await db.run(
                db.type === 'postgres'
                    ? `INSERT INTO watchlist_items (sync_user, account_id, item_id, item_type, item_name, poster, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (sync_user, account_id, item_id) DO UPDATE SET item_name = EXCLUDED.item_name, poster = EXCLUDED.poster, added_at = EXCLUDED.added_at`
                    : `INSERT INTO watchlist_items (sync_user, account_id, item_id, item_type, item_name, poster, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(sync_user, account_id, item_id) DO UPDATE SET item_name = excluded.item_name, poster = excluded.poster, added_at = excluded.added_at`,
                [authUser, effectiveAccountId, itemId.slice(0, 128), cleanType, cleanName, cleanPoster, now]
            )
            return { success: true }
        } catch {
            return { success: false }
        }
    })

    fastify.delete('/api/watchlist/remove', {
        bodyLimit: 1024,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }
        assertWritablePrimary()

        const { itemId, accountId } = request.body || {}
        if (!itemId) { reply.status(400); return { error: 'itemId required' } }

        const effectiveAccountId = accountId || HOUSEHOLD_ACCOUNT_ID

        try {
            await db.run(
                'DELETE FROM watchlist_items WHERE sync_user = $1 AND account_id = $2 AND item_id = $3',
                [authUser, effectiveAccountId, itemId]
            )
            return { success: true }
        } catch {
            return { success: false }
        }
    })

    fastify.get('/api/watchlist', {
        config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    }, async (request, reply) => {
        const authUser = await verifyAuth(request)
        if (!authUser) { reply.status(401); return { error: 'Unauthorized' } }

        const accountId = (request.query && request.query.accountId) || HOUSEHOLD_ACCOUNT_ID

        try {
            const rows = await db.query(
                `SELECT item_id, item_type, item_name, poster, added_at FROM watchlist_items
                 WHERE sync_user = $1 AND account_id = $2 ORDER BY added_at DESC`,
                [authUser, accountId]
            )
            return { items: (rows || []).map(r => ({
                itemId: r.item_id,
                type: r.item_type,
                name: r.item_name,
                poster: r.poster,
                addedAt: r.added_at,
            })) }
        } catch {
            return { items: [] }
        }
    })
}
