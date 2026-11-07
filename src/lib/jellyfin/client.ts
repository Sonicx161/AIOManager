// Browser-direct Jellyfin protocol client, read-only except for two scoped
// watched-state mutations.
//
// Speaks the Jellyfin HTTP API against genuine Jellyfin servers and the
// AIOStreams / AIOMetadata Jellyfin facades. Key invariants:
//   - every request carries credentials in headers only (never in a URL query)
//   - every request uses referrerPolicy no-referrer, because the configuration
//     base path can itself be a secret and must not leak as a referrer
//   - error messages never echo the base URL, request bodies or response bodies
//     and error causes are sanitized so logged causes cannot leak them either
//   - no retries, no token refresh; watched/progress state is mutated only by
//     the scoped clearWatchState and writeUserData operations. Callers must
//     verify writeUserData with an explicit readback; clearWatchState verifies
//     its own readback. Acknowledgements alone prove nothing.
//   - fetch is injectable; globalThis.fetch is resolved per call, never captured
//     at module load
//   - completeness of bounded reads is reported honestly, never assumed

import type {
    JellyfinClient,
    JellyfinClientOptions,
    JellyfinErrorKind,
    JellyfinItem,
    JellyfinItemQuery,
    JellyfinItemResult,
    JellyfinPagedReadOptions,
    JellyfinProduct,
    JellyfinServerDetails,
    JellyfinSession,
    JellyfinSignIn,
    JellyfinSystemInfo,
    JellyfinUserDataUpdate,
    JellyfinUser,
} from './types.ts'

export type * from './types.ts'

const CLIENT_NAME = 'AIOManager'
const CLIENT_VERSION = '2.1.0'
const DEFAULT_TIMEOUT_MS = 15000

function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new JellyfinError('aborted', 'Played items read was aborted')); return }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
        const onAbort = () => { clearTimeout(timer); reject(new JellyfinError('aborted', 'Played items read was aborted')) }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}
const RESUME_PAGE_LIMIT = 50
const PLAYED_MAX_ITEMS = 500
/** Head pages stay at 250 rows on every product; only archive windows grow on native Jellyfin. */
export const PLAYED_PAGE_SIZE = 250
const SESSION_FRESH_MS = 120000
/** A check-in further than this into the future is clock skew or fabricated. */
const SESSION_FUTURE_SKEW_MS = 5000
const PLAYED_ALL_MAX_ITEMS = 50_000
const RESUME_ALL_MAX_ITEMS = 10_000
const RESUME_ALL_PAGE_SIZE = 50
const LIBRARY_ALL_MAX_ITEMS = 100_000
const LIBRARY_PAGE_SIZE = 500

/**
 * Typed failure for every client operation. `kind` classifies the failure so
 * callers can distinguish credential problems (auth), servers that are not
 * Jellyfin-compatible (unsupported), upstream trouble (server), transport
 * trouble (network/timeout/aborted) and shape violations (invalid-response).
 */
export class JellyfinError extends Error {
    readonly kind: JellyfinErrorKind
    readonly status?: number
    constructor(kind: JellyfinErrorKind, message: string, info?: { status?: number; cause?: unknown }) {
        super(message, info?.cause !== undefined ? { cause: info.cause } : undefined)
        this.name = 'JellyfinError'
        this.kind = kind
        if (info?.status !== undefined) this.status = info.status
    }
}

/**
 * Validates and canonicalizes a Jellyfin base URL.
 *
 * Keeps every non-trailing path segment (/jellyfin/u/me, /jellyfin/<id>...),
 * because addon configuration addresses are meaningful and not interchangeable
 * with the bare host. Requires http/https, rejects embedded credentials, query
 * strings and fragments, and strips trailing slashes. Never appends endpoints
 * by resetting to the URL root, and never echoes the input in errors.
 */
export function normalizeJellyfinUrl(input: string): string {
    let url: URL
    try {
        url = new URL(input.trim())
    } catch {
        throw new JellyfinError('invalid-url', 'Jellyfin server address must be a valid http(s) URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new JellyfinError('invalid-url', 'Jellyfin server address must use http or https')
    }
    if (url.username !== '' || url.password !== '') {
        throw new JellyfinError('invalid-url', 'Jellyfin server address must not contain embedded credentials')
    }
    if (url.search !== '' || url.hash !== '') {
        throw new JellyfinError('invalid-url', 'Jellyfin server address must not include a query string or fragment')
    }
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) throw new JellyfinError('invalid-response', `${label} returned an unexpected shape`)
    return value
}

function parseUser(value: unknown, label: string): JellyfinUser {
    const record = expectRecord(value, label)
    if (typeof record.Id !== 'string' || record.Id === '') {
        throw new JellyfinError('invalid-response', `${label} returned a user without an Id`)
    }
    return record as JellyfinUser
}

function parseItem(value: unknown, label: string): JellyfinItem {
    const record = expectRecord(value, label)
    if (typeof record.Id !== 'string' || record.Id === '') {
        throw new JellyfinError('invalid-response', `${label} returned an item without an Id`)
    }
    return record as JellyfinItem
}

/**
 * A TotalRecordCount is only usable when it is a finite nonnegative integer.
 * Anything else (missing, fractional, negative, Infinity/NaN, wrong type) is
 * treated as unknown so completeness is never argued from a garbage number.
 */
function parseTotalRecordCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * Wraps a raw transport error for use as an error cause without leaking the
 * original request URL: the base path of a private configuration address can
 * itself be a secret, and undici/browser errors may embed the full URL in the
 * message or in a nested cause. The wrapper keeps name and (redacted) message
 * and drops the nested cause chain entirely.
 */
function sanitizedCause(err: unknown, baseUrl: string): Error | undefined {
    if (!(err instanceof Error)) return undefined
    let message = err.message.split(baseUrl).join('[redacted]')
    message = message.replace(/https?:\/\/\S+/g, '[redacted-url]')
    const safe = new Error(message)
    safe.name = err.name
    return safe
}

function quoteAuthValue(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function authorizationHeader(deviceId: string, token?: string): string {
    const parts = [
        `Client=${quoteAuthValue(CLIENT_NAME)}`,
        `Device=${quoteAuthValue(CLIENT_NAME)}`,
        `DeviceId=${quoteAuthValue(deviceId)}`,
        `Version=${quoteAuthValue(CLIENT_VERSION)}`,
    ]
    if (token !== undefined) parts.push(`Token=${quoteAuthValue(token)}`)
    return `MediaBrowser ${parts.join(', ')}`
}

function defaultDeviceId(): string {
    const cryptoApi = globalThis.crypto
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
    return `aio-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function detectProduct(packageName: string | undefined, info?: Record<string, unknown>): JellyfinProduct {
    const pkg = (packageName ?? '').trim().toLowerCase()
    if (pkg === 'aiostreams') return 'aiostreams'
    if (pkg === 'aiometadata') return 'aiometadata'
    if (pkg === 'jellyfin' || pkg === 'jellyfin-server') return 'jellyfin'
    const nativeSystemInfo = !pkg && info?.ProductName === 'Jellyfin Server'
        && typeof info.SupportsLibraryMonitor === 'boolean'
        && typeof info.CanSelfRestart === 'boolean'
        && typeof info.SystemArchitecture === 'string'
        && Array.isArray(info.CompletedInstallations)
    return nativeSystemInfo ? 'jellyfin' : 'compatible'
}

/** Stable display label for a detected product (raw names live in packageName). */
function displayProductName(product: JellyfinProduct): string {
    switch (product) {
        case 'jellyfin':
            return 'Jellyfin'
        case 'aiostreams':
            return 'AIOStreams'
        case 'aiometadata':
            return 'AIOMetadata'
        default:
            return 'Jellyfin-compatible server'
    }
}

// The only two textual shapes a GUID takes in Jellyfin-family APIs: 32 hex
// characters, or the standard 8-4-4-4-12 dashed form. Anything else is an
// arbitrary id and must never be "normalized" for comparison.
const GUID_32_HEX = /^[0-9a-f]{32}$/i
const GUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isGuidForm(value: string): boolean {
    return GUID_32_HEX.test(value) || GUID_DASHED.test(value)
}

/**
 * Item identity for clearWatchState readback verification. Exact string
 * equality always passes, with one strictly scoped tolerance: when BOTH ids
 * are valid GUID forms (32 hex or standard dashed), differences in dash
 * placement and letter case are ignored, because facade servers can re-emit
 * ids in the other shape for the same item. Arbitrary strings are never
 * normalized (case, whitespace or separators): if either side is not a GUID,
 * the comparison stays exact.
 */
function sameItemId(requested: string, returned: string): boolean {
    if (requested === returned) return true
    if (!isGuidForm(requested) || !isGuidForm(returned)) return false
    return requested.replace(/-/g, '').toLowerCase() === returned.replace(/-/g, '').toLowerCase()
}

interface RequestSpec {
    /** Logical endpoint name used in error messages; never interpolated with ids or secrets. */
    label: string
    /** Path and query, starting with '/'. The token must never appear here. */
    path: string
    method?: 'GET' | 'POST' | 'DELETE'
    token?: string
    body?: unknown
    /** Pre-encoded body sent verbatim; contentType sets the header instead of application/json. */
    rawBody?: string
    contentType?: string
    signal?: AbortSignal
    /** Statuses that must be classified as auth failures for this endpoint (e.g. user 404s). */
    authStatuses?: readonly number[]
}

/**
 * The read-only JellyfinClient plus its two scoped watched-state mutations:
 * clearWatchState and writeUserData. They exist on a separate interface
 * (extending JellyfinClient) so the read-only contract in types.ts stays
 * intact for callers that only read.
 */
export interface JellyfinWatchClient extends JellyfinClient {
    /**
     * Clears the watched flag and resume position of exactly one user/item
     * pair. Two requests, no more: a DELETE to
     * /Users/{userId}/PlayedItems/{itemId} — the played-items endpoint whose
     * ResetPlayedState semantics clear Played, PlaybackPositionTicks and
     * PlayCount on Jellyfin, AIOMetadata and AIOStreams alike — followed by a
     * GET of the same user/item. The DELETE response is never trusted as
     * proof (the AIOMetadata route swallows errors and answers with a canned
     * result): success requires the readback to name the same item and carry
     * UserData with an explicit boolean false Played and an explicit numeric
     * zero PlaybackPositionTicks. Missing or mistyped readback data is a
     * failure (kind invalid-response); a well-typed but contradicting state
     * means the write did not take effect (kind server). Auth, transport,
     * timeout, abort and unsupported-endpoint failures propagate unchanged,
     * and no other item or user is ever addressed.
     */
    clearWatchState(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<void>
    /**
     * Writes UserData. Servers without /Items/{id}/UserData (Jellyfin 10.8) answer 404/405; a
     * played-only update then falls back to PlayedItems?datePlayed= and the result reports the
     * route used. The capability is learned from the response and remembered for this client.
     */
    writeUserData(accessToken: string, userId: string, itemId: string, update: JellyfinUserDataUpdate, signal?: AbortSignal): Promise<{ via: 'userdata' | 'played-items' } | void>
    /**
     * Sets the user's Primary profile picture. The body must be the base64
     * TEXT of the image bytes (Jellyfin base64-decodes it), never raw bytes.
     * Route selection is the caller's (version-aware): 'user-image' posts
     * /UserImage?userId= (12.x), 'legacy' posts /Users/{id}/Images/Primary
     * (10.x and still served on 12.x). A 403 (user policy forbids preference
     * edits) surfaces as JellyfinError kind 'auth' with status 403 so the
     * caller can map it to a Can't change state.
     */
    setUserImage(accessToken: string, userId: string, image: { base64: string; contentType: string }, route: 'user-image' | 'legacy', signal?: AbortSignal): Promise<void>
    /** Deletes the user's Primary image, restoring the server's default avatar. 404 counts as already-removed. */
    deleteUserImage(accessToken: string, userId: string, route: 'user-image' | 'legacy', signal?: AbortSignal): Promise<void>
}

/** MediaBrowser authorization header value; shared with the scoped image helpers. */
export function jellyfinAuthHeaderValue(deviceId: string, token: string): string {
    return authorizationHeader(deviceId, token)
}

/**
 * Creates a Jellyfin protocol client bound to one server base URL. Read-only
 * except for the two scoped, readback-verified watched-state mutations.
 * Each method performs at most its documented requests and accepts an
 * optional AbortSignal. A single-use, same-client head continuation can retain
 * two pages briefly for the initial archive walk; no state is persisted.
 */
export function createJellyfinClient(baseUrl: string, options?: JellyfinClientOptions): JellyfinWatchClient {
    // Private to this client and consumed once. Raw pages never enter persisted
    // query data; another server, credential, or restored result cannot reuse them.
    const playedHeads = new WeakMap<JellyfinItemResult, {
        token: string; userId: string; checkedAt: number; pages: Map<string, unknown>
    }>()
    const normalizedBase = normalizeJellyfinUrl(baseUrl)
    const deviceId = options?.deviceId ?? defaultDeviceId()
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const injectedFetch = options?.fetch

    async function request(spec: RequestSpec): Promise<unknown> {
        const controller = new AbortController()
        let timedOut = false
        let timerStop: () => void = () => {}
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
            timerStop()
        }, timeoutMs)
        const external = spec.signal
        if (external?.aborted) {
            clearTimeout(timer)
            throw new JellyfinError('aborted', `Request to ${spec.label} was aborted before it was sent`)
        }
        // A fetch that ignores its abort signal (wrapped or stalled transport) must
        // still fail at the deadline, so the timer also rejects a race.
        let stop: (reason: Error) => void = () => {}
        const stopped = new Promise<never>((_, reject) => { stop = reject })
        stopped.catch(() => {})
        const onExternalAbort = () => { controller.abort(); stop(new Error('aborted')) }
        external?.addEventListener('abort', onExternalAbort, { once: true })
        timerStop = () => stop(new Error('timeout'))
        const url = `${normalizedBase}${spec.path}`
        const headers: Record<string, string> = { Accept: 'application/json' }
        if (spec.token !== undefined || spec.method === 'POST') {
            headers.Authorization = authorizationHeader(deviceId, spec.token)
        }
        if (spec.body !== undefined || spec.rawBody !== undefined) {
            headers['Content-Type'] = spec.contentType ?? 'application/json'
        }
        const init: RequestInit = {
            method: spec.method ?? 'GET',
            headers,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
        }
        if (spec.body !== undefined) init.body = JSON.stringify(spec.body)
        else if (spec.rawBody !== undefined) init.body = spec.rawBody
        try {
            const fetchFn = injectedFetch ?? globalThis.fetch
            if (typeof fetchFn !== 'function') {
                throw new JellyfinError('network', 'No fetch implementation is available for Jellyfin requests')
            }
            let response: Response
            let text: string
            try {
                let received: Response | undefined
                let body = ''
                const exchange = (async () => {
                    received = await fetchFn(url, init)
                    body = await received.text()
                })()
                exchange.catch(() => {})
                await Promise.race([exchange, stopped])
                response = received!
                text = body
            } catch (err) {
                if (timedOut) throw new JellyfinError('timeout', `Request to ${spec.label} timed out after ${timeoutMs} ms`)
                if (external?.aborted) {
                    throw new JellyfinError('aborted', `Request to ${spec.label} was aborted`, {
                        cause: sanitizedCause(err, normalizedBase),
                    })
                }
                throw new JellyfinError('network', `Network request to ${spec.label} failed`, {
                    cause: sanitizedCause(err, normalizedBase),
                })
            }
            if (!response.ok) {
                const status = response.status
                let kind: JellyfinErrorKind
                if (status === 401 || status === 403) kind = 'auth'
                else if (status === 400 || status === 404 || status === 405 || status === 406 || status === 415 || status === 422 || status === 501)
                    kind = 'unsupported'
                else if (status === 408) kind = 'network'
                else kind = 'server'
                if (spec.authStatuses?.includes(status)) kind = 'auth'
                throw new JellyfinError(kind, `Server returned ${status} from ${spec.label}`, { status })
            }
            if (text.trim() === '') return null
            try {
                return JSON.parse(text)
            } catch {
                throw new JellyfinError('unsupported', `Server returned a non-JSON response from ${spec.label}`, { status: response.status })
            }
        } finally {
            clearTimeout(timer)
            external?.removeEventListener('abort', onExternalAbort)
        }
    }

    async function getPublicInfo(signal?: AbortSignal): Promise<JellyfinSystemInfo> {
        const res = await request({ label: 'System/Info/Public', path: '/System/Info/Public', signal })
        return expectRecord(res, 'System/Info/Public') as JellyfinSystemInfo
    }

    async function listPublicUsers(signal?: AbortSignal): Promise<JellyfinUser[]> {
        const res = await request({ label: 'Users/Public', path: '/Users/Public', signal })
        if (!Array.isArray(res)) throw new JellyfinError('invalid-response', 'Users/Public returned an unexpected shape')
        return res.map((entry) => parseUser(entry, 'Users/Public'))
    }

    async function signIn(username: string, password: string, signal?: AbortSignal): Promise<JellyfinSignIn> {
        const res = await request({
            label: 'Users/AuthenticateByName',
            path: '/Users/AuthenticateByName',
            method: 'POST',
            body: { Username: username, Pw: password },
            signal,
        })
        const record = expectRecord(res, 'Sign-in response')
        if (typeof record.AccessToken !== 'string' || record.AccessToken === '') {
            throw new JellyfinError('invalid-response', 'Sign-in response did not include an access token')
        }
        return {
            accessToken: record.AccessToken,
            user: parseUser(record.User, 'Sign-in response'),
            serverId: optionalString(record.ServerId),
        }
    }

    async function fetchUser(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinUser> {
        const res = await request({
            label: 'Users/{userId}',
            path: `/Users/${encodeURIComponent(userId)}`,
            token: accessToken,
            signal,
            authStatuses: [401, 403, 404],
        })
        const user = parseUser(res, 'Users/{userId}')
        if (user.Id !== userId) {
            throw new JellyfinError('auth', 'Server returned a different user than the one requested')
        }
        return user
    }

    async function connectToken(accessToken: string, userId?: string, signal?: AbortSignal): Promise<JellyfinSignIn> {
        if (userId === undefined) {
            let res: unknown
            try {
                res = await request({ label: 'Users/Me', path: '/Users/Me', token: accessToken, signal })
            } catch (err) {
                // API keys are valid credentials but have no user of their own. Never
                // auto-pick a user: the caller must choose one explicitly.
                if (err instanceof JellyfinError && (err.status === 400 || err.status === 404)) {
                    throw new JellyfinError(
                        'auth',
                        'Enter the Remote user ID for this API key, then verify sign-in again.',
                        { status: err.status, cause: err }
                    )
                }
                throw err
            }
            return { accessToken, user: parseUser(res, 'Users/Me') }
        }
        return { accessToken, user: await fetchUser(accessToken, userId, signal) }
    }

    async function listUsers(accessToken: string, signal?: AbortSignal): Promise<JellyfinUser[]> {
        const res = await request({ label: 'Users', path: '/Users', token: accessToken, signal })
        if (!Array.isArray(res)) throw new JellyfinError('invalid-response', 'Users returned an unexpected shape')
        return res.map((entry) => parseUser(entry, 'Users'))
    }

    async function inspect(accessToken: string, user: JellyfinUser, signal?: AbortSignal): Promise<JellyfinServerDetails> {
        if (!isRecord(user) || typeof user.Id !== 'string' || user.Id === '') {
            throw new JellyfinError('invalid-response', 'inspect requires a user with an Id')
        }
        let info: Record<string, unknown>
        try {
            info = expectRecord(
                await request({ label: 'System/Info', path: '/System/Info', token: accessToken, signal }),
                'System/Info'
            )
        } catch (err) {
            // 403/404 mean the authenticated info endpoint is unavailable to this
            // credential; public info still names the server, but the public
            // endpoint never carries a PackageName, so product detection can only
            // fall back to 'compatible' — every facade also claims the Jellyfin
            // ProductName, so it proves nothing. Auth failures and upstream
            // errors propagate untouched.
            if (err instanceof JellyfinError && (err.status === 403 || err.status === 404)) {
                const pub = expectRecord(
                    await request({ label: 'System/Info/Public', path: '/System/Info/Public', signal }),
                    'System/Info/Public'
                )
                const product = detectProduct(undefined)
                return {
                    product,
                    productName: displayProductName(product),
                    serverId: optionalString(pub.Id),
                    serverName: optionalString(pub.ServerName),
                    version: optionalString(pub.Version),
                }
            }
            throw err
        }
        const product = detectProduct(optionalString(info.PackageName), info)
        return {
            product,
            productName: displayProductName(product),
            serverId: optionalString(info.Id),
            serverName: optionalString(info.ServerName),
            version: optionalString(info.Version),
            packageName: optionalString(info.PackageName),
        }
    }

    async function readItem(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItem> {
        const item = parseItem(await request({
            label: 'Users/{userId}/Items/{itemId}',
            path: `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=ProviderIds&EnableImages=false`,
            token: accessToken,
            signal,
        }), 'Item details')
        if (item.Id !== itemId) throw new JellyfinError('invalid-response', 'Item details returned a different item')
        return item
    }

    /**
     * Bounded resume read (Limit 50). Returns the honest bounded-result
     * contract: `total` is the upstream TotalRecordCount only when it is a
     * finite nonnegative integer (null otherwise), and `complete` is true only
     * when the page provably covers the resume set — a matching total, or a
     * short page/bare array without one. A page that ignores Limit, duplicates
     * ids, or contradicts its own total is never reported complete.
     */
    async function readResume(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinItemResult> {
        const query = new URLSearchParams({
            Limit: String(RESUME_PAGE_LIMIT),
            Fields: 'UserData,ProviderIds',
            EnableImages: 'false',
        })
        const res = await request({
            label: 'Users/{userId}/Items/Resume',
            path: `/Users/${encodeURIComponent(userId)}/Items/Resume?${query.toString()}`,
            token: accessToken,
            signal,
        })
        let page: unknown[]
        let total: number | null = null
        if (Array.isArray(res)) {
            page = res
        } else if (isRecord(res) && Array.isArray(res.Items)) {
            page = res.Items
            total = parseTotalRecordCount(res.TotalRecordCount)
        } else {
            throw new JellyfinError('invalid-response', 'Users/{userId}/Items/Resume returned an unexpected shape')
        }
        const limitIgnored = page.length > RESUME_PAGE_LIMIT
        const seen = new Set<string>()
        const items: JellyfinItem[] = []
        let sawDuplicates = false
        for (const entry of page) {
            const parsed = parseItem(entry, 'Resume items')
            if (seen.has(parsed.Id)) {
                sawDuplicates = true
                continue
            }
            seen.add(parsed.Id)
            items.push(parsed)
        }
        // Cap extras from an ignored Limit before judging completeness.
        const truncatedByCap = items.length > RESUME_PAGE_LIMIT
        if (truncatedByCap) items.length = RESUME_PAGE_LIMIT
        const reached = total !== null ? items.length === total : items.length < RESUME_PAGE_LIMIT
        const complete = !sawDuplicates && !truncatedByCap && !limitIgnored && reached
        const limited = !sawDuplicates && !truncatedByCap && !limitIgnored && items.length === RESUME_PAGE_LIMIT && (total === null || total > items.length)
        return { items, total, complete, limit: RESUME_PAGE_LIMIT, ...(limited ? { limited: true as const } : {}) }
    }

    /**
     * Bounded played-history head read (up to 500 items, 250 per page). This
     * is the fresh HEAD the activity poll refreshes quickly; the full history
     * comes from readAllPlayed's archive walk, and callers merge the two (see
     * mergePlayedReads). Pages are deduplicated by Id so duplicates never
     * count toward the upstream total, and any anomaly — a repeated page, a
     * duplicate id, a moving total, an ignored Limit, a short page
     * contradicting its own total, or truncation by the bound — keeps the
     * result incomplete. `total` is the upstream TotalRecordCount when it is a
     * finite nonnegative integer, null otherwise; an unknown total is judged
     * only by natural exhaustion (short/empty page).
     *
     * Windows are requested at raw offsets: StartIndex advances by the
     * requested window size, never by the deduplicated item count. Facades such
     * as AIOMetadata slice their raw entry array by StartIndex/Limit and then
     * silently drop entries inside the page (unresolvable metadata, profile
     * caps, duplicate ids), so a page can be shorter than its Limit while many
     * raw entries remain; a short page therefore only ends the walk when a
     * usable total says the raw space is (or cannot be proven not to be)
     * exhausted. Hitting the 500-item bound without any paging anomaly is
     * reported as `limited`, the intentional head bound — distinct from
     * malformed or unverifiable listings, which stay plain incomplete.
     *
     * Pages are requested with SortBy=DatePlayed&SortOrder=Descending (the
     * standard query ordering by last-played date) when the upstream accepts
     * it; a 400 on the sorted query downgrades to unsorted paging for the rest
     * of the read. Sorting is a preference — correctness never relies on it.
     */
    async function readPlayed(accessToken: string, userId: string, signal?: AbortSignal, onProgress?: JellyfinPagedReadOptions['onProgress'], parallelHeadPages?: boolean, pageRetries?: number): Promise<JellyfinItemResult> {
        const pages = new Map<string, unknown>()
        const result = await readItemPages(
            accessToken,
            {
                label: 'Users/{userId}/Items',
                basePath: `/Users/${encodeURIComponent(userId)}/Items`,
                pageSize: PLAYED_PAGE_SIZE,
                maxItems: PLAYED_MAX_ITEMS,
                sorted: true,
                stopOnTotal: true,
                onProgress,
                capturePages: pages,
                windowConcurrency: parallelHeadPages ? 2 : 1,
                fanOutFirst: parallelHeadPages === true,
                pageRetries,
                params: {
                    IsPlayed: 'true',
                    IncludeItemTypes: 'Movie,Episode',
                    Recursive: 'true',
                    Fields: 'UserData,ProviderIds',
                    EnableImages: 'false',
                },
            },
            signal
        )
        // Sparse, complete, unsorted, or anomalous heads take the ordinary path.
        // A private copy keeps caller edits and metadata resolution out of reuse.
        if (result.limited && pages.size === 2 && [...pages.entries()].every(([path, page]) =>
            path.includes('SortBy=DatePlayed') && isRecord(page) && Array.isArray(page.Items) && page.Items.length === PLAYED_PAGE_SIZE
        )) {
            playedHeads.set(result, { token: accessToken, userId, checkedAt: Date.now(), pages: structuredClone(pages) })
        }
        return result
    }

    /**
     * Full-history played read for the archive walk: pages the ENTIRE raw
     * space (default bound 50,000 items — a deterministic sanity bound, never
     * a visible product cutoff) at raw offsets with fail-closed semantics: it
     * never stops on the total, so a lying small TotalRecordCount cannot
     * truncate it, and it is only `complete` when natural exhaustion yields
     * exactly the claimed total with no anomaly. Sparse pages, interior empty
     * windows and duplicates keep it honestly incomplete.
     *
     * `options.onProgress` is awaited after every page that added items with
     * a copied partial snapshot (`complete` always false), so callers can
     * publish progressive history while the walk continues.
     */
    async function readAllPlayed(
        accessToken: string,
        userId: string,
        options?: JellyfinPagedReadOptions,
        signal?: AbortSignal
    ): Promise<JellyfinItemResult> {
        const observedHead = options?.prefetchedHead
        const retained = observedHead ? playedHeads.get(observedHead) : undefined
        if (observedHead) playedHeads.delete(observedHead)
        const age = retained ? Date.now() - retained.checkedAt : -1
        // Captured head pages seed the walk at any window size: readItemPages
        // replays them as a window prelude, then continues with the requested
        // window from the raw offset where the prelude ends.
        const prefetchedPages = retained && retained.token === accessToken && retained.userId === userId
            && age >= 0 && age < 5_000
            && (options?.maxItems ?? PLAYED_ALL_MAX_ITEMS) >= PLAYED_MAX_ITEMS
            ? retained.pages : undefined
        return readItemPages(
            accessToken,
            {
                label: 'Users/{userId}/Items',
                basePath: `/Users/${encodeURIComponent(userId)}/Items`,
                pageSize: options?.pageSize ?? PLAYED_PAGE_SIZE,
                maxItems: options?.maxItems ?? PLAYED_ALL_MAX_ITEMS,
                sorted: true,
                stopOnTotal: false,
                onProgress: options?.onProgress,
                prefetchedPages,
                pageRetries: options?.pageRetries,
                retryDelayMs: options?.retryDelayMs,
                windowConcurrency: options?.windowConcurrency,
                params: {
                    IsPlayed: 'true',
                    IncludeItemTypes: 'Movie,Episode',
                    Recursive: 'true',
                    Fields: 'UserData,ProviderIds',
                    EnableImages: 'false',
                },
            },
            signal
        )
    }

    /**
     * Cheap freshness probe for the sorted played head (native Jellyfin only):
     * the same sorted query as the head's first page, capped at 25 rows.
     * Callers compare it against the previous head prefix to decide whether a
     * full head read is worth its bytes. No completeness contract: total is
     * the upstream TotalRecordCount when usable, null otherwise.
     */
    async function probePlayedHead(accessToken: string, userId: string, signal?: AbortSignal): Promise<{ items: JellyfinItem[]; total: number | null }> {
        const query = new URLSearchParams({
            StartIndex: '0',
            Limit: '25',
            IsPlayed: 'true',
            IncludeItemTypes: 'Movie,Episode',
            Recursive: 'true',
            Fields: 'UserData,ProviderIds',
            EnableImages: 'false',
            SortBy: 'DatePlayed',
            SortOrder: 'Descending',
        })
        const res = await request({
            label: 'Users/{userId}/Items',
            path: `/Users/${encodeURIComponent(userId)}/Items?${query.toString()}`,
            token: accessToken,
            signal,
        })
        let page: unknown[]
        let total: number | null = null
        if (Array.isArray(res)) {
            page = res
        } else if (isRecord(res) && Array.isArray(res.Items)) {
            page = res.Items
            total = parseTotalRecordCount(res.TotalRecordCount)
        } else {
            throw new JellyfinError('invalid-response', 'Users/{userId}/Items returned an unexpected shape')
        }
        return { items: page.map(entry => parseItem(entry, 'Played probe')), total }
    }

    async function readAllLibrary(
        accessToken: string,
        userId: string,
        options?: JellyfinPagedReadOptions,
        signal?: AbortSignal
    ): Promise<JellyfinItemResult> {
        return readItemPages(
            accessToken,
            {
                label: 'Users/{userId}/Items',
                basePath: `/Users/${encodeURIComponent(userId)}/Items`,
                pageSize: options?.pageSize ?? LIBRARY_PAGE_SIZE,
                maxItems: options?.maxItems ?? LIBRARY_ALL_MAX_ITEMS,
                sorted: false,
                stopOnTotal: false,
                params: {
                    IncludeItemTypes: 'Movie,Episode,Series',
                    Recursive: 'true',
                    Fields: 'UserData,ProviderIds',
                    EnableImages: 'false',
                },
            },
            signal
        )
    }

    /**
     * Shared raw-offset paging walk for /Users/{userId}/Items listing reads.
     *
     * StartIndex always advances by the REQUESTED window size, never by the
     * deduplicated item count: servers page this endpoint over their own raw
     * entry space (the AIOMetadata facade literally slices a raw array with
     * StartIndex/Limit before filtering inside the page), so the only offsets
     * that tile the space without gaps or repeats are multiples of the
     * requested window. Deduplication stays client-side and never moves the
     * cursor.
     *
     * A page shorter than its requested Limit is NOT proof of exhaustion: the
     * facade may have filtered entries out of a full window. The walk ends on
     * a short page only when the total is unknown (the bare-array contract) or
     * — for `stopOnTotal` reads only — the raw space is provably covered
     * (rawStart >= total). Otherwise it continues at the next raw offset until
     * an empty page beyond the claimed raw space, the item cap, the page bound
     * or raw coverage of a trusted total. An EMPTY page inside the claimed raw
     * space (a window the facade filtered entirely) is not exhaustion either:
     * the walk continues while the total says more raw entries exist, bounded
     * by the page bound. Such an interior empty window marks the offsets as
     * unreliable and can never again prove completeness. `stopOnTotal: false`
     * (migration all-history reads) never stops on a non-empty signal from the
     * total, so a lying small TotalRecordCount cannot truncate it; those reads
     * stay fail-closed and are only complete when natural exhaustion yields
     * exactly the claimed total with no anomaly.
     *
     * When `onProgress` is provided it is awaited after every page that added
     * items, with a copied honest partial snapshot (`complete` always false).
     */
    async function readItemPages(
        accessToken: string,
        spec: {
            label: string
            basePath: string
            pageSize: number
            maxItems: number
            params: Record<string, string>
            sorted: boolean
            stopOnTotal: boolean
            onProgress?: (snapshot: JellyfinItemResult) => void | Promise<void>
            capturePages?: Map<string, unknown>
            prefetchedPages?: Map<string, unknown>
            pageRetries?: number
            retryDelayMs?: number
            windowConcurrency?: number
            fanOutFirst?: boolean
        },
        signal?: AbortSignal
    ): Promise<JellyfinItemResult> {
        const seen = new Set<string>()
        const items: JellyfinItem[] = []
        let total: number | null = null
        let totalMoved = false
        let sawDuplicates = false
        let sawRepeatedPage = false
        let sawInteriorEmptyPage = false
        let limitIgnored = false
        let truncatedByCap = false
        let stoppedByCap = false
        let stoppedByPageBound = false
        let exhaustedNaturally = false
        let allowSort = spec.sorted
        let rawStart = 0
        let pages = 0
        let pageRetriesLeft = spec.pageRetries ?? 0
        let concurrency = Math.max(1, spec.windowConcurrency ?? 1)
        const maxPages = Math.ceil(spec.maxItems / spec.pageSize) * 2 + 4
        // Captured head pages can be smaller than this walk's window. Replayed
        // as a contiguous prelude they keep the head handoff at any window
        // size; the raw space still tiles because every window advances by
        // exactly its own requested limit.
        const preludeWindows = new Map<number, number>()
        if (spec.prefetchedPages) {
            const windows = [...spec.prefetchedPages.keys()]
                .flatMap(path => {
                    const query = path.slice(path.indexOf('?') + 1)
                    const start = Number(new URLSearchParams(query).get('StartIndex'))
                    const limit = Number(new URLSearchParams(query).get('Limit'))
                    return Number.isInteger(start) && start >= 0 && Number.isInteger(limit) && limit > 0 ? [{ start, limit }] : []
                })
                .sort((a, b) => a.start - b.start)
            let expected = 0
            for (const window of windows) {
                if (window.start !== expected) break
                preludeWindows.set(window.start, window.limit)
                expected = window.start + window.limit
            }
        }
        const windowPath = (start: number, limit: number): string => {
            const query = new URLSearchParams({ ...spec.params, StartIndex: String(start), Limit: String(limit) })
            if (allowSort) {
                query.set('SortBy', 'DatePlayed')
                query.set('SortOrder', 'Descending')
            }
            return `${spec.basePath}?${query.toString()}`
        }
        // Windows are raw offsets, so any number can be in flight at once;
        // results are still processed strictly in window order.
        interface WalkWindow { start: number; limit: number; path: string; promise: Promise<unknown>; abort: () => void }
        const pending: WalkWindow[] = []
        let nextIssueStart = 0
        const pendingLimit = () => pending.reduce((sum, window) => sum + window.limit, 0)
        const startWindow = (start: number, limit: number): WalkWindow => {
            const path = windowPath(start, limit)
            if (spec.prefetchedPages?.has(path)) {
                return { start, limit, path, promise: Promise.resolve(spec.prefetchedPages.get(path)), abort: () => {} }
            }
            const controller = new AbortController()
            const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
            const promise = request({ label: spec.label, path, token: accessToken, signal: requestSignal })
            // A window can fail before the walk reaches it; its rejection is still read in order.
            promise.catch(() => {})
            return {
                start,
                limit,
                path,
                promise,
                abort: () => controller.abort(),
            }
        }
        const discardPending = () => {
            for (const window of pending.splice(0)) {
                window.abort()
                window.promise.catch(() => {})
            }
            nextIssueStart = rawStart
        }
        const fillPipeline = (current: number) => {
            // The first window is always issued alone so a sort rejection is
            // detected before any fan-out, unless the read opts in (head pages).
            const allowed = (pages > 0 || spec.fanOutFirst === true || concurrency <= 1) ? concurrency : 1
            while (pending.length < allowed - 1) {
                if (nextIssueStart >= spec.maxItems) break
                const prelude = preludeWindows.get(nextIssueStart)
                const limit = prelude ?? spec.pageSize
                // Speculation stays within one window of the claimed total:
                // the sentinel window still gets issued (a lying small total
                // keeps the walk going), but a truthful total pays no extra
                // requests beyond it.
                if (total !== null && nextIssueStart >= total + limit) break
                // Never issue speculatively past the item cap: the last window
                // is sized from the exact remaining count.
                if (!prelude && items.length + current + pendingLimit() + limit > spec.maxItems) break
                pending.push(startWindow(nextIssueStart, limit))
                nextIssueStart += limit
            }
        }
        try {
            for (;;) {
                if (signal?.aborted) {
                    discardPending()
                    throw new JellyfinError('aborted', 'Played items read was aborted')
                }
                const remaining = spec.maxItems - items.length
                if (remaining <= 0) {
                    stoppedByCap = true
                    break
                }
                if (pages >= maxPages) {
                    stoppedByPageBound = true
                    break
                }
                const limit = Math.min(preludeWindows.get(rawStart) ?? spec.pageSize, remaining)
                const path = windowPath(rawStart, limit)
                if (pending[0]?.start !== rawStart || pending[0].path !== path) {
                    if (pending.length > 0) discardPending()
                    pending.push(startWindow(rawStart, limit))
                    nextIssueStart = rawStart + limit
                }
                const window = pending.shift()!
                fillPipeline(window.limit)
                let res: unknown
                try {
                    res = await window.promise
                } catch (err) {
                    // Sorting is a preference over the standard query, never a
                    // requirement: an upstream that rejects the sort key can still
                    // serve correct pages. Exactly one downgrade attempt per read.
                    if (allowSort && err instanceof JellyfinError && err.status === 400) {
                        allowSort = false
                        discardPending()
                        continue
                    }
                    // Opt-in resume of a stalled page: a transient failure retries the
                    // same offset with backoff, keeping every page already read.
                    const transient = err instanceof JellyfinError && (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'server')
                    if (transient && pageRetriesLeft > 0 && !signal?.aborted) {
                        const delay = (spec.retryDelayMs ?? 500) * 2 ** ((spec.pageRetries ?? 0) - pageRetriesLeft) * (0.75 + Math.random() * 0.5)
                        pageRetriesLeft--
                        concurrency = 1
                        await pause(delay, signal)
                        pending.unshift(startWindow(rawStart, limit))
                        continue
                    }
                    discardPending()
                    throw err
                }
                pageRetriesLeft = spec.pageRetries ?? 0
                if (window.start < PLAYED_MAX_ITEMS) spec.capturePages?.set(window.path, res)
                let page: unknown[]
                if (Array.isArray(res)) {
                    page = res
                } else if (isRecord(res) && Array.isArray(res.Items)) {
                    page = res.Items
                    const rawTotal = parseTotalRecordCount(res.TotalRecordCount)
                    if (rawTotal !== null) {
                        if (total !== null && total !== rawTotal) totalMoved = true
                        total = rawTotal
                    }
                } else {
                    discardPending()
                    throw new JellyfinError('invalid-response', 'Users/{userId}/Items returned an unexpected shape')
                }
                if (page.length > limit) limitIgnored = true
                const fresh: JellyfinItem[] = []
                let pageHadDuplicate = false
                for (const entry of page) {
                    const parsed = parseItem(entry, 'Played items')
                    if (seen.has(parsed.Id)) {
                        pageHadDuplicate = true
                        continue
                    }
                    seen.add(parsed.Id)
                    fresh.push(parsed)
                }
                if (pageHadDuplicate) sawDuplicates = true
                if (fresh.length > remaining) {
                    fresh.length = remaining
                    truncatedByCap = true
                }
                items.push(...fresh)
                pages++
                // The cursor follows the requested window, not the items kept.
                rawStart += limit
                if (spec.onProgress && fresh.length > 0) {
                    // Partials are never provably complete; the snapshot is a copy
                    // so consumers cannot mutate the walk's live arrays.
                    await spec.onProgress({ items: items.slice(), total, complete: false, inProgress: true as const, limit: spec.maxItems })
                }
                if (fresh.length === 0) {
                    if (page.length > 0) {
                        sawRepeatedPage = true
                        break
                    }
                    if (total !== null && rawStart < total) {
                        // Empty page INSIDE the claimed raw space: the whole window
                        // was filtered upstream while more raw entries remain. Keep
                        // walking the raw offsets (bounded by the page bound); the
                        // listing can never be proven complete after this.
                        sawInteriorEmptyPage = true
                        continue
                    }
                    exhaustedNaturally = true
                    break
                }
                if (page.length < limit) {
                    // A short page proves exhaustion only when nothing claims more
                    // raw entries: no usable total, or (bounded reads only) the
                    // raw space is already covered. Fail-closed all-history reads
                    // never trust a total to stop, so they confirm via empty page.
                    if (total === null || (spec.stopOnTotal && rawStart >= total)) {
                        exhaustedNaturally = true
                        break
                    }
                    // Sparse facade window: keep walking the raw offsets.
                    continue
                }
                if (spec.stopOnTotal && total !== null && rawStart >= total) {
                    exhaustedNaturally = true
                    break
                }
            }
        } finally {
            discardPending()
        }
        const contradicted =
            stoppedByCap || stoppedByPageBound || truncatedByCap || sawRepeatedPage || sawInteriorEmptyPage || sawDuplicates || totalMoved || limitIgnored
        const reached = spec.stopOnTotal
            ? total !== null ? items.length === total : exhaustedNaturally
            : exhaustedNaturally && (total === null || items.length === total)
        const limited = stoppedByCap && !stoppedByPageBound && !truncatedByCap && !sawRepeatedPage && !sawInteriorEmptyPage && !sawDuplicates && !totalMoved && !limitIgnored && (total === null || total > items.length)
        const paginationComplete = !spec.stopOnTotal && exhaustedNaturally && !stoppedByCap && !stoppedByPageBound
            && !truncatedByCap && !sawRepeatedPage && !totalMoved && !limitIgnored
        return {
            items,
            total,
            complete: !contradicted && reached,
            limit: spec.maxItems,
            ...(limited ? { limited: true as const } : {}),
            ...(paginationComplete ? { paginationComplete: true as const } : {}),
            ...(spec.sorted ? { sortAccepted: allowSort } : {}),
        }
    }

    async function readAllResume(
        accessToken: string,
        userId: string,
        options?: JellyfinPagedReadOptions,
        signal?: AbortSignal
    ): Promise<JellyfinItemResult> {
        const pageSize = options?.pageSize ?? RESUME_ALL_PAGE_SIZE
        const maxItems = options?.maxItems ?? RESUME_ALL_MAX_ITEMS
        const maxPages = Math.ceil(maxItems / Math.max(1, Math.min(pageSize, maxItems))) * 2 + 4
        const basePath = `/Users/${encodeURIComponent(userId)}/Items/Resume`
        const seen = new Set<string>()
        const items: JellyfinItem[] = []
        let cursor = 0
        let pages = 0
        let total: number | null = null
        let totalMoved = false
        let sawDuplicates = false
        let sawRepeatedPage = false
        let limitIgnored = false
        let truncatedByCap = false
        let stoppedByCap = false
        let stoppedByPageBound = false
        let exhaustedNaturally = false
        for (;;) {
            if (items.length >= maxItems) {
                stoppedByCap = true
                break
            }
            if (pages >= maxPages) {
                stoppedByPageBound = true
                break
            }
            const query = new URLSearchParams({
                StartIndex: String(cursor),
                Limit: String(pageSize),
                Fields: 'UserData,ProviderIds',
                EnableImages: 'false',
            })
            const res = await request({
                label: 'Users/{userId}/Items/Resume',
                path: `${basePath}?${query.toString()}`,
                token: accessToken,
                signal,
            })
            pages++
            let page: unknown[]
            if (Array.isArray(res)) {
                page = res
            } else if (isRecord(res) && Array.isArray(res.Items)) {
                page = res.Items
                const rawTotal = parseTotalRecordCount(res.TotalRecordCount)
                if (rawTotal !== null) {
                    if (total !== null && total !== rawTotal) totalMoved = true
                    total = rawTotal
                }
            } else {
                throw new JellyfinError('invalid-response', 'Users/{userId}/Items/Resume returned an unexpected shape')
            }
            if (page.length > pageSize) {
                limitIgnored = true
                page = page.slice(0, pageSize)
            }
            cursor += page.length
            const before = items.length
            for (const entry of page) {
                const parsed = parseItem(entry, 'Resume items')
                if (seen.has(parsed.Id)) {
                    sawDuplicates = true
                    continue
                }
                seen.add(parsed.Id)
                if (items.length < maxItems) items.push(parsed)
                else truncatedByCap = true
            }
            if (page.length === 0) {
                exhaustedNaturally = true
                break
            }
            if (items.length === before) {
                sawRepeatedPage = true
                break
            }
            if (page.length < pageSize) {
                exhaustedNaturally = true
                break
            }
        }
        const contradicted =
            stoppedByCap || stoppedByPageBound || truncatedByCap || sawRepeatedPage || sawDuplicates || totalMoved || limitIgnored
        const reached = exhaustedNaturally && (total === null || items.length === total)
        return { items, total, complete: !contradicted && reached, limit: maxItems }
    }

    async function readWatchItem(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItem> {
        const item = parseItem(
            await request({
                label: 'Users/{userId}/Items/{itemId}',
                path: `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=UserData,ProviderIds&EnableImages=false`,
                token: accessToken,
                signal,
            }),
            'Item details'
        )
        if (!sameItemId(itemId, item.Id)) {
            throw new JellyfinError('invalid-response', 'Item details returned a different item')
        }
        return item
    }

    async function queryUserItems(
        accessToken: string,
        userId: string,
        query: JellyfinItemQuery,
        signal?: AbortSignal
    ): Promise<JellyfinItem[]> {
        const params = new URLSearchParams({
            Fields: 'UserData,ProviderIds',
            EnableImages: 'false',
        })
        if (query.ids?.length) params.set('Ids', query.ids.join(','))
        if (query.parentId !== undefined) params.set('ParentId', query.parentId)
        if (query.includeItemTypes !== undefined) params.set('IncludeItemTypes', query.includeItemTypes)
        if (query.recursive !== undefined) params.set('Recursive', String(query.recursive))
        if (query.startIndex !== undefined) params.set('StartIndex', String(query.startIndex))
        if (query.limit !== undefined) params.set('Limit', String(query.limit))
        const res = await request({
            label: 'Users/{userId}/Items',
            path: `/Users/${encodeURIComponent(userId)}/Items?${params.toString()}`,
            token: accessToken,
            signal,
        })
        let page: unknown[]
        if (Array.isArray(res)) {
            page = res
        } else if (isRecord(res) && Array.isArray(res.Items)) {
            page = res.Items
        } else {
            throw new JellyfinError('invalid-response', 'Users/{userId}/Items returned an unexpected shape')
        }
        return page.map(entry => parseItem(entry, 'Item lookup'))
    }

    /**
     * Fresh, client-reported playback rows for the explicit user only. A row
     * counts as live playback when it carries a NowPlayingItem with a real
     * identity (non-empty string Id), a PlayState whose PositionTicks (when
     * present) is a finite nonnegative number and whose IsPaused (when present)
     * is a boolean, and a LastPlaybackCheckIn within the 120s freshness window
     * and no more than 5s in the future. Synthetic rows (e.g. the AIOMetadata
     * caller describing the requesting client itself) carry none of these and
     * never count, so callers cannot invent capabilities from them.
     */
    async function readSessions(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinSession[]> {
        // ActiveWithinSeconds shrinks the answer on genuine Jellyfin servers;
        // facades that ignore it are filtered client-side exactly as before.
        const res = await request({ label: 'Sessions', path: '/Sessions?ActiveWithinSeconds=120', token: accessToken, signal })
        if (!Array.isArray(res)) throw new JellyfinError('invalid-response', 'Sessions returned an unexpected shape')
        const now = Date.now()
        const live: JellyfinSession[] = []
        for (const row of res) {
            if (!isRecord(row)) continue
            if (row.UserId !== userId) continue
            if (!isRecord(row.NowPlayingItem)) continue
            const nowPlaying = row.NowPlayingItem as Record<string, unknown>
            if (typeof nowPlaying.Id !== 'string' || nowPlaying.Id === '') continue
            if (!isRecord(row.PlayState)) continue
            const playState = row.PlayState as Record<string, unknown>
            if (
                playState.PositionTicks !== undefined &&
                !(typeof playState.PositionTicks === 'number' && Number.isFinite(playState.PositionTicks) && playState.PositionTicks >= 0)
            ) {
                continue
            }
            if (playState.IsPaused !== undefined && typeof playState.IsPaused !== 'boolean') continue
            const checkIn = typeof row.LastPlaybackCheckIn === 'string' ? Date.parse(row.LastPlaybackCheckIn) : Number.NaN
            if (!Number.isFinite(checkIn)) continue
            if (now - checkIn > SESSION_FRESH_MS) continue
            if (checkIn - now > SESSION_FUTURE_SKEW_MS) continue
            live.push(row as JellyfinSession)
        }
        return live
    }

    /**
     * Scoped, verified watched-state clear for one user/item pair. The write
     * is a single DELETE to /Users/{userId}/PlayedItems/{itemId}; its
     * response body is deliberately ignored because facades acknowledge
     * writes they failed to apply. Proof comes only from the readback GET of
     * the same user/item: it must name the same item (exact match, or both
     * ids valid GUIDs differing only in dashes/case) and carry UserData with
     * an explicit Played=false and an explicit PlaybackPositionTicks=0.
     * Missing, mistyped or contradicting state fails the operation; absence
     * of UserData is never success.
     */
    async function clearWatchState(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<void> {
        if (typeof userId !== 'string' || userId === '') {
            throw new JellyfinError('invalid-response', 'clearWatchState requires a non-empty userId')
        }
        if (typeof itemId !== 'string' || itemId === '') {
            throw new JellyfinError('invalid-response', 'clearWatchState requires a non-empty itemId')
        }
        await request({
            label: 'Users/{userId}/PlayedItems/{itemId}',
            path: `/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(itemId)}`,
            method: 'DELETE',
            token: accessToken,
            signal,
        })
        const item = parseItem(
            await request({
                label: 'Users/{userId}/Items/{itemId}',
                path: `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?Fields=UserData,ProviderIds&EnableImages=false`,
                token: accessToken,
                signal,
            }),
            'Item details'
        )
        if (!sameItemId(itemId, item.Id)) {
            throw new JellyfinError('invalid-response', 'Item details returned a different item')
        }
        const userData = item.UserData
        if (!isRecord(userData)) {
            throw new JellyfinError('invalid-response', 'Watched-state readback did not include UserData')
        }
        const played = userData.Played
        const position = userData.PlaybackPositionTicks
        if (typeof played !== 'boolean' || typeof position !== 'number' || !Number.isFinite(position)) {
            throw new JellyfinError('invalid-response', 'Watched-state readback was incomplete')
        }
        if (played !== false || position !== 0) {
            throw new JellyfinError('server', 'Server did not clear the watched state for this item')
        }
    }

    let userDataRoute: 'unknown' | 'userdata' | 'played-items' = 'unknown'

    async function writeUserData(
        accessToken: string,
        userId: string,
        itemId: string,
        update: JellyfinUserDataUpdate,
        signal?: AbortSignal
    ): Promise<{ via: 'userdata' | 'played-items' }> {
        if (typeof userId !== 'string' || userId === '') {
            throw new JellyfinError('invalid-response', 'writeUserData requires a non-empty userId')
        }
        if (typeof itemId !== 'string' || itemId === '') {
            throw new JellyfinError('invalid-response', 'writeUserData requires a non-empty itemId')
        }
        const body: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(update)) {
            if (value !== undefined) body[key] = value
        }
        if (!Object.keys(body).length) {
            throw new JellyfinError('invalid-response', 'writeUserData requires at least one field')
        }
        const playedItemsOnly = update.Played === true && update.PlaybackPositionTicks === undefined
        const viaPlayedItems = async (cause?: unknown): Promise<{ via: 'played-items' }> => {
            if (!playedItemsOnly) {
                throw cause instanceof JellyfinError ? cause : new JellyfinError('unsupported', 'This server cannot store this watch state without the UserData endpoint')
            }
            const datePlayed = update.LastPlayedDate !== undefined ? `?datePlayed=${encodeURIComponent(update.LastPlayedDate)}` : ''
            await request({
                label: 'Users/{userId}/PlayedItems/{itemId}',
                path: `/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(itemId)}${datePlayed}`,
                method: 'POST',
                token: accessToken,
                signal,
            })
            return { via: 'played-items' }
        }
        if (userDataRoute === 'played-items') return viaPlayedItems()
        try {
            await request({
                label: 'Users/{userId}/Items/{itemId}/UserData',
                path: `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}/UserData`,
                method: 'POST',
                token: accessToken,
                body,
                signal,
            })
        } catch (err) {
            if (err instanceof JellyfinError && err.kind === 'unsupported' && (err.status === 404 || err.status === 405) && playedItemsOnly) {
                const result = await viaPlayedItems(err)
                userDataRoute = 'played-items'
                return result
            }
            throw err
        }
        userDataRoute = 'userdata'
        return { via: 'userdata' }
    }

    async function setUserImage(accessToken: string, userId: string, image: { base64: string; contentType: string }, route: 'user-image' | 'legacy', signal?: AbortSignal): Promise<void> {
        if (!userId) throw new JellyfinError('invalid-response', 'setUserImage requires a non-empty userId')
        const path = route === 'user-image'
            ? `/UserImage?userId=${encodeURIComponent(userId)}`
            : `/Users/${encodeURIComponent(userId)}/Images/Primary`
        await request({
            label: route === 'user-image' ? 'UserImage' : 'Users/{userId}/Images/Primary',
            path,
            method: 'POST',
            token: accessToken,
            rawBody: image.base64,
            contentType: image.contentType,
            signal,
            authStatuses: [401, 403, 404],
        })
    }

    async function deleteUserImage(accessToken: string, userId: string, route: 'user-image' | 'legacy', signal?: AbortSignal): Promise<void> {
        if (!userId) throw new JellyfinError('invalid-response', 'deleteUserImage requires a non-empty userId')
        const path = route === 'user-image'
            ? `/UserImage?userId=${encodeURIComponent(userId)}`
            : `/Users/${encodeURIComponent(userId)}/Images/Primary`
        try {
            await request({
                label: route === 'user-image' ? 'UserImage delete' : 'Users/{userId}/Images/Primary delete',
                path,
                method: 'DELETE',
                token: accessToken,
                signal,
                authStatuses: [401, 403],
            })
        } catch (err) {
            if (err instanceof JellyfinError && err.status === 404) return
            throw err
        }
    }

    return {
        getPublicInfo,
        listPublicUsers,
        signIn,
        connectToken,
        listUsers,
        getUser: fetchUser,
        inspect,
        readItem,
        readWatchItem,
        readResume,
        readPlayed,
        probePlayedHead,
        readAllPlayed,
        readAllResume,
        readAllLibrary,
        queryUserItems,
        readSessions,
        clearWatchState,
        writeUserData,
        setUserImage,
        deleteUserImage,
    }
}
