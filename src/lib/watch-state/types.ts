export type WatchMediaType = 'movie' | 'episode'

export interface WatchStateRecord {
    id: string
    title: string
    seriesTitle?: string
    episodeTitle?: string
    type: WatchMediaType | 'unknown'
    identities: string[]
    season?: number
    episode?: number
    watched?: boolean
    positionMs?: number
    durationMs?: number
    playedAt: number | null
    resumePlayedAt?: number | null
    /** 'estimated' dates are display-only and are never written to a destination; absent means a native exact date. */
    dateConfidence?: 'exact' | 'estimated'
    /** The one resume episode of a series whose item-level date is exact for this episode. */
    resumeSlot?: true
    playCount?: number
    unmodified?: boolean
    notes?: string[]
    fingerprint: string
}

export interface WatchStateEndpoint {
    connectionId: string
    label: string
    subject: string
    scope: string
}

export interface WatchStateSnapshot extends WatchStateEndpoint {
    records: WatchStateRecord[]
    complete: boolean
    notes: string[]
}

export type MigrationProgress = (message: string) => void

export interface WatchStateSource {
    read(signal: AbortSignal, progress?: MigrationProgress): Promise<WatchStateSnapshot>
}

export interface WatchStatePatch {
    watched?: true
    positionMs?: number
    durationMs?: number
    playedAt?: number
    resumePlayedAt?: number | null
    resumeSlot?: true
    playCount?: number
}

export interface MigrationWriteResult {
    status: 'applied' | 'unchanged' | 'conflict'
    message: string
    record?: WatchStateRecord
}

export interface WatchStateDestination extends WatchStateEndpoint {
    capabilities: { watched: boolean; resume: boolean; dates: boolean; counts?: boolean; combined?: boolean; requiresDates?: boolean; requiresDuration?: boolean; notes: string[] }
    resolve(record: WatchStateRecord, signal: AbortSignal): Promise<WatchStateRecord[]>
    apply(expected: WatchStateRecord, patch: WatchStatePatch, signal: AbortSignal): Promise<MigrationWriteResult>
    /** Called once before the first write of an import run: drops per-run caches and re-verifies the session. */
    beginRun?(signal: AbortSignal): Promise<void>
}

export interface MigrationOptions {
    watched: boolean
    resume: boolean
}

export interface MigrationRow {
    id: string
    source: WatchStateRecord
    target?: WatchStateRecord
    patch?: WatchStatePatch
    status: 'ready' | 'unchanged' | 'conflict' | 'skipped' | 'unsupported'
    reason: string
    notes: string[]
    /** The write carries state but no exact watch time, so it is sent without a date. */
    undated?: true
}

export interface WatchMigrationPlan {
    createdAt: number
    source: WatchStateSnapshot
    destination: WatchStateEndpoint
    options: MigrationOptions
    notes: string[]
    rows: MigrationRow[]
}

export interface MigrationFailure {
    stage: 'identity' | 'prewrite' | 'write' | 'readback' | 'verification'
    reason: 'rate_limited' | 'timeout' | 'network' | 'http' | 'invalid_response' | 'remote_declined' | 'acknowledgement' | 'state_mismatch' | 'unknown'
    httpStatus?: number
    attempts?: number
}

export interface MigrationResult {
    rowId: string
    status: 'applied' | 'unchanged' | 'conflict' | 'failed'
    message: string
    completedAt: number
    failure?: MigrationFailure
    verified?: Pick<WatchStateRecord, 'watched' | 'positionMs' | 'playedAt' | 'playCount'>
}
