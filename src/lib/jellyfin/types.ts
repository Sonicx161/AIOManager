// Public type contract for the read-only Jellyfin-protocol client.
//
// This family of connections speaks the Jellyfin HTTP API against several distinct
// products: genuine Jellyfin servers, the AIOStreams Jellyfin facade and the
// AIOMetadata Jellyfin facade. Product identity is therefore reported explicitly
// (see JellyfinServerDetails) and must never be inferred from ProductName alone.

/** Detected product behind a Jellyfin-compatible API. */
export type JellyfinProduct = 'jellyfin' | 'aiostreams' | 'aiometadata' | 'compatible'

/** Error classification used by JellyfinError. */
export type JellyfinErrorKind =
    | 'invalid-url' // base URL rejected before any request was made
    | 'auth' // 401/403, rejected credentials, user mismatch or non-user-scoped token
    | 'unsupported' // endpoint missing (404), protocol mismatch, non-JSON response
    | 'server' // upstream 5xx / rate limiting
    | 'network' // fetch transport failure
    | 'invalid-response' // JSON that does not match the expected shape
    | 'timeout' // per-request timeout elapsed
    | 'aborted' // caller aborted via AbortSignal

/** Raw user DTO. Id is the only field every implementation is required to return. */
export interface JellyfinUser {
    Id: string
    Name?: string
    HasPassword?: boolean
    PrimaryImageTag?: string
    [key: string]: unknown
}

/** Result of signIn / connectToken. serverId is only known when the upstream reports it. */
export interface JellyfinSignIn {
    accessToken: string
    user: JellyfinUser
    serverId?: string
}

/**
 * Raw Quick Connect envelope from Initiate and Connect. Secret and Code are
 * validated by the client before the envelope is handed to callers;
 * Authenticated only turns true after the user approved the code in their own
 * Jellyfin app. The Secret is a one-time value the server consumes on
 * AuthenticateWithQuickConnect.
 */
export interface JellyfinQuickConnectResult {
    Secret?: string
    Code?: string
    Authenticated?: boolean
    [key: string]: unknown
}

/** Shape of GET /System/Info/Public (and the common subset of /System/Info). */
export interface JellyfinSystemInfo {
    ServerName?: string
    Version?: string
    ProductName?: string
    Id?: string
    OperatingSystem?: string
    [key: string]: unknown
}

/**
 * Product-aware server description returned by inspect(). `productName` is a
 * stable display label (Jellyfin / AIOStreams / AIOMetadata /
 * Jellyfin-compatible server); the raw upstream PackageName is preserved
 * separately in `packageName` when the authenticated endpoint reports it.
 */
export interface JellyfinServerDetails {
    product: JellyfinProduct
    productName: string
    serverId?: string
    serverName?: string
    version?: string
    packageName?: string
}

/** Per-item user data relevant to watched/resume state. */
export interface JellyfinUserData {
    Played?: boolean
    PlaybackPositionTicks?: number
    LastPlayedDate?: string
    PlayCount?: number
    /** The user's 0-10 rating; null or absent when unrated. */
    Rating?: number | null
    IsFavorite?: boolean
    [key: string]: unknown
}

/** Library item (movie / episode) as returned by resume and played queries. */
export interface JellyfinItem {
    Id: string
    Name?: string
    Type?: string
    SeriesName?: string
    SeriesId?: string
    ParentIndexNumber?: number
    IndexNumber?: number
    RunTimeTicks?: number
    ProviderIds?: Record<string, string>
    /** Provider IDs verified from this episode's parent Series record. */
    SeriesProviderIds?: Record<string, string>
    UserData?: JellyfinUserData
    [key: string]: unknown
}

/**
 * Bounded result of readResume()/readPlayed(). Completeness is reported, never
 * assumed: `total` is the upstream-reported count only when it is a finite
 * nonnegative integer (null when unknown or invalid), and `complete` is true
 * only when the read is defensibly exhaustive — never merely because a page
 * ran out while a cap, duplicate, or contradictory total was observed.
 */
export interface JellyfinItemResult {
    items: JellyfinItem[]
    /** Upstream total when reported as a finite nonnegative integer; null when unknown. */
    total: number | null
    /** True only when nothing suggests truncation, duplicate inflation or contradiction. */
    complete: boolean
    /** All-history paging reached its natural end; raw totals may still include filtered rows. */
    paginationComplete?: true
    /** Only the requested history bound prevented completeness; no paging anomaly was observed. */
    limited?: true
    /**
     * Present ONLY on partial snapshots published while a paged read is still
     * walking (onProgress publishers). Lets consumers distinguish
     * actively-loading progress from a settled incomplete listing so
     * in-flight pages do not each raise a "could not be verified" warning.
     * Never set on final client results and never persisted.
     */
    inProgress?: true
    /**
     * Present only on reads requested with DatePlayed sorting: true when the
     * server accepted the sort, false when a 400 downgraded the read to
     * unsorted paging. Consumers that rely on recency order (head-only card
     * reads) must fall back to the archive walk when this is false.
     */
    sortAccepted?: boolean
    /** The bound this read applied: 50 for resume, 500 for played. */
    limit: number
}

export interface JellyfinPagedReadOptions {
    maxItems?: number
    pageSize?: number
    /** Windows kept in flight during a walk (results still process in window order); default 1. */
    windowConcurrency?: number
    /** Retries per page for transient failures (timeout, network, server); default 0. */
    pageRetries?: number
    /** First retry delay in ms; doubles per retry. */
    retryDelayMs?: number
    /** Same-client, single-use head observation for the initial archive walk only. */
    prefetchedHead?: JellyfinItemResult
    /**
     * Called after every page that added items, with an honest partial
     * snapshot of the walk so far (`complete` is always false: a partial
     * listing is never provably complete). May be async; the walk awaits it
     * between pages. The snapshot's items array is a fresh copy.
     */
    onProgress?: (snapshot: JellyfinItemResult) => void | Promise<void>
}

export interface JellyfinItemQuery {
    ids?: string[]
    parentId?: string
    includeItemTypes?: string
    recursive?: boolean
    startIndex?: number
    limit?: number
}

export interface JellyfinUserDataUpdate {
    Played?: true
    PlaybackPositionTicks?: number
    LastPlayedDate?: string
    PlayCount?: number
    /** 0-10 user rating. */
    Rating?: number
    IsFavorite?: boolean
}

/** Backward-compatible alias for the played-history result. */
export type JellyfinPlayedResult = JellyfinItemResult

/** Raw now-playing item DTO from /Sessions. */
export interface JellyfinNowPlayingItem {
    Id?: string
    Name?: string
    Type?: string
    SeriesName?: string
    SeriesId?: string
    ParentIndexNumber?: number
    IndexNumber?: number
    RunTimeTicks?: number
    ProviderIds?: Record<string, string>
    SeriesProviderIds?: Record<string, string>
    UserData?: JellyfinUserData
    [key: string]: unknown
}

/** Raw play-state DTO from /Sessions. */
export interface JellyfinPlayState {
    PositionTicks?: number
    IsPaused?: boolean
    IsMuted?: boolean
    CanSeek?: boolean
    [key: string]: unknown
}

/**
 * Raw /Sessions row. Only rows carrying NowPlayingItem + PlayState + a fresh
 * LastPlaybackCheckIn are treated as live playback by readSessions.
 */
export interface JellyfinSession {
    Id?: string
    UserId?: string
    UserName?: string
    Client?: string
    DeviceName?: string
    ApplicationVersion?: string
    NowPlayingItem?: JellyfinNowPlayingItem
    PlayState?: JellyfinPlayState
    LastPlaybackCheckIn?: string
    [key: string]: unknown
}

export interface JellyfinClientOptions {
    /** Stable device identity sent in the Authorization header. Generated when omitted. */
    deviceId?: string
    /** Fetch implementation. Injected for tests; globalThis.fetch is resolved per call otherwise. */
    fetch?: typeof fetch
    /**
     * Per-request timeout in milliseconds (default 15000). Extension beyond the
     * shared connection contract, kept optional so existing callers are unaffected.
     */
    timeoutMs?: number
}

/**
 * Browser-direct, read-only Jellyfin protocol client. Every method performs at
 * most the documented requests (no retries, no refresh), never sends the access
 * token in a query string and never mutates watched/progress state.
 */
export interface JellyfinClient {
    getPublicInfo(signal?: AbortSignal): Promise<JellyfinSystemInfo>
    listPublicUsers(signal?: AbortSignal): Promise<JellyfinUser[]>
    signIn(username: string, password: string, signal?: AbortSignal): Promise<JellyfinSignIn>
    connectToken(accessToken: string, userId?: string, signal?: AbortSignal): Promise<JellyfinSignIn>
    /** GET /QuickConnect/Enabled. False when the server lacks or refuses the endpoint; transport failures throw. */
    quickConnectEnabled(signal?: AbortSignal): Promise<boolean>
    /** POST /QuickConnect/Initiate. Returns the pending code shown to the user and its one-time secret. */
    quickConnectInitiate(signal?: AbortSignal): Promise<JellyfinQuickConnectResult>
    /** GET /QuickConnect/Connect?secret=…. A 404 means the secret is unknown, expired or consumed. */
    quickConnectState(secret: string, signal?: AbortSignal): Promise<JellyfinQuickConnectResult>
    /** POST /Users/AuthenticateWithQuickConnect. Consumes the approved secret and returns the session. */
    authenticateWithQuickConnect(secret: string, signal?: AbortSignal): Promise<JellyfinSignIn>
    listUsers(accessToken: string, signal?: AbortSignal): Promise<JellyfinUser[]>
    getUser(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinUser>
    inspect(accessToken: string, user: JellyfinUser, signal?: AbortSignal): Promise<JellyfinServerDetails>
    readItem(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItem>
    readWatchItem(accessToken: string, userId: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItem>
    readResume(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinItemResult>
    readPlayed(accessToken: string, userId: string, signal?: AbortSignal, onProgress?: JellyfinPagedReadOptions['onProgress'], parallelHeadPages?: boolean, pageRetries?: number): Promise<JellyfinItemResult>
    /** One sorted 25-row probe of the played head prefix for cheap freshness checks. */
    probePlayedHead(accessToken: string, userId: string, signal?: AbortSignal): Promise<{ items: JellyfinItem[]; total: number | null }>
    readAllPlayed(accessToken: string, userId: string, options?: JellyfinPagedReadOptions, signal?: AbortSignal): Promise<JellyfinItemResult>
    readAllResume(accessToken: string, userId: string, options?: JellyfinPagedReadOptions, signal?: AbortSignal): Promise<JellyfinItemResult>
    readAllLibrary(accessToken: string, userId: string, options?: JellyfinPagedReadOptions, signal?: AbortSignal): Promise<JellyfinItemResult>
    /** Full favorites walk over Movies and Episodes at the library page window. */
    readAllFavorites(accessToken: string, userId: string, options?: JellyfinPagedReadOptions, signal?: AbortSignal): Promise<JellyfinItemResult>
    queryUserItems(accessToken: string, userId: string, query: JellyfinItemQuery, signal?: AbortSignal): Promise<JellyfinItem[]>
    readSessions(accessToken: string, userId: string, signal?: AbortSignal): Promise<JellyfinSession[]>
}
