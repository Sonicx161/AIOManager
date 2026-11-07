export interface LibraryItem {
    _id: string
    name?: string
    type?: string
    poster?: string
    background?: string
    logo?: string
    removed?: boolean
    temp?: boolean
    state?: {
        lastWatched?: string
        timeOffset?: number
        duration?: number
        flaggedWatched?: number
        timesWatched?: number
        timeWatched?: number
        overallTimeWatched?: number
        video_id?: string
        watched?: string
        season?: number
        episode?: number
    }
    _ctime?: string
    _mtime?: string
}

export interface SavedEpisodeRange {
    start: number
    end: number
}

export interface SavedSeasonSummary {
    season: number
    count: number
    ranges: SavedEpisodeRange[]
}

/** Verified per-episode watch state recovered from Stremio's watched bitfield (no real watch dates). */
export interface SavedEpisodesSummary {
    episodeCount: number
    seasons: SavedSeasonSummary[]
}

export interface ActivityItem {
    id: string // Unique ID: accountId:uniqueItemId (episode-aware)
    accountId: string
    accountName: string
    accountColorIndex: number
    itemId: string // Base item ID (e.g., tt123)
    uniqueItemId: string // Episode-aware ID (e.g., tt123:1:5 for series)
    name: string
    type: string
    poster: string
    timestamp: Date      // Last watched (_mtime / lastWatched)
    firstWatched?: Date  // First added to library (_ctime) - when they started watching
    duration: number
    watched: number
    progress: number
    timesWatched?: number  // From state.timesWatched
    flaggedWatched?: number // From state.flaggedWatched (Stremio's watched bit)
    isInProgress: boolean  // timeOffset > 0 && progress < 90
    season?: number
    episode?: number
    /** Inferred episode bounds for a watch whose exact episode was never recorded. */
    episodeRange?: { season: number; from: number; to: number }
    overallTimeWatched?: number
    genres?: string[]
    source?: string // platform the watch came from: 'stremio' | 'nuvio' | ... (absent = unknown)
    sourceConnectionId?: string // exact remote login this item came from (same-platform multiplicity); absent = canonical/legacy route
    backfill?: boolean // recovered from Stremio's watched-bitfield; no real per-episode time, so excluded from time-based Replay stats
    /** Imported saved watch state (bitfield aggregate series / flagged-only movie): no real watch dates, presented as saved state. */
    importedSavedState?: boolean
    /** A real play whose time came from an import stamp, shown as approximate. */
    timeApproximate?: boolean
    /**
     * Authoritative current resume position (ms) from the live overlay; present only
     * when the current library state supplied one. Presence means `watched` is
     * historical credit, not the current resume (Sol R2-10).
     */
    liveResume?: number
    /** Verified episode count/ranges recovered from the watched bitfield (series saved state only). */
    savedEpisodes?: SavedEpisodesSummary
    readOnly?: boolean
    mediaObservation?: { connectionId: string; productName: string; kind: 'resume' | 'played' | 'live'; checkedAt: number; reportedAt?: number; hasPlayedDate: boolean; positionMs: number; isPaused?: boolean }
    mediaSources?: string[]
    /** Exact user-scoped server items contributing to this observation. */
    mediaTargets?: Array<{ connectionId: string; itemId: string }>
    /** Jellyfin ProviderIds.Tmdb, kept for artwork fallback only; never part of row identity. */
    tmdbId?: number
}

// A detected watch event from snapshot diffing.
// Accumulated in the cloud sync blob as the source of truth for
// Activity, Metrics, and Replay history.
export interface WatchEvent {
    id: string
    accountId: string
    itemId: string
    video_id: string
    event_ts: number
    detected_ts: number
    name: string
    type: string
    poster: string
    time_watched: number
    time_watched_delta?: number
    duration: number
    season?: number
    episode?: number
    source?: string
    sourceConnectionId?: string // exact remote login that produced this event; absent = canonical/legacy account scope
    /** Frozen identity scope (canonical events carry attribution but keep the bare scope). */
    scopeKey?: string
    timesWatched?: number
    /** Server rows only: Stremio's accumulated watch time when the row was recorded. */
    overall_time_watched?: number
    backfill?: boolean // recovered from Stremio's watched-bitfield (no real per-episode timestamp)
    /**
     * Positive per-episode completion confirmation stamped by recordBackfillEpisodes when
     * the checksum-verified watched bitfield covers an episode that already has real
     * historic events: their dates/times stay untouched, the flag is the only change.
     * Mirrors Stremio's own state.flaggedWatched marker (1 = watched).
     */
    flaggedWatched?: number
}

export interface SnapshotItem {
    mtime: number
    video_id: string
    overallTimeWatched: number
    timeWatched: number
    timeOffset: number
    duration?: number
    season?: number
    episode?: number
    /** Fingerprint of the saved watched marks (series bitfield, movie flag and count). */
    watchMark?: string
    /** Rebuilt from a server row: its times and resume position are unknown. */
    fromServer?: boolean
    /** Whether this episode's own bit was set in the watched bitfield (undefined = unknown). */
    ownBit?: boolean
    /** ownBit is unknown only because the series episode list was not cached; the bitfield itself is well formed. */
    ownBitPending?: boolean
}
