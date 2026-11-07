import { createHash } from 'crypto'
import db from '../db.js'
import { decrypt } from '../crypto.js'
import { FALLBACK_KEYS } from '../keys.js'
import { STREMIO_API } from '../config.js'
import { enqueueProxyRequest } from '../proxy-queue.js'
import { resilientFetch } from '../utils/api-resilience.js'
import { trace } from '../utils/trace.js'
import { createFailureBreaker } from './breaker.js'
import { runBudgetedScan } from './cycle-runner.js'
import { assertAccountActive, gateCode } from '../admin/account-state.js'

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
const ACTIVITY_SCAN_CONCURRENCY = envInt('ACTIVITY_SCAN_CONCURRENCY', 4, 1)
const ACTIVITY_BREAKER_THRESHOLD = envInt('ACTIVITY_BREAKER_THRESHOLD', 2, 1)
const ACTIVITY_BREAKER_BASE_MS = envInt('ACTIVITY_BREAKER_BASE_MS', 5 * 60 * 1000, 0)
const ACTIVITY_BREAKER_MAX_MS = envInt('ACTIVITY_BREAKER_MAX_MS', 60 * 60 * 1000, 0)

const EVENT_COLUMNS = [
    'id', 'sync_user', 'account_id', 'account_name', 'item_id', 'unique_item_id', 'item_name', 'item_type',
    'poster', 'season', 'episode', 'video_id', 'event_type', 'event_ts', 'duration', 'progress', 'watched',
    'times_watched', 'is_in_progress', 'overall_time_watched', 'metadata'
]

const SNAPSHOT_COLUMNS = [
    'sync_user', 'account_id', 'item_id', 'unique_item_id', 'item_name', 'item_type', 'poster',
    'season', 'episode', 'video_id', 'duration', 'progress', 'watched', 'times_watched',
    'is_in_progress', 'overall_time_watched', 'mtime', 'time_watched'
]

// time_watched rides along with writes the compared columns already trigger; it never causes one.
const SNAPSHOT_COMPARE_COLUMNS = SNAPSHOT_COLUMNS.filter(col => !['sync_user', 'account_id', 'item_id', 'mtime', 'time_watched'].includes(col))

let scanTimer = null
let isStarted = false
let isScanning = false
let credentialCursor = null
let nonStremioSkipWarned = false
// Last finished cycle, in memory only, for the Dashboard.
let lastCycle = null
const accountStateHashes = new Map()

// Keep per-account fetch backoff across cycles until success or process restart.
const fetchBreaker = createFailureBreaker({
    threshold: ACTIVITY_BREAKER_THRESHOLD,
    baseMs: ACTIVITY_BREAKER_BASE_MS,
    maxMs: Math.max(ACTIVITY_BREAKER_MAX_MS, ACTIVITY_BREAKER_BASE_MS),
})

// Breaker keys are JSON [sync_user, account_id, connection_id]; an owner reset
// touches only that owner's entries. Zero DB writes.
const breakerKeyOwner = (key) => {
    try { return JSON.parse(key)[0] } catch { return null }
}

// Clears exactly the entries the dry run counts: this owner's connections whose
// backoff window is still open. Not-yet-tripped and expired entries stay.
export function resetBreakerForOwner(syncUser) {
    if (!syncUser) return 0
    const now = Date.now()
    return fetchBreaker.clearMatching((key, entry) => breakerKeyOwner(key) === syncUser && entry.until > now)
}

export function breakerSummaryForOwner(syncUser) {
    const now = Date.now()
    const owned = syncUser ? fetchBreaker.inspectMatching((key) => breakerKeyOwner(key) === syncUser) : []
    let inBackoff = 0
    let longestMs = 0
    for (const entry of owned) {
        if (entry.until > now) {
            inBackoff++
            longestMs = Math.max(longestMs, entry.until - now)
        }
    }
    return { entries: owned.length, inBackoff, longestBackoffMs: longestMs }
}

export const _fetchBreakerForTests = fetchBreaker

function deterministicEventId(syncUser, accountId, itemId, eventType, eventTs, season, episode) {
    const bucket = Math.floor(Number(eventTs || Date.now()) / 60000)
    const raw = `${syncUser}:${accountId}:${itemId}:${season ?? ''}:${episode ?? ''}:${eventType}:${bucket}`
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32)
    return `evt_${hash}`
}

// watch_progress ids key on the watch itself (episode, resume position, accumulated time, flag,
// play count and lastWatched day), not the write time: a retry of the same watch hits
// ON CONFLICT DO NOTHING while a separate watch with the same measures stays distinct.
function watchOccurrenceEventId(syncUser, accountId, itemId, season, episode, item) {
    const lastWatched = parseEventTime(item.lastWatched)
    const day = lastWatched ? new Date(lastWatched).toISOString().slice(0, 10) : ''
    const occurrence = `p${asNumber(item.progress)}:o${asNumber(item.overallTimeWatched)}:w${asNumber(item.watched)}:t${asNumber(item.timesWatched)}:d${day}`
    const raw = `${syncUser}:${accountId}:${itemId}:${season ?? ''}:${episode ?? ''}:watch_progress:${occurrence}`
    return `evt_${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`
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
        lastWatched: s.lastWatched || raw.lastWatched || null,
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

// Stremio uses placeholder dates such as 0001-01-01 for "never".
const MIN_PLAUSIBLE_EVENT_MS = Date.UTC(1995, 0, 1)

export function parseEventTime(value) {
    if (!value) return 0
    const parsed = new Date(value).getTime()
    if (!Number.isFinite(parsed) || parsed < MIN_PLAUSIBLE_EVENT_MS) return 0
    return parsed > Date.now() + 5 * 60 * 1000 ? Date.now() : parsed
}

// A library item's _ctime is when it was added, not when it was watched.
export function firstWatchTime(item, mtime) {
    const lastWatched = parseEventTime(item.lastWatched)
    if (lastWatched > 0) return lastWatched
    if (mtime > 0) return mtime
    return parseEventTime(item._ctime)
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

// Keyset cursor on the collapsed login identity. It never changes mid-rotation the way
// updated_at does (re-login, token refresh), and unlike the winning row's id it does not
// move when a duplicate bump swaps which row wins.
function credentialCursorKey(row) {
    return { syncUser: row.sync_user, accountId: row.account_id, connectionId: row.connection_id ?? '' }
}

function credentialLoginId(row) {
    return `${row.sync_user}\u0000${row.account_id}\u0000${row.connection_id ?? ''}`
}

async function getRegisteredAccountsPage(limit, after = null) {
    // Stremio-only: Nuvio/RealStream auth_key rows are JSON token bundles, not Stremio authKeys.
    // Per-connection rows (secondary logins) are scanned too, each under its OWN scope —
    // two Stremio users on one account must never poll into one snapshot key. Duplicate
    // rows of the same login (account-level dupes or per-connection re-registrations)
    // collapse before pagination so duplicates cannot make a full page look like
    // the end of the table and prevent later accounts from ever being scanned.
    // Keyset paging (#43): OFFSET over updated_at let rows shift between pages, so a
    // login could be skipped or scanned twice for a whole rotation.
    // Params stay in text order: the db layer rewrites $n positionally for SQLite.
    const keyset = after
        ? {
            where: ` AND (sync_user, account_id, COALESCE(connection_id, '')) > ($1, $2, $3)`,
            limitParam: '$4',
            params: [after.syncUser, after.accountId, after.connectionId, limit],
        }
        : { where: '', limitParam: '$1', params: [limit] }
    return db.query(
        `SELECT sync_user, account_id, account_name, auth_key, connection_id
         FROM (
             SELECT sync_user, account_id, account_name, auth_key, connection_id, updated_at, id,
                    ROW_NUMBER() OVER (
                        PARTITION BY sync_user, account_id, COALESCE(connection_id, '')
                        ORDER BY updated_at DESC, id ASC
                    ) AS login_rank
             FROM server_credentials
             WHERE (credential_type = 'stremio' OR credential_type IS NULL)
               AND NOT EXISTS (SELECT 1 FROM account_admin_state aas WHERE aas.sync_user = server_credentials.sync_user)
         ) ranked
         WHERE login_rank = 1${keyset.where}
         ORDER BY sync_user ASC, account_id ASC, COALESCE(connection_id, '') ASC
         LIMIT ${keyset.limitParam}`,
        keyset.params
    )
}

export async function getAccountsForCycle() {
    const limit = ACTIVITY_MAX_ACCOUNTS_PER_CYCLE
    let selected = await getRegisteredAccountsPage(limit, credentialCursor)

    if (selected.length === 0 && credentialCursor) {
        credentialCursor = null
        selected = await getRegisteredAccountsPage(limit, null)
    } else if (selected.length < limit && credentialCursor) {
        const seen = new Set(selected.map(credentialLoginId))
        const wrapped = await getRegisteredAccountsPage(limit - selected.length, null)
        selected = [...selected, ...wrapped.filter(row => !seen.has(credentialLoginId(row)))]
    }

    credentialCursor = selected.length < limit ? null : credentialCursorKey(selected[selected.length - 1])
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
        time_watched: item.timeWatched || 0,
    }
}

function buildEvent(syncUser, accountId, accountName, item, eventType, eventTs = null) {
    const se = getSeasonEpisode(item)
    const itemId = item.id || item._id || ''
    const uniqueId = item.unique_id || item.video_id || `${accountId}:${itemId}`
    const ts = eventTs || Date.now()
    return {
        id: eventType === 'watch_progress'
            ? watchOccurrenceEventId(syncUser, accountId, uniqueId, se.season, se.episode, item)
            : deterministicEventId(syncUser, accountId, uniqueId, eventType, ts, se.season, se.episode),
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

/**
 * A same-episode change is a play only with evidence for that episode: its resume position
 * moved, or its own watch time grew while lastWatched advanced past the last recorded watch.
 * Stremio keeps video_id on the last played episode while others are marked watched (e.g.
 * synced from another app), bumping the count, the aggregate time and _mtime; those are not
 * plays. A baseline without per-episode time cannot prove one. For a movie the watched flag
 * is its own state, so marking it watched still counts.
 */
export function isPlaybackChange(item, snap, snapMtime = 0) {
    const current = buildSnapshot(snap.sync_user || '', snap.account_id || '', item.id || item._id || '', item, 0)
    const sameEpisode = !['video_id', 'season', 'episode'].some(column => valuesDiffer(column, snap[column], current[column]))
    if (!sameEpisode || !isSeriesItem(item)) return true
    if (valuesDiffer('progress', snap.progress, current.progress)) return true
    if (snap.time_watched == null) return false
    // An outside mark already advances lastWatched, so after one this reduces to "time_watched grew".
    return asNumber(current.time_watched) > asNumber(snap.time_watched) && parseEventTime(item.lastWatched) > snapMtime
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

// Events and snapshots for a SECONDARY login are stored under the scoped account id
// `${accountId}::${connectionId}` — the snapshot PK (sync_user, account_id, item_id)
// then isolates the two users' libraries, and deterministic event ids stay unique per
// login. The canonical/legacy login keeps the bare accountId exactly as before.
function scanScopeAccountId(accountId, connectionId) {
    return connectionId ? `${accountId}::${connectionId}` : accountId
}

async function scanAccount(syncUser, accountId, accountName, authKey, limits, log = null, connectionId = null) {
    const scanStart = Date.now()
    trace('activity', 'scanAccount.start', { accountId, connectionId })
    // Deadline exhaustion halts the cycle without penalizing the account.
    if (limits.deadline && Date.now() >= limits.deadline) {
        trace('activity', 'scanAccount.complete', { accountId, connectionId, libraryItems: 0, skipped: true, reason: 'deadline-cut', timing: Date.now() - scanStart })
        return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: false, complete: false, failed: false }
    }
    // Account state gate: a blocked owner is skipped without a platform call, a DB
    // write or a breaker failure; the cycle summary counts it as skipped.
    try {
        await assertAccountActive(syncUser)
    } catch (stateErr) {
        if (gateCode(stateErr)) {
            trace('activity', 'scanAccount.complete', { accountId, connectionId, libraryItems: 0, skipped: true, reason: 'owner-blocked', timing: Date.now() - scanStart })
            return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: true, complete: true, failed: false }
        }
        throw stateErr
    }
    const library = await fetchLibrary(authKey, limits.deadline, log)
    if (!library || !Array.isArray(library)) {
        // An empty response after the deadline is a budget cut, not a fetch failure.
        const deadlineCut = Boolean(limits.deadline) && Date.now() >= limits.deadline
        trace('activity', 'scanAccount.complete', { accountId, connectionId, libraryItems: 0, skipped: true, reason: deadlineCut ? 'deadline-cut' : 'no-library', timing: Date.now() - scanStart })
        return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: false, complete: !deadlineCut, failed: !deadlineCut }
    }

    const scopeAccountId = scanScopeAccountId(accountId, connectionId)
    const hashKey = `${syncUser}:${scopeAccountId}`
    const libraryHash = computeLibraryHash(library)
    if (getCachedLibraryHash(hashKey) === libraryHash) {
        trace('activity', 'scanAccount.complete', { accountId, connectionId, libraryItems: library.length, skipped: true, reason: 'hash-match', timing: Date.now() - scanStart })
        return { eventsWritten: 0, snapshotWrites: 0, snapshotDeletes: 0, skippedByHash: true, complete: true }
    }

    const existingSnapshots = await getSnapshot(syncUser, scopeAccountId)
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
                if (snap) snapshotsToDelete.push({ syncUser, accountId: scopeAccountId, itemId })
                continue
            }
        }

        if (!isActuallyWatched(item)) continue

        if (!snap) {
            const isSeries = isSeriesItem(item)
            if (!isSeries || item.video_id) {
                const eventTs = firstWatchTime(item, mtime)
                if (!enqueueEvent(buildEvent(syncUser, scopeAccountId, accountName, item, 'first_watch', eventTs))) break
            }
            if (!enqueueSnapshot(buildSnapshot(syncUser, scopeAccountId, itemId, item, mtime), null)) break
            continue
        }

        const snapMtime = Number(snap.mtime ?? 0)
        if (shouldPreserveSnapshotEpisode(itemId, item, snap, mtime, snapMtime)) {
            if (!enqueueEvent(buildEvent(syncUser, scopeAccountId, accountName, snapshotToItem(itemId, snap, item), 'snapshot_watch', snapMtime))) break
        }

        let snapshotMtime = mtime
        if (mtime > snapMtime && hasWatchStateChange({ ...item, video_id: videoId }, snap)) {
            if (isPlaybackChange({ ...item, video_id: videoId }, snap, snapMtime)) {
                if (!enqueueEvent(buildEvent(syncUser, scopeAccountId, accountName, item, 'watch_progress', mtime))) break
            } else {
                // Not a play: keep the last real watch time so a later episode change does
                // not preserve this write as a watch.
                snapshotMtime = snapMtime
            }
        }

        if (!enqueueSnapshot(buildSnapshot(syncUser, scopeAccountId, itemId, item, snapshotMtime), snap)) break
    }

    if (complete) {
        for (const [itemId] of snapMap) {
            if (!seenItemIds.has(itemId)) snapshotsToDelete.push({ syncUser, accountId: scopeAccountId, itemId })
        }
    }

    const [eventsWritten, snapshotWrites, snapshotDeletes] = await db.tx(async (tx) => {
        const ew = await batchInsertEvents(events, tx)
        const sw = await batchUpsertSnapshots(snapshots, tx)
        const sd = await deleteSnapshots(snapshotsToDelete, tx)
        return [ew, sw, sd]
    })

    if (complete) setCachedLibraryHash(hashKey, libraryHash)

    trace('activity', 'scanAccount.complete', { accountId, connectionId, libraryItems: library.length, eventsWritten, snapshotWrites, snapshotDeletes, complete, timing: Date.now() - scanStart })
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
        accountsSkippedByBreaker: 0,
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

        // Skip accounts with repeated fetch failures until their backoff expires. The
        // breaker key carries the connection id: a failing secondary login backs off
        // itself without silencing the canonical login's scans (and vice versa).
        const eligibleCreds = []
        for (const cred of cycleCredentials) {
            const breakerKey = JSON.stringify([cred.sync_user, cred.account_id, cred.connection_id ?? null])
            const breakerState = fetchBreaker.shouldSkip(breakerKey)
            if (breakerState?.skip) {
                summary.accountsSkippedByBreaker++
                trace('activity', 'cycle.breaker-skip', { accountId: cred.account_id, connectionId: cred.connection_id ?? null, failures: breakerState.failures })
                continue
            }
            eligibleCreds.push(cred)
        }

        const scanSummary = await runBudgetedScan({
            items: eligibleCreds,
            concurrency: ACTIVITY_SCAN_CONCURRENCY,
            deadline,
            maxEvents: ACTIVITY_MAX_EVENTS_PER_CYCLE,
            maxSnapshots: ACTIVITY_MAX_SNAPSHOT_WRITES_PER_CYCLE,
            scanItem: async (cred, limits) => {
                const authKey = decrypt(cred.auth_key, FALLBACK_KEYS)
                if (!authKey) return null
                try {
                    const result = await scanAccount(cred.sync_user, cred.account_id, cred.account_name, authKey, {
                        deadline: limits.deadline,
                        maxEvents: limits.maxEvents,
                        maxSnapshots: limits.maxSnapshots,
                    }, fastify.log, cred.connection_id ?? null)
                    const breakerKey = JSON.stringify([cred.sync_user, cred.account_id, cred.connection_id ?? null])
                    if (result.failed) fetchBreaker.recordFailure(breakerKey)
                    else if (result.failed !== false) fetchBreaker.recordSuccess(breakerKey)
                    if (result.skippedByHash) summary.accountsSkippedByHash++
                    return result
                } catch (err) {
                    // Only platform fetch failures affect the breaker.
                    fastify.log.warn({ category: 'Activity' }, `Scan failed for account ${cred.account_id}${cred.connection_id ? ` (connection ${cred.connection_id})` : ''}: ${err.message}`)
                    return null
                }
            },
        })

        summary.accountsScanned = scanSummary.scanned
        summary.eventsWritten = scanSummary.eventsWritten
        summary.snapshotWrites = scanSummary.snapshotWrites
        summary.snapshotDeletes = scanSummary.snapshotDeletes
        summary.budgetExhausted = scanSummary.budgetExhausted

        fastify.log.info(
            { category: 'Activity' },
            `Activity scan complete: ${summary.accountsScanned} accounts scanned (${summary.accountsSkippedByHash} hash-skipped, ${summary.accountsSkippedByBreaker} breaker-skipped), ${summary.eventsWritten} events, ${summary.snapshotWrites} snapshot writes, ${summary.snapshotDeletes} snapshot deletes in ${Date.now() - startTime}ms${summary.budgetExhausted ? ' (budget exhausted)' : ''}`
        )
        trace('activity', 'runActivityCycle.complete', { accountsScanned: summary.accountsScanned, accountsSkippedByHash: summary.accountsSkippedByHash, accountsSkippedByBreaker: summary.accountsSkippedByBreaker, eventsWritten: summary.eventsWritten, snapshotWrites: summary.snapshotWrites, snapshotDeletes: summary.snapshotDeletes, budgetExhausted: summary.budgetExhausted, timing: Date.now() - cycleStart })

        lastCycle = { ...summary, startedAt: cycleStart, durationMs: Date.now() - cycleStart }
        return summary
    } catch (err) {
        lastCycle = { ...summary, error: 'scan_failed', startedAt: cycleStart, durationMs: Date.now() - cycleStart }
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
        getStatus() {
            return { enabled: ACTIVITY_ENGINE_ENABLED, running: isScanning, started: isStarted, lastCycle: lastCycle ? { ...lastCycle } : null, breakerEntries: fetchBreaker.size() }
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
                scanConcurrency: ACTIVITY_SCAN_CONCURRENCY,
                breaker: {
                    threshold: ACTIVITY_BREAKER_THRESHOLD,
                    baseMs: ACTIVITY_BREAKER_BASE_MS,
                    maxMs: Math.max(ACTIVITY_BREAKER_MAX_MS, ACTIVITY_BREAKER_BASE_MS),
                },
                retention: 'permanent',
            }
        }
    }
}
