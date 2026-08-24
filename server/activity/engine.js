import { createHash } from 'crypto'
import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { STREMIO_API } from '../config.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { resilientFetch } from '../utils/api-resilience.js'
import { trace } from '../utils/trace.js'

function envBool(name, fallback = false) {
    const value = process.env[name]
    if (value == null || value === '') return fallback
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function envInt(name, fallback, min = 0) {
    const parsed = parseInt(process.env[name] || '', 10)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(min, parsed)
}

const ACTIVITY_ENGINE_ENABLED = envBool('ACTIVITY_ENGINE_ENABLED', false)
const ACTIVITY_SCAN_INTERVAL_MS = envInt('ACTIVITY_SCAN_INTERVAL_MS', 5 * 60 * 1000, 60 * 1000)
const ACTIVITY_SCAN_JITTER_MS = envInt('ACTIVITY_SCAN_JITTER_MS', 2 * 60 * 1000, 0)
const ACTIVITY_INITIAL_DELAY_MS = envInt('ACTIVITY_INITIAL_DELAY_MS', 30 * 1000, 5 * 1000)
const ACTIVITY_CYCLE_BUDGET_MS = envInt('ACTIVITY_CYCLE_BUDGET_MS', 120000, 10000)
const ACTIVITY_MAX_ACCOUNTS_PER_CYCLE = envInt('ACTIVITY_MAX_ACCOUNTS_PER_CYCLE', 50, 1)
const ACTIVITY_MAX_EVENTS_PER_CYCLE = envInt('ACTIVITY_MAX_EVENTS_PER_CYCLE', 1000, 1)
const ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE = envInt('ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE', 5000, 1)
const ACTIVITY_BATCH_SIZE = envInt('ACTIVITY_BATCH_SIZE', 40, 1)
const ACTIVITY_FETCH_TIMEOUT_MS = envInt('ACTIVITY_FETCH_TIMEOUT_MS', 10000, 1000)
const ACTIVITY_HASH_CACHE_TTL_MS = envInt('ACTIVITY_HASH_CACHE_TTL_MS', 24 * 60 * 60 * 1000, 60 * 1000)
const ACTIVITY_HASH_CACHE_MAX = envInt('ACTIVITY_HASH_CACHE_MAX', 5000, 100)

const EVENT_COLUMNS = [
    'id', 'sync_user', 'account_id', 'account_name', 'item_id', 'unique_item_id', 'item_name', 'item_type',
    'poster', 'season', 'episode', 'video_id', 'event_type', 'event_ts', 'duration', 'progress', 'watched',
    'times_watched', 'is_in_progress', 'overall_time_watched', 'metadata'
]

const SNAPSHOT_COLUMNS = [
    'sync_user', 'account_id', 'item_id', 'unique_item_id', 'item_name', 'item_type', 'poster',
    'season', 'episode', 'video_id', 'duration', 'progress', 'watched', 'times_watched',
    'is_in_progress', 'overall_time_watched', 'mtime'
]

const SNAPSHOT_COMPARE_COLUMNS = SNAPSHOT_COLUMNS.filter(col => !['sync_user', 'account_id', 'item_id', 'mtime'].includes(col))

let scanTimer = null
let isStarted = false
let isScanning = false
let credentialCursor = ''
let nonStremioSkipWarned = false
const accountStateHashes = new Map()

function deterministicEventId(syncUser, accountId, itemId, eventType, eventTs, season, episode) {
    const bucket = Math.floor(Number(eventTs || Date.now()) / 60000)
    const raw = `${syncUser}:${accountId}:${itemId}:${season ?? ''}:${episode ?? ''}:${eventType}:${bucket}`
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32)
    return `evt_${hash}`
}

function hashString(value) {
    return createHash('sha256').update(value).digest('hex')
}

function normalizeItem(raw) {
    const s = raw.state || {}
    return {
        id: raw._id || raw.id || '',
        _id: raw._id || raw.id || '',
        name: raw.name || '',
        type: raw.type || '',
        poster: raw.poster || '',
        removed: raw.removed || false,
        temp: raw.temp || false,
        _mtime: raw._mtime || 0,
        _ctime: raw._ctime || 0,
        video_id: s.video_id || raw.video_id || null,
        unique_id: s.video_id || raw.unique_id || null,
        duration: Math.min(Number(s.duration ?? raw.duration ?? 0), Number.MAX_SAFE_INTEGER),
        progress: Math.min(Number(s.timeOffset ?? raw.progress ?? 0), Number.MAX_SAFE_INTEGER),
        watched: Number(s.flaggedWatched ?? s.watched ?? raw.watched ?? 0),
        timesWatched: Number(s.timesWatched ?? raw.timesWatched ?? 0),
        timeOffset: Math.min(Number(s.timeOffset ?? raw.timeOffset ?? 0), Number.MAX_SAFE_INTEGER),
        overallTimeWatched: Math.min(Number(s.overallTimeWatched ?? raw.overallTimeWatched ?? 0), Number.MAX_SAFE_INTEGER),
        timeWatched: Math.min(Number(s.timeWatched ?? raw.timeWatched ?? 0), Number.MAX_SAFE_INTEGER),
        inProgress: !!(s.timeOffset && s.duration && (s.timeOffset / s.duration) < 0.9),
        season: s.season ?? raw.season ?? null,
        episode: s.episode ?? raw.episode ?? null,
    }
}

const MAX_PLAUSIBLE_SEASON = 100
function clampSeason(season) {
    return (season != null && Number.isFinite(season) && season >= 0 && season <= MAX_PLAUSIBLE_SEASON) ? season : null
}

export function getSeasonEpisode(item) {
    if (!item) return { season: null, episode: null }
    const sm = String(item.id || '').match(/=s(\d+):?e(\d+)/i)
    if (sm) return { season: clampSeason(parseInt(sm[1], 10) || null), episode: parseInt(sm[2], 10) || null }
    const videoParts = String(item.video_id || item.unique_id || '').split(':').filter(Boolean)
    if (videoParts.length >= 3) {
        const season = Number(videoParts[videoParts.length - 2])
        const episode = Number(videoParts[videoParts.length - 1])
        if (Number.isFinite(season) && Number.isFinite(episode)) {
            return { season: clampSeason(season), episode }
        }
    }
    return {
        season: clampSeason(item.season != null ? Number(item.season) : null),
        episode: item.episode != null ? Number(item.episode) : null
    }
}

function isSeriesItem(item) {
    return item.type === 'series' || item.type === 'anime' || item.type === 'episode'
}

export function isActuallyWatched(item) {
    if (!item) return false
    const isSeries = isSeriesItem(item)

    const progress = Number(item.progress ?? 0)
    const duration = Number(item.duration ?? 0)
    const watched = Number(item.watched ?? 0)
    const timesWatched = Number(item.timesWatched ?? 0)
    const timeOffset = Number(item.timeOffset ?? 0)

    if (timesWatched > 0) return true
    if (watched > 0) return true
    if (Number(item.timeWatched ?? 0) > 0 || Number(item.overallTimeWatched ?? 0) > 0) return true
    if (progress > 0 && duration > 0 && timeOffset > 0 && (timeOffset / duration) > 0.05) return true

    if (isSeries && item.video_id && item.video_id.trim() !== '' && progress > 0) return true
    return false
}

function parseEventTime(value) {
    if (!value) return 0
    const parsed = new Date(value).getTime()
    if (!Number.isFinite(parsed)) return 0
    return parsed > Date.now() + 5 * 60 * 1000 ? Date.now() : parsed
}

function computeLibraryHash(library) {
    const raw = library.map(item => [
        item.id,
        item.removed ? 1 : 0,
        item.type || '',
        item.video_id || '',
        item.duration || 0,
        item.progress || 0,
        item.watched || 0,
        item.timesWatched || 0,
        item.timeOffset || 0,
        item.overallTimeWatched || 0,
        item.timeWatched || 0,
        item._mtime || 0,
    ].join('|')).sort().join('\n')
    return hashString(raw)
}

async function getRegisteredAccountsPage(limit, afterId = '') {
    // Stremio-only: Nuvio/RealStream auth_key rows are JSON token bundles, not Stremio authKeys.
    // Keyset on the primary key. updated_at moves when an account re-logs in, and an
    // OFFSET page over a moving sort key skips rows.
    return db.query(
        `SELECT id, sync_user, account_id, account_name, auth_key
         FROM server_credentials
         WHERE (credential_type = 'stremio' OR credential_type IS NULL) AND id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [afterId, limit]
    )
}

export async function getAccountsForCycle() {
    const limit = ACTIVITY_MAX_ACCOUNTS_PER_CYCLE
    let selected = await getRegisteredAccountsPage(limit, credentialCursor)

    if (selected.length < limit && credentialCursor !== '') {
        const seen = new Set(selected.map(row => row.id))
        const wrapped = await getRegisteredAccountsPage(limit - selected.length, '')
        selected = [...selected, ...wrapped.filter(row => !seen.has(row.id))]
    }

    credentialCursor = selected.length > 0 ? selected[selected.length - 1].id : ''
    return selected
}

function getCachedLibraryHash(hashKey) {
    const entry = accountStateHashes.get(hashKey)
    if (!entry) return null
    if (Date.now() - entry.ts > ACTIVITY_HASH_CACHE_TTL_MS) {
        accountStateHashes.delete(hashKey)
        return null
    }
    return entry.hash
}

function setCachedLibraryHash(hashKey, libraryHash) {
    accountStateHashes.set(hashKey, { hash: libraryHash, ts: Date.now() })
    if (accountStateHashes.size <= ACTIVITY_HASH_CACHE_MAX) return

    const overflow = accountStateHashes.size - ACTIVITY_HASH_CACHE_MAX
    const oldest = [...accountStateHashes.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, overflow)
    for (const [key] of oldest) accountStateHashes.delete(key)
}

async function fetchLibrary(authKey, deadline = 0, log = null) {
    if (deadline && Date.now() >= deadline) return null
    const accountIdHint = authKey ? authKey.substring(0, 4) + '***' : 'empty'
    try {
        const remainingBudget = deadline ? Math.max(1000, deadline - Date.now()) : ACTIVITY_FETCH_TIMEOUT_MS
        const timeoutMs = Math.min(ACTIVITY_FETCH_TIMEOUT_MS, remainingBudget)
        const res = await enqueueProxyRequest(STREMIO_API, () => resilientFetch(`${STREMIO_API}/datastoreGet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'DatastoreGet', authKey, collection: 'libraryItem', all: true }),
            idempotent: true,
            retries: deadline ? 0 : 1,
            timeout: timeoutMs
        }))
        if (!res.ok) {
            if (log) log.warn({ category: 'Activity' }, `Library fetch failed for ${accountIdHint}: HTTP ${res.status}`)
            return null
        }
        const json = await res.json()
        if (json?.error) {
            if (log) log.warn({ category: 'Activity' }, `Library fetch error for ${accountIdHint}: ${JSON.stringify(json.error).substring(0, 200)}`)
            return null
        }
        const result = json?.result
        let items = null
        if (Array.isArray(result)) items = result
        else if (result?.library && Array.isArray(result.library)) items = result.library
        if (!items) {
            if (log) log.warn({ category: 'Activity' }, `Library fetch returned no items for ${accountIdHint} (result keys: ${result ? Object.keys(result).join(',') : 'null'})`)
            return null
        }
        return items.map(normalizeItem)
    } catch (e) {
        if (log) log.warn({ category: 'Activity' }, `Library fetch exception for ${accountIdHint}: ${e.message}`)
        return null
    }
}

async function getSnapshot(syncUser, accountId) {
    return db.query(
        'SELECT * FROM activity_snapshots WHERE sync_user = $1 AND account_id = $2',
        [syncUser, accountId]
    )
}

function buildSnapshotMap(rows) {
    const map = new Map()
    for (const row of rows) map.set(row.item_id, row)
    return map
}

function asString(value) {
    return value == null ? '' : String(value)
}

function asNumber(value) {
    const num = Number(value ?? 0)
    return Number.isFinite(num) ? num : 0
}

function valuesDiffer(column, left, right) {
    if (['season', 'episode'].includes(column)) {
        const leftEmpty = left == null || left === ''
        const rightEmpty = right == null || right === ''
        if (leftEmpty && rightEmpty) return false
        return asNumber(left) !== asNumber(right)
    }
    if (['duration', 'progress', 'watched', 'times_watched', 'is_in_progress', 'overall_time_watched'].includes(column)) {
        return asNumber(left) !== asNumber(right)
    }
    return asString(left) !== asString(right)
}

function snapshotNeedsWrite(existing, next) {
    if (!existing) return true
    return SNAPSHOT_COMPARE_COLUMNS.some(column => valuesDiffer(column, existing[column], next[column]))
}

function buildSnapshot(syncUser, accountId, itemId, item, mtime) {
    const se = getSeasonEpisode(item)
    const uniqueId = item.unique_id || item.video_id || `${accountId}:${itemId}`
    return {
        sync_user: syncUser,
        account_id: accountId,
        item_id: itemId,
        unique_item_id: uniqueId,
        item_name: item.name || '',
        item_type: item.type || '',
        poster: item.poster || '',
        season: se.season,
        episode: se.episode,
        video_id: item.video_id || null,
        duration: item.duration || 0,
        progress: item.progress || 0,
        watched: item.watched || 0,
        times_watched: item.timesWatched || 0,
        is_in_progress: item.inProgress ? 1 : 0,
        overall_time_watched: item.overallTimeWatched || 0,
        mtime,
    }
}

function buildEvent(syncUser, accountId, accountName, item, eventType, eventTs = null) {
    const se = getSeasonEpisode(item)
    const itemId = item.id || item._id || ''
    const uniqueId = item.unique_id || item.video_id || `${accountId}:${itemId}`
    const ts = eventTs || Date.now()
    return {
        id: deterministicEventId(syncUser, accountId, uniqueId, eventType, ts, se.season, se.episode),
        sync_user: syncUser,
        account_id: accountId,
        account_name: accountName || '',
        item_id: itemId,
        unique_item_id: uniqueId,
        item_name: item.name || '',
        item_type: item.type || '',
        poster: item.poster || '',
        season: se.season,
        episode: se.episode,
        video_id: item.video_id || null,
        event_type: eventType,
        event_ts: ts,
        duration: item.duration || 0,
        progress: item.progress || 0,
        watched: item.watched || 0,
        times_watched: item.timesWatched || 0,
        is_in_progress: item.inProgress ? 1 : 0,
        overall_time_watched: item.overallTimeWatched || 0,
        metadata: null,
    }
}

function snapshotToItem(itemId, snap, fallback = {}) {
    return {
        id: itemId,
        unique_id: snap.unique_item_id || snap.video_id || null,
        name: snap.item_name || fallback.name || '',
        type: snap.item_type || fallback.type || '',
        poster: snap.poster || fallback.poster || '',
        season: snap.season ?? null,
        episode: snap.episode ?? null,
        video_id: snap.video_id || null,
        duration: Number(snap.duration ?? fallback.duration ?? 0),
        progress: Number(snap.progress ?? 0),
        watched: Number(snap.watched ?? 0),
        timesWatched: Number(snap.times_watched ?? 0),
        overallTimeWatched: Number(snap.overall_time_watched ?? 0),
        inProgress: Number(snap.is_in_progress ?? 0) === 1,
    }
}

const WATCH_STATE_COLUMNS = ['video_id', 'season', 'episode', 'duration', 'progress', 'watched', 'times_watched', 'is_in_progress', 'overall_time_watched']

export function hasWatchStateChange(item, snap) {
    const current = buildSnapshot(snap.sync_user || '', snap.account_id || '', item.id || item._id || '', item, 0)
    return WATCH_STATE_COLUMNS.some(column => valuesDiffer(column, snap[column], current[column]))
}

export function shouldPreserveSnapshotEpisode(itemId, item, snap, mtime, snapMtime) {
    const itemType = item.type || snap.item_type || ''
    if (itemType !== 'series' && itemType !== 'anime' && itemType !== 'episode') return false
    if (!snapMtime) return false

    const se = getSeasonEpisode(item)
    const currentSeason = se.season
    const currentEpisode = se.episode

    if (snap.season != null || snap.episode != null) {
        return snap.season !== currentSeason || snap.episode !== currentEpisode
    }

    const snapVideoId = String(snap.video_id || '')
    if (!snapVideoId || snapVideoId === itemId) return false
    const currentVideoId = String(item.video_id || item.unique_id || '')
    return snapVideoId !== currentVideoId
}

function chunked(items, size = ACTIVITY_BATCH_SIZE) {
    const chunks = []
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
    return chunks
}

function buildPlaceholders(rowCount, columnCount) {
    let param = 1
    return Array.from({ length: rowCount }, () => {
        const row = Array.from({ length: columnCount }, () => `$${param++}`)
        return `(${row.join(',')})`
    }).join(',')
}

async function batchInsertEvents(events, tx) {
    if (events.length === 0) return 0
    const uniqueEvents = Array.from(new Map(events.map(event => [event.id, event])).values())
    const runner = tx || db
    let written = 0

    for (const group of chunked(uniqueEvents)) {
        const placeholders = buildPlaceholders(group.length, EVENT_COLUMNS.length)
        const params = group.flatMap(event => EVENT_COLUMNS.map(column => event[column]))
        const verb = db.type === 'postgres' ? 'INSERT INTO' : 'INSERT OR IGNORE INTO'
        const conflict = db.type === 'postgres' ? ' ON CONFLICT (id) DO NOTHING' : ''
        const result = await runner.run(
            `${verb} activity_events (${EVENT_COLUMNS.join(',')}) VALUES ${placeholders}${conflict}`,
            params
        )
        written += Number(result?.changes || 0)
    }

    return written
}

async function batchUpsertSnapshots(snapshots, tx) {
    if (snapshots.length === 0) return 0
    const uniqueSnapshots = Array.from(new Map(
        snapshots.map(snapshot => [`${snapshot.sync_user}:${snapshot.account_id}:${snapshot.item_id}`, snapshot])
    ).values())
    const updateColumns = SNAPSHOT_COLUMNS
        .filter(column => !['sync_user', 'account_id', 'item_id'].includes(column))
        .map(column => `${column}=EXCLUDED.${column}`)
        .join(',')
    const runner = tx || db
    let written = 0

    for (const group of chunked(uniqueSnapshots)) {
        const placeholders = buildPlaceholders(group.length, SNAPSHOT_COLUMNS.length)
        const params = group.flatMap(snapshot => SNAPSHOT_COLUMNS.map(column => snapshot[column]))
        const result = await runner.run(
            `INSERT INTO activity_snapshots (${SNAPSHOT_COLUMNS.join(',')}) VALUES ${placeholders}
             ON CONFLICT (sync_user, account_id, item_id) DO UPDATE SET ${updateColumns}`,
            params
        )
        written += Number(result?.changes || 0)
    }

    return written
}

async function deleteSnapshots(keys, tx) {
    if (keys.length === 0) return 0
    const runner = tx || db
    const groups = new Map()
    for (const key of keys) {
        const groupKey = `${key.syncUser}\u0000${key.accountId}`
        if (!groups.has(groupKey)) {
            groups.set(groupKey, { syncUser: key.syncUser, accountId: key.accountId, itemIds: [] })
        }
        groups.get(groupKey).itemIds.push(key.itemId)
    }

    let deleted = 0
    for (const group of groups.values()) {
        const itemIds = Array.from(new Set(group.itemIds))
        for (const chunk of chunked(itemIds)) {
            const placeholders = chunk.map((_, idx) => `$${idx + 3}`).join(',')
            const result = await runner.run(
                `DELETE FROM activity_snapshots WHERE sync_user = $1 AND account_id = $2 AND item_id IN (${placeholders})`,
                [group.syncUser, group.accountId, ...chunk]
            )
            deleted += Number(result?.changes || 0)
        }
    }
    return deleted
}

async function scanAccount(syncUser, accountId, accountName, authKey, limits, log = null) {
    const scanStart = Date.now()
    trace('activity', 'scanAccount.start', { accountId })
    const library = await fetchLibrary(authKey, limits.deadline, log)
    if (!library || !Array.isArray(library)) {
        trace('activity', 'scanAccount.complete', { accountId, libraryItems: 0, skipped: true, reason: 'no-library', timing: Date.now() - scanStart })
        return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: false, complete: true }
    }

    const hashKey = `${syncUser}:${accountId}`
    const libraryHash = computeLibraryHash(library)
    if (getCachedLibraryHash(hashKey) === libraryHash) {
        trace('activity', 'scanAccount.complete', { accountId, libraryItems: library.length, skipped: true, reason: 'hash-match', timing: Date.now() - scanStart })
        return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: true, complete: true }
    }

    const existingSnapshots = await getSnapshot(syncUser, accountId)
    const snapMap = buildSnapshotMap(existingSnapshots)
    const events = []
    const snapshots = []
    const snapshotsToDelete = []
    const seenItemIds = new Set()
    let complete = true

    const enqueueEvent = (event) => {
        if (events.length >= limits.maxEvents) {
            complete = false
            return false
        }
        events.push(event)
        return true
    }

    const enqueueSnapshot = (snapshot, existing) => {
        if (!snapshotNeedsWrite(existing, snapshot)) return true
        if (snapshots.length >= limits.maxSnapshots) {
            complete = false
            return false
        }
        snapshots.push(snapshot)
        return true
    }

    for (const item of library) {
        if (Date.now() > limits.deadline) {
            complete = false
            break
        }

        const itemId = item.id || item._id || ''
        if (!itemId) continue
        seenItemIds.add(itemId)

        const mtime = parseEventTime(item._mtime)
        if (!mtime) continue

        const snap = snapMap.get(itemId)
        const videoId = item.video_id || item.unique_id || itemId

        if (item.removed) {
            const s = item.state || item
            const hasWatchData =
                (Number(s.timesWatched ?? 0) > 0) ||
                (Number(s.timeOffset ?? 0) > 0) ||
                (Number(s.timeWatched ?? 0) > 0) ||
                (Number(s.overallTimeWatched ?? 0) > 0) ||
                (s.video_id && String(s.video_id).trim() !== '') ||
                (Number(s.flaggedWatched ?? 0) > 0)
            if (!hasWatchData) {
                if (snap) snapshotsToDelete.push({ syncUser, accountId, itemId })
                continue
            }
        }

        if (!isActuallyWatched(item)) continue

        if (!snap) {
            const isSeries = isSeriesItem(item)
            if (!isSeries || item.video_id) {
                const eventTs = parseEventTime(item._ctime) || mtime
                if (!enqueueEvent(buildEvent(syncUser, accountId, accountName, item, 'first_watch', eventTs))) break
            }
            if (!enqueueSnapshot(buildSnapshot(syncUser, accountId, itemId, item, mtime), null)) break
            continue
        }

        const snapMtime = Number(snap.mtime ?? 0)
        if (shouldPreserveSnapshotEpisode(itemId, item, snap, mtime, snapMtime)) {
            if (!enqueueEvent(buildEvent(syncUser, accountId, accountName, snapshotToItem(itemId, snap, item), 'snapshot_watch', snapMtime))) break
        }

        if (mtime > snapMtime && hasWatchStateChange({ ...item, video_id: videoId }, snap)) {
            if (!enqueueEvent(buildEvent(syncUser, accountId, accountName, item, 'watch_progress', mtime))) break
        }

        if (!enqueueSnapshot(buildSnapshot(syncUser, accountId, itemId, item, mtime), snap)) break
    }

    if (complete) {
        for (const [itemId] of snapMap) {
            if (!seenItemIds.has(itemId)) snapshotsToDelete.push({ syncUser, accountId, itemId })
        }
    }

    const [eventsWritten, snapshotWrites, snapshotDeletes] = await db.tx(async (tx) => {
        const ew = await batchInsertEvents(events, tx)
        const sw = await batchUpsertSnapshots(snapshots, tx)
        const sd = await deleteSnapshots(snapshotsToDelete, tx)
        return [ew, sw, sd]
    })

    if (complete) setCachedLibraryHash(hashKey, libraryHash)

    trace('activity', 'scanAccount.complete', { accountId, libraryItems: library.length, eventsWritten, snapshotWrites, snapshotDeletes, complete, timing: Date.now() - scanStart })
    return { eventsWritten, snapshotWrites, snapshotDeletes, skippedByHash: false, complete }
}

async function runActivityCycle(fastify) {
    if (isScanning) {
        trace('activity', 'runActivityCycle.skipped', { reason: 'scan_in_progress' })
        return { skipped: true, reason: 'scan_in_progress' }
    }
    if (!ACTIVITY_ENGINE_ENABLED) {
        trace('activity', 'runActivityCycle.skipped', { reason: 'activity_engine_disabled' })
        return { skipped: true, reason: 'activity_engine_disabled' }
    }

    const cycleStart = Date.now()
    trace('activity', 'runActivityCycle.start', {})

    isScanning = true
    const startTime = Date.now()
    const deadline = startTime + ACTIVITY_CYCLE_BUDGET_MS
    const summary = {
        skipped: false,
        accountsScanned: 0,
        accountsSkippedByHash: 0,
        eventsWritten: 0,
        snapshotWrites: 0,
        snapshotDeletes: 0,
        budgetExhausted: false,
    }

    try {
        const cycleCredentials = await getAccountsForCycle()
        if (cycleCredentials.length === 0) return summary

        if (!nonStremioSkipWarned) {
            const nonStremio = await db.query(
                "SELECT 1 FROM server_credentials WHERE credential_type IS NOT NULL AND credential_type != 'stremio' LIMIT 1"
            ).catch(() => [])
            if (nonStremio.length > 0) {
                nonStremioSkipWarned = true
                fastify.log.warn({ category: 'Activity' }, 'Non-Stremio accounts (Nuvio/RealStream/Hydra) are present but not tracked by the activity scanner; only Stremio credentials are scanned.')
            }
        }

        for (const cred of cycleCredentials) {
            if (Date.now() > deadline) {
                summary.budgetExhausted = true
                break
            }
            if (summary.eventsWritten >= ACTIVITY_MAX_EVENTS_PER_CYCLE) {
                summary.budgetExhausted = true
                break
            }
            if (summary.snapshotWrites >= ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE) {
                summary.budgetExhausted = true
                break
            }

            const authKey = decrypt(cred.auth_key, FALLBACK_KEYS)
            if (!authKey) continue

            try {
                const result = await scanAccount(cred.sync_user, cred.account_id, cred.account_name, authKey, {
                    deadline,
                    maxEvents: Math.max(0, ACTIVITY_MAX_EVENTS_PER_CYCLE - summary.eventsWritten),
                    maxSnapshots: Math.max(0, ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE - summary.snapshotWrites),
                }, fastify.log)
                summary.accountsScanned++
                if (result.skippedByHash) summary.accountsSkippedByHash++
                summary.eventsWritten += result.eventsWritten
                summary.snapshotWrites += result.snapshotWrites
                summary.snapshotDeletes += result.snapshotDeletes
                if (Date.now() > deadline) {
                    summary.budgetExhausted = true
                    break
                }
                if (!result.complete) {
                    summary.budgetExhausted = true
                    break
                }
            } catch (err) {
                fastify.log.warn({ category: 'Activity' }, `Scan failed for account ${cred.account_id}: ${err.message}`)
            }
        }

        fastify.log.info(
            { category: 'Activity' },
            `Activity scan complete: ${summary.accountsScanned} accounts scanned (${summary.accountsSkippedByHash} hash-skipped), ${summary.eventsWritten} events, ${summary.snapshotWrites} snapshot writes, ${summary.snapshotDeletes} snapshot deletes in ${Date.now() - startTime}ms${summary.budgetExhausted ? ' (budget exhausted)' : ''}`
        )
        trace('activity', 'runActivityCycle.complete', { accountsScanned: summary.accountsScanned, accountsSkippedByHash: summary.accountsSkippedByHash, eventsWritten: summary.eventsWritten, snapshotWrites: summary.snapshotWrites, snapshotDeletes: summary.snapshotDeletes, budgetExhausted: summary.budgetExhausted, timing: Date.now() - cycleStart })

        return summary
    } catch (err) {
        fastify.log.error({ category: 'Activity' }, `Activity scan error: ${err.message}`)
        trace('activity', 'runActivityCycle.error', { error: err.message, timing: Date.now() - cycleStart })
        return { ...summary, error: 'scan_failed' }
    } finally {
        isScanning = false
    }
}

function jitteredDelay(baseDelay) {
    if (ACTIVITY_SCAN_JITTER_MS <= 0) return baseDelay
    return baseDelay + Math.floor(Math.random() * ACTIVITY_SCAN_JITTER_MS)
}

export function createActivityEngine(fastify) {
    const scheduleNext = (initial = false) => {
        if (!isStarted || !ACTIVITY_ENGINE_ENABLED) return
        const delay = jitteredDelay(initial ? ACTIVITY_INITIAL_DELAY_MS : ACTIVITY_SCAN_INTERVAL_MS)
        scanTimer = setTimeout(async () => {
            scanTimer = null
            await runActivityCycle(fastify)
            scheduleNext(false)
        }, delay)
    }

    return {
        start() {
            if (!ACTIVITY_ENGINE_ENABLED) {
                fastify.log.info({ category: 'Activity' }, 'Activity engine disabled. Set ACTIVITY_ENGINE_ENABLED=true to enable background polling.')
                return
            }
            if (isStarted) return
            isStarted = true
            scheduleNext(true)
            fastify.log.info({ category: 'Activity' }, `Activity engine started (interval: ${ACTIVITY_SCAN_INTERVAL_MS / 60000}min, jitter: ${ACTIVITY_SCAN_JITTER_MS / 1000}s)`)
        },
        stop() {
            isStarted = false
            if (scanTimer) {
                clearTimeout(scanTimer)
                scanTimer = null
            }
            fastify.log.info({ category: 'Activity' }, 'Activity engine stopped.')
        },
        async triggerScan() {
            if (!ACTIVITY_ENGINE_ENABLED) return { triggered: false, reason: 'activity_engine_disabled' }
            if (isScanning) return { triggered: false, reason: 'scan_in_progress' }
            const summary = await runActivityCycle(fastify)
            return { triggered: !summary.skipped, ...summary }
        },
        isRunning() {
            return isScanning
        },
        isEnabled() {
            return ACTIVITY_ENGINE_ENABLED
        },
        getConfig() {
            return {
                enabled: ACTIVITY_ENGINE_ENABLED,
                intervalMs: ACTIVITY_SCAN_INTERVAL_MS,
                jitterMs: ACTIVITY_SCAN_JITTER_MS,
                maxAccountsPerCycle: ACTIVITY_MAX_ACCOUNTS_PER_CYCLE,
                maxEventsPerCycle: ACTIVITY_MAX_EVENTS_PER_CYCLE,
                maxSnapshotWritesPerCycle: ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE,
                fetchTimeoutMs: ACTIVITY_FETCH_TIMEOUT_MS,
                batchSize: ACTIVITY_BATCH_SIZE,
                retention: 'permanent',
            }
        }
    }
}
