// Persisted, encrypted observations of successful Jellyfin library reads.
//
// The media query client in useJellyfinMedia is deliberately transient
// (gcTime 0, fresh per page load), so on a full reload every account card
// briefly renders a latest-watched title from another platform until the
// Jellyfin request settles. This cache restores the last SUCCESSFUL dated
// library observation per account+connection while the fresh read is in
// flight, so the card never falls back to the wrong platform's title.
//
// Invariants:
//   - only successful resume/played/archive reads are persisted, never
//     sessions and never credentials: a restored snapshot can never fabricate
//     live playing/paused state or reconnect anyone
//   - the payload is sealed with the vault's encryption key via the shared
//     encrypt/decrypt helpers, so no plaintext watch history is ever at rest
//   - storage follows the workspace-persisted localforage routing, so each
//     vault owner's observations live in that owner's database
//   - every payload records the exact subject scope (account, connection,
//     sealed credentials, verified remote user and server) and restores only
//     for an identical scope: a reconnect, user change or server change can
//     never inherit the previous subject's history
//   - restored observations are placeholders for pending reads only; a live
//     error replaces them, and honesty flags (complete/limited/total) are
//     preserved exactly as they were observed
//   - version and subject validation reject the whole payload; each read is
//     validated independently so a damaged section cannot discard healthy
//     siblings or be restored as a successful empty listing

import type { MediaRead } from './reads.ts'
import type { JellyfinItem, JellyfinItemResult } from './types.ts'

/** A probe proves the head current for at most this long; then a full read is forced. */
export const HEAD_PROBE_MAX_AGE_MS = 5 * 60_000
/** Rows fetched by the cheap head probe. */
export const HEAD_PROBE_ROWS = 25

export const MEDIA_CACHE_PREFIX = 'aio_jf_media_v1'
const MEDIA_CACHE_VERSION = 1
/**
 * Mirrors the client's deterministic full-walk sanity bound (50,000 items):
 * the largest observation a honest read can produce. Not a product cutoff —
 * it exists so a corrupt payload cannot balloon memory.
 */
const MAX_ITEMS_PER_READ = 50_000

/** Message matching the waiting placeholder in useJellyfinMedia. */
export const MEDIA_READ_WAITING_MESSAGE = 'Reading this server for the verified user…'

/** The exact subject a cached observation belongs to. Every field must match. */
export interface MediaCacheScope {
    accountId: string
    connectionId: string
    /** Sealed credential blob (connection.credentials.jellyfin): the saved sign-in's identity. */
    credentials: string
    /** Verified remote user (connection.mediaServer.userId). */
    userId: string
    /** Verified remote server (connection.mediaServer.serverId, '' when unknown). */
    serverId: string
}

export interface MediaCacheReadObservation {
    items: JellyfinItem[]
    total: number | null
    complete: boolean
    paginationComplete?: true
    limited?: true
    /** Whether the server accepted DatePlayed sorting for this read, when it was requested. */
    sortAccepted?: boolean
    limit: number
    /** When the server reported this read; restored reads keep this timestamp. */
    checkedAt: number
}

export interface MediaCacheObservation {
    resume?: MediaCacheReadObservation
    played?: MediaCacheReadObservation
    /** Last successful full-history walk (all played pages), head+archive merge source. */
    archive?: MediaCacheReadObservation
    savedAt: number
}

/** Sections of an observation a writer may update without touching the rest. */
export type MediaCacheObservationSections = Partial<Pick<MediaCacheObservation, 'resume' | 'played' | 'archive'>> & { savedAt?: number }

/** Injectable cipher bound to the active vault key. */
export interface MediaCacheCrypto {
    encrypt(plain: string): Promise<string>
    decrypt(sealed: string): Promise<string>
}

/** Loading only needs the decrypt half of a cipher. */
export type MediaCacheDecryptor = Pick<MediaCacheCrypto, 'decrypt'>

/** Injectable workspace-persisted key/value storage (localforage-compatible). */
export interface MediaCacheStorage {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
    removeItem(key: string): Promise<void>
    keys(): Promise<string[]>
}

export function mediaCacheStorageKey(scope: { accountId: string; connectionId: string }): string {
    return `${MEDIA_CACHE_PREFIX}:${scope.accountId}:${scope.connectionId}`
}

export function sameMediaCacheScope(a: MediaCacheScope, b: MediaCacheScope): boolean {
    return a.accountId === b.accountId
    && a.connectionId === b.connectionId
    && a.credentials === b.credentials
    && a.userId === b.userId
    && a.serverId === b.serverId
}

function isCacheItem(value: unknown): value is JellyfinItem {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { Id?: unknown }).Id === 'string' && (value as { Id: string }).Id !== ''
}

function parseReadObservation(value: unknown): MediaCacheReadObservation | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (!Array.isArray(record.items) || record.items.length > MAX_ITEMS_PER_READ) return undefined
    if (!record.items.every(isCacheItem)) return undefined
    const total = record.total
    if (!(total === null || (typeof total === 'number' && Number.isInteger(total) && total >= 0))) return undefined
    if (typeof record.complete !== 'boolean') return undefined
    if (record.paginationComplete !== undefined && record.paginationComplete !== true) return undefined
    if (record.limited !== undefined && record.limited !== true) return undefined
    if (record.sortAccepted !== undefined && typeof record.sortAccepted !== 'boolean') return undefined
    // Partials are never persisted: a stored in-flight snapshot is corrupt.
    if (record.inProgress !== undefined) return undefined
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit <= 0) return undefined
    if (typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt) || record.checkedAt < 0) return undefined
    return {
        items: record.items,
        total,
        complete: record.complete,
        ...(record.paginationComplete === true ? { paginationComplete: true as const } : {}),
        ...(record.limited === true ? { limited: true as const } : {}),
        ...(typeof record.sortAccepted === 'boolean' ? { sortAccepted: record.sortAccepted } : {}),
        limit: record.limit,
        checkedAt: record.checkedAt,
    }
}

export function encodeMediaObservation(scope: MediaCacheScope, observation: MediaCacheObservation): string {
    return JSON.stringify({ v: MEDIA_CACHE_VERSION, scope, observation })
}

export function decodeMediaObservation(payload: string, scope: MediaCacheScope): MediaCacheObservation | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(payload)
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.v !== MEDIA_CACHE_VERSION) return null
    const sealed = record.scope
    if (typeof sealed !== 'object' || sealed === null || Array.isArray(sealed)) return null
    const sealedScope = sealed as Record<string, unknown>
    for (const field of ['accountId', 'connectionId', 'credentials', 'userId', 'serverId'] as const) {
        if (typeof sealedScope[field] !== 'string') return null
    }
    const candidateScope: MediaCacheScope = {
        accountId: sealedScope.accountId as string,
        connectionId: sealedScope.connectionId as string,
        credentials: sealedScope.credentials as string,
        userId: sealedScope.userId as string,
        serverId: sealedScope.serverId as string,
    }
    if (!sameMediaCacheScope(candidateScope, scope)) return null
    if (typeof record.observation !== 'object' || record.observation === null || Array.isArray(record.observation)) return null
    const raw = record.observation as Record<string, unknown>
    if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt) || raw.savedAt < 0) return null
    const resume = parseReadObservation(raw.resume)
    const played = parseReadObservation(raw.played)
    const archive = parseReadObservation(raw.archive)
    if (!resume && !played && !archive) return null
    return {
        ...(resume ? { resume } : {}),
        ...(played ? { played } : {}),
        ...(archive ? { archive } : {}),
        savedAt: raw.savedAt,
    }
}

/** Keeps only the successful reads of a live result; null when nothing succeeded. */
export function observedLibraryReads(reads: { resume: MediaRead<JellyfinItemResult>; played: MediaRead<JellyfinItemResult> }): MediaCacheObservation | null {
    const keep = (read: MediaRead<JellyfinItemResult>): MediaCacheReadObservation | undefined =>
        read.status === 'success'
            ? {
                items: read.data.items,
                total: read.data.total,
                complete: read.data.complete,
                ...(read.data.paginationComplete ? { paginationComplete: true as const } : {}),
                ...(read.data.limited ? { limited: true as const } : {}),
                ...(typeof read.data.sortAccepted === 'boolean' ? { sortAccepted: read.data.sortAccepted } : {}),
                limit: read.data.limit,
                checkedAt: read.checkedAt,
            }
            : undefined
    const resume = keep(reads.resume)
    const played = keep(reads.played)
    if (!resume && !played) return null
    return {
        ...(resume ? { resume } : {}),
        ...(played ? { played } : {}),
        savedAt: Date.now(),
    }
}

/** A successful full-walk read as an archive observation; null for anything else. */
export function observedArchiveRead(read: MediaRead<JellyfinItemResult>): MediaCacheReadObservation | undefined {
    return read.status === 'success'
        ? {
            items: read.data.items,
            total: read.data.total,
            complete: read.data.complete,
            ...(read.data.paginationComplete ? { paginationComplete: true as const } : {}),
            ...(read.data.limited ? { limited: true as const } : {}),
            ...(typeof read.data.sortAccepted === 'boolean' ? { sortAccepted: read.data.sortAccepted } : {}),
            limit: read.data.limit,
            checkedAt: read.checkedAt,
        }
        : undefined
}

/**
 * Section-wise merge for read-modify-write persistence: the new sections win,
 * sections the writer did not touch survive from the previous observation.
 * Null when nothing would remain.
 */
export function mergeMediaObservations(previous: MediaCacheObservation | undefined, next: MediaCacheObservationSections): MediaCacheObservation | null {
    const merged: MediaCacheObservation = {
        resume: next.resume ?? previous?.resume,
        played: next.played ?? previous?.played,
        archive: next.archive ?? previous?.archive,
        savedAt: next.savedAt ?? Date.now(),
    }
    return merged.resume || merged.played || merged.archive ? merged : null
}

/** Converts a restored observation into the read pair the activity pipeline consumes. */
export function restoredLibraryReads(observation: MediaCacheObservation): { resume: MediaRead<JellyfinItemResult>; played: MediaRead<JellyfinItemResult>; archive?: MediaRead<JellyfinItemResult> } | null {
    if (!observation.resume && !observation.played && !observation.archive) return null
    const restore = (obs: MediaCacheReadObservation): MediaRead<JellyfinItemResult> => ({
        status: 'success',
        data: {
            items: obs.items,
            total: obs.total,
            complete: obs.complete,
            ...(obs.paginationComplete ? { paginationComplete: true as const } : {}),
            ...(obs.limited ? { limited: true as const } : {}),
            ...(typeof obs.sortAccepted === 'boolean' ? { sortAccepted: obs.sortAccepted } : {}),
            limit: obs.limit,
        },
        checkedAt: obs.checkedAt,
    })
    return {
        resume: observation.resume ? restore(observation.resume) : { status: 'waiting', message: MEDIA_READ_WAITING_MESSAGE },
        played: observation.played ? restore(observation.played) : { status: 'waiting', message: MEDIA_READ_WAITING_MESSAGE },
        ...(observation.archive ? { archive: restore(observation.archive) } : {}),
    }
}

export const ARCHIVE_RECONCILE_COOLDOWN_MS = 60_000

export const SETTLED_ARCHIVE_MAX = 8

/** Inserts as most recent and evicts the least recently used entries beyond `max`. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > max) {
        const oldest = map.keys().next()
        if (oldest.done) break
        map.delete(oldest.value)
    }
}

/** Drops every entry whose key is no longer owned by a live scope. */
export function pruneToLive<K, V>(map: Map<K, V>, live: ReadonlySet<K>): void {
    for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key)
}

export const ARCHIVE_REFRESH_MS = 10 * 60_000
const ARCHIVE_RETRY_BASE_MS = 30_000
/** Consecutive failed walks per scope before automatic archive retries stop. */
export const ARCHIVE_FAILURE_BUDGET = 3
/** After the budget trips, the next automatic walk is a single probe this long after. */
export const ARCHIVE_BREAKER_CAP_MS = 60 * 60_000

export interface ArchiveFailureState { failures: number; trippedAt: number | null }

/** `ms` spread by up to +/- `spread`, so connections that started together drift apart. */
export function jittered(ms: number, random: () => number = Math.random, spread = 0.2): number {
    return Math.round(ms * (1 + (random() * 2 - 1) * spread))
}

/** A fixed fraction in [0, 1) per key, so a jittered interval is identical on every render. */
export function stableRandom(key: string): () => number {
    let hash = 2166136261
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
    return () => ((hash >>> 0) % 10_000) / 10_000
}

/** Stable per-key jitter for fixed polling intervals: same key, same interval, every render. */
export function scopeJitteredInterval(base: number, key: string, spread = 0.1): number {
    return jittered(base, stableRandom(key), spread)
}

export function archiveBreakerOpen(state: ArchiveFailureState | undefined, now: number): boolean {
    return !!state && state.failures >= ARCHIVE_FAILURE_BUDGET && state.trippedAt !== null && now - state.trippedAt < ARCHIVE_BREAKER_CAP_MS
}

export function recordArchiveFailure(state: ArchiveFailureState | undefined, now: number): ArchiveFailureState {
    const failures = (state?.failures ?? 0) + 1
    return { failures, trippedAt: failures >= ARCHIVE_FAILURE_BUDGET ? now : null }
}

/** Visibility or a user refresh re-arms a tripped breaker for exactly one probe walk. */
export function rearmArchiveBreaker(state: ArchiveFailureState | undefined): ArchiveFailureState | undefined {
    return state && state.failures >= ARCHIVE_FAILURE_BUDGET ? { failures: ARCHIVE_FAILURE_BUDGET - 1, trippedAt: null } : state
}

/**
 * Next archive poll: the regular cadence once settled, a doubling backoff while
 * walks fail, and the breaker cap (never sooner) once the failure budget is spent.
 * Always jittered so connections do not synchronize.
 */
export function archiveRefetchDelay(state: ArchiveFailureState | undefined, now: number, random: () => number = Math.random, stranded = false): number {
    const failures = Math.max(state?.failures ?? 0, stranded ? 1 : 0)
    if (failures <= 0) return jittered(ARCHIVE_REFRESH_MS, random, 0.1)
    if (state && archiveBreakerOpen(state, now)) return ARCHIVE_BREAKER_CAP_MS - (now - state.trippedAt!) + Math.round(random() * ARCHIVE_BREAKER_CAP_MS * 0.1)
    return jittered(Math.min(ARCHIVE_REFRESH_MS, ARCHIVE_RETRY_BASE_MS * 2 ** (failures - 1)), random)
}

export const SESSION_POLL_MS = 15_000
export const SESSION_IDLE_POLL_MS = 45_000
/** Consecutive polls reporting no live row before card-only connections idle back. */
export const SESSION_IDLE_STREAK = 2

/**
 * /Sessions cadence: 15s whenever a page-scope consumer (Activity and the
 * other full pages) is mounted; connections only cards show idle back to a
 * jittered 45s after several empty polls, and any live row restores 15s.
 */
export function sessionRefetchDelay(idleStreak: number, pageScopeMounted: boolean, key: string): number {
    if (pageScopeMounted || idleStreak < SESSION_IDLE_STREAK) return SESSION_POLL_MS
    return scopeJitteredInterval(SESSION_IDLE_POLL_MS, key)
}

export interface PlayedComposeTrace {
    connection: string
    played: number | string
    archive: number | string
    partial: boolean
    settled: boolean
    restored: boolean
}

/** Render-free diagnostics payload for one composed connection. */
export function playedComposeTrace(args: {
    connectionId: string
    played: MediaRead<JellyfinItemResult>
    liveArchive: MediaRead<JellyfinItemResult> | undefined
    settledArchive: MediaRead<JellyfinItemResult> | undefined
    restoredArchive: MediaRead<JellyfinItemResult> | undefined
}): PlayedComposeTrace {
    const archive = args.liveArchive
    return {
        connection: args.connectionId.slice(0, 6),
        played: args.played.status === 'success' ? args.played.data.items.length : args.played.status,
        archive: archive?.status === 'success' ? archive.data.items.length : archive?.status ?? 'none',
        partial: archive?.status === 'success' && archive.data.inProgress === true,
        settled: !!args.settledArchive,
        restored: !!args.restoredArchive,
    }
}

/** Emits only when a connection's payload changed since its last emission. */
export function dedupeTrace(last: Map<string, string>, entry: PlayedComposeTrace): boolean {
    const signature = JSON.stringify(entry)
    if (last.get(entry.connection) === signature) return false
    last.set(entry.connection, signature)
    return true
}

export interface ArchiveRewalkState { at: number; signature: string; archiveCheckedAt: number }

/** Cheap identity of the fresh head listing: size and edge ids, never the drifting total. */
export function headListingSignature(head: JellyfinItemResult): string {
    const ids = head.items
    return [ids.length, ids[0]?.Id, ids[1]?.Id, ids[ids.length - 1]?.Id].join('|')
}

/**
 * Whether the head/archive mismatch warrants another full walk now. Cooldown
 * bounded; and once a walk has run for a given head listing, the same listing
 * still failing to reconcile is a property of the source, not stale data, so it
 * waits for the regular archive cadence. Any change to the head listing (a new
 * watch, a deletion) produces a new signature and walks again.
 */
export function archiveRewalkDue(args: {
    head: JellyfinItemResult
    archive: JellyfinItemResult
    archiveCheckedAt: number
    prior?: ArchiveRewalkState
    now: number
}): { due: boolean; signature: string } {
    const signature = headListingSignature(args.head)
    // Unknown totals cannot prove the tail; the head prefix still detects new
    // watches, and tail deletions wait for the regular archive cadence.
    const totalsKnown = args.head.total !== null && args.archive.total !== null
    if (totalsKnown ? playedReadsReconcile(args.head, args.archive) : headPrefixMatches(args.head, args.archive)) return { due: false, signature }
    const { prior } = args
    if (prior && args.now - prior.at < ARCHIVE_RECONCILE_COOLDOWN_MS) return { due: false, signature }
    if (prior && prior.signature === signature && prior.archiveCheckedAt !== args.archiveCheckedAt) return { due: false, signature }
    return { due: true, signature }
}

/**
 * A fresh head read still agrees with a full archive walk when the totals
 * are known and match and the head's item ids are exactly the archive's first head.length
 * ids (as sets — order ties may shift). Order-insensitive on purpose; any
 * new, missing or reordered-beyond-recognition entry means the archive no
 * longer describes the current listing and must be re-walked.
 */
export function playedReadsReconcile(head: JellyfinItemResult, archive: JellyfinItemResult): boolean {
    // An unknown total proves nothing: a tail deletion leaves the head prefix
    // unchanged, so only a known, equal total lets the prefix stand in for a walk.
    return head.total !== null && head.total === archive.total && headPrefixMatches(head, archive)
}

/** The head's ids are exactly the archive's first head.length ids, as sets. */
export function headPrefixMatches(head: JellyfinItemResult, archive: JellyfinItemResult): boolean {
    const headIds = new Set(head.items.map(item => item.Id))
    if (headIds.size !== head.items.length) return false
    const archiveHeadIds = new Set(archive.items.slice(0, head.items.length).map(item => item.Id))
    if (archiveHeadIds.size !== head.items.length) return false
    for (const id of headIds) {
        if (!archiveHeadIds.has(id)) return false
    }
    return true
}

/**
 * The archive read consumers should merge with the head. Only a settled live
 * walk wins; while a walk is pending, partial or failed, the last known
 * complete archive (in-memory settled, else the persisted restore) keeps
 * serving, so a warm session never shows less history than it already had.
 */
export function selectArchiveRead(
    live: MediaRead<JellyfinItemResult> | undefined,
    settled: MediaRead<JellyfinItemResult> | undefined,
    restored: MediaRead<JellyfinItemResult> | undefined,
): MediaRead<JellyfinItemResult> | undefined {
    if (live?.status === 'success' && live.data.inProgress !== true) return live
    return settled ?? restored ?? live
}

/**
 * The played read history is derived from. A refetch that fails (head error,
 * query error) must not erase rows an earlier read already proved: the last
 * successful listing keeps feeding history while the live error is still
 * reported through the connection's own reads.
 */
export function historyPlayedRead(
    live: MediaRead<JellyfinItemResult>,
    lastGood: Extract<MediaRead<JellyfinItemResult>, { status: 'success' }> | undefined,
): MediaRead<JellyfinItemResult> {
    return live.status === 'success' ? live : lastGood ?? live
}

/**
 * Merges the fresh head read (first pages, refreshed on the fast poll) with
 * the archive read (full walk, bounded cadence) into the played read the
 * activity pipeline consumes. Honesty rules:
 *   - the head's product bound (the old 500 cutoff) is never surfaced: no
 *     `limited` flag is ever produced here
 *   - `complete` is claimed only when provable NOW: the fresh head already
 *     covered the whole claimed raw space, or the archive walk is complete
 *     AND the head still reconciles with it (same total, same head items)
 *   - a failed or contradictory side keeps the merged listing honestly
 *     incomplete; items shown are the freshest verifiable rows
 *   - head rows win over archive rows on id collisions (fresher UserData)
 */
export function mergePlayedReads(
    head: MediaRead<JellyfinItemResult> | undefined,
    archive: MediaRead<JellyfinItemResult> | undefined
): MediaRead<JellyfinItemResult> | undefined {
    if (!head) return archive
    // A live head failure is never masked by older data: the error read
    // surfaces exactly as it would without an archive.
    if (head.status !== 'success') return head
    if (!archive) {
        // Full walk pending or unavailable: show the fresh head without the
        // product cap; complete only when the head itself covered everything.
        return { status: 'success', data: { items: head.data.items, total: head.data.total, complete: head.data.complete, limit: head.data.limit }, checkedAt: head.checkedAt }
    }
    if (archive.status !== 'success') {
        // The full walk failed: the head is all that is verifiable right now.
        return { status: 'success', data: { items: head.data.items, total: head.data.total, complete: false, limit: head.data.limit }, checkedAt: head.checkedAt }
    }
    if (head.data.complete) {
        // The fresh head alone proved the whole listing (small libraries):
        // a retained archive tail would only be stale rows.
        return { status: 'success', data: { items: head.data.items, total: head.data.total, complete: true, limit: head.data.limit }, checkedAt: head.checkedAt }
    }
    const headIds = new Set(head.data.items.map(item => item.Id))
    const reconciles = playedReadsReconcile(head.data, archive.data)
    const items = [...head.data.items, ...archive.data.items.filter(item => !headIds.has(item.Id))]
    return {
        status: 'success',
        data: {
            items,
            total: head.data.total ?? archive.data.total,
            complete: reconciles && archive.data.complete,
            ...(reconciles && archive.data.paginationComplete ? { paginationComplete: true as const } : {}),
            limit: archive.data.limit,
        },
        checkedAt: head.checkedAt,
    }
}

/**
 * The per-connection played listing the hook exposes: fresh head merged with
 * the best archive (live settled walk, else last settled, else persisted), the
 * in-progress marker while a walk is still the only archive source, and the
 * history read that survives head failures.
 */
export function composeJobPlayed(args: {
    liveHead: MediaRead<JellyfinItemResult> | undefined
    restoredHead: MediaRead<JellyfinItemResult> | undefined
    liveArchive: MediaRead<JellyfinItemResult> | undefined
    archiveErrored: boolean
    archiveFetching: boolean
    libraryLoaded: boolean
    settledArchive: MediaRead<JellyfinItemResult> | undefined
    restoredArchive: MediaRead<JellyfinItemResult> | undefined
    lastGood: Extract<MediaRead<JellyfinItemResult>, { status: 'success' }> | undefined
    waiting: MediaRead<JellyfinItemResult>
    known?: (read: MediaRead<JellyfinItemResult>) => MediaRead<JellyfinItemResult>
    /** Head-only consumer: no archive verdict is expected, so absence is not an in-progress walk. */
    archiveOptional?: boolean
}): ComposedPlayed {
    const known = args.known ?? (read => read)
    const head = args.liveHead && args.liveHead.status !== 'waiting'
        ? args.liveHead
        : args.restoredHead || args.liveHead || args.waiting
    const stableArchiveRead = selectArchiveRead(args.liveArchive, args.settledArchive, args.restoredArchive)
    const knownArchive = stableArchiveRead ? known(stableArchiveRead) : undefined
    const knownHead = head.status === 'waiting' ? undefined : known(head)
    const mergedPlayed = mergePlayedReads(knownHead, knownArchive)
    const archiveVerdict = !!args.liveArchive || args.archiveErrored || !!args.restoredArchive || !!args.settledArchive
    const archiveWalking = !args.settledArchive && (stableArchiveRead?.status === 'success' && stableArchiveRead.data.inProgress === true)
        || (!archiveVerdict && !args.archiveOptional && (args.archiveFetching || args.libraryLoaded))
    const played = mergedPlayed && mergedPlayed.status === 'success' && archiveWalking
        ? { ...mergedPlayed, data: { ...mergedPlayed.data, inProgress: true as const } }
        : mergedPlayed ?? args.waiting
    return { played, historyPlayed: historyPlayedRead(played, args.lastGood) }
}

/**
 * Loads the sealed observation for one scope. Returns null for a missing key,
 * a foreign vault's ciphertext, storage failure or any malformed payload: a
 * cache miss only means this reload waits for the live read.
 */
export async function loadMediaObservation(storage: MediaCacheStorage, decrypt: MediaCacheDecryptor, scope: MediaCacheScope): Promise<MediaCacheObservation | null> {
    const sealed = await loadSealedMediaObservation(storage, scope)
    if (sealed === null) return null
    return decodeSealedMediaObservation(sealed, decrypt, scope, sectionNames)
}

/** Reads the raw sealed observation bytes; null when absent or unreadable. */
export async function loadSealedMediaObservation(storage: MediaCacheStorage, scope: MediaCacheScope): Promise<string | null> {
    try {
        const sealed = await storage.getItem(mediaCacheStorageKey(scope))
        return typeof sealed === 'string' && sealed !== '' ? sealed : null
    } catch {
        return null
    }
}

/** Decodes only the requested sections of a sealed observation. */
export async function decodeSealedMediaObservation(
    sealed: string,
    decrypt: MediaCacheDecryptor,
    scope: MediaCacheScope,
    sections: ReadonlyArray<'resume' | 'played' | 'archive'>,
): Promise<MediaCacheObservation | null> {
    return decodeStoredMediaObservation(sealed, decrypt, scope, sections)
}

/** Keys of this cache's namespace that no live scope owns anymore. */
export function orphanedMediaCacheKeys(storedKeys: string[], liveKeys: string[]): string[] {
    const live = new Set(liveKeys)
    return storedKeys.filter(key => key.startsWith(`${MEDIA_CACHE_PREFIX}:`) && !live.has(key))
}

/**
 * Content signature of persisted head sections: ids, UserData, parent provider
 * ids, total, complete and limited. A poll whose head produces the same
 * signature needs no storage write at all.
 */
export function headObservationSignature(head: { resume?: MediaCacheReadObservation; played?: MediaCacheReadObservation }): string {
    const section = (obs: MediaCacheReadObservation | undefined): string => obs
        ? JSON.stringify([
            obs.total,
            obs.complete,
            obs.limited === true,
            obs.items.map(item => [item.Id, item.UserData ?? null, item.SeriesProviderIds ?? null]),
        ])
        : ''
    return `${section(head.resume)}|${section(head.played)}`
}

/** UserData fields a probe compares: the watch date, count and played flag. */
function probeUserData(item: JellyfinItem): unknown {
    const userData = item.UserData
    return [
        userData?.LastPlayedDate ?? null,
        userData?.PlayCount ?? null,
        userData?.Played ?? null,
    ]
}

/**
 * Whether a probe read proves the previous sorted head is still current: same
 * usable total and the probe rows equal the previous head prefix row by row
 * (id and watched-state UserData). Order-sensitive on purpose: a tie reorder
 * is treated as a change and forces the full read.
 */
export function headProbeMatches(probe: { items: JellyfinItem[]; total: number | null }, previous: JellyfinItemResult): boolean {
    if (probe.total === null || previous.total === null || probe.total !== previous.total) return false
    if (probe.items.length !== Math.min(HEAD_PROBE_ROWS, previous.items.length)) return false
    for (let i = 0; i < probe.items.length; i++) {
        if (probe.items[i].Id !== previous.items[i].Id) return false
        const a = JSON.stringify(probeUserData(probe.items[i]))
        const b = JSON.stringify(probeUserData(previous.items[i]))
        if (a !== b) return false
    }
    return true
}

/** Continue Watching is re-read every poll; an unchanged list keeps the previous (enriched) read. */
export function resumeMatches(current: JellyfinItemResult, previous: JellyfinItemResult): boolean {
    if (current.total !== previous.total || current.items.length !== previous.items.length) return false
    return current.items.every((item, i) => item.Id === previous.items[i].Id
        && JSON.stringify(probeUserData(item)) === JSON.stringify(probeUserData(previous.items[i]))
        && (item.UserData?.PlaybackPositionTicks ?? null) === (previous.items[i].UserData?.PlaybackPositionTicks ?? null))
}

/**
 * Whether the 60s head poll may probe instead of re-reading the full head:
 * native Jellyfin only, both previous head reads successful, the played head
 * sorted and settled, no forced read pending, and a full head read ran within
 * the max age so the probe can never stand in for one indefinitely.
 */
export function headProbeEligible(args: {
    product: string | undefined
    forced: boolean
    now: number
    lastFullHeadAt: number | undefined
    resume: MediaRead<JellyfinItemResult> | undefined
    played: MediaRead<JellyfinItemResult> | undefined
    lastFullHeadMaxAgeMs?: number
}): boolean {
    if (args.forced || args.product !== 'jellyfin') return false
    if (args.resume?.status !== 'success' || args.played?.status !== 'success') return false
    if (args.played.data.inProgress === true || args.played.data.sortAccepted !== true) return false
    const last = args.lastFullHeadAt
    if (last === undefined || args.now - last >= (args.lastFullHeadMaxAgeMs ?? HEAD_PROBE_MAX_AGE_MS)) return false
    return true
}

/**
 * Whether a hydrated archive observation may stand in for the persisted one in
 * the archive query. False when there is nothing hydrated (read storage) or
 * when this session persisted a newer archive for the scope after hydration.
 */
export function preferHydratedArchive(hydrated: MediaCacheReadObservation | undefined, lastPersistedCheckedAt: number | undefined): boolean {
    if (!hydrated) return false
    if (lastPersistedCheckedAt === undefined) return true
    return hydrated.checkedAt >= lastPersistedCheckedAt
}

export interface ComposedPlayed {
    played: MediaRead<JellyfinItemResult>
    historyPlayed: MediaRead<JellyfinItemResult>
}

/** Reference equality over a memo input tuple. */
export function sameMemoInputs(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

export interface PlayedComposeMemoEntry { inputs: unknown[]; composed: ComposedPlayed }

/**
 * Per-job composition memo. A poll whose inputs are reference-equal reuses the
 * previous composed played object, so downstream projector caches hit and no
 * consumer re-projects the full history.
 */
export function createPlayedComposeMemo(limit = 32): (key: string, inputs: unknown[], compute: () => ComposedPlayed) => ComposedPlayed {
    const memos = new Map<string, PlayedComposeMemoEntry>()
    return (key, inputs, compute) => {
        const cached = memos.get(key)
        if (cached && sameMemoInputs(cached.inputs, inputs)) {
            setBounded(memos, key, cached, limit)
            return cached.composed
        }
        const composed = compute()
        setBounded(memos, key, { inputs, composed }, limit)
        return composed
    }
}


// Each section is independently sealed with its exact subject scope. A head
// refresh can retain the archive ciphertext instead of decrypting/resealing it.
// Metadata is sealed too: no watch dates, identities or items are plaintext.
const sectionNames = ['resume', 'played', 'archive'] as const
interface SectionEnvelope {
    v: 2
    metadata: string
    resume?: string
    played?: string
    archive?: string
}
function sectionEnvelope(value: string): SectionEnvelope | null {
    try {
        const parsed = JSON.parse(value)
        return parsed?.v === 2 && typeof parsed.metadata === 'string' ? parsed as SectionEnvelope : null
    } catch { return null }
}
async function envelopeMetadata(envelope: SectionEnvelope, cipher: MediaCacheDecryptor, scope: MediaCacheScope): Promise<{ savedAt: number } | null> {
    try {
        const metadata = JSON.parse(await cipher.decrypt(envelope.metadata))
        if (metadata?.v !== 2 || !metadata.scope || !sameMediaCacheScope(metadata.scope, scope)
            || typeof metadata.savedAt !== 'number' || !Number.isFinite(metadata.savedAt) || metadata.savedAt < 0) return null
        return { savedAt: metadata.savedAt }
    } catch { return null }
}
async function decodeStoredMediaObservation(sealed: string, cipher: MediaCacheDecryptor, scope: MediaCacheScope, sections: ReadonlyArray<'resume' | 'played' | 'archive'> = sectionNames): Promise<MediaCacheObservation | null> {
    const envelope = sectionEnvelope(sealed)
    if (!envelope) {
        try { return decodeMediaObservation(await cipher.decrypt(sealed), scope) } catch { return null }
    }
    const metadata = await envelopeMetadata(envelope, cipher, scope)
    if (!metadata) return null
    const observation: MediaCacheObservation = { savedAt: metadata.savedAt }
    for (const section of sections) {
        const ciphertext = envelope[section]
        if (typeof ciphertext !== 'string') continue
        try {
            const decoded = decodeMediaObservation(await cipher.decrypt(ciphertext), scope)
            if (decoded?.[section]) observation[section] = decoded[section]
        } catch { /* A damaged section cannot discard healthy siblings. */ }
    }
    return observation.resume || observation.played || observation.archive ? observation : null
}

/** Builds one atomic storage value, accepting old monolithic observations on first write. */
export async function sealMediaObservationSections(
    previous: string | null,
    cipher: MediaCacheCrypto,
    scope: MediaCacheScope,
    next: MediaCacheObservationSections,
): Promise<string | null> {
    const parsedEnvelope = previous ? sectionEnvelope(previous) : null
    let envelope = parsedEnvelope
    if (envelope && !await envelopeMetadata(envelope, cipher, scope)) envelope = null
    // Legacy migration is one-time. Foreign-key/scope payloads are cache misses.
    const legacy = previous && !parsedEnvelope ? await decodeStoredMediaObservation(previous, cipher, scope) : null
    const savedAt = next.savedAt ?? Date.now()
    const result: SectionEnvelope = {
        v: 2,
        metadata: await cipher.encrypt(JSON.stringify({ v: 2, scope, savedAt })),
    }
    for (const section of sectionNames) {
        const observation = next[section] ?? legacy?.[section]
        if (observation) result[section] = await cipher.encrypt(encodeMediaObservation(scope, { [section]: observation, savedAt }))
        else if (typeof envelope?.[section] === 'string') result[section] = envelope[section]
    }
    return result.resume || result.played || result.archive ? JSON.stringify(result) : null
}
